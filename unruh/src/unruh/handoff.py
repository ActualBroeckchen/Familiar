"""Session-handoff layer (M6) — intent + open threads across session
boundaries.

When a session ends, the chat path summarises the last few messages
into an "active intent" and a list of "open threads" and calls
set_handoff. The next session's first [Temporal Context] surfaces the
result (via get_handoff inside temporal_context) so the Familiar
resumes mid-thought instead of starting cold.

Lifecycle:
  set_handoff       — supersede any prior unconsumed handoff, then
                      insert the new one (unconsumed). Empty handoffs
                      (no intent, no threads) are a no-op so we never
                      store a hollow "Last session:" header.
  get_handoff       — the latest unconsumed handoff (or latest of all
                      with include_consumed=True, for debugging).
  mark_consumed     — flip a handoff to consumed once the new session
                      has surfaced it, so it stops re-appearing on
                      every subsequent message.

Pure functions over a sqlite3.Connection, same shape as schedule.py /
interest.py — trivially unit-testable with an in-memory DB.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from .db import new_id, now_iso

# Defensive caps at the storage boundary. The intent + threads come from
# an LLM summary (untrusted external output); a runaway model could
# return a wall of text that then bloats every future session's prompt.
# These bounds keep a handoff cheap. Generous enough that a well-behaved
# "one short sentence + a few threads" summary is never touched.
MAX_INTENT_CHARS = 500
MAX_THREADS = 10
MAX_THREAD_CHARS = 200


def set_handoff(
    conn: sqlite3.Connection,
    *,
    intent: str | None = None,
    threads: list | None = None,
    session_id: str | None = None,
) -> dict[str, Any]:
    """Store a session-end handoff. Supersedes any prior unconsumed
    handoff first so at most one is ever live (a session that ends
    before the previous handoff was surfaced shouldn't leave two
    competing rows).

    No-op when there's nothing to say — an empty intent AND no threads
    means we don't write a row, so the next session won't render a
    hollow header. Returns {ok, id, skipped}.
    """
    intent_clean = (intent or "").strip()[:MAX_INTENT_CHARS] or None
    thread_list = [
        t.strip()[:MAX_THREAD_CHARS] for t in (threads or [])
        if isinstance(t, str) and t.strip()
    ][:MAX_THREADS]

    if not intent_clean and not thread_list:
        return {"ok": True, "id": None, "skipped": True}

    ts = now_iso()
    # Supersede prior unconsumed handoffs (one live at a time).
    conn.execute(
        "UPDATE handoff SET consumed = 1, consumed_at = ? WHERE consumed = 0",
        (ts,),
    )
    hid = new_id()
    conn.execute(
        """INSERT INTO handoff
               (id, session_id, intent, threads_json, consumed, created_at, consumed_at)
           VALUES (?, ?, ?, ?, 0, ?, NULL)""",
        (hid, session_id, intent_clean, json.dumps(thread_list), ts),
    )
    return {"ok": True, "id": hid, "skipped": False}


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id":           row["id"],
        "session_id":   row["session_id"],
        "intent":       row["intent"],
        "open_threads": json.loads(row["threads_json"] or "[]"),
        "consumed":     bool(row["consumed"]),
        "created_at":   row["created_at"],
    }


def get_handoff(
    conn: sqlite3.Connection,
    *,
    include_consumed: bool = False,
) -> dict[str, Any] | None:
    """Return the most recent handoff, or None. By default only an
    unconsumed one (what temporal_context surfaces); pass
    include_consumed=True to get the latest regardless (debugging)."""
    if include_consumed:
        row = conn.execute(
            "SELECT * FROM handoff ORDER BY created_at DESC, id DESC LIMIT 1"
        ).fetchone()
    else:
        row = conn.execute(
            "SELECT * FROM handoff WHERE consumed = 0 ORDER BY created_at DESC, id DESC LIMIT 1"
        ).fetchone()
    return _row_to_dict(row) if row else None


def mark_consumed(conn: sqlite3.Connection, *, id: str) -> dict[str, Any]:
    """Flip a handoff to consumed. Idempotent: a no-op (updated=0) if
    the id is unknown or already consumed. Returns {ok, updated}."""
    ts = now_iso()
    cur = conn.execute(
        "UPDATE handoff SET consumed = 1, consumed_at = ? WHERE id = ? AND consumed = 0",
        (ts, id),
    )
    return {"ok": True, "updated": cur.rowcount}
