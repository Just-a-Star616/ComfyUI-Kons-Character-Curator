# Kons Character Curator

Standalone app (not a ComfyUI custom node): FastAPI + stdlib sqlite3 server, React 18 / Vite 5 UI. All image generation goes through the `MuseMossSheetDesigner` node on ComfyUI servers over the ComfyUI HTTP API.

## Run and check

```
.venv/bin/uvicorn server.app:app --port 8700      # restart after server changes (stop the old one first: fuser -k 8700/tcp)
cd web && npm run build                             # FastAPI serves web/dist; rebuild after UI changes
.venv/bin/python -m py_compile server/*.py
```

No test suite. After UI changes, open the affected page in a browser and check the console: a hook placed after an early return once blanked the character page.

## Layout

- `server/app.py`: routes. `server/db.py`: schema; new columns go in `ADDED_COLUMNS`, JSON columns in `JSON_COLUMNS` (`row()` decodes them, skipping NULL).
- `server/library.py`: indexing in place (pixel SHA1 dedupe, thumbnails, 256-bit dHash), character matching, trash via `gio trash`, dataset export.
- `server/comfy.py`: builds the node graph (`sheet_graph`), queues jobs, files results. Node id is fixed to `muse` so the node's per-view cache works.
- `server/config.py`: reads `config.json`.
- `web/src/`: `Character.jsx` (gallery + Generate panel), `Loras.jsx` (LoRA rows, picker, info dialog), `Datasets.jsx`, `Duplicates.jsx`, `Review.jsx`, `ui.jsx` (grid, side drawer).

## Rules

- Machine-specific values (server addresses, folder paths) belong in `config.json`, which is git-ignored. Never put them in code or docs; `config.example.json` uses placeholders. The repo is public.
- Commit with the GitHub noreply email (set in this repo's git config), not a personal address.
- Deleting images moves them to the Trash; never hard-delete user files.
- LoRA data comes from the ComfyUI server: names from `LoraLoader`, metadata and Civitai info from rgthree-comfy routes, base model and previews from ComfyUI-Lora-Manager. Civitai lookups run on a server marked "can reach Civitai"; the app itself makes no internet requests.
- Generated assets record `style` and `loras` so the gallery can filter them; keep that when adding generation paths.
