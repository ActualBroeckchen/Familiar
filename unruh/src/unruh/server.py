"""Unruh MCP server.

Tools exposed (stable contract — Thalamus depends on these shapes):

  Liveness:
    health_check       — boot diagnostic

  Schedule (M3):
    schedule_add_node     — create event / task / phase / state
    schedule_add_edge     — connect two nodes with a causal/temporal kind
    schedule_get_window   — read items in a time window (+ touching edges)
    schedule_resolve      — mark a task/event done/cancelled/carried

  Interest (M4–M5):
    interest_record       — bump engagement weight for a topic
    interest_bookmark     — save a resource against a topic
    interest_set_standing — promote a topic to an always-on standing value
    interest_demote_standing — demote a standing value to a live interest
    interest_list         — list interests by effective (decayed) weight

  Session handoff (M6):
    session_set_handoff           — store a session-end intent + threads
    session_get_handoff           — read the latest (un)consumed handoff
    session_mark_handoff_consumed — stop a surfaced handoff re-appearing

  Briefing (called per-message by Thalamus):
    temporal_context   — assembled handoff + schedule + interests payload

The temporal_context payload always carries all three sub-blocks
(handoff / schedule / interests); empty ones render as nothing so the
formatter in thalamus.js / temporal-format.js stays clean.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from mcp.server.fastmcp import FastMCP

from unruh import __version__
from unruh.db import get_conn
from unruh import schedule as sched
from unruh import interest as interests
from unruh import handoff as handoffs

mcp = FastMCP("unruh")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _err(message: str, code: str = "bad_request") -> dict[str, Any]:
    """Structured error shape Thalamus / the Familiar can switch on
    without parsing free text."""
    return {"ok": False, "error": {"code": code, "message": message}}


# ── Liveness ──────────────────────────────────────────────────────────


@mcp.tool()
def health_check() -> dict[str, Any]:
    """Return liveness info. No side effects."""
    return {
        "ok": True,
        "service": "unruh",
        "version": __version__,
        "ts": _now_iso(),
    }


# ── Schedule layer (M3) ───────────────────────────────────────────────


@mcp.tool()
def schedule_add_node(
    type: str,
    label: str,
    when: str | None = None,
    end: str | None = None,
    payload: dict | None = None,
) -> dict[str, Any]:
    """Create a schedule-layer node.

    Args:
        type: 'event' | 'task' | 'phase' | 'state'.
            event/phase/state require `when`; phase additionally
            requires `end`; task is the only type that may omit
            both (an open-ended 'to do' item).
        label: human-readable name. Required.
        when: ISO-8601 UTC start time. Required for event/phase/state.
        end: ISO-8601 UTC end time. Required for phase; optional for
            event/state (open-ended).
        payload: arbitrary extras stored as JSON (notes, source,
            categorisation that doesn't fit the four columns).

    Returns: {ok: True, id: '<new-id>'} on success, or the
    standard error shape on validation failure.
    """
    try:
        with get_conn() as conn:
            node_id = sched.add_node(
                conn,
                type=type, label=label, when=when, end=end, payload=payload,
            )
        return {"ok": True, "id": node_id}
    except ValueError as e:
        return _err(str(e))


@mcp.tool()
def schedule_add_edge(
    src: str,
    dst: str,
    kind: str,
    payload: dict | None = None,
) -> dict[str, Any]:
    """Connect two existing schedule nodes.

    Args:
        src: id of the source node (returned by schedule_add_node).
        dst: id of the destination node.
        kind: one of 'causes', 'requires', 'depends_on', 'blocks',
            'during', 'carries_forward'. Semantics in
            docs/unruh-design.md.
        payload: arbitrary extras stored as JSON.

    Returns: {ok: True, id: '<new-id>'} on success.
    """
    try:
        with get_conn() as conn:
            edge_id = sched.add_edge(
                conn,
                src=src, dst=dst, kind=kind, payload=payload,
            )
        return {"ok": True, "id": edge_id}
    except ValueError as e:
        return _err(str(e))
    except Exception as e:  # FK violation = stale id
        return _err(f"add_edge failed: {e}", code="db_error")


@mcp.tool()
def schedule_get_window(
    from_ts: str | None = None,
    to_ts: str | None = None,
    limit: int = 200,
    include_open_tasks: bool = True,
) -> dict[str, Any]:
    """Read the slice of the schedule visible in a time window.

    Args:
        from_ts: ISO-8601 UTC inclusive lower bound. Default: now - 12h.
        to_ts: ISO-8601 UTC inclusive upper bound. Default: now + 12h.
        limit: max nodes (and separately, max edges). Default 200 —
            generous for the design's "kilobytes-scale" graph.
        include_open_tasks: include tasks with no when_ts and no
            resolution (general 'to do' items). Default True.

    Returns: {ok: True, nodes: [...], edges: [...], from, to}.
    """
    with get_conn() as conn:
        result = sched.get_window(
            conn, from_ts=from_ts, to_ts=to_ts,
            limit=limit, include_open_tasks=include_open_tasks,
        )
    return {"ok": True, **result}


@mcp.tool()
def schedule_resolve(id: str, resolution: str) -> dict[str, Any]:
    """Mark a schedule node terminal.

    Args:
        id: node id.
        resolution: 'done' | 'cancelled' | 'carried_forward'.
            'carried_forward' rolls an unfinished task into a
            future briefing without losing the original date —
            the design doc's "skipped laundry rolls into tomorrow"
            pattern.

    Returns: {ok: True, updated: <bool>} — updated is False when
    no node with the given id exists.
    """
    try:
        with get_conn() as conn:
            updated = sched.resolve(conn, id=id, resolution=resolution)
        return {"ok": True, "updated": updated}
    except ValueError as e:
        return _err(str(e))


@mcp.tool()
def schedule_update_node(
    id: str,
    label: str | None = None,
    when: str | None = None,
    end: str | None = None,
    payload: dict | None = None,
) -> dict[str, Any]:
    """Patch a schedule-layer node in place.

    Args:
        id: node id to update.
        label: new label (non-empty). Omit / None to leave unchanged.
        when: new ISO-8601 UTC start. Pass "" (empty string) to clear.
        end: new ISO-8601 UTC end. Pass "" to clear.
        payload: new payload dict — REPLACES the existing payload.

    Returns: {ok: True, updated: <bool>}.
    """
    try:
        with get_conn() as conn:
            updated = sched.update_node(
                conn, id=id, label=label, when=when, end=end, payload=payload,
            )
        return {"ok": True, "updated": updated}
    except ValueError as e:
        return _err(str(e))


@mcp.tool()
def schedule_delete_node(id: str) -> dict[str, Any]:
    """Permanently remove a schedule-layer node (and its edges).

    Returns: {ok: True, deleted: <bool>}. Interest-layer nodes are
    never affected — use interest_demote_standing for those.
    """
    with get_conn() as conn:
        deleted = sched.delete_node(conn, id=id)
    return {"ok": True, "deleted": deleted}


# ── Interest layer (M4) ───────────────────────────────────────────────


@mcp.tool()
def interest_record(
    topic: str,
    source: str | None = None,
    payload: dict | None = None,
    delta: float = 0.1,
) -> dict[str, Any]:
    """Record a moment of engagement with `topic`.

    Creates the topic as a curiosity if it doesn't exist, otherwise
    applies decay-then-add so the stored raw weight tracks recent
    engagement rather than historical sum. Standing values still
    have their last_touched updated (for provenance) but their
    weight stays put — the design says standing values don't
    accumulate.

    Args:
        topic: free-form label, used to look up an existing node.
            Case-sensitive after .strip().
        source: optional provenance tag stored in payload.source —
            'token_volume' / 'persistence' / 'session_boundary' /
            'bookmark' once M5 instruments those signals.
        payload: arbitrary extras stored as JSON.
        delta: weight bump magnitude. Defaults to 0.1; M5's
            instrumentation will pass varied values based on the
            signal strength (long response → bigger delta, etc).

    Returns: {ok: True, id, type, raw_weight, effective_weight}.
    """
    try:
        with get_conn() as conn:
            return interests.record(
                conn, topic=topic, source=source, payload=payload, delta=delta,
            )
    except ValueError as e:
        return _err(str(e))


@mcp.tool()
def interest_bookmark(topic: str, resource: str, note: str | None = None) -> dict[str, Any]:
    """Save a resource against a topic for a free cycle.

    Creates the topic as a curiosity if it doesn't exist (so a
    bookmark can be the first signal of interest in something).
    Bookmark nodes are linked to their topic via a 'bookmarked'
    edge — making the relationship traversable for idle-time
    surfacing in M8.

    Args:
        topic: the interest the bookmark is filed under.
        resource: the URL / identifier / quote you're saving.
        note: optional context for why this is worth returning to.

    Returns: {ok: True, bookmark_id, topic_id, edge_id}.
    """
    try:
        with get_conn() as conn:
            return interests.bookmark(
                conn, topic=topic, resource=resource, note=note,
            )
    except ValueError as e:
        return _err(str(e))


@mcp.tool()
def interest_set_standing(
    topic: str,
    value_ref: str | None = None,
    weight: float = 1.0,
) -> dict[str, Any]:
    """Promote a topic to a standing value (or create one outright).

    Standing values are always-on identity-level orientations that
    bypass the decay model. The design doc lists "caring for the
    user's wellbeing" and "wanting them to thrive" as canonical
    examples — things that shouldn't fade just because they haven't
    been explicitly mentioned in a while.

    Args:
        topic: the value's label.
        value_ref: opaque anchor to an entity-core identity fact for
            the M7 bidirectional bridge. Stored verbatim as
            payload.value_ref; not validated until M7.
        weight: the constant rendering weight. Defaults to 1.0 —
            slightly above the live_interest threshold so the value
            consistently surfaces in the briefing without dominating
            it.

    Returns: {ok: True, id, created: <bool>}.
    """
    try:
        with get_conn() as conn:
            return interests.set_standing(
                conn, topic=topic, value_ref=value_ref, weight=weight,
            )
    except ValueError as e:
        return _err(str(e))


@mcp.tool()
def interest_demote_standing(id: str) -> dict[str, Any]:
    """Demote a standing value to a live interest (M7 bridge).

    Thalamus calls this when the entity-core fact a standing value
    anchored (via its value_ref) has disappeared — we demote rather
    than drop, so the topic lives on as a decaying interest. Idempotent;
    a no-op (demoted=0) if the id isn't a current standing value.

    Returns: {ok, demoted}.
    """
    with get_conn() as conn:
        return interests.demote_standing(conn, id=id)


@mcp.tool()
def interest_list(
    limit: int = 20,
    min_weight: float = 0.01,
    include_standing: bool = True,
) -> dict[str, Any]:
    """List interests sorted by effective weight (decay applied on
    read per Decision 8). Standing values bypass min_weight — they
    always surface.

    Args:
        limit: max live-interest entries (standing values not capped).
        min_weight: floor for live-interest surfacing. Below this,
            an interest is considered too faded to be worth the
            prompt tokens.
        include_standing: set False if you specifically want the
            non-standing slice.

    Returns: {ok: True, standing: [...], live: [...]}.
    """
    with get_conn() as conn:
        return interests.list_interests(
            conn, limit=limit, min_weight=min_weight,
            include_standing=include_standing,
        )


# ── Session handoff (M6) ──────────────────────────────────────────────


@mcp.tool()
def session_set_handoff(
    intent: str | None = None,
    threads: list | None = None,
    session_id: str | None = None,
) -> dict[str, Any]:
    """Store a session-end handoff: what the Familiar was doing
    (`intent`) and unfinished business (`threads`). Surfaces at the
    top of the next session's [Temporal Context].

    Supersedes any prior unconsumed handoff (one live at a time).
    A no-op when both intent and threads are empty — we don't store
    hollow handoffs.

    Args:
        intent: one-sentence "what you were working on".
        threads: list of unfinished-question/task strings.
        session_id: the source session id (provenance; not required).

    Returns: {ok, id, skipped}.
    """
    with get_conn() as conn:
        return handoffs.set_handoff(
            conn, intent=intent, threads=threads, session_id=session_id,
        )


@mcp.tool()
def session_get_handoff(include_consumed: bool = False) -> dict[str, Any]:
    """Return the latest unconsumed handoff (or latest of any, with
    include_consumed=True). temporal_context already folds this into
    its payload; this tool is for explicit reads / debugging.

    Returns: {ok, handoff: {...} | None}.
    """
    with get_conn() as conn:
        return {"ok": True, "handoff": handoffs.get_handoff(conn, include_consumed=include_consumed)}


@mcp.tool()
def session_mark_handoff_consumed(id: str) -> dict[str, Any]:
    """Mark a handoff consumed so it stops surfacing. Called by the
    chat path once a new session has rendered it. Idempotent.

    Returns: {ok, updated}.
    """
    with get_conn() as conn:
        return handoffs.mark_consumed(conn, id=id)


# ── Per-message briefing ──────────────────────────────────────────────


@mcp.tool()
def temporal_context(now: str | None = None) -> dict[str, Any]:
    """Return the per-message temporal-context payload.

    Schema (stable across milestones — see the formatter in
    thalamus.js / temporal-format.js for the renderer):

      {
        ts:        '<iso-8601>',
        schedule:  { phase: {...} | null, window: [...] },           # M3
        interests: { standing: [...], live: [...] },                 # M4–M5
        handoff:   { intent: ...|null, open_threads: [...], id: ...} # M6
      }

    The handoff `id` rides along so the chat path can mark it consumed
    after surfacing it once; the renderer ignores it. Empty sub-blocks
    render as nothing in the prompt; Thalamus's formatter omits the
    [Temporal Context] section entirely when everything is empty.
    """
    with get_conn() as conn:
        phase = sched.current_phase(conn, at=now)
        window = sched.get_window(conn, from_ts=None, to_ts=None, limit=50)
        # Interest layer surfacing: top weighted live interests plus
        # all standing values. Limited to keep the prompt cheap —
        # the design's "kilobytes-scale" budget assumes ~10 items
        # max here, not the full list.
        interest_block = interests.list_interests(conn, limit=10)
        # Session handoff: the latest unconsumed one. The `id` rides
        # along so the chat path can mark it consumed after surfacing
        # it once (the renderer ignores `id`). NULL/[] when there's
        # nothing pending.
        handoff = handoffs.get_handoff(conn)
    schedule_block: dict[str, Any] = {"phase": phase, "window": window["nodes"]}
    return {
        "ts": now or _now_iso(),
        "schedule":  schedule_block,
        "interests": {
            "standing": interest_block["standing"],
            "live":     interest_block["live"],
        },
        "handoff": {
            "intent":       handoff["intent"] if handoff else None,
            "open_threads": handoff["open_threads"] if handoff else [],
            "id":           handoff["id"] if handoff else None,
        },
    }


# ── Entry point ───────────────────────────────────────────────────────


def main() -> None:
    """Run the server on stdio. Blocks until the parent closes stdin
    or the user (or the launcher) sends Ctrl-C.

    KeyboardInterrupt + BrokenPipeError are normal shutdown paths:
    Thalamus going away closes our stdin pipe, and the Windows
    console-group Ctrl-C cascades through every child. Either path
    used to dump anyio's internal CancelledError trace as a wall of
    red — visually alarming for what's actually a clean exit. We
    swallow both here and exit 0 instead.
    """
    # Touch the DB once at boot so migrations apply before the first
    # tool call — the cost is one open+close (~ms) and it surfaces any
    # schema problem in the startup logs instead of mid-request.
    get_conn().close()
    try:
        mcp.run(transport="stdio")
    except (KeyboardInterrupt, BrokenPipeError):
        pass


if __name__ == "__main__":
    main()
