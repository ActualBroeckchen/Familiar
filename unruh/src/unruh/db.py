"""SQLite connection + migration management for Unruh.

One DB file per Unruh install at `unruh/data/unruh.db`. WAL mode
+ a generous busy_timeout cover the case where two Unruh processes
race (the launchers go to lengths to prevent that, but the
prevention isn't bulletproof; cf. Cross-cutting concerns §10 in
docs/unruh-implementation-plan.md).

Migrations are plain `.sql` files in `migrations/`, named
`NNNN_description.sql`. The current schema version is stored in
`meta.schema_version`. On every connect, any migration with a
number > current version is applied in order inside a transaction.
Idempotent (CREATE IF NOT EXISTS etc.) so partial application
doesn't wedge the DB.
"""

from __future__ import annotations

import re
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

DB_FILENAME = "unruh.db"
MIGRATIONS_DIR = Path(__file__).parent / "migrations"


def default_db_path() -> Path:
    """Resolve the canonical DB path: <package-parent>/data/unruh.db.

    Layout: src/unruh/db.py → src/unruh → src → <unruh-root>/data/unruh.db.
    Override at call time by passing an explicit path to `get_conn`.
    """
    return Path(__file__).resolve().parent.parent.parent / "data" / DB_FILENAME


def now_iso() -> str:
    """UTC ISO-8601 to the second. Single source of 'now' across the
    codebase so timestamps round-trip cleanly through the formatter."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_id() -> str:
    """Generate an opaque node/edge id. UUID4 — short enough to print
    in prompts, long enough to never collide in practice."""
    return uuid.uuid4().hex


def get_conn(db_path: Path | None = None) -> sqlite3.Connection:
    """Open a connection, configure pragmas, apply pending migrations.

    Uses Python's deferred-transaction mode (the sqlite3 default) so
    the standard `with conn:` context manager wraps each block in a
    transaction — commit on clean exit, rollback on exception. That
    matters for multi-write operations like seed_today(): a crash
    halfway through used to leave half a routine in the DB; now it
    rolls back cleanly.

    Returns a connection with row_factory = sqlite3.Row so callers can
    treat rows as dicts.
    """
    path = db_path or default_db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=10.0)
    conn.row_factory = sqlite3.Row
    # WAL: readers don't block writers, safer for the rare multi-process case.
    conn.execute("PRAGMA journal_mode = WAL")
    # If two writers do race, wait up to 5s before giving up.
    conn.execute("PRAGMA busy_timeout = 5000")
    # Enforce ON DELETE CASCADE on edges when a node is deleted.
    conn.execute("PRAGMA foreign_keys = ON")
    run_migrations(conn)
    return conn


def _current_version(conn: sqlite3.Connection) -> int:
    """Read meta.schema_version, returning 0 if the table or row is
    missing (i.e. fresh DB). Wrapped in try/except because the very
    first connect runs before meta exists."""
    try:
        row = conn.execute(
            "SELECT value FROM meta WHERE key = 'schema_version'"
        ).fetchone()
    except sqlite3.OperationalError:
        return 0
    return int(row["value"]) if row else 0


_MIGRATION_NAME = re.compile(r"^(\d{4})_[\w\-]+\.sql$")


def _pending_migrations(current: int) -> list[tuple[int, Path]]:
    """List migrations newer than `current`, sorted by number."""
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
    """Apply any migrations newer than the recorded schema_version.

    NOTE: `executescript` issues its own implicit COMMIT before
    running, so we can't wrap it in our own BEGIN/COMMIT. That
    means a migration isn't atomic — but every CREATE in the
    bundled migrations uses IF NOT EXISTS, so a partial-then-retry
    just picks up where the previous attempt left off. The
    schema_version write happens only after the script returns
    successfully, so a failed migration won't mark itself complete.

    We commit the meta-version update explicitly because the caller
    might be holding the connection without a `with` block (e.g.
    Unruh's main() does `get_conn().close()` to surface schema
    problems early; without an explicit commit the version
    record would roll back on close and we'd re-run migrations
    on every boot — harmless but wasteful).
    """
    current = _current_version(conn)
    for version, path in _pending_migrations(current):
        sql = path.read_text(encoding="utf-8")
        conn.executescript(sql)
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)",
            (str(version),),
        )
        conn.commit()
