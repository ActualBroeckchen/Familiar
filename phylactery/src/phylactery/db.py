"""SQLite connection + migration management for Phylactery.

One DB file at phylactery/data/phylactery.db. sqlite-vec extension is
loaded on every connection before migrations run, so vec0 virtual tables
are always accessible. WAL mode + busy_timeout for robustness.
"""

from __future__ import annotations

import re
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

DB_FILENAME = "phylactery.db"
MIGRATIONS_DIR = Path(__file__).parent / "migrations"


def default_db_path() -> Path:
    return Path(__file__).resolve().parent.parent.parent / "data" / DB_FILENAME


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_id() -> str:
    return uuid.uuid4().hex


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
