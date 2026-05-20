"""Schedule-layer logic — events, tasks, phases, states, and the
edges that connect them.

This is the M3 surface. Pure functions over a sqlite3.Connection so
they're trivial to unit-test in isolation (`get_conn(":memory:")`).
Server-side glue (MCP tool registration, payload shaping) lives in
server.py — keep it thin so the model of "what an Unruh schedule is"
stays in one place.

Node shapes by type:

  type='event'   — fixed appointment. when_ts = start (required),
                   end_ts = end (optional).
  type='task'    — something that needs doing. when_ts = optional
                   deadline; resolution tracks done/cancelled/carried.
  type='phase'   — named time-block in the daily routine. when_ts =
                   start (required, may use today's date templating
                   on read), end_ts = end (required).
  type='state'   — emotional / situational context spanning a window.
                   when_ts = start (required), end_ts = end (optional;
                   open-ended state).

Edge kinds (semantics in the design doc):
  'causes' | 'requires' | 'depends_on' | 'blocks' | 'during' | 'carries_forward'
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any

from .db import new_id, now_iso

# ── Allowed values. Surfaced as constants so tests + the MCP layer
# can validate without re-typing the strings. Adding a new value
# means updating the migration's comment + this set + (probably) the
# formatter; the DB itself is schema-permissive on these columns. ──

SCHEDULE_NODE_TYPES = {"event", "task", "phase", "state"}
SCHEDULE_EDGE_KINDS = {
    "causes", "requires", "depends_on", "blocks", "during", "carries_forward",
}
RESOLUTIONS = {"done", "cancelled", "carried_forward"}

DEFAULT_WINDOW_HOURS = 24


# ── Writes ─────────────────────────────────────────────────────────────


def add_node(
    conn: sqlite3.Connection,
    *,
    type: str,
    label: str,
    when: str | None = None,
    end: str | None = None,
    payload: dict | None = None,
) -> str:
    """Insert a schedule-layer node. Returns the new id.

    Raises ValueError on bad inputs — the MCP layer catches and
    returns a structured error so the model gets a clear "fix this"
    message instead of an opaque traceback.
    """
    if type not in SCHEDULE_NODE_TYPES:
        raise ValueError(f"unknown schedule node type {type!r}; expected one of {sorted(SCHEDULE_NODE_TYPES)}")
    if not label or not label.strip():
        raise ValueError("label is required and must be non-empty")
    if type in {"event", "phase", "state"} and not when:
        raise ValueError(f"node type {type!r} requires a 'when' timestamp")
    if type == "phase" and not end:
        raise ValueError("phase nodes require an 'end' timestamp")

    node_id = new_id()
    ts = now_iso()
    conn.execute(
        """INSERT INTO nodes
               (id, layer, type, label, payload_json, when_ts, end_ts,
                resolution, weight, last_touched, created_at, updated_at)
           VALUES (?, 'schedule', ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)""",
        (node_id, type, label.strip(), json.dumps(payload or {}), when, end, ts, ts),
    )
    return node_id


def add_edge(
    conn: sqlite3.Connection,
    *,
    src: str,
    dst: str,
    kind: str,
    payload: dict | None = None,
) -> str:
    """Insert an edge between two existing nodes. Returns the new id.

    Foreign-key constraints reject edges referencing missing nodes —
    so the IntegrityError this raises is a "you typed a stale id"
    signal rather than a corruption hazard.
    """
    if kind not in SCHEDULE_EDGE_KINDS:
        raise ValueError(f"unknown schedule edge kind {kind!r}; expected one of {sorted(SCHEDULE_EDGE_KINDS)}")
    if src == dst:
        raise ValueError("an edge cannot connect a node to itself")

    edge_id = new_id()
    conn.execute(
        """INSERT INTO edges (id, src_id, dst_id, kind, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (edge_id, src, dst, kind, json.dumps(payload or {}), now_iso()),
    )
    return edge_id


def resolve(
    conn: sqlite3.Connection,
    *,
    id: str,
    resolution: str,
) -> bool:
    """Transition a task/event/state to a terminal resolution.

    Returns True if the row was updated, False if no node with that
    id exists (caller can decide whether to treat that as an error).
    """
    if resolution not in RESOLUTIONS:
        raise ValueError(f"unknown resolution {resolution!r}; expected one of {sorted(RESOLUTIONS)}")
    cur = conn.execute(
        "UPDATE nodes SET resolution = ?, updated_at = ? WHERE id = ? AND layer = 'schedule'",
        (resolution, now_iso(), id),
    )
    return cur.rowcount > 0


# ── Reads ──────────────────────────────────────────────────────────────


def _node_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    """Normalise a node row for the wire format. Drops NULL columns
    so the model isn't reading meaningless 'end_ts: null' for every
    item that has no end."""
    out: dict[str, Any] = {
        "id":         row["id"],
        "type":       row["type"],
        "label":      row["label"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }
    if row["when_ts"]:     out["when"]       = row["when_ts"]
    if row["end_ts"]:      out["end"]        = row["end_ts"]
    if row["resolution"]:  out["resolution"] = row["resolution"]
    payload = json.loads(row["payload_json"] or "{}")
    if payload: out["payload"] = payload
    return out


def _edge_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    out = {
        "id":         row["id"],
        "src":        row["src_id"],
        "dst":        row["dst_id"],
        "kind":       row["kind"],
        "created_at": row["created_at"],
    }
    payload = json.loads(row["payload_json"] or "{}")
    if payload: out["payload"] = payload
    return out


def get_window(
    conn: sqlite3.Connection,
    *,
    from_ts: str | None = None,
    to_ts: str | None = None,
    limit: int = 200,
    include_open_tasks: bool = True,
) -> dict[str, Any]:
    """Return the slice of schedule-layer nodes within [from_ts, to_ts]
    plus the edges that touch them.

    Defaults to a 24-hour window centred on now if either bound is
    omitted. Open tasks (no when_ts, resolution NULL) are included
    by default so 'things to do' surfaces in the briefing regardless
    of when they were created.

    `limit` is per-result (nodes + edges separately) — the design
    doc commits to keeping the graph small, but cap from the start
    to bound prompt-token risk before M5+ adds volume.
    """
    if not from_ts or not to_ts:
        now = datetime.now(timezone.utc)
        if not from_ts: from_ts = (now - timedelta(hours=DEFAULT_WINDOW_HOURS / 2)).isoformat(timespec="seconds")
        if not to_ts:   to_ts   = (now + timedelta(hours=DEFAULT_WINDOW_HOURS / 2)).isoformat(timespec="seconds")

    # Nodes whose when_ts is inside the window, OR phases / states
    # whose end_ts is inside it (catches phases starting before the
    # window but ending inside it). Open tasks without a when_ts are
    # included separately as a UNION. The whole UNION is wrapped in
    # a subquery so the outer ORDER BY can reference column names —
    # SQLite's bare-UNION + ORDER BY chokes otherwise.
    union_sql = """
        SELECT * FROM nodes
         WHERE layer = 'schedule'
           AND (
             (when_ts IS NOT NULL AND when_ts BETWEEN ? AND ?)
             OR
             (end_ts  IS NOT NULL AND end_ts  BETWEEN ? AND ?)
           )
    """
    params: list[Any] = [from_ts, to_ts, from_ts, to_ts]
    if include_open_tasks:
        union_sql += """
        UNION
        SELECT * FROM nodes
         WHERE layer = 'schedule' AND type = 'task'
           AND when_ts IS NULL AND resolution IS NULL
        """
    node_sql = f"""
        SELECT * FROM ({union_sql})
         ORDER BY COALESCE(when_ts, '9999') ASC
         LIMIT ?
    """
    params.append(limit)

    node_rows = conn.execute(node_sql, params).fetchall()
    nodes = [_node_row_to_dict(r) for r in node_rows]

    if not nodes:
        return {"nodes": [], "edges": [], "from": from_ts, "to": to_ts}

    ids = [n["id"] for n in nodes]
    placeholders = ",".join("?" * len(ids))
    edge_rows = conn.execute(
        f"""SELECT * FROM edges
             WHERE src_id IN ({placeholders}) OR dst_id IN ({placeholders})
             LIMIT ?""",
        (*ids, *ids, limit),
    ).fetchall()
    edges = [_edge_row_to_dict(r) for r in edge_rows]

    return {"nodes": nodes, "edges": edges, "from": from_ts, "to": to_ts}


def current_phase(
    conn: sqlite3.Connection,
    *,
    at: str | None = None,
) -> dict[str, Any] | None:
    """Return the phase node containing `at` (default now), or None.

    Phases are open-ended on the right edge by convention (when_ts
    <= at < end_ts) so two back-to-back phases don't double-match
    at the boundary instant.
    """
    at = at or now_iso()
    row = conn.execute(
        """SELECT * FROM nodes
            WHERE layer = 'schedule' AND type = 'phase'
              AND when_ts <= ? AND ? < end_ts
            ORDER BY when_ts DESC
            LIMIT 1""",
        (at, at),
    ).fetchone()
    return _node_row_to_dict(row) if row else None
