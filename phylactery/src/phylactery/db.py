"""SQLite connection + migration management for Phylactery.

One DB file at phylactery/data/phylactery.db. sqlite-vec extension is
loaded on every connection before migrations run, so vec0 virtual tables
are always accessible. WAL mode + busy_timeout for robustness.
"""

from __future__ import annotations

import os
import re
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

DB_FILENAME = "phylactery.db"
MIGRATIONS_DIR = Path(__file__).parent / "migrations"


def default_db_path() -> Path:
    # PHYLACTERY_DB_PATH relocates the store for the whole server process (the
    # cross-process smoke test uses it to isolate its writes to a temp file;
    # also lets an install point at an external data dir). Unset → canonical
    # <phylactery-root>/data/phylactery.db.
    override = os.environ.get("PHYLACTERY_DB_PATH")
    if override:
        return Path(override)
    return Path(__file__).resolve().parent.parent.parent / "data" / DB_FILENAME


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_id() -> str:
    return uuid.uuid4().hex


# ── Readable ids (the 0.8.x id overhaul; mirrors unruh/db.py) ────────────
# Model-facing ids (graph nodes/edges) are label-derived slugs with a short
# random suffix — "sister-mira-k3" — instead of uuid4 hex: ~3 tokens in a
# legend line instead of ~16, self-documenting in tool calls. Writers retry
# on a PK collision; old hex ids stay valid (ids are opaque TEXT).

_SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"  # no 0/O/1/l/i lookalikes
_SLUG_MAX_LABEL = 20


def _slugify(label: str) -> str:
    out: list[str] = []
    prev_dash = True
    for ch in (label or "").lower():
        if ch.isascii() and ch.isalnum():
            out.append(ch)
            prev_dash = False
        elif not prev_dash:
            out.append("-")
            prev_dash = True
    slug = "".join(out).strip("-")
    if len(slug) > _SLUG_MAX_LABEL:
        cut = slug[:_SLUG_MAX_LABEL]
        slug = cut[: cut.rfind("-")] if "-" in cut else cut
    return slug


def slug_id(label: str | None = None, *, kind: str = "node", suffix_len: int = 2) -> str:
    import secrets
    base = _slugify(label or "")
    if not base:
        base = _slugify(kind) or "id"
        suffix_len = max(suffix_len, 4)
    suffix = "".join(secrets.choice(_SLUG_ALPHABET) for _ in range(suffix_len))
    return f"{base}-{suffix}"


def insert_with_slug_retry(conn, sql: str, args_for_id, *, label: str | None = None, kind: str = "node") -> str:
    """INSERT whose first parameter is the id; slug id with retry-on-collision
    (suffix grows), uuid4 as the final fallback. Returns the id that stuck."""
    for suffix_len in (2, 3, 5):
        candidate = slug_id(label, kind=kind, suffix_len=suffix_len)
        try:
            conn.execute(sql, args_for_id(candidate))
            return candidate
        except sqlite3.IntegrityError as e:
            if "UNIQUE" not in str(e) and "PRIMARY KEY" not in str(e):
                raise
    fallback = new_id()
    conn.execute(sql, args_for_id(fallback))
    return fallback


def get_conn(db_path: Path | None = None) -> sqlite3.Connection:
    path = db_path or default_db_path()
    path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(str(path), timeout=10.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA foreign_keys = ON")

    # Load sqlite-vec before migrations so vec0 virtual tables can be created.
    try:
        import sqlite_vec
        conn.enable_load_extension(True)
        sqlite_vec.load(conn)
        conn.enable_load_extension(False)
    except Exception as e:
        # Degrade gracefully if sqlite-vec isn't installed yet (e.g. during
        # uv sync). Vector search won't work but the service can still start.
        import sys
        print(f"[phylactery] sqlite-vec unavailable: {e} — vector search disabled", file=sys.stderr)

    run_migrations(conn)
    return conn


def _current_version(conn: sqlite3.Connection) -> int:
    try:
        row = conn.execute(
            "SELECT value FROM meta WHERE key = 'schema_version'"
        ).fetchone()
    except sqlite3.OperationalError:
        return 0
    return int(row["value"]) if row else 0


_MIGRATION_NAME = re.compile(r"^(\d{4})_[\w\-]+\.sql$")


def _pending_migrations(current: int) -> list[tuple[int, Path]]:
    pending: list[tuple[int, Path]] = []
    for f in sorted(MIGRATIONS_DIR.glob("*.sql")):
        m = _MIGRATION_NAME.match(f.name)
        if not m:
            continue
        n = int(m.group(1))
        if n > current:
            pending.append((n, f))
    return pending


def run_migrations(conn: sqlite3.Connection) -> None:
    current = _current_version(conn)
    for version, path in _pending_migrations(current):
        sql = path.read_text(encoding="utf-8")
        conn.executescript(sql)
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)",
            (str(version),),
        )
        conn.commit()
