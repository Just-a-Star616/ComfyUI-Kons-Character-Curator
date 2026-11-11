import json
import sqlite3
from pathlib import Path

from .config import CONFIG

DATA = Path(__file__).resolve().parent.parent / "data"
DB_PATH = DATA / "catalogue.sqlite"

SCHEMA = """
CREATE TABLE IF NOT EXISTS character (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, trigger TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '', body_details TEXT NOT NULL DEFAULT '', nsfw_details TEXT NOT NULL DEFAULT '',
  state_json TEXT NOT NULL DEFAULT '', aliases TEXT NOT NULL DEFAULT '[]', franchise TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '', cover_id INTEGER, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS outfit (
  id INTEGER PRIMARY KEY, character_id INTEGER REFERENCES character(id) ON DELETE CASCADE,
  name TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', footwear TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
  UNIQUE(character_id, name));
-- kind: source|import|view|sheet|template|list_image|edit; path is relative to data/ for stored files, absolute for indexed ones; multiview|mesh|rig are reserved for the 3D stage.
CREATE TABLE IF NOT EXISTS asset (
  id INTEGER PRIMARY KEY, sha1 TEXT NOT NULL, path TEXT NOT NULL, width INTEGER, height INTEGER, kind TEXT NOT NULL,
  view_id TEXT NOT NULL DEFAULT '', character_id INTEGER REFERENCES character(id) ON DELETE SET NULL,
  outfit_id INTEGER REFERENCES outfit(id) ON DELETE SET NULL, parent_id INTEGER REFERENCES asset(id) ON DELETE SET NULL,
  job_id INTEGER REFERENCES job(id) ON DELETE SET NULL, prompt TEXT NOT NULL DEFAULT '', seed INTEGER,
  rating TEXT CHECK (rating IN ('pass', 'fail')), favorite INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]', phash BLOB, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS asset_character ON asset(character_id);
-- Every place a copy of an asset's image exists on disk (imports index in place; duplicates collapse into one asset).
CREATE TABLE IF NOT EXISTS asset_file (
  path TEXT PRIMARY KEY, asset_id INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE, mtime REAL NOT NULL);
CREATE INDEX IF NOT EXISTS asset_file_asset ON asset_file(asset_id);
CREATE TABLE IF NOT EXISTS caption (
  id INTEGER PRIMARY KEY, asset_id INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  source TEXT NOT NULL, text TEXT NOT NULL, is_current INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS caption_asset ON caption(asset_id);
CREATE TABLE IF NOT EXISTS server (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, url TEXT NOT NULL, models TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS job (
  id INTEGER PRIMARY KEY, server_id INTEGER REFERENCES server(id), comfy_prompt_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL, character_id INTEGER REFERENCES character(id) ON DELETE SET NULL, outfit_id INTEGER,
  params TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'queued', error TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT '{}', created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
-- Image pairs a person confirmed are not duplicates (a < b).
CREATE TABLE IF NOT EXISTS dup_ignore (a INTEGER NOT NULL, b INTEGER NOT NULL, PRIMARY KEY (a, b));
CREATE TABLE IF NOT EXISTS dataset (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, character_id INTEGER REFERENCES character(id) ON DELETE SET NULL,
  trigger TEXT NOT NULL DEFAULT '', created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS dataset_item (
  dataset_id INTEGER NOT NULL REFERENCES dataset(id) ON DELETE CASCADE, asset_id INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  caption TEXT, PRIMARY KEY (dataset_id, asset_id));
"""

DEFAULT_MODELS = {"unet": "flux-2-klein-9b-kv-fp8.safetensors", "clip": "qwen_3_8b_fp8mixed.safetensors", "clip_type": "flux2",
                  "vae": "flux2-vae.safetensors", "steps": 4, "cfg": 1.0, "vision": {}}


# Columns added after the first release; init() adds them to existing databases.
ADDED_COLUMNS = (("character", "cover_id", "INTEGER"), ("asset", "phash", "BLOB"), ("asset", "style", "TEXT"), ("asset", "loras", "TEXT"), ("server", "civitai", "INTEGER NOT NULL DEFAULT 0"))


def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init():
    DATA.mkdir(exist_ok=True)
    with connect() as conn:
        conn.executescript(SCHEMA)
        for table, column, decl in ADDED_COLUMNS:
            if column not in [r[1] for r in conn.execute(f"PRAGMA table_info({table})")]:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
        conn.executemany("INSERT OR IGNORE INTO server (name, url, models) VALUES (?, ?, ?)",
                         [(s["name"], s["url"], json.dumps(DEFAULT_MODELS)) for s in CONFIG["servers"]])


JSON_COLUMNS = ("tags", "aliases", "models", "params", "result", "loras")


def row(r):
    if r is None:
        return None
    d = dict(r)
    d.pop("phash", None)  # Binary, internal to duplicate search.
    for k in JSON_COLUMNS:
        if d.get(k) is not None:
            d[k] = json.loads(d[k])
    return d


def rows(cursor):
    return [row(r) for r in cursor]


def write(conn, table, data, id=None):
    """Insert (id None) or update a row from a dict; JSON columns are encoded. Returns the row id."""
    data = {k: json.dumps(v) if k in JSON_COLUMNS else v for k, v in data.items()}
    if id is None:
        cur = conn.execute(f"INSERT INTO {table} ({', '.join(data)}) VALUES ({', '.join('?' * len(data))})", tuple(data.values()))
        return cur.lastrowid
    if data:
        conn.execute(f"UPDATE {table} SET {', '.join(f'{k} = ?' for k in data)} WHERE id = ?", (*data.values(), id))
    return id


def set_caption(conn, asset_id, source, text):
    conn.execute("UPDATE caption SET is_current = 0 WHERE asset_id = ?", (asset_id,))
    conn.execute("INSERT INTO caption (asset_id, source, text) VALUES (?, ?, ?)", (asset_id, source, text))
