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

import os
import re
import sqlite3
import uuid
from datetime import date, datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

DB_FILENAME = "unruh.db"
MIGRATIONS_DIR = Path(__file__).parent / "migrations"

# The ward's local zone, resolved EXPLICITLY from the TZ env (Thalamus spawns
# Unruh with TZ=wardTimeZone) via zoneinfo — NOT via the C runtime's local-time
# resolution. `datetime.astimezone()` with no arg reads the platform local
# zone, and on Windows the C runtime can't parse an IANA name like
# "Europe/Berlin": it drops DST and applies the standard offset, landing every
# converted time an hour off in summer. ZoneInfo uses the IANA tz database (the
# `tzdata` dep guarantees it on Windows) and applies DST correctly for the
# date. Returns None when TZ is unset/unknown → callers fall back to the old
# co-located behaviour. Cached; the process is spawned per ward zone.
_ZONE_CACHE: dict[str, ZoneInfo | None] = {}


def _local_zone() -> ZoneInfo | None:
    tz = os.environ.get("TZ")
    if not tz:
        return None
    if tz not in _ZONE_CACHE:
        try:
            _ZONE_CACHE[tz] = ZoneInfo(tz)
        except (ZoneInfoNotFoundError, ValueError, OSError):
            _ZONE_CACHE[tz] = None
    return _ZONE_CACHE[tz]


def default_db_path() -> Path:
    """Resolve the canonical DB path: <package-parent>/data/unruh.db.

    Layout: src/unruh/db.py → src/unruh → src → <unruh-root>/data/unruh.db.
    Override at call time by passing an explicit path to `get_conn`, or set
    UNRUH_DB_PATH in the environment to relocate the store for the whole server
    process (used by the cross-process smoke test to isolate its writes to a
    temp file; also lets an install point at an external data dir).
    """
    override = os.environ.get("UNRUH_DB_PATH")
    if override:
        return Path(override)
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
    their own ingest seam, never here. See docs/unruh-design.md.

    "Now" is read in the ward's IANA zone (from TZ) so it agrees with
    to_local_naive — the two are compared (reconcile's past/future check), so
    they must share one definition of local."""
    zone = _local_zone()
    now = datetime.now(zone) if zone is not None else datetime.now()
    return now.replace(tzinfo=None).isoformat(timespec="seconds")


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
        zone = _local_zone()
        dt = (dt.astimezone(zone) if zone is not None else dt.astimezone()).replace(tzinfo=None)
    return dt.isoformat(timespec="seconds")


def new_id() -> str:
    """Generate an opaque fallback id (UUID4 hex). Prefer slug_id() for
    anything a model reads — 32-hex ids tokenize terribly and carry no
    meaning. This remains for internal rows and as the collision-exhausted
    fallback; old hex ids stay valid forever (ids are opaque TEXT)."""
    return uuid.uuid4().hex


# ── Readable ids (the 0.8.x id overhaul) ─────────────────────────────────
#
# Ids that reach the model's context are label-derived word slugs with a
# short random suffix — "dentist-k3", "weekly-cleaning-8f" — instead of
# uuid4 hex. Why: a 32-hex id costs ~16 tokens in every legend line and the
# model can neither read nor reliably retype it; a slug costs ~3, self-
# documents in tool calls, and the suffix keeps it collision-safe (writers
# retry with a fresh suffix on a PK collision). Old hex ids coexist —
# nothing parses id shape anywhere; they're opaque keys.

_SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"  # no 0/O/1/l/i lookalikes
_SLUG_MAX_LABEL = 20   # chars of slugified label kept (whole words)


def _slugify(label: str) -> str:
    """Lowercase-ascii-dash the label and keep the first couple of words."""
    out = []
    prev_dash = True  # suppress leading dashes
    for ch in (label or "").lower():
        if ch.isascii() and (ch.isalnum()):
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
    """A readable id: `<label-slug>-<suffix>` (e.g. "dentist-k3"), falling
    back to `<kind>-<suffix>` ("causes-x7k2") when there's no usable label.
    NOT guaranteed unique — the caller inserts and retries on a PK collision
    (see insert_with_slug_retry); the suffix makes accidental guesses miss
    safely rather than hit someone else's row."""
    import secrets
    base = _slugify(label or "")
    if not base:
        base = _slugify(kind) or "id"
        suffix_len = max(suffix_len, 4)  # label-less ids lean on the suffix
    suffix = "".join(secrets.choice(_SLUG_ALPHABET) for _ in range(suffix_len))
    return f"{base}-{suffix}"


def insert_with_slug_retry(conn, sql: str, args_for_id, *, label: str | None = None, kind: str = "node") -> str:
    """Run an INSERT whose first parameter is the new id, generating a slug
    id and retrying with a longer suffix on a PK collision (then uuid4 as the
    final fallback). `args_for_id(id)` returns the full parameter tuple.
    Returns the id that stuck."""
    for attempt, suffix_len in enumerate((2, 3, 5)):
        candidate = slug_id(label, kind=kind, suffix_len=suffix_len)
        try:
            conn.execute(sql, args_for_id(candidate))
            return candidate
        except sqlite3.IntegrityError as e:
            if "UNIQUE" not in str(e) and "PRIMARY KEY" not in str(e):
                raise  # a real constraint problem, not an id collision
    fallback = new_id()
    conn.execute(sql, args_for_id(fallback))
    return fallback


_LEGACY_ID = re.compile(r"^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def ids_to_slugs(conn: sqlite3.Connection) -> dict:
    """One-shot mechanical re-key: every legacy hex/UUID node and edge id
    becomes a readable slug. Dumb tech by design — no judgment, no LLM:
    read label → slug_id → UPDATE the row and every reference to it
    (edges.src_id/dst_id), all in one transaction so a crash changes
    nothing. Foreign keys are suspended for the duration because the
    schema has no ON UPDATE CASCADE; the updates themselves keep every
    reference consistent. Idempotent: slugged rows don't match the legacy
    pattern and are skipped. Returns {nodes, edges, mapping} — the caller
    (Proto-Familiar) applies `mapping` to its own JSON stores that
    reference node ids (outbox originIds, projection-cue state, surface
    events)."""
    mapping: dict[str, str] = {}
    taken = {r["id"] for r in conn.execute("SELECT id FROM nodes")}
    taken |= {r["id"] for r in conn.execute("SELECT id FROM edges")}

    def fresh(label: str | None, kind: str) -> str:
        for suffix_len in (2, 3, 5):
            cand = slug_id(label, kind=kind, suffix_len=suffix_len)
            if cand not in taken:
                taken.add(cand)
                return cand
        cand = new_id()
        taken.add(cand)
        return cand

    # PRAGMA foreign_keys is a no-op while a transaction is open — commit any
    # in-flight implicit transaction first so the toggle actually applies.
    conn.commit()
    conn.execute("PRAGMA foreign_keys = OFF")
    try:
        with conn:  # one transaction: all-or-nothing
            nodes = conn.execute("SELECT id, label, type FROM nodes").fetchall()
            n_nodes = 0
            for r in nodes:
                if not _LEGACY_ID.match(r["id"]):
                    continue
                new = fresh(r["label"], r["type"] or "node")
                mapping[r["id"]] = new
                conn.execute("UPDATE nodes SET id=? WHERE id=?", (new, r["id"]))
                conn.execute("UPDATE edges SET src_id=? WHERE src_id=?", (new, r["id"]))
                conn.execute("UPDATE edges SET dst_id=? WHERE dst_id=?", (new, r["id"]))
                n_nodes += 1
            edges = conn.execute("SELECT id, kind FROM edges").fetchall()
            n_edges = 0
            for r in edges:
                if not _LEGACY_ID.match(r["id"]):
                    continue
                new = fresh(None, r["kind"] or "edge")
                mapping[r["id"]] = new
                conn.execute("UPDATE edges SET id=? WHERE id=?", (new, r["id"]))
                n_edges += 1
    finally:
        conn.execute("PRAGMA foreign_keys = ON")
    return {"nodes": n_nodes, "edges": n_edges, "mapping": mapping}


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
    heal_malformed_schedule_times(conn)
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


_TIME_ONLY = re.compile(r"^T?(\d{1,2}):(\d{2})(?::(\d{2}))?")


def _salvage_time(value: str, ref_date: str) -> str | None:
    """Pull a wall-clock time out of a date-less/mangled string and put it on
    ref_date as a clean local-naive datetime. Handles "23:00:00", the legacy
    UTC artifact "T13:00:00+00:00" (offset dropped — routine phases are the
    ward's local wall-clock), etc. None if there's no valid HH:MM to find."""
    m = _TIME_ONLY.match(value.strip())
    if not m:
        return None
    hh, mm, ss = int(m.group(1)), int(m.group(2)), int(m.group(3) or 0)
    if hh > 23 or mm > 59 or ss > 59:
        return None
    return f"{ref_date}T{hh:02d}:{mm:02d}:{ss:02d}"


def heal_malformed_schedule_times(conn: sqlite3.Connection) -> int:
    """Repair schedule when_ts/end_ts that the one-time UTC migration couldn't —
    chiefly legacy DATE-LESS, offset-stamped phase times like "T13:00:00+00:00"
    that `datetime.fromisoformat` (and so `to_local_naive`) can't parse, which
    leaked raw into the temporal briefing. Also normalises any straggler
    offset-bearing value the flag-gated migration missed (a row created after
    the flag was set).

    Runs on EVERY connect and is idempotent by construction: it only rewrites a
    value that actually changes (a clean local-naive timestamp normalises to
    itself), so a healed row is never touched again and there's no flag to set
    prematurely — which is exactly the trap that let these artifacts survive the
    one-time migration. Cheap: schedule nodes number in the dozens.

    Firing-neutral: it makes stored times MORE correct (the local-naive form the
    whole system already compares in), never changes which items fire or when in
    a way the design didn't already intend."""
    try:
        rows = conn.execute(
            "SELECT id, when_ts, end_ts, created_at FROM nodes "
            "WHERE layer='schedule' AND (when_ts IS NOT NULL OR end_ts IS NOT NULL)"
        ).fetchall()
    except sqlite3.OperationalError:
        return 0
    updated = 0
    for r in rows:
        ref_date = (r["created_at"] or "")[:10]
        if len(ref_date) != 10:
            ref_date = date.today().isoformat()
        new_vals = {}
        changed = False
        for col in ("when_ts", "end_ts"):
            v = r[col]
            if not v:
                new_vals[col] = v
                continue
            try:
                datetime.fromisoformat(str(v).replace("Z", "+00:00"))
                normalized = to_local_naive(str(v))       # offset → local; naive unchanged
            except (TypeError, ValueError):
                normalized = _salvage_time(str(v), ref_date) or v  # date-less artifact
            new_vals[col] = normalized
            if normalized != v:
                changed = True
        if changed:
            conn.execute(
                "UPDATE nodes SET when_ts=?, end_ts=? WHERE id=?",
                (new_vals["when_ts"], new_vals["end_ts"], r["id"]),
            )
            updated += 1
    if updated:
        conn.commit()
        import sys
        print(f"[unruh] healed {updated} malformed schedule timestamp(s) to local-naive", file=sys.stderr)
    return updated
