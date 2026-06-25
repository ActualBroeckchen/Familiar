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

SCHEDULE_NODE_TYPES = {"event", "task", "phase", "state", "reminder"}
SCHEDULE_EDGE_KINDS = {
    "causes", "requires", "depends_on", "blocks", "during", "carries_forward",
    # co_occurs_with: src and dst overlapped in time — a NOTICED correlation,
    # no causal claim. The honest first rung of the ladder the reflection
    # loop climbs (co_occurs → causes) before asserting cause.
    "co_occurs_with",
}
RESOLUTIONS = {"done", "cancelled", "carried_forward", "fired"}

# ── Consequence metadata (rides in an edge's payload_json) ──────────────
# A consequence is an edge (usually 'causes' or 'co_occurs_with') carrying
# some of these. All optional — a bare structural edge carries none. See
# docs/consequence-graph-build-spec.md.
CONSEQUENCE_VALENCES   = {"help", "harm", "neutral"}
CONSEQUENCE_CONDITIONS = {"on_resolve", "on_lapse", "unconditional"}
CONSEQUENCE_SEVERITIES = {"low", "medium", "high"}
CONSEQUENCE_CERTAINTIES = {"low", "medium", "high"}


def validate_consequence_payload(payload: dict | None) -> dict:
    """Validate/normalise the consequence keys inside an edge payload.

    Only the consequence keys are checked; any other keys pass through
    untouched (the payload is still arbitrary JSON). Unknown enum values
    raise ValueError — the same 'you typed something wrong' signal
    add_edge already gives for an unknown kind. Returns the payload
    (possibly with horizon_hours coerced to a number/None).
    """
    if not payload:
        return payload or {}
    out = dict(payload)
    for key, allowed in (
        ("valence",   CONSEQUENCE_VALENCES),
        ("condition", CONSEQUENCE_CONDITIONS),
        ("severity",  CONSEQUENCE_SEVERITIES),
        ("certainty", CONSEQUENCE_CERTAINTIES),
    ):
        if key in out and out[key] is not None and out[key] not in allowed:
            raise ValueError(f"unknown consequence {key} {out[key]!r}; expected one of {sorted(allowed)}")
    if out.get("horizon_hours") is not None:
        try:
            out["horizon_hours"] = float(out["horizon_hours"])
        except (TypeError, ValueError):
            raise ValueError(f"horizon_hours must be a number, got {out['horizon_hours']!r}")
    if "observed" in out and out["observed"] is not None:
        out["observed"] = bool(out["observed"])
    return out

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
    if type in {"event", "phase", "state", "reminder"} and not when:
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

    payload = validate_consequence_payload(payload)
    edge_id = new_id()
    conn.execute(
        """INSERT INTO edges (id, src_id, dst_id, kind, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (edge_id, src, dst, kind, json.dumps(payload or {}), now_iso()),
    )
    return edge_id


def update_edge(conn: sqlite3.Connection, *, id: str, payload: dict) -> bool:
    """Merge consequence metadata into an existing edge's payload — the
    way a structural link (prep requires interview) gets annotated with
    valence/horizon/certainty after the fact, or a projection's certainty
    gets recalibrated. Shallow-merges the given keys over the stored
    payload (so partial updates don't wipe the rest). Returns True if the
    edge existed, False otherwise.
    """
    row = conn.execute("SELECT payload_json FROM edges WHERE id = ?", (id,)).fetchone()
    if row is None:
        return False
    merged = json.loads(row["payload_json"] or "{}")
    merged.update(validate_consequence_payload(payload))
    conn.execute("UPDATE edges SET payload_json = ? WHERE id = ?", (json.dumps(merged), id))
    return True


def delete_edge(conn: sqlite3.Connection, *, id: str) -> bool:
    """Remove a single schedule edge by id, leaving both endpoint nodes
    intact. This is how a mis-stated consequence link gets corrected
    without deleting the events themselves (for that, delete_node
    cascades the edges).

    The layer guard mirrors delete_node: we only delete edges whose
    source is a schedule-layer node, so a schedule-edge id can never
    reach across and remove an interest/bookmark edge that happens to
    share the edges table. Returns True if a row was deleted, False if
    no schedule edge matched that id.
    """
    cur = conn.execute(
        """DELETE FROM edges
            WHERE id = ?
              AND src_id IN (SELECT id FROM nodes WHERE layer = 'schedule')""",
        (id,),
    )
    return cur.rowcount > 0



def find_state_by_label(conn: sqlite3.Connection, *, label: str) -> str | None:
    """The id of the most-recent schedule `state` node with this exact
    (case-insensitive) label, or None. Backs resolve-or-create when the
    Familiar names a consequence-state ('crash', 'good streak') by label
    — so the graph reuses one node instead of growing a duplicate per
    mention."""
    row = conn.execute(
        """SELECT id FROM nodes
            WHERE layer = 'schedule' AND type = 'state' AND lower(label) = lower(?)
            ORDER BY created_at DESC LIMIT 1""",
        ((label or "").strip(),),
    ).fetchone()
    return row["id"] if row else None


def resolve(
    conn: sqlite3.Connection,
    *,
    id: str,
    resolution: str,
) -> bool:
    """Transition a task/event/state to a terminal resolution.

    Returns True if the row was updated, False if no node with that
    id exists (caller can decide whether to treat that as an error).

    For recurring nodes this resolves the WHOLE SERIES (the anchor's
    own resolution column). To resolve a single occurrence of a
    recurring node, use resolve_occurrence() instead — it writes into
    payload.resolutions and leaves the series alive.
    """
    if resolution not in RESOLUTIONS:
        raise ValueError(f"unknown resolution {resolution!r}; expected one of {sorted(RESOLUTIONS)}")
    ts = now_iso()
    # Action-position: stamp WHEN the ward acted, and — for a node with a
    # [when, end] window — WHERE in that window they landed
    # (window_fraction: 0 at the open, 1 at the close, >1 if they acted
    # after it). This is the hook the reflection loop correlates with how
    # things went ("starts past the midpoint → more stressed"). See the
    # build spec. Stored in payload (no migration); harmless on instant
    # nodes (no window → no fraction).
    row = conn.execute(
        "SELECT when_ts, end_ts, payload_json FROM nodes WHERE id = ? AND layer = 'schedule'",
        (id,),
    ).fetchone()
    if row is None:
        return False
    payload = json.loads(row["payload_json"] or "{}")
    payload["acted_at"] = ts
    frac = _window_fraction(row["when_ts"], row["end_ts"], ts)
    if frac is not None:
        payload["window_fraction"] = frac
    cur = conn.execute(
        "UPDATE nodes SET resolution = ?, updated_at = ?, payload_json = ? WHERE id = ? AND layer = 'schedule'",
        (resolution, ts, json.dumps(payload), id),
    )
    return cur.rowcount > 0


def resolve_occurrence(
    conn: sqlite3.Connection,
    *,
    id: str,
    occurrence_date: str,
    resolution: str,
) -> bool:
    """Mark a single occurrence of a recurring node resolved.

    Writes into payload.resolutions (a map of {YYYY-MM-DD: resolution})
    instead of touching the node's own `resolution` column. The
    JS-side expander (recurrence.js) filters resolved
    occurrence-dates out when generating the temporal-context window,
    so "this Sunday's cleaning got done" hides this Sunday without
    affecting next Sunday.

    Raises ValueError if the node doesn't carry a recurrence rule
    (per-occurrence resolution is meaningless for one-time entries —
    use resolve() for those). Returns True if the write succeeded,
    False if the node id wasn't found.
    """
    if resolution not in RESOLUTIONS:
        raise ValueError(f"unknown resolution {resolution!r}; expected one of {sorted(RESOLUTIONS)}")
    if not occurrence_date or not isinstance(occurrence_date, str):
        raise ValueError("occurrence_date is required (YYYY-MM-DD)")
    row = conn.execute(
        "SELECT payload_json FROM nodes WHERE id = ? AND layer = 'schedule'",
        (id,),
    ).fetchone()
    if row is None:
        return False
    payload = json.loads(row["payload_json"] or "{}")
    if not payload.get("recurrence"):
        raise ValueError(
            f"node {id} has no recurrence rule; use resolve() for one-time nodes"
        )
    resolutions = payload.get("resolutions") or {}
    if not isinstance(resolutions, dict):
        resolutions = {}
    resolutions[occurrence_date] = resolution
    payload["resolutions"] = resolutions
    conn.execute(
        "UPDATE nodes SET payload_json = ?, updated_at = ? WHERE id = ?",
        (json.dumps(payload), now_iso(), id),
    )
    return True


def update_node(
    conn: sqlite3.Connection,
    *,
    id: str,
    label: str | None = None,
    when: str | None = None,
    end: str | None = None,
    payload: dict | None = None,
) -> bool:
    """Patch a schedule-layer node in place. Any field passed as None
    is left unchanged; pass an empty string to clear (when/end can be
    nulled this way). payload, when given, REPLACES the existing JSON
    payload — partial-merge is left to the caller because the M9 UI
    surface only edits whole payloads anyway.

    Returns True if a row was updated, False if no node matched.
    """
    sets: list[str] = []
    args: list[Any] = []
    if label is not None:
        if not label.strip():
            raise ValueError("label cannot be cleared (use delete_node if you want to remove the node)")
        sets.append("label = ?")
        args.append(label.strip())
    if when is not None:
        sets.append("when_ts = ?")
        args.append(when or None)
    if end is not None:
        sets.append("end_ts = ?")
        args.append(end or None)
    if payload is not None:
        sets.append("payload_json = ?")
        args.append(json.dumps(payload))
    if not sets:
        return False
    sets.append("updated_at = ?")
    args.append(now_iso())
    args.append(id)
    cur = conn.execute(
        f"UPDATE nodes SET {', '.join(sets)} WHERE id = ? AND layer = 'schedule'",
        args,
    )
    return cur.rowcount > 0


def delete_node(conn: sqlite3.Connection, *, id: str) -> bool:
    """Permanently remove a schedule-layer node and any edges that
    referenced it (via ON DELETE CASCADE on the edges table).

    Returns True if a row was deleted, False if no node matched. The
    layer guard ensures we never accidentally delete an interest-layer
    node by id — those have their own demote/reset semantics.
    """
    cur = conn.execute(
        "DELETE FROM nodes WHERE id = ? AND layer = 'schedule'",
        (id,),
    )
    return cur.rowcount > 0


# ── Reminders (M11) ────────────────────────────────────────────────────


def get_due_reminders(
    conn: sqlite3.Connection,
    *,
    now: str | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Return reminder nodes whose when_ts has arrived and that have
    not yet been resolved (fired / cancelled / done).

    `now` is an ISO-8601 UTC string; if omitted, the current wall
    clock is used. Returning a list (not a generator) keeps the MCP
    JSON shape simple.

    Pure read — does NOT mark anything fired. Callers do that with
    schedule.resolve(id, 'fired') after delivery succeeds, so a
    crash mid-delivery leaves the reminder fireable next tick rather
    than dropping it silently.
    """
    now = now or now_iso()
    rows = conn.execute(
        """SELECT * FROM nodes
            WHERE layer = 'schedule'
              AND type  = 'reminder'
              AND resolution IS NULL
              AND when_ts IS NOT NULL
              AND when_ts <= ?
            ORDER BY when_ts ASC
            LIMIT ?""",
        (now, limit),
    ).fetchall()
    return [_node_row_to_dict(row) for row in rows]


def reminders_health(conn: sqlite3.Connection) -> dict[str, Any]:
    """Quick observability surface for the reminders scheduler.

    Reports:
      - total reminders in the DB
      - pending (resolution IS NULL)
      - overdue (resolution IS NULL AND when_ts <= now): if this
        number grows monotonically, the scheduler is stuck.
      - next_fires_at: when the next pending reminder will fire,
        or None.
      - last_fired: ISO of the most-recently-fired reminder (a sanity
        check that something actually ran recently).

    The Node-side scheduler calls this on every tick and logs a
    warning if `overdue` keeps growing across ticks. Surfacing
    silent-failure was the explicit design-doc concern for M11.
    """
    now = now_iso()
    totals = conn.execute(
        """SELECT
              COUNT(*) AS total,
              SUM(CASE WHEN resolution IS NULL                          THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN resolution IS NULL AND when_ts <= ?         THEN 1 ELSE 0 END) AS overdue
            FROM nodes
           WHERE layer = 'schedule' AND type = 'reminder'""",
        (now,),
    ).fetchone()
    next_row = conn.execute(
        """SELECT when_ts FROM nodes
            WHERE layer = 'schedule' AND type = 'reminder'
              AND resolution IS NULL AND when_ts IS NOT NULL
            ORDER BY when_ts ASC LIMIT 1""",
    ).fetchone()
    last_row = conn.execute(
        """SELECT updated_at FROM nodes
            WHERE layer = 'schedule' AND type = 'reminder'
              AND resolution = 'fired'
            ORDER BY updated_at DESC LIMIT 1""",
    ).fetchone()
    return {
        "total":          int(totals["total"]   or 0),
        "pending":        int(totals["pending"] or 0),
        "overdue":        int(totals["overdue"] or 0),
        "next_fires_at":  next_row["when_ts"]    if next_row else None,
        "last_fired":     last_row["updated_at"] if last_row else None,
        "now":            now,
    }


# ── Reads ──────────────────────────────────────────────────────────────


def _parse_iso(s: str | None) -> datetime | None:
    """Parse a stored ISO-8601 timestamp (which may end in 'Z' from JS
    or '+00:00' from now_iso). Returns None on anything unparseable."""
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def _window_fraction(when: str | None, end: str | None, acted: str) -> float | None:
    """Where in a [when, end] window an action at `acted` fell:
    0.0 at the open, 1.0 at the close, >1.0 if acted after it closed.
    Returns None when there's no real window (no end, or zero-width)."""
    w, e, a = _parse_iso(when), _parse_iso(end), _parse_iso(acted)
    if not (w and e and a):
        return None
    span = (e - w).total_seconds()
    if span <= 0:
        return None
    return round((a - w).total_seconds() / span, 3)


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


def list_phases(
    conn: sqlite3.Connection,
    *,
    include_resolved: bool = False,
    limit: int = 200,
) -> list[dict[str, Any]]:
    """Return every phase node, regardless of stored date.

    Phases recur daily by design — `current_phase()` already matches
    on time-of-day only — but `get_window()` honours the calendar
    date in `when_ts` / `end_ts`, so the day after I add a phase
    its row falls outside any reasonable window. Callers that want
    the routine surface (the M9 Routine tab, briefing layers
    rendering "today's rhythm") should use this instead.

    Resolved phases excluded by default so a cancelled phase stops
    showing up; pass include_resolved=True to surface them too.
    """
    sql = (
        "SELECT * FROM nodes WHERE layer = 'schedule' AND type = 'phase'"
        + ("" if include_resolved else " AND resolution IS NULL")
        + " ORDER BY when_ts ASC LIMIT ?"
    )
    rows = conn.execute(sql, (limit,)).fetchall()
    return [_node_row_to_dict(r) for r in rows]


def list_recurring(
    conn: sqlite3.Connection,
    *,
    include_resolved: bool = False,
    limit: int = 200,
) -> list[dict[str, Any]]:
    """Return every schedule node whose payload carries a `recurrence`
    rule, regardless of stored when_ts.

    Recurring nodes anchor on their FIRST occurrence — the rest are
    computed at read-time by the JS-side expander in recurrence.js.
    `get_window` only catches nodes whose stored when_ts falls inside
    the window, which means a "weekly cleaning" anchored months ago
    is invisible to it. Callers assembling the temporal context (or
    Routine surface) should pull recurring nodes through here and
    let the expander generate the relevant occurrences.

    Resolved nodes excluded by default; the resolution on a recurring
    anchor applies to the whole rule (i.e. cancelling the series).
    Per-occurrence resolution isn't tracked yet — pass
    include_resolved=True if surfacing them anyway is useful.
    """
    sql = (
        "SELECT * FROM nodes WHERE layer = 'schedule'"
        + " AND json_extract(payload_json, '$.recurrence') IS NOT NULL"
        + ("" if include_resolved else " AND resolution IS NULL")
        + " ORDER BY when_ts ASC LIMIT ?"
    )
    rows = conn.execute(sql, (limit,)).fetchall()
    return [_node_row_to_dict(r) for r in rows]


def current_phase(
    conn: sqlite3.Connection,
    *,
    at: str | None = None,
) -> dict[str, Any] | None:
    """Return the phase node whose time-of-day range contains `at`
    (default now), or None.

    Phases are daily-recurring by design: only the HH:MM:SS portion
    of the stored timestamps is compared against `at`, so a phase
    added on any past date remains active at that time of day every
    day until manually resolved.

    Two cases handled:
      • Normal phase  (start < end, e.g. 09:00–17:00): active when
        start ≤ current_time < end.
      • Overnight phase (end < start, e.g. 23:00–06:00): active when
        current_time ≥ start OR current_time < end.

    Open-ended on the right edge (when = end_time boundary, the NEXT
    phase wins) so back-to-back phases don't double-match.

    Resolved phases are excluded so a deliberately cancelled phase
    stops recurring.
    """
    at = at or now_iso()
    row = conn.execute(
        """SELECT * FROM nodes
            WHERE layer = 'schedule' AND type = 'phase'
              AND resolution IS NULL
              AND (
                -- Normal phase: start time < end time (same calendar day)
                (strftime('%H:%M:%S', when_ts) < strftime('%H:%M:%S', end_ts)
                 AND strftime('%H:%M:%S', when_ts) <= strftime('%H:%M:%S', ?)
                 AND strftime('%H:%M:%S', ?) < strftime('%H:%M:%S', end_ts))
                OR
                -- Overnight phase: end time < start time (wraps midnight)
                (strftime('%H:%M:%S', when_ts) >= strftime('%H:%M:%S', end_ts)
                 AND (strftime('%H:%M:%S', ?) >= strftime('%H:%M:%S', when_ts)
                      OR strftime('%H:%M:%S', ?) < strftime('%H:%M:%S', end_ts)))
              )
            ORDER BY when_ts DESC
            LIMIT 1""",
        (at, at, at, at),
    ).fetchone()
    return _node_row_to_dict(row) if row else None
