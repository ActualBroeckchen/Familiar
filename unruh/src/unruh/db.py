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
    """LOCAL-naive ISO-8601 to the second — the single source of 'now'.

    Unruh models ONE person's local day on a co-located machine, so it
    stores and compares everything in the ward's local wall-clock with NO
    timezone offset. This is deliberate: every human-facing surface (the
    [Now] block, the formatter, the times the Familiar speaks) is local, so
    keeping storage local too removes the entire class of UTC<->local
    conversion bugs (a model that drops the offset, or double-applies it).
    External instants (e.g. an iCal feed) are converted to local once at
    their own ingest seam, never here. See docs/unruh-design.md."""
    return datetime.now().isoformat(timespec="seconds")


def to_local_naive(s: str | None) -> str | None:
    """Canonicalise an incoming ISO timestamp to the LOCAL-naive form Unruh
    stores and compares in.

    - A naive string ("2026-06-26T14:56:00") is already local wall-clock —
      reformatted to seconds precision and returned as-is.
    - An offset-bearing string ("…Z" / "…+02:00", e.g. from an external
      calendar or pre-migration data) is converted to local time and the
      tzinfo dropped.

    This is the ONE place the Familiar's timestamps stop needing the model
    to do timezone math: it can write plain local time, and an offset value
    (if one ever arrives) is normalised in code. Returns the input unchanged
    when it can't be parsed (validation lives at the caller)."""
    if not s:
        return s
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return s
    if dt.tzinfo is not None:
        dt = dt.astimezone().replace(tzinfo=None)
    return dt.isoformat(timespec="seconds")


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
    migrate_timestamps_to_local(conn)
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


def migrate_timestamps_to_local(conn: sqlite3.Connection) -> int:
    """One-time: rewrite any offset-bearing schedule `when_ts`/`end_ts` to
    LOCAL-naive (the form Unruh now stores). Done in Python rather than a .sql
    migration because SQLite's `datetime()` mangles the ISO 'T' separator and
    its offset parsing is version-fragile — real tz conversion needs `to_local_naive`.

    Idempotent: gated by a `meta.local_time_migrated` flag and only writes rows
    that actually change, so already-naive timestamps (the common case — e.g. a
    reminder the model wrote in plain local time) are left untouched, while a
    pre-migration UTC value (an old seeded phase, an LLM that converted to UTC)
    is shifted to local. Returns the number of rows updated."""
    try:
        done = conn.execute("SELECT value FROM meta WHERE key='local_time_migrated'").fetchone()
    except sqlite3.OperationalError:
        return 0  # meta table not created yet (fresh DB) → nothing to migrate
    if done and str(done["value"]) == "1":
        return 0
    updated = 0
    try:
        rows = conn.execute(
            "SELECT id, when_ts, end_ts FROM nodes "
            "WHERE layer='schedule' AND (when_ts IS NOT NULL OR end_ts IS NOT NULL)"
        ).fetchall()
    except sqlite3.OperationalError:
        return 0  # nodes table not created yet
    for r in rows:
        new_when = to_local_naive(r["when_ts"])
        new_end = to_local_naive(r["end_ts"])
        if new_when != r["when_ts"] or new_end != r["end_ts"]:
            conn.execute("UPDATE nodes SET when_ts=?, end_ts=? WHERE id=?", (new_when, new_end, r["id"]))
            updated += 1
    conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES('local_time_migrated', '1')")
    conn.commit()
    if updated:
        import sys
        print(f"[unruh] local-time migration: normalised {updated} schedule timestamp(s) to local", file=sys.stderr)
    return updated
