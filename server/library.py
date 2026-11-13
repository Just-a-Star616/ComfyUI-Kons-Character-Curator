import hashlib
import io
import json
import os
import re
import shutil
import subprocess
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image

from . import db

ASSETS = db.DATA / "assets"
THUMBS = db.DATA / "thumbs"
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}
SKIP_DIRS = {"__pycache__", "thumbs", "cfz_conditioning_cache", "node_modules", ".git"}
# Folders holding reference/input images (Input, Downloaded, downloads, ...): their images are kind 'source'.
SOURCE_DIRS = {"input", "inputs", "download", "downloads", "downloaded", "source", "sources", "reference", "references", "refs"}
LEET = str.maketrans("5103478", "sioeatb")


def pixel_hash(image):
    # Hash pixels, not file bytes: ComfyUI re-saves identical images with new metadata, and datasets get copied around.
    return hashlib.sha1(image.convert("RGBA").tobytes()).hexdigest()


def dhash(image):
    """256-bit difference hash (32 bytes). 64 bits cannot tell apart different poses of one figure on a white background."""
    px = np.asarray(image.convert("L").resize((17, 16), Image.Resampling.LANCZOS), dtype=np.int16)
    return np.packbits(px[:, 1:] > px[:, :-1]).tobytes()


def make_thumb(image, sha1):
    path = THUMBS / sha1[:2] / f"{sha1}.webp"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        t = image.convert("RGB")
        t.thumbnail((384, 384))
        t.save(path, quality=80)


def file_path(asset):
    return Path(asset["path"]) if os.path.isabs(asset["path"]) else db.DATA / asset["path"]


def store(conn, data, **fields):
    """Save image bytes content-addressed and add an asset row. Returns the asset id."""
    image = Image.open(io.BytesIO(data))
    sha1 = pixel_hash(image)
    existing = conn.execute("SELECT id FROM asset WHERE sha1 = ?", (sha1,)).fetchone()
    if existing:
        return existing["id"]
    path = ASSETS / sha1[:2] / f"{sha1}.png"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        if image.format == "PNG":
            path.write_bytes(data)
        else:
            image.save(path)
    make_thumb(image, sha1)
    return db.write(conn, "asset", {"sha1": sha1, "path": str(path.relative_to(db.DATA)), "width": image.width, "height": image.height, "phash": dhash(image), **fields})


def png_prompt(info):
    """Recover prompt/seed from a ComfyUI-saved PNG's info (API graph in the 'prompt' text chunk)."""
    try:
        graph = json.loads(info.get("prompt", ""))
    except (ValueError, TypeError):
        return {}
    for node in graph.values():
        if node.get("class_type") == "MuseMossSheetDesigner":
            inputs = node["inputs"]
            if not isinstance(inputs, dict):
                continue
            return {"prompt": inputs.get("prompt", "") if isinstance(inputs.get("prompt"), str) else "", "seed": inputs.get("seed") if isinstance(inputs.get("seed"), int) else None}
    if not isinstance(graph, dict):
        return {}
    texts = [n["inputs"]["text"] for n in graph.values() if isinstance(n, dict) and n.get("class_type") == "CLIPTextEncode" and isinstance(n.get("inputs", {}).get("text"), str)]
    return {"prompt": texts[0]} if texts else {}


def norm(name):
    return re.sub(r"[^a-z0-9]", "", name.lower().translate(LEET))


def alias_map(conn):
    out = {}
    for c in db.rows(conn.execute("SELECT id, name, trigger, aliases FROM character")):
        for a in (c["name"], c["trigger"], *c["aliases"]):
            if len(norm(a)) >= 3:
                out.setdefault(norm(a), c["id"])
    return out


def match_character(aliases, parts):
    """First path segment, or a token in it, that names a known character (leetspeak-insensitive)."""
    for part in parts:
        if norm(part) in aliases:
            return aliases[norm(part)]
        for token in re.split(r"[^A-Za-z0-9]+", part):
            if len(token) >= 3 and norm(token) in aliases:
                return aliases[norm(token)]
    return None


def path_parts(parts):
    """Folders, then the file name without extension or ComfyUI's _00001_ counter."""
    return [*parts[:-1], re.sub(r"_?\d+_?$", "", Path(parts[-1]).stem)]


def rematch(conn):
    """Assign unassigned images whose on-disk paths name a known character (after adding aliases or characters)."""
    aliases, matched = alias_map(conn), 0
    for r in conn.execute("SELECT a.id, f.path FROM asset a JOIN asset_file f ON f.asset_id = a.id WHERE a.character_id IS NULL").fetchall():
        character_id = match_character(aliases, path_parts(Path(r["path"]).parts))
        if character_id:
            matched += conn.execute("UPDATE asset SET character_id = ? WHERE id = ? AND character_id IS NULL", (character_id, r["id"])).rowcount
    return matched


def is_source(parts):
    return any(p.lower() in SOURCE_DIRS for p in parts[:-1])


def mark_sources(conn):
    """Set kind 'source' on imported images that have a copy in a source folder."""
    ids = {r["asset_id"] for r in conn.execute("SELECT f.asset_id, f.path FROM asset_file f JOIN asset a ON a.id = f.asset_id WHERE a.kind = 'import'")
           if is_source(Path(r["path"]).parts)}
    conn.executemany("UPDATE asset SET kind = 'source' WHERE id = ?", [(i,) for i in ids])
    return len(ids)


def _probe(path):
    try:
        with Image.open(path) as image:
            image.load()
            sha1 = pixel_hash(image)
            make_thumb(image, sha1)
            return {"sha1": sha1, "width": image.width, "height": image.height, "phash": dhash(image), **png_prompt(image.info)}
    except Exception as error:  # Corrupt or truncated files are reported and skipped, not fatal to a 40k-image scan.
        return {"error": f"{path}: {error}"}


def scan(root, per_character_folders, progress):
    """Index every image under root in place. per_character_folders: each top-level folder is a character
    (created when no existing character matches its name). Returns counts."""
    root = Path(root).expanduser()
    conn = db.connect()
    known = {r["path"]: r["mtime"] for r in conn.execute("SELECT path, mtime FROM asset_file")}
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        for f in sorted(filenames):
            p = os.path.join(dirpath, f)
            if os.path.splitext(f)[1].lower() in IMAGE_EXTS and known.get(p) != os.path.getmtime(p):
                files.append(p)
    counts = {"total": len(files), "done": 0, "added": 0, "duplicates": 0, "errors": []}
    progress(counts)
    aliases = alias_map(conn)
    with ProcessPoolExecutor(max(1, (os.cpu_count() or 2) // 2)) as pool:
        for path, info in zip(files, pool.map(_probe, files, chunksize=16)):
            counts["done"] += 1
            if "error" in info:
                counts["errors"].append(info["error"])
            else:
                parts = Path(path).relative_to(root).parts
                character_id = match_character(aliases, path_parts(parts) if not per_character_folders else parts[:1])
                if per_character_folders and character_id is None and len(parts) > 1:
                    character_id = db.write(conn, "character", {"name": parts[0]})
                    aliases[norm(parts[0])] = character_id
                existing = conn.execute("SELECT id FROM asset WHERE sha1 = ?", (info["sha1"],)).fetchone()
                if existing:
                    asset_id = existing["id"]
                    counts["duplicates"] += 1
                    if character_id:
                        conn.execute("UPDATE asset SET character_id = ? WHERE id = ? AND character_id IS NULL", (character_id, asset_id))
                    if is_source(parts):
                        conn.execute("UPDATE asset SET kind = 'source' WHERE id = ? AND kind = 'import'", (asset_id,))
                else:
                    rejected = any(p == "_rejected" or p.endswith("_removed") for p in parts[:-1])
                    asset_id = db.write(conn, "asset", {"sha1": info["sha1"], "path": path, "width": info["width"], "height": info["height"], "kind": "source" if is_source(parts) else "import",
                                                         "character_id": character_id, "prompt": info.get("prompt", ""), "seed": info.get("seed"), "phash": info["phash"],
                                                         "rating": "fail" if rejected else None})
                    counts["added"] += 1
                conn.execute("INSERT OR REPLACE INTO asset_file (path, asset_id, mtime) VALUES (?, ?, ?)", (path, asset_id, os.path.getmtime(path)))
                sidecar = Path(path).with_suffix(".txt")
                if sidecar.exists():
                    text = sidecar.read_text(encoding="utf-8", errors="replace").strip()
                    if text and not conn.execute("SELECT 1 FROM caption WHERE asset_id = ? AND text = ?", (asset_id, text)).fetchone():
                        db.set_caption(conn, asset_id, "file", text)
            if counts["done"] % 200 == 0:
                conn.commit()
                progress(counts)
    conn.commit()
    conn.close()
    progress(counts)
    return counts


def import_presets(conn, path):
    """Muse MOSS Sheet Designer presets: {'characters': {...}, 'outfits': {...}} or the older flat character dict."""
    presets = json.loads(Path(path).expanduser().read_text(encoding="utf-8"))
    if "characters" not in presets:
        presets = {"characters": presets, "outfits": {k: {"outfit": v["outfit"]} for k, v in presets.items() if v.get("outfit")}}
    for name, p in presets["characters"].items():
        conn.execute("INSERT OR IGNORE INTO character (name, description, body_details, nsfw_details, state_json) VALUES (?, ?, ?, ?, ?)",
                     (name, p.get("prompt", ""), p.get("body_details", ""), p.get("nsfw_details", ""), p.get("state_json", "")))
    for name, p in presets["outfits"].items():
        owner = conn.execute("SELECT id FROM character WHERE name = ?", (name,)).fetchone()
        if not conn.execute("SELECT 1 FROM outfit WHERE name = ? AND character_id IS ?", (name, owner and owner["id"])).fetchone():
            conn.execute("INSERT INTO outfit (character_id, name, text) VALUES (?, ?, ?)", (owner and owner["id"], name, p["outfit"]))
    return len(presets["characters"]), len(presets["outfits"])


def _thumb_hash(sha1):
    with Image.open(THUMBS / sha1[:2] / f"{sha1}.webp") as image:
        return dhash(image)


def backfill_phash(conn):
    """Hash assets indexed before phash existed, from their thumbnails."""
    missing = conn.execute("SELECT id, sha1 FROM asset WHERE phash IS NULL OR typeof(phash) != 'blob'").fetchall()
    if missing:
        with ProcessPoolExecutor(max(1, (os.cpu_count() or 2) // 2)) as pool:
            hashes = list(pool.map(_thumb_hash, [r["sha1"] for r in missing], chunksize=64))
        conn.executemany("UPDATE asset SET phash = ? WHERE id = ?", [(h, r["id"]) for h, r in zip(hashes, missing)])
        conn.commit()


def near_duplicates(conn, threshold, character_id=None, limit=100):
    """Groups of visually near-identical images (Hamming distance of the 256-bit dHash <= threshold), minus pairs marked not-duplicate."""
    backfill_phash(conn)
    sql = "SELECT id, phash FROM asset WHERE hidden = 0" + (" AND character_id = ?" if character_id else "")
    rows = conn.execute(sql, (character_id,) if character_id else ()).fetchall()
    if len(rows) < 2:
        return []
    ids = np.array([r["id"] for r in rows])
    hashes = np.frombuffer(b"".join(r["phash"] for r in rows), dtype=np.uint64).reshape(-1, 4)
    ignored = {(r["a"], r["b"]) for r in conn.execute("SELECT a, b FROM dup_ignore")}
    # Pivot clustering: every member is within threshold of the group's first image (no A~B~C chaining).
    taken = np.zeros(len(rows), dtype=bool)
    groups = []
    for i in range(len(rows) - 1):
        if taken[i]:
            continue
        close = np.nonzero((np.bitwise_count(np.bitwise_xor(hashes[i + 1:], hashes[i])).sum(axis=1) <= threshold) & ~taken[i + 1:])[0] + i + 1
        members = [int(j) for j in close if tuple(sorted((int(ids[i]), int(ids[j])))) not in ignored]
        if members:
            taken[members] = True
            taken[i] = True
            groups.append([int(ids[i])] + [int(ids[j]) for j in members])
    return sorted(groups, key=len, reverse=True)[:limit]


def trash(path):
    """Move a file to the desktop Trash (recoverable). Missing files are ignored."""
    if os.path.exists(path):
        subprocess.run(["gio", "trash", path], check=True)


def delete_asset(conn, asset_id):
    """Trash every on-disk copy of an asset and remove it from the catalogue."""
    a = conn.execute("SELECT path, sha1 FROM asset WHERE id = ?", (asset_id,)).fetchone()
    if a is None:
        return
    for path in {str(file_path(a)), *(r["path"] for r in conn.execute("SELECT path FROM asset_file WHERE asset_id = ?", (asset_id,)))}:
        trash(path)
    conn.execute("DELETE FROM asset WHERE id = ?", (asset_id,))
    (THUMBS / a["sha1"][:2] / f"{a['sha1']}.webp").unlink(missing_ok=True)


def delete_copy(conn, asset_id, path):
    """Trash one on-disk copy; the asset survives while another copy remains."""
    if not conn.execute("SELECT 1 FROM asset_file WHERE asset_id = ? AND path = ?", (asset_id, path)).fetchone():
        raise ValueError("not a file of this asset")
    remaining = [r["path"] for r in conn.execute("SELECT path FROM asset_file WHERE asset_id = ? AND path != ?", (asset_id, path))]
    if not remaining:
        return delete_asset(conn, asset_id)
    trash(path)
    conn.execute("DELETE FROM asset_file WHERE path = ?", (path,))
    conn.execute("UPDATE asset SET path = ? WHERE id = ? AND path = ?", (remaining[0], asset_id, path))


def current_caption(conn, asset_id):
    r = conn.execute("SELECT text FROM caption WHERE asset_id = ? AND is_current = 1", (asset_id,)).fetchone()
    return r["text"] if r else ""


def clean_caption(text):
    """Drop what Qwen3 echoes back: the /no_think switch and 'Trigger word: ...' lines."""
    lines = [l for l in text.splitlines() if not re.fullmatch(r"\s*((\w+ )?trigger( word)?\s*:.*|/?no_think)\s*", l, re.I)]
    return re.sub(r"\s*/?no_think\s*$", "", "\n".join(lines).strip())


def export_dataset(conn, dataset_id, target):
    """kohya / ai-toolkit layout: img_###.png + img_###.txt, trigger word first ([trigger], AI-Toolkit's placeholder, when unset)."""
    ds = conn.execute("SELECT * FROM dataset WHERE id = ?", (dataset_id,)).fetchone()
    out = Path(target).expanduser() / ds["name"]
    out.mkdir(parents=True, exist_ok=True)
    items = conn.execute("SELECT a.id, a.path, i.caption FROM dataset_item i JOIN asset a ON a.id = i.asset_id WHERE i.dataset_id = ? ORDER BY a.id", (dataset_id,)).fetchall()
    for n, item in enumerate(items, 1):
        caption = (item["caption"] or current_caption(conn, item["id"])).strip()
        trigger = ds["trigger"].strip() or "[trigger]"
        if trigger and not caption.startswith(trigger):
            caption = f"{trigger}, {caption}" if caption else trigger
        shutil.copyfile(file_path(item), out / f"img_{n:03d}.png")
        (out / f"img_{n:03d}.txt").write_text(caption + "\n", encoding="utf-8")
    return str(out), len(items)
