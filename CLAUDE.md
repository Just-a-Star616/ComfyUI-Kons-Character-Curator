# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Kons Character Curator

Standalone app (not a ComfyUI custom node): FastAPI + stdlib sqlite3 server, React 18 / Vite 5 UI. All image generation goes through the `MuseMossSheetDesigner` node on ComfyUI servers over the ComfyUI HTTP API.

## Run and check

```
.venv/bin/uvicorn server.app:app --port 8700      # restart after server changes (stop the old one first: fuser -k 8700/tcp)
cd web && npm run build                             # FastAPI serves web/dist; rebuild after UI changes
.venv/bin/python -m py_compile server/*.py
```

On Windows: `.venv\Scripts\uvicorn.exe server.app:app --port 8700`, or `launch_curator.bat` (checks the venv and build, opens the browser). For UI work, `npm run dev` in `web/` proxies `/api` and `/data` to port 8700, so no rebuild is needed. `web/dist` is only mounted if it exists when the server starts.

No test suite. After UI changes, open the affected page in a browser and check the console: a hook placed after an early return once blanked the character page.

## Layout

- `server/app.py`: routes. `db.init()` runs at import. Write endpoints whitelist columns with `pick(data, *_FIELDS)`. Long work (generation, captioning, folder scans) runs as asyncio tasks held in `_tasks`; the UI polls `GET /api/jobs/{id}` (`waitJob` in `web/src/api.js`).
- `server/db.py`: schema; new columns go in `ADDED_COLUMNS` (the only migration mechanism), JSON columns in `JSON_COLUMNS` (`write()` encodes them, `row()` decodes them, skipping NULL). Each request or job step opens its own short-lived `db.connect()`.
- `server/library.py`: indexing in place (pixel SHA1 dedupe, thumbnails, 256-bit dHash), character matching, trash via `gio trash` (Linux-only; deleting fails on Windows), dataset export.
- `server/comfy.py`: builds the node graph (`sheet_graph`), queues jobs, files results. Node id is fixed to `muse` so the node's per-view cache works. Job kinds: `sheet` (default), `caption` (LC Vision Caption), `restyle` (node `image_edit` mode); `run_job()` records failures on the job row.
- `server/config.py`: reads `config.json` once at import. Its `servers` are only inserted on first start (`INSERT OR IGNORE`); after that servers are edited on the Servers page (`server` table, per-server models in `server.models`).
- `web/src/`: no router or state library; `App.jsx` switches pages from a `page` state and also holds the Library, Assets and Servers pages. `Character.jsx` (gallery + Generate panel), `Loras.jsx` (LoRA rows, picker, info dialog), `Wardrobe.jsx` (shared outfits and accessories), `Datasets.jsx`, `Duplicates.jsx`, `Review.jsx`, `ui.jsx` (grid, side drawer, `useLoad`). `main.jsx` loads `/api/config` into `CONFIG` before rendering.

## Data model

- Asset identity is the SHA1 of RGBA pixels, not file bytes, so re-saved or copied images collapse into one `asset`; every on-disk copy is a row in `asset_file`.
- `asset.path` is relative to `data/` for stored files (`data/assets/<sha1[:2]>/<sha1>.png`) and absolute for images indexed in place: always resolve it with `library.file_path()`.
- `asset.kind`: `source|import|view|sheet|template|list_image|edit` (`multiview|mesh|rig` reserved for the 3D stage). Edits are child assets via `parent_id`.
- Captions are versioned: one `caption` row per asset has `is_current = 1`, and `db.set_caption()` does the swap. `dataset_item.caption` overrides per dataset. Export writes `img_###.png` + `img_###.txt` with the trigger word first (AI-Toolkit's `[trigger]` placeholder when the dataset has none).
- `comfy.DEFAULT_STATE` and `STYLES` / `VIEWS` / `VIEW_PRESETS` in `web/src/api.js` are copies of the Muse node's contracts; keep them in sync with the node.

## Rules

- Machine-specific values (server addresses, folder paths) belong in `config.json`, which is git-ignored. Never put them in code or docs; `config.example.json` uses placeholders. The repo is public.
- Commit with the GitHub noreply email (set in this repo's git config), not a personal address.
- Deleting images moves them to the Trash; never hard-delete user files.
- LoRA data comes from the ComfyUI server: names from `LoraLoader`, metadata and Civitai info from rgthree-comfy routes, base model and previews from ComfyUI-Lora-Manager. Civitai lookups run on a server marked "can reach Civitai"; the app itself makes no internet requests.
- Generated assets record `style`, `loras` and `accessories` so the gallery and Wardrobe can filter them; keep that when adding generation paths.
- LC Vision loaders end with `keep_model_loaded: False`: llama.cpp VRAM is outside ComfyUI's model management and must be freed before the next generation.
- Outfits and accessories with `character_id` NULL are shared. Accessories go into the designer `part_prompts` (see `sheet_graph`), not the outfit text, except in prompt lists.
