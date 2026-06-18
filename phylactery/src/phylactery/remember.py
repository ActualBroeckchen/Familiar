"""Remember-consent map — governs how the ward's information is stored.

Stored as a JSON file alongside the Phylactery database so it survives
across DB snapshots and is directly observable on disk.

Map values: true → store freely, false → never store (drop silently),
"ask" → store as consent_pending and surface for confirmation.

Default: basics=true (safe to remember basic facts), everything else "ask"
(never silently discard — surfacing for consent is always preferable to
losing information the Familiar should have but wasn't allowed to keep).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

CATEGORIES = ("basics", "emotional_content", "health_info", "relationships", "whereabouts")
VALID_VALUES = (True, False, "ask")

DEFAULT_MAP: dict[str, Any] = {
    "basics":           True,
    "emotional_content": "ask",
    "health_info":       "ask",
    "relationships":     "ask",
    "whereabouts":       "ask",
}


def _map_path() -> Path:
    from phylactery.db import default_db_path
    return default_db_path().parent / "remember_map.json"


def get() -> dict[str, Any]:
    """Return the current remember map, filling any missing categories with defaults."""
    result = dict(DEFAULT_MAP)
    path = _map_path()
    if not path.exists():
        return result
    try:
        stored = json.loads(path.read_text(encoding="utf-8"))
        for cat in CATEGORIES:
            if cat in stored and stored[cat] in VALID_VALUES:
                result[cat] = stored[cat]
    except Exception:
        pass  # corrupt file → use defaults rather than failing
    return result


def set_map(new_map: dict[str, Any]) -> dict[str, Any]:
    """Validate and persist a new remember map.

    Only recognised categories are written. Unrecognised keys are rejected.
    Returns {"ok": True, "map": ...} or {"ok": False, "errors": [...]}.
    """
    errors: list[str] = []
    result = dict(DEFAULT_MAP)
    for k, v in new_map.items():
        if k not in CATEGORIES:
            errors.append(f"unknown category: {k!r}")
            continue
        if v not in VALID_VALUES:
            errors.append(f"invalid value for {k!r}: {v!r} — must be true/false/ask")
            continue
        result[k] = v
    if errors:
        return {"ok": False, "errors": errors}
    path = _map_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return {"ok": True, "map": result}
