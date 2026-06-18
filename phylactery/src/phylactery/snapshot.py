"""Auto-snapshot before destructive operations.

Every destructive op (memory/identity/graph update+delete) calls
auto_snapshot() first. This preserves the 'memories-disappearing'
invariant: a bad model decision is always recoverable.

Snapshots are SQLite database files created with VACUUM INTO — a full
byte-for-byte copy of the live database at the moment of the snapshot.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from phylactery.db import get_conn, new_id, now_iso, default_db_path

SNAPSHOTS_DIR_NAME = "snapshots"


def _snapshots_dir() -> Path:
    return default_db_path().parent / SNAPSHOTS_DIR_NAME


def create_snapshot(conn: sqlite3.Connection | None = None) -> dict:
    """Create a snapshot of the current database. Returns snapshot metadata."""
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        snap_id = new_id()
        ts = now_iso().replace(":", "-").replace("+", "Z")
        snap_dir = _snapshots_dir()
        snap_dir.mkdir(parents=True, exist_ok=True)
        snap_path = snap_dir / f"snapshot-{ts}-{snap_id[:8]}.sqlite"

        conn.execute(f"VACUUM INTO '{snap_path}'")

        size = snap_path.stat().st_size if snap_path.exists() else 0
        created_at = now_iso()

        with conn:
            conn.execute(
                "INSERT INTO snapshots(id, file_path, size_bytes, created_at) VALUES (?,?,?,?)",
                (snap_id, str(snap_path), size, created_at),
            )

        return {"id": snap_id, "filePath": str(snap_path), "sizeBytes": size, "createdAt": created_at}
    finally:
        if own_conn:
            conn.close()


def list_snapshots(conn: sqlite3.Connection | None = None) -> list[dict]:
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT id, file_path, size_bytes, created_at FROM snapshots ORDER BY created_at DESC"
        ).fetchall()
        return [
            {"id": r["id"], "filePath": r["file_path"], "sizeBytes": r["size_bytes"], "createdAt": r["created_at"]}
            for r in rows
        ]
    finally:
        if own_conn:
            conn.close()


def restore_snapshot(snapshot_id: str) -> dict:
    """Restore the live database from a snapshot.

    This replaces the live DB file with the snapshot. The current MCP
    connection must be re-established after restore (thalamus reconnect).
    """
    conn = get_conn()
    try:
        row = conn.execute(
            "SELECT file_path FROM snapshots WHERE id = ?", (snapshot_id,)
        ).fetchone()
        if not row:
            return {"ok": False, "error": f"snapshot {snapshot_id!r} not found"}
        snap_path = Path(row["file_path"])
        if not snap_path.exists():
            return {"ok": False, "error": f"snapshot file missing: {snap_path}"}
    finally:
        conn.close()

    import shutil
    live_path = default_db_path()
    # Copy snapshot over the live DB (WAL files will be recreated on next open).
    for suffix in ("", "-shm", "-wal"):
        victim = Path(str(live_path) + suffix)
        if victim.exists():
            victim.unlink()
    shutil.copy2(str(snap_path), str(live_path))

    return {"ok": True, "restoredFrom": str(snap_path)}


def auto_snapshot(conn: sqlite3.Connection) -> None:
    """Silently snapshot before a destructive op. Errors are logged, not raised."""
    try:
        create_snapshot(conn)
    except Exception as e:
        import sys
        print(f"[phylactery] auto-snapshot failed (proceeding anyway): {e}", file=sys.stderr)
