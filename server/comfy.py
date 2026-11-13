"""Drives MuseMossSheetDesigner on a ComfyUI server: builds the API graph, queues it, files the results as assets."""
import asyncio
import json
import uuid

import httpx

from . import db, library

CLIENT_ID = str(uuid.uuid4())
NODE = "muse"  # Fixed graph id: the node caches renders per node id, so unchanged views are not re-rendered.
NODE_IMAGE_INPUTS = ("character_image", "detail_image", "pose_image")  # The UI's describe_image slot is sent as character_image.
DEFAULT_CONTROL = {"locked": [], "seeds": {}, "edits": {}, "edit_seeds": {}, "prompts": {}, "action": None}
# Copy of the node's contracts/default_state.json.
DEFAULT_STATE = {"kind": "moss_image_character_sheet", "schema_version": 1, "views": ["face_front", "body_front", "body_left", "body_right", "body_back"],
                 "character": {"identity": "", "outfit": ""}, "part_prompts": {}, "appearance": {"hand_state": "auto", "clothing_type": "auto", "footwear_state": "auto"},
                 "style": "none", "background": "white", "prompt_format": "auto", "negative_prompt": "",
                 "size": {"mode": "auto", "body_height": 1120, "pixel_budget": 2000000, "manual_width": 1536, "manual_height": 1024}}


async def get(server, path, **params):
    async with httpx.AsyncClient(base_url=server["url"], timeout=30) as client:
        r = await client.get(path, params=params)
        r.raise_for_status()
        return r


async def upload(server, conn, asset_id):
    a = conn.execute("SELECT sha1, path FROM asset WHERE id = ?", (asset_id,)).fetchone()
    async with httpx.AsyncClient(base_url=server["url"], timeout=60) as client:
        r = await client.post("/upload/image", files={"image": (f"kons_curator_{a['sha1']}.png", library.file_path(a).read_bytes(), "image/png")}, data={"overwrite": "true"})
        r.raise_for_status()
        return r.json()["name"]


def enabled_loras(p):
    """p["loras"]: the Generate panel's rows, {on, lora, strength, words}."""
    return [r for r in p.get("loras", []) if r.get("on") and r.get("lora") and float(r.get("strength", 0))]


def sheet_graph(server, character, outfit, p, refs):
    """p: job params (mode, views, seed, megapixels, prompt_list, control, describe, remove_background)."""
    m = server["models"]
    state = json.loads(character["state_json"]) if character["state_json"] else dict(DEFAULT_STATE)
    if p.get("views"):
        state["views"] = p["views"]
    if p.get("style"):
        state["style"] = p["style"]
    if outfit and outfit["footwear"]:
        state["part_prompts"] = {**state.get("part_prompts", {}), "footwear": outfit["footwear"]}
    trigger = character["trigger"].strip()
    description = character["description"].strip()
    if trigger and not description.startswith(trigger):
        description = f"{trigger}, {description}"
    loras = enabled_loras(p)
    words = ", ".join(r["words"].strip() for r in loras if r.get("words", "").strip())
    if words:
        description = f"{words}, {description}"
    inputs = {
        "model": [f"lora{len(loras) - 1}", 0] if loras else ["unet", 0], "clip": [f"lora{len(loras) - 1}", 1] if loras else ["clip", 0],
        "vae": ["vae", 0], "prompt": description, "state_json": json.dumps(state),
        "mode": p.get("mode", "per_view"), "seed": int(p.get("seed", 0)), "steps": int(m["steps"]), "cfg": float(m["cfg"]),
        "megapixels": float(p.get("megapixels", 1.0)), "kv_cache": m.get("kv_cache", "auto"),
        "view_control": json.dumps({**DEFAULT_CONTROL, **p.get("control", {})}),
        "outfit": outfit["text"] if outfit else "", "body_details": character["body_details"], "nsfw_details": character["nsfw_details"],
        "remove_background": bool(p.get("remove_background", True)), "pose_megapixels": float(p.get("pose_megapixels", 0.75)), "prompt_list": p.get("prompt_list") or "A-Poses (6)",
    }
    graph = {
        "unet": {"class_type": "UNETLoader", "inputs": {"unet_name": m["unet"], "weight_dtype": "default"}},
        "clip": {"class_type": "CLIPLoader", "inputs": {"clip_name": m["clip"], "type": m["clip_type"], "device": "default"}},
        "vae": {"class_type": "VAELoader", "inputs": {"vae_name": m["vae"]}},
        **{f"lora{n}": {"class_type": "LoraLoader", "inputs": {"model": [f"lora{n - 1}", 0] if n else ["unet", 0], "clip": [f"lora{n - 1}", 1] if n else ["clip", 0],
                                                                "lora_name": r["lora"], "strength_model": float(r["strength"]), "strength_clip": float(r["strength"])}}
           for n, r in enumerate(loras)},
        NODE: {"class_type": "MuseMossSheetDesigner", "inputs": inputs},
        "save_sheet": {"class_type": "SaveImage", "inputs": {"images": [NODE, 0], "filename_prefix": "kons_curator/sheet"}},
        "save_template": {"class_type": "SaveImage", "inputs": {"images": [NODE, 2], "filename_prefix": "kons_curator/template"}},
    }
    for slot, name in refs.items():
        graph[f"ref_{slot}"] = {"class_type": "LoadImage", "inputs": {"image": name}}
        inputs[slot] = [f"ref_{slot}", 0]
    for toggle in p.get("describe", []):
        inputs[toggle] = True
    if p.get("describe"):
        # llama.cpp memory is outside ComfyUI's model management: free it before the next generation needs the VRAM.
        graph["vision"] = {"class_type": "LCVisionLoader", "inputs": {**m["vision"], "keep_model_loaded": False}}
        inputs["vision_model"] = ["vision", 0]
    return graph


# Replaces the node's default system prompt, which asks for the subject's appearance in rich detail.
CAPTION_SYSTEM = ("You write captions for training a character LoRA. The character's identity is learned from a trigger word, "
                  "so captions must never describe what stays the same in every image of them: face, eyes, hair (color, length, style), "
                  "ears, skin, species, age, body type. Describe only what changes between images. Output one plain paragraph of "
                  "comma-separated phrases, no headings, labels, lists or notes, and nothing after the caption. No reasoning.")


def caption_graph(server, image_name, instruction, keep_loaded):
    return {
        "img": {"class_type": "LoadImage", "inputs": {"image": image_name}},
        "vision": {"class_type": "LCVisionLoader", "inputs": {**server["models"]["vision"], "keep_model_loaded": keep_loaded}},
        "caption": {"class_type": "LCVisionCaption", "inputs": {"vision_model": ["vision", 0], "prompt": instruction, "system_prompt": CAPTION_SYSTEM, "reference_image_1": ["img", 0]}},
        "show": {"class_type": "PreviewAny", "inputs": {"source": ["caption", 0]}},
    }


async def queue_and_wait(server, graph):
    async with httpx.AsyncClient(base_url=server["url"], timeout=30) as client:
        r = await client.post("/prompt", json={"prompt": graph, "client_id": CLIENT_ID})
        if r.status_code != 200:
            raise RuntimeError(f"ComfyUI rejected the prompt: {r.text[:2000]}")
        prompt_id = r.json()["prompt_id"]
        while True:
            await asyncio.sleep(2)
            try:
                history = (await client.get(f"/history/{prompt_id}")).json().get(prompt_id)
            except httpx.TransportError:  # A busy server (model load/unload, NAS rescan) can miss one poll; keep waiting.
                continue
            if history:  # ComfyUI adds a prompt to history only once it has finished or failed.
                break
        status = history["status"]
        if status.get("status_str") == "error":
            errors = [m[1] for m in status.get("messages", []) if m[0] == "execution_error"]
            raise RuntimeError(errors[0].get("exception_message", "execution error") if errors else "execution error")
        return prompt_id, history["outputs"]


async def fetch(server, image):
    return (await get(server, "/view", filename=image["filename"], subfolder=image.get("subfolder", ""), type=image.get("type", "output"))).content


async def run_sheet_job(job_id):
    """Queue one MuseMossSheetDesigner run and file every image it produced."""
    with db.connect() as conn:
        job = db.row(conn.execute("SELECT * FROM job WHERE id = ?", (job_id,)).fetchone())
        server = db.row(conn.execute("SELECT * FROM server WHERE id = ?", (job["server_id"],)).fetchone())
        character = conn.execute("SELECT * FROM character WHERE id = ?", (job["character_id"],)).fetchone()
        outfit = conn.execute("SELECT * FROM outfit WHERE id = ?", (job["outfit_id"],)).fetchone() if job["outfit_id"] else None
        p = job["params"]
        refs = {slot: await upload(server, conn, aid) for slot, aid in p.get("refs", {}).items() if aid and slot in NODE_IMAGE_INPUTS}
        conn.execute("UPDATE job SET status = 'running' WHERE id = ?", (job_id,))
    prompt_id, outputs = await queue_and_wait(server, sheet_graph(server, character, outfit, p, refs))
    ui = outputs.get(NODE, {})
    result = {"views": {}, "assets": [], "described": (ui.get("muse_described") or [{}])[0]}
    style = p.get("style") or json.loads(character["state_json"] or "{}").get("style", "none")
    common = {"character_id": job["character_id"], "outfit_id": job["outfit_id"], "job_id": job_id, "style": style,
              "loras": [{"lora": r["lora"], "strength": float(r["strength"])} for r in enabled_loras(p)]}
    parents = p.get("parents", {})
    with db.connect() as conn:
        for view, card in (ui.get("muse_views") or [{}])[0].items():
            if not card.get("image"):
                continue
            edit = p.get("control", {}).get("edits", {}).get(view)
            aid = library.store(conn, await fetch(server, card["image"]), kind="edit" if edit else "view", view_id=view, prompt=card["prompt"],
                                seed=card["seed"], parent_id=parents.get(view) or p.get("refs", {}).get("character_image"), **common)
            if not library.current_caption(conn, aid):
                db.set_caption(conn, aid, "node_prompt", card["prompt"] + (f" {edit}" if edit else ""))
            path = conn.execute("SELECT path FROM asset WHERE id = ?", (aid,)).fetchone()["path"]
            result["views"][view] = {"asset_id": aid, "path": path, "seed": card["seed"], "prompt": card["prompt"], "stale": card["stale"]}
        captions = ui.get("muse_captions", [])  # Missing on servers running a node version without it.
        for i, image in enumerate(ui.get("images", [])):
            caption = captions[i] if i < len(captions) else ""
            aid = library.store(conn, await fetch(server, image), kind="list_image", view_id=f"{p.get('prompt_list')}#{i}", prompt=caption,
                                seed=int(p.get("seed", 0)) + i, parent_id=p.get("refs", {}).get("character_image"), **common)
            if caption and not library.current_caption(conn, aid):
                db.set_caption(conn, aid, "node_prompt", caption)
            result["assets"].append(aid)
        for node, kind in (("save_sheet", "sheet"), ("save_template", "template")):
            for image in outputs.get(node, {}).get("images", []):
                result["assets"].append(library.store(conn, await fetch(server, image), kind=kind, **common))
        db.write(conn, "job", {"status": "done", "comfy_prompt_id": prompt_id, "result": result}, job_id)


async def run_caption_job(job_id):
    """Caption each asset with LC Vision Caption; the answer becomes the asset's current caption."""
    with db.connect() as conn:
        job = db.row(conn.execute("SELECT * FROM job WHERE id = ?", (job_id,)).fetchone())
        server = db.row(conn.execute("SELECT * FROM server WHERE id = ?", (job["server_id"],)).fetchone())
        conn.execute("UPDATE job SET status = 'running' WHERE id = ?", (job_id,))
    p = job["params"]
    for n, aid in enumerate(p["asset_ids"]):
        with db.connect() as conn:
            name = await upload(server, conn, aid)
        # Stay loaded between images; the last one releases the vision model's VRAM.
        _, outputs = await queue_and_wait(server, caption_graph(server, name, p["instruction"], n < len(p["asset_ids"]) - 1))
        text = library.clean_caption(outputs["show"]["text"][0])
        with db.connect() as conn:
            db.set_caption(conn, aid, "lc_vision", text)
            db.write(conn, "job", {"result": {"done": n + 1, "total": len(p["asset_ids"])}}, job_id)
    with db.connect() as conn:
        db.write(conn, "job", {"status": "done"}, job_id)


async def run_restyle_job(job_id):
    """image_edit each asset in the node; results are child 'edit' assets, optionally added to a dataset."""
    with db.connect() as conn:
        job = db.row(conn.execute("SELECT * FROM job WHERE id = ?", (job_id,)).fetchone())
        server = db.row(conn.execute("SELECT * FROM server WHERE id = ?", (job["server_id"],)).fetchone())
        conn.execute("UPDATE job SET status = 'running' WHERE id = ?", (job_id,))
    p, made = job["params"], []
    for n, aid in enumerate(p["asset_ids"]):
        with db.connect() as conn:
            src = conn.execute("SELECT * FROM asset WHERE id = ?", (aid,)).fetchone()
            character = conn.execute("SELECT * FROM character WHERE id = ?", (src["character_id"],)).fetchone() if src["character_id"] else None
            # image_edit ignores the character text, but the node requires a non-empty description.
            character = character or {"state_json": "", "trigger": "", "description": "character", "body_details": "", "nsfw_details": ""}
            name = await upload(server, conn, aid)
            caption = library.current_caption(conn, aid)
        params = {"mode": "image_edit", "style": p["style"], "seed": int(p.get("seed", 0)) + n, "megapixels": p.get("megapixels", 1.0),
                  "control": {"edits": {"image": p.get("instruction", "")}}}
        _, outputs = await queue_and_wait(server, sheet_graph(server, character, None, params, {"character_image": name}))
        ui = outputs.get(NODE, {})
        with db.connect() as conn:
            for image in ui.get("images", []):
                new = library.store(conn, await fetch(server, image), kind="edit", view_id=src["view_id"], character_id=src["character_id"], outfit_id=src["outfit_id"],
                                    parent_id=aid, job_id=job_id, prompt=(ui.get("muse_captions") or [""])[0], seed=params["seed"], style=p["style"])
                if not library.current_caption(conn, new):
                    db.set_caption(conn, new, "node_prompt", ", ".join(t for t in (caption, p.get("caption_suffix", "")) if t))
                if p.get("dataset_id"):
                    conn.execute("INSERT OR IGNORE INTO dataset_item (dataset_id, asset_id) VALUES (?, ?)", (p["dataset_id"], new))
                made.append(new)
            db.write(conn, "job", {"result": {"done": n + 1, "total": len(p["asset_ids"]), "assets": made}}, job_id)
    with db.connect() as conn:
        db.write(conn, "job", {"status": "done"}, job_id)


async def run_job(job_id, kind):
    try:
        await {"caption": run_caption_job, "restyle": run_restyle_job}.get(kind, run_sheet_job)(job_id)
    except Exception as error:
        with db.connect() as conn:
            db.write(conn, "job", {"status": "error", "error": str(error) or type(error).__name__}, job_id)
        raise
