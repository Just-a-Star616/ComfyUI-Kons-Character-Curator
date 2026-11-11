import asyncio
import json
from pathlib import Path
from urllib.parse import quote

import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import comfy, db, library
from .config import CONFIG

db.init()
library.ASSETS.mkdir(parents=True, exist_ok=True)
with db.connect() as _conn:
    library.mark_sources(_conn)
app = FastAPI(title="Kons Character Curator")
_tasks = set()

CHARACTER_FIELDS = {"name", "trigger", "aliases", "cover_id", "description", "body_details", "nsfw_details", "state_json", "franchise", "tags", "notes"}
OUTFIT_FIELDS = {"character_id", "name", "text", "footwear", "tags"}
ASSET_FIELDS = {"rating", "favorite", "hidden", "tags", "outfit_id", "character_id", "view_id"}


def pick(data, fields):
    return {k: v for k, v in data.items() if k in fields}


def one(conn, sql, *args):
    r = db.row(conn.execute(sql, args).fetchone())
    if r is None:
        raise HTTPException(404)
    return r


# Characters and outfits

@app.get("/api/characters")
def characters(q: str = ""):
    with db.connect() as conn:
        like = f"%{q}%"
        return db.rows(conn.execute("""
            SELECT c.*, (SELECT COUNT(*) FROM asset a WHERE a.character_id = c.id AND a.hidden = 0) AS asset_count,
              COALESCE((SELECT id FROM asset WHERE id = c.cover_id), (SELECT a.id FROM asset a WHERE a.character_id = c.id AND a.hidden = 0 AND (a.rating IS NULL OR a.rating = 'pass')
               ORDER BY a.favorite DESC, a.kind = 'source' DESC, a.kind = 'view' AND a.view_id = 'face_front' DESC, a.rating = 'pass' DESC, a.id DESC LIMIT 1)) AS cover
            FROM character c WHERE c.name LIKE ? OR c.trigger LIKE ? OR c.franchise LIKE ? OR c.tags LIKE ? OR c.description LIKE ? OR c.aliases LIKE ? ORDER BY c.name""",
            (like, like, like, like, like, like)))


@app.post("/api/characters")
def create_character(data: dict):
    with db.connect() as conn:
        return {"id": db.write(conn, "character", pick(data, CHARACTER_FIELDS))}


@app.get("/api/characters/{cid}")
def character(cid: int):
    with db.connect() as conn:
        c = one(conn, "SELECT * FROM character WHERE id = ?", cid)
        c["outfits"] = db.rows(conn.execute("SELECT * FROM outfit WHERE character_id = ? OR character_id IS NULL ORDER BY character_id IS NULL, name", (cid,)))
        return c


@app.put("/api/characters/{cid}")
def update_character(cid: int, data: dict):
    with db.connect() as conn:
        db.write(conn, "character", pick(data, CHARACTER_FIELDS), cid)
    return character(cid)


@app.delete("/api/characters/{cid}")
def delete_character(cid: int, images: bool = False):
    """images: also move the character's images to the Trash; otherwise they stay as unassigned."""
    with db.connect() as conn:
        one(conn, "SELECT id FROM character WHERE id = ?", cid)
        if images:
            for r in conn.execute("SELECT id FROM asset WHERE character_id = ?", (cid,)).fetchall():
                library.delete_asset(conn, r["id"])
        conn.execute("DELETE FROM character WHERE id = ?", (cid,))


@app.post("/api/characters/{cid}/merge")
def merge_character(cid: int, data: dict):
    """Fold this character into another: images, outfits and jobs move, its name becomes an alias."""
    into = data["into"]
    with db.connect() as conn:
        src, dst = one(conn, "SELECT * FROM character WHERE id = ?", cid), one(conn, "SELECT * FROM character WHERE id = ?", into)
        for table in ("asset", "outfit", "job", "dataset"):
            conn.execute(f"UPDATE OR IGNORE {table} SET character_id = ? WHERE character_id = ?", (into, cid))
        aliases = list(dict.fromkeys(dst["aliases"] + [src["name"]] + src["aliases"] + ([src["trigger"]] if src["trigger"] else [])))
        db.write(conn, "character", {"aliases": aliases}, into)
        conn.execute("DELETE FROM character WHERE id = ?", (cid,))


@app.post("/api/outfits")
def create_outfit(data: dict):
    with db.connect() as conn:
        return {"id": db.write(conn, "outfit", pick(data, OUTFIT_FIELDS))}


@app.put("/api/outfits/{oid}")
def update_outfit(oid: int, data: dict):
    with db.connect() as conn:
        db.write(conn, "outfit", pick(data, OUTFIT_FIELDS), oid)


@app.delete("/api/outfits/{oid}")
def delete_outfit(oid: int):
    with db.connect() as conn:
        conn.execute("DELETE FROM outfit WHERE id = ?", (oid,))


# Assets

@app.get("/api/assets")
def assets(character_id: str = "", outfit_id: int | None = None, kind: str = "", rating: str = "", view_id: str = "",
           q: str = "", folder: str = "", style: str = "", lora: str = "", hidden: bool = False, limit: int = 300, offset: int = 0):
    """character_id: an id, or 'none' for unassigned images. folder: substring of any on-disk location."""
    where, args = ["a.hidden = ?"], [int(hidden)]
    if character_id == "none":
        where.append("a.character_id IS NULL")
    elif character_id:
        where.append("a.character_id = ?")
        args.append(int(character_id))
    if outfit_id is not None:
        where.append("a.outfit_id = ?")
        args.append(outfit_id)
    if folder:
        where.append("EXISTS (SELECT 1 FROM asset_file f WHERE f.asset_id = a.id AND f.path LIKE ?)")
        args.append(f"%{folder}%")
    if kind:
        where.append(f"a.kind IN ({', '.join('?' * len(kind.split(',')))})")
        args += kind.split(",")
    if rating:
        where.append("a.rating IS NULL" if rating == "unrated" else "a.rating = ?")
        args += [] if rating == "unrated" else [rating]
    if style:
        where.append("a.style = ?")
        args.append(style)
    if lora:
        where.append("EXISTS (SELECT 1 FROM json_each(a.loras) WHERE json_extract(value, '$.lora') = ?)")
        args.append(lora)
    if view_id:
        where.append("a.view_id = ?")
        args.append(view_id)
    if q:
        where.append("(a.prompt LIKE ? OR a.tags LIKE ? OR cap.text LIKE ?)")
        args += [f"%{q}%"] * 3
    with db.connect() as conn:
        return db.rows(conn.execute(f"""
            SELECT a.*, cap.text AS caption, c.name AS character_name FROM asset a
            LEFT JOIN caption cap ON cap.asset_id = a.id AND cap.is_current = 1 LEFT JOIN character c ON c.id = a.character_id
            WHERE {' AND '.join(where)} ORDER BY a.id DESC LIMIT ? OFFSET ?""", (*args, limit, offset)))


@app.get("/api/assets/loras")
def asset_loras(character_id: int):
    """LoRAs used on this character's generated images, for the gallery filter."""
    with db.connect() as conn:
        return [r[0] for r in conn.execute("""SELECT DISTINCT json_extract(value, '$.lora') AS l FROM asset, json_each(asset.loras)
                                              WHERE asset.character_id = ? ORDER BY l""", (character_id,))]


@app.get("/api/assets/{aid}")
def asset(aid: int):
    with db.connect() as conn:
        a = one(conn, "SELECT * FROM asset WHERE id = ?", aid)
        a["captions"] = db.rows(conn.execute("SELECT * FROM caption WHERE asset_id = ? ORDER BY id DESC", (aid,)))
        lineage, parent = [], a["parent_id"]
        while parent and len(lineage) < 20:
            p = db.row(conn.execute("SELECT id, path, kind, view_id, parent_id FROM asset WHERE id = ?", (parent,)).fetchone())
            if p is None:
                break
            lineage.insert(0, p)
            parent = p["parent_id"]
        a["lineage"] = lineage
        a["children"] = db.rows(conn.execute("SELECT id, path, kind, view_id FROM asset WHERE parent_id = ?", (aid,)))
        a["files"] = [r["path"] for r in conn.execute("SELECT path FROM asset_file WHERE asset_id = ? ORDER BY path", (aid,))]
        return a


@app.get("/api/assets/{aid}/file")
def asset_file(aid: int):
    with db.connect() as conn:
        return FileResponse(library.file_path(one(conn, "SELECT path FROM asset WHERE id = ?", aid)))


@app.get("/api/assets/{aid}/thumb")
def asset_thumb(aid: int):
    with db.connect() as conn:
        sha1 = one(conn, "SELECT sha1 FROM asset WHERE id = ?", aid)["sha1"]
    return FileResponse(library.THUMBS / sha1[:2] / f"{sha1}.webp", headers={"Cache-Control": "max-age=31536000, immutable"})


@app.post("/api/assets/delete")
def delete_assets(data: dict):
    """Move the images (every on-disk copy) to the Trash and drop them from the catalogue."""
    with db.connect() as conn:
        for aid in data["ids"]:
            library.delete_asset(conn, aid)
    return {"deleted": len(data["ids"])}


@app.post("/api/assets/{aid}/delete_copy")
def delete_copy(aid: int, data: dict):
    with db.connect() as conn:
        try:
            library.delete_copy(conn, aid, data["path"])
        except ValueError as error:
            raise HTTPException(400, str(error))


@app.get("/api/duplicates")
def duplicates(threshold: int = 6, character_id: int | None = None):
    with db.connect() as conn:
        groups = library.near_duplicates(conn, threshold, character_id)
        out = []
        for g in groups:
            out.append(db.rows(conn.execute(f"""
                SELECT a.*, c.name AS character_name, cap.text AS caption, (SELECT COUNT(*) FROM asset_file f WHERE f.asset_id = a.id) AS copies
                FROM asset a LEFT JOIN character c ON c.id = a.character_id LEFT JOIN caption cap ON cap.asset_id = a.id AND cap.is_current = 1
                WHERE a.id IN ({', '.join('?' * len(g))}) ORDER BY a.width * a.height DESC, a.id""", g)))
        return out


@app.post("/api/duplicates/ignore")
def ignore_duplicates(data: dict):
    ids = sorted(data["ids"])
    with db.connect() as conn:
        conn.executemany("INSERT OR IGNORE INTO dup_ignore (a, b) VALUES (?, ?)", [(a, b) for i, a in enumerate(ids) for b in ids[i + 1:]])


@app.get("/api/copies")
def copies(character_id: int | None = None, limit: int = 200):
    """Images stored more than once on disk."""
    with db.connect() as conn:
        rows = db.rows(conn.execute(f"""
            SELECT a.*, c.name AS character_name, COUNT(f.path) AS copies FROM asset a JOIN asset_file f ON f.asset_id = a.id
            LEFT JOIN character c ON c.id = a.character_id {'WHERE a.character_id = ?' if character_id else ''}
            GROUP BY a.id HAVING copies > 1 ORDER BY copies DESC, a.id LIMIT ?""", (character_id, limit) if character_id else (limit,)))
        for r in rows:
            r["files"] = [f["path"] for f in conn.execute("SELECT path FROM asset_file WHERE asset_id = ? ORDER BY path", (r["id"],))]
        return rows


@app.post("/api/assets/rematch")
def rematch_assets():
    with db.connect() as conn:
        return {"matched": library.rematch(conn)}


@app.post("/api/assets/bulk")
def bulk_assets(data: dict):
    with db.connect() as conn:
        for aid in data["ids"]:
            db.write(conn, "asset", pick(data["data"], ASSET_FIELDS), aid)


@app.patch("/api/assets/{aid}")
def update_asset(aid: int, data: dict):
    with db.connect() as conn:
        db.write(conn, "asset", pick(data, ASSET_FIELDS), aid)


@app.put("/api/assets/{aid}/caption")
def update_caption(aid: int, data: dict):
    with db.connect() as conn:
        db.set_caption(conn, aid, data.get("source", "manual"), data["text"])


@app.post("/api/assets/upload")
async def upload_assets(files: list[UploadFile] = File(...), character_id: int | None = Form(None), outfit_id: int | None = Form(None), kind: str = Form("source")):
    with db.connect() as conn:
        ids = [library.store(conn, await f.read(), kind=kind, character_id=character_id, outfit_id=outfit_id) for f in files]
    return {"ids": ids}


# Import

@app.get("/api/config")
def config():
    """The UI's machine-specific defaults from config.json."""
    return {k: CONFIG[k] for k in ("presets_path", "scan_roots", "export_dir")}


@app.post("/api/import/presets")
def import_presets(data: dict):
    with db.connect() as conn:
        characters, outfits = library.import_presets(conn, data["path"])
    return {"characters": characters, "outfits": outfits}


@app.post("/api/import/scan")
async def import_scan(data: dict):
    """Index a folder tree in place as a background job; progress is in the job's result."""
    if not Path(data["path"]).expanduser().is_dir():
        raise HTTPException(400, "not a folder")
    with db.connect() as conn:
        jid = db.write(conn, "job", {"kind": "scan", "params": data, "status": "running"})

    def progress(counts):
        with db.connect() as conn:
            db.write(conn, "job", {"result": {**counts, "errors": counts["errors"][-20:]}}, jid)

    async def run():
        try:
            counts = await asyncio.to_thread(library.scan, data["path"], bool(data.get("per_character_folders")), progress)
            with db.connect() as conn:
                db.write(conn, "job", {"status": "done", "result": {**counts, "errors": counts["errors"][-20:]}}, jid)
        except Exception as error:
            with db.connect() as conn:
                db.write(conn, "job", {"status": "error", "error": str(error)}, jid)
            raise

    task = asyncio.get_running_loop().create_task(run())
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return {"id": jid}


# Servers

@app.get("/api/servers")
def servers():
    with db.connect() as conn:
        return db.rows(conn.execute("SELECT * FROM server ORDER BY id"))


@app.put("/api/servers/{sid}")
def update_server(sid: int, data: dict):
    with db.connect() as conn:
        db.write(conn, "server", pick(data, {"name", "url", "models", "civitai"}), sid)


@app.get("/api/servers/{sid}/info")
async def server_info(sid: int):
    """Model lists and node availability from the server's /object_info."""
    with db.connect() as conn:
        server = one(conn, "SELECT * FROM server WHERE id = ?", sid)
    try:
        info = (await comfy.get(server, "/object_info")).json()
    except httpx.HTTPError as error:
        return {"online": False, "error": str(error)}
    choices = lambda node, field: info.get(node, {}).get("input", {}).get("required", {}).get(field, [[]])[0]
    vision = info.get("LCVisionLoader", {}).get("input", {}).get("required", {})
    return {"online": True, "muse": "MuseMossSheetDesigner" in info, "lc_vision": "LCVisionCaption" in info,
            "unet": choices("UNETLoader", "unet_name"), "clip": choices("CLIPLoader", "clip_name"), "clip_type": choices("CLIPLoader", "type"),
            "vae": choices("VAELoader", "vae_name"), "loras": choices("LoraLoader", "lora_name"), "rgthree": "Power Lora Loader (rgthree)" in info,
            "vision_models": choices("LCVisionLoader", "model_name"),
            "prompt_lists": info.get("MuseMossSheetDesigner", {}).get("input", {}).get("optional", {}).get("prompt_list", [[]])[0],
            # Default LCVisionLoader inputs, to start the server's vision config from.
            "vision_defaults": {k: (v[1] or {}).get("default", v[0][0] if isinstance(v[0], list) and v[0] else None) for k, v in vision.items()}}


@app.get("/api/servers/{sid}/lora_catalog")
async def lora_catalog(sid: int):
    """ComfyUI-Lora-Manager's index on the server, keyed by LoRA name with / separators: title, base model, preview, tags. Empty without it."""
    with db.connect() as conn:
        server = one(conn, "SELECT * FROM server WHERE id = ?", sid)
    items, page, pages = [], 1, 1
    try:
        while page <= pages:  # The list is capped at 100 per page.
            d = (await comfy.get(server, "/api/lm/loras/list", page=page, page_size=100)).json()
            items += d["items"]
            pages, page = d["total_pages"], page + 1
    except (httpx.HTTPError, ValueError, KeyError):
        return {}
    return {"/".join(filter(None, [i["folder"].replace("\\", "/"), i["file_path"].replace("\\", "/").rsplit("/", 1)[-1]])):
            {"title": i["model_name"], "base": i["base_model"], "tags": i["tags"], "preview": server["url"] + i["preview_url"] if i["preview_url"] else ""}
            for i in items}


async def rgthree_info(server, file, refresh=False):
    """rgthree's info for a LoRA on one server (None if the server lacks the file), with core ComfyUI's preview image first.
    file may use either path separator. refresh has rgthree fetch missing Civitai data, which it saves next to the LoRA."""
    entry = next((m for m in (await comfy.get(server, "/experiment/models/loras")).json() if m["name"].replace("\\", "/") == file.replace("\\", "/")), None)
    if entry is None:
        return None
    name = entry["name"]
    async with httpx.AsyncClient(base_url=server["url"], timeout=120) as client:
        r = await client.get("/rgthree/api/loras/info/refresh" if refresh else "/rgthree/api/loras/info", params={"files": name, "light": 0})
        r.raise_for_status()
    info = r.json()["data"][0]
    info["clipSkip"] = info.pop("raw", {}).get("metadata", {}).get("ss_clip_skip")
    info["trainedWords"] = [w for w in info.get("trainedWords", []) if w["word"].strip()]
    # rgthree's own preview route only serves .jpg/.png; core ComfyUI's also serves .webp and previews embedded in the file.
    info["images"] = [{"url": f"{server['url']}/experiment/models/preview/loras/{entry['pathIndex']}/{quote(name)}", "preview": True}] + \
                     [i for i in info.get("images", []) if not i.get("url", "").startswith("/")]
    info["server_id"], info["file"] = server["id"], name
    return info


@app.get("/api/servers/{sid}/lora_info")
async def lora_info(sid: int, file: str, refresh: bool = False):
    """rgthree's info for one LoRA. refresh runs on a server marked as able to reach Civitai (this one if it is).
    A server whose copy has no Civitai data (local keeps its own copies) shows the Civitai server's info instead.
    server_id and file in the result name where the info lives, for saving edits."""
    with db.connect() as conn:
        server = one(conn, "SELECT * FROM server WHERE id = ?", sid)
        via = db.row(conn.execute("SELECT * FROM server WHERE civitai = 1 ORDER BY id = ? DESC LIMIT 1", (sid,)).fetchone())
    if refresh and via is None:
        raise HTTPException(400, "No server is marked 'can reach Civitai' on the Servers page.")
    try:
        info = await rgthree_info(via, file, True) if refresh else await rgthree_info(server, file)
        if not refresh and via and via["id"] != sid and not (info or {}).get("links"):
            info = await rgthree_info(via, file) or info
    except httpx.HTTPError as error:
        raise HTTPException(502, f"rgthree-comfy info not available: {error}")
    if info is None:
        raise HTTPException(404, f"{file} not found")
    return info


@app.post("/api/servers/{sid}/lora_info")
async def save_lora_info(sid: int, data: dict):
    """Save edited fields ({file, fields}) into rgthree's info file through the server the info came from."""
    with db.connect() as conn:
        server = one(conn, "SELECT * FROM server WHERE id = ?", sid)
    async with httpx.AsyncClient(base_url=server["url"], timeout=30) as client:
        r = await client.post("/rgthree/api/loras/info", params={"file": data["file"]}, data={"json": json.dumps(data["fields"])})
        r.raise_for_status()


# Jobs

@app.post("/api/jobs")
async def create_job(data: dict):
    if data["kind"] not in ("sheet", "caption", "restyle"):
        raise HTTPException(400, "kind must be sheet, caption or restyle")
    with db.connect() as conn:
        jid = db.write(conn, "job", pick(data, {"kind", "server_id", "character_id", "outfit_id", "params"}))
    task = asyncio.get_running_loop().create_task(comfy.run_job(jid, data["kind"]))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return {"id": jid}


@app.get("/api/jobs")
def jobs(character_id: int | None = None, limit: int = 50):
    with db.connect() as conn:
        sql = "SELECT * FROM job" + (" WHERE character_id = ?" if character_id else "") + " ORDER BY id DESC LIMIT ?"
        return db.rows(conn.execute(sql, (character_id, limit) if character_id else (limit,)))


@app.get("/api/jobs/{jid}")
def job(jid: int):
    with db.connect() as conn:
        return one(conn, "SELECT * FROM job WHERE id = ?", jid)


# Datasets

@app.get("/api/datasets")
def datasets():
    with db.connect() as conn:
        return db.rows(conn.execute("SELECT d.*, (SELECT COUNT(*) FROM dataset_item i WHERE i.dataset_id = d.id) AS size FROM dataset d ORDER BY d.id DESC"))


@app.post("/api/datasets")
def create_dataset(data: dict):
    with db.connect() as conn:
        return {"id": db.write(conn, "dataset", pick(data, {"name", "character_id", "trigger"}))}


@app.get("/api/datasets/{did}")
def dataset(did: int):
    with db.connect() as conn:
        d = one(conn, "SELECT * FROM dataset WHERE id = ?", did)
        d["items"] = db.rows(conn.execute("""
            SELECT a.id, a.path, a.kind, a.view_id, a.width, a.height, i.caption AS override, cap.text AS caption FROM dataset_item i
            JOIN asset a ON a.id = i.asset_id LEFT JOIN caption cap ON cap.asset_id = a.id AND cap.is_current = 1
            WHERE i.dataset_id = ? ORDER BY a.id""", (did,)))
        return d


@app.put("/api/datasets/{did}")
def update_dataset(did: int, data: dict):
    with db.connect() as conn:
        db.write(conn, "dataset", pick(data, {"name", "trigger", "character_id"}), did)


@app.post("/api/datasets/{did}/items")
def dataset_items(did: int, data: dict):
    with db.connect() as conn:
        if data.get("remove"):
            conn.executemany("DELETE FROM dataset_item WHERE dataset_id = ? AND asset_id = ?", [(did, a) for a in data["asset_ids"]])
        else:
            conn.executemany("INSERT OR IGNORE INTO dataset_item (dataset_id, asset_id) VALUES (?, ?)", [(did, a) for a in data["asset_ids"]])


@app.put("/api/datasets/{did}/items/{aid}")
def dataset_item_caption(did: int, aid: int, data: dict):
    with db.connect() as conn:
        conn.execute("UPDATE dataset_item SET caption = ? WHERE dataset_id = ? AND asset_id = ?", (data.get("caption") or None, did, aid))


@app.post("/api/datasets/{did}/export")
def export_dataset(did: int, data: dict):
    with db.connect() as conn:
        folder, count = library.export_dataset(conn, did, data["target"])
    return {"folder": folder, "count": count}


WEB_DIST = Path(__file__).resolve().parent.parent / "web" / "dist"
if WEB_DIST.is_dir():
    app.mount("/", StaticFiles(directory=WEB_DIST, html=True), name="web")
