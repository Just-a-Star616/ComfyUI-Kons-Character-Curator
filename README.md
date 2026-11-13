# Kons Character Curator

Local catalogue and curation app for characters, outfits and LoRA datasets. All image generation goes through the [Muse MOSS Sheet Designer](https://github.com/Just-a-Star616/ComfyUI-Muse-MOSS-Sheet-Designer) node (`MuseMossSheetDesigner`) on one or more ComfyUI servers; this app stores and organises the results.

It is a standalone app, not a ComfyUI custom node: clone it outside `custom_nodes/` and run it next to ComfyUI. ComfyUI servers only need the node installed.

## Run

```
git clone https://github.com/Just-a-Star616/ComfyUI-Kons-Character-Curator
cd ComfyUI-Kons-Character-Curator
uv venv .venv && uv pip install --python .venv/bin/python -r requirements.txt
cd web && npm install && npm run build && cd ..
.venv/bin/uvicorn server.app:app --port 8700
```

Open http://127.0.0.1:8700. Add `--host 0.0.0.0` to reach it from other machines; it has no login, so only do that on a trusted network. For UI development run `npm run dev` in `web/` (proxies `/api` and `/data` to port 8700).

Data lives in `data/`: `catalogue.sqlite` and content-addressed images in `data/assets/`.

## Config

Copy `config.example.json` to `config.json` (not committed) and set your paths:
- `servers`: ComfyUI servers added to a new database (later edits happen on the Servers page).
- `presets_path`: the node's `muse_moss_sheet_presets.json`, offered by **Import presets**.
- `scan_roots`: folders offered by **Scan folder**; `per_character_folders` when each top folder is one character.
- `export_dir`: default target for dataset export.

Without `config.json` the app starts with one local server and empty paths.

## Servers

The servers in `config.json` are added on first start. On the **Servers** page press **Check** to list the models on that server, then set the UNET, CLIP (+ type), VAE, steps and cfg. The LC Vision Loader inputs (for Describe and dataset captioning) can start from **Use loader defaults**.

Each server needs the Muse MOSS Sheet Designer node. Prompt-list captions need the node version that reports `muse_captions`; older versions still return images, without captions.

## Pages

- **Library**: characters with search over name, trigger, franchise, tags and description. **Import Muse presets** reads the node's `user/default/muse_moss_sheet_presets.json`.
- **Character**: description fields, outfits (New, Variant = copy and change one thing), source image upload, and **Generate**:
  - `per_view`: view cards like the node's (Confirm, New seed, Edit, prompt override), Next view / All views / Build final sheet. An edit is stored as a child of the image it edits.
  - `prompt_list`: renders a dataset list; every image is filed with its prompt as caption.
  - **Describe** fills description, outfit and body from `character_image` with LC Vision; review, then Save.
  - **Accessories**: toggle the character's and shared accessories for a run; images record which were used.
  - **Style**: the node's designer style. Images record it; the gallery filters by it.
  - **LoRA**: rows of on / LoRA / strength / trigger words, applied with core `LoraLoader` (model and clip). The picker browses the server's LoRA folders, with each file's base model, title and preview from ComfyUI-Lora-Manager (both servers' indexes merged), a base-model filter and a search over name, title and tags. **Info** shows rgthree-comfy's model info (metadata trigger words, the core preview image) and **Refresh from Civitai** has rgthree look the file up by hash, always on a server ticked **can reach Civitai** on the Servers page (the remote, behind its system VPN). rgthree saves the result next to the LoRA, so the other server reads it from the shared folder; click a word to add it to the row's trigger words, which are put in front of the description. Images record the LoRAs used; the gallery filters by them.
- **Wardrobe**: outfits and accessories across characters. Shared items (no character) are offered on every character's page; items can be moved, shared or copied between characters, and each shows the images made with it. An accessory (weapon, jewelry, prop...) joins the designer part prompt for where it is worn, so it only reaches views where that part is visible: a held sword appears on full-body views, not portraits. In prompt lists, which have no part prompts, accessories follow the outfit text.
- **Assets**: every image, filtered by kind, rating, text.
- **Review**: P pass, F fail, S skip, ← back over unrated images, with the character's source image beside them.
- **Datasets**: add passed images, edit captions (per-dataset overrides), find/replace, caption all with LC Vision Caption, and export `img_###.png` + `img_###.txt` with the trigger word first (kohya / ai-toolkit layout).

## 3D (planned)

Asset kinds `multiview`, `mesh` and `rig` are reserved for the 3D stage (TRELLIS2 / Pixal3D through ComfyUI, Blender cleanup and rigging). The A-Poses prompt list is the starting point for CharacterGen-style canonical multiviews.
