"""Machine-specific settings, read from config.json at the repo root (start from config.example.json). config.json is not committed."""
import json
from pathlib import Path

FILE = Path(__file__).resolve().parent.parent / "config.json"
DEFAULTS = {"servers": [{"name": "local", "url": "http://127.0.0.1:8188"}], "presets_path": "", "scan_roots": [], "export_dir": ""}
CONFIG = {**DEFAULTS, **(json.loads(FILE.read_text()) if FILE.exists() else {})}
