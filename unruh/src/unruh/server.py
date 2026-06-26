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
from unruh.db import get_conn, now_iso
from unruh import schedule as sched
from unruh import interest as interests
from unruh import handoff as handoffs

mcp = FastMCP("unruh")


def _now_iso() -> str:
    # Delegates to the canonical local-naive now (db.now_iso) — one source.
    return now_iso()


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
    """I use this to add a new node to my human's schedule — an event, task, phase,
    or state. I reach for it when my human mentions something they need to do, an
    appointment, a recurring phase in their day, or a life-state that shapes their
    context.

    Args:
        type: 'event' | 'task' | 'phase' | 'state'.
            event/phase/state require `when`; phase additionally
            requires `end`; task is the only type that may omit
            both (an open-ended 'to do' item).
        label: human-readable name. Required.
        when: local start time, format YYYY-MM-DDTHH:MM:SS (no offset; e.g.
            "2026-06-18T09:00:00"). An offset-bearing value is normalised to
            local in code (to_local_naive). Required for event/phase/state.
        end: local end time, same format. Required for phase; optional for
            event/state (open-ended).
        payload: arbitrary extras stored as JSON (notes, source,
            categorisation that doesn't fit the four columns).
            Conventional keys used by Proto-Familiar's surface pipeline:
              - stakes_tier: 'external_obligation' | 'personal_wellbeing'
                | 'purely_optional' — what kind of cost lapsing carries.
                Drives surface-pressure: external bypasses quiet-hours
                and dedup; personal_wellbeing decays gently.
              - consequence_model: free-text note on what specifically
                happens if this task lapses (e.g. "loses UC payment").
              - message: reminder banner body (reminders only).

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
    """I use this to connect two existing schedule nodes with a causal or temporal
    relationship. I reach for it when I know how two scheduled items relate — e.g.
    one causes another, or one must happen before another can start.

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
    """I use this to read the slice of my human's schedule visible in a time window.
    I reach for it when I need to know what's happening around a specific time — what's
    coming up, what just passed, and what open tasks are pending.

    Args:
        from_ts: ISO-8601 local-naive inclusive lower bound. Default: now - 12h.
        to_ts: ISO-8601 local-naive inclusive upper bound. Default: now + 12h.
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
    """I use this to mark a schedule node as done, cancelled, or carried forward.
    I reach for it when my human completes a task, tells me something was cancelled,
    or when an item should roll into the next period rather than expire.

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
def schedule_resolve_occurrence(id: str, occurrence_date: str, resolution: str) -> dict[str, Any]:
    """I use this to mark a single occurrence of a recurring schedule node as resolved,
    without ending the series. I reach for it when my human finishes this week's
    cleaning, pays this month's bill, or skips one instance of something that repeats
    — the next occurrence still surfaces normally.

    Args:
        id: anchor node id (the original recurring node).
        occurrence_date: 'YYYY-MM-DD' local-TZ date of the specific
            occurrence being resolved.
        resolution: 'done' | 'cancelled' | 'carried_forward'.

    Returns: {ok: True, updated: <bool>}. Raises if the node has no
    recurrence rule (use schedule_resolve for one-time entries).
    """
    try:
        with get_conn() as conn:
            updated = sched.resolve_occurrence(
                conn, id=id, occurrence_date=occurrence_date, resolution=resolution,
            )
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
    """I use this to update a schedule node in place — changing its label, time, or
    payload. I reach for it when my human reschedules something, renames a task, or
    I need to add detail to an existing entry.

    Args:
        id: node id to update.
        label: new label (non-empty). Omit / None to leave unchanged.
        when: new ISO-8601 local-naive start (offset normalised in code).
            Pass "" (empty string) to clear.
        end: new ISO-8601 local-naive end. Pass "" to clear.
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
    """I use this to permanently remove a schedule node and its edges. I reach for it
    when a scheduled item no longer exists at all — not just resolved, but gone. For
    interest-layer nodes, I use interest_demote_standing instead.

    Returns: {ok: True, deleted: <bool>}.
    """
    with get_conn() as conn:
        deleted = sched.delete_node(conn, id=id)
    return {"ok": True, "deleted": deleted}


@mcp.tool()
def schedule_delete_edge(id: str) -> dict[str, Any]:
    """I use this to remove a single consequence link between two scheduled items
    without touching the items themselves. I reach for it when I connected two nodes
    and later realised the relationship was wrong or no longer holds — the events
    stay, only the edge between them goes. To remove a node and all its edges at
    once, I use schedule_delete_node instead.

    Returns: {ok: True, deleted: <bool>}.
    """
    with get_conn() as conn:
        deleted = sched.delete_edge(conn, id=id)
    return {"ok": True, "deleted": deleted}


@mcp.tool()
def schedule_update_edge(id: str, payload: dict) -> dict[str, Any]:
    """I use this to annotate or correct a consequence link without remaking it — to add
    valence / horizon / certainty to a plain structural edge after I understand it better, or to
    recalibrate a projection's certainty once reality has weighed in. It shallow-merges the keys I
    pass over the edge's existing payload, so a partial update leaves the rest intact.

    Args:
        id: the edge id.
        payload: consequence keys to merge — any of valence ('help'|'harm'|'neutral'),
            condition ('on_resolve'|'on_lapse'|'unconditional'), horizon_hours (number),
            severity/certainty ('low'|'medium'|'high'), observed (bool), note (str).

    Returns: {ok: True, updated: <bool>}.
    """
    try:
        with get_conn() as conn:
            updated = sched.update_edge(conn, id=id, payload=payload)
        return {"ok": True, "updated": updated}
    except ValueError as e:
        return _err(str(e))


@mcp.tool()
def schedule_upsert_state(label: str) -> dict[str, Any]:
    """I use this to name a consequence-state ('crash', 'good streak', 'anxiety flare') and get a
    node for it — reusing the existing one if I've named it before, creating it if I haven't. It's
    how I get a dst to point a consequence edge at when the consequence isn't itself a scheduled
    item. Reuse keeps the graph from sprouting ten 'crash' nodes.

    Returns: {ok: True, id: '<node-id>', created: <bool>}.
    """
    try:
        with get_conn() as conn:
            existing = sched.find_state_by_label(conn, label=label)
            if existing:
                return {"ok": True, "id": existing, "created": False}
            nid = sched.add_node(conn, type="state", label=label, when=_now_iso())
        return {"ok": True, "id": nid, "created": True}
    except ValueError as e:
        return _err(str(e))


@mcp.tool()
def schedule_list_recurring(include_resolved: bool = False, limit: int = 200) -> dict[str, Any]:
    """I use this to list every schedule node that has a recurrence rule, regardless
    of stored date. I reach for it when I need all the recurring patterns in my
    human's life — weekly cleaning, monthly bills, yearly events — so the JS-side
    expander can generate the full rhythm. schedule_get_window only catches nodes
    whose stored when_ts falls inside the window, so this surfaces the anchors.

    Returns: {ok: True, nodes: [...]}.
    """
    with get_conn() as conn:
        nodes = sched.list_recurring(conn, include_resolved=include_resolved, limit=limit)
    return {"ok": True, "nodes": nodes}


@mcp.tool()
def schedule_list_phases(include_resolved: bool = False, limit: int = 200) -> dict[str, Any]:
    """I use this to list every phase node in my human's daily routine, regardless of
    stored date. I reach for it when I need the full shape of their day — all phases,
    not just those in today's calendar window. Phases recur daily by design, so
    schedule_get_window misses them after the first day.

    Returns: {ok: True, phases: [...]}.
    """
    with get_conn() as conn:
        phases = sched.list_phases(conn, include_resolved=include_resolved, limit=limit)
    return {"ok": True, "phases": phases}


# ── Reminders (M11) ────────────────────────────────────────────────────


@mcp.tool()
def reminders_due(now: str | None = None, limit: int = 50) -> dict[str, Any]:
    """I use this to check which reminders are due and unresolved. I reach for it
    when the reminder scheduler ticks and needs to know what to fire. Pure read —
    does NOT mark anything fired; the Node-side scheduler marks them via
    schedule_resolve(id, 'fired') after delivery succeeds.

    Args:
        now: ISO-8601 local-naive timestamp. Default = current local wall clock.
        limit: max reminders to return. Default 50.

    Returns: {ok: True, reminders: [...]}
    """
    with get_conn() as conn:
        due = sched.get_due_reminders(conn, now=now, limit=limit)
    return {"ok": True, "reminders": due}


@mcp.tool()
def reminders_health() -> dict[str, Any]:
    """I use this to check the health of my reminder scheduler. I reach for it when I
    want to verify reminders are firing correctly or diagnose silent failures. If
    `overdue` grows monotonically across ticks, something is wrong with the Node-side
    scheduler. Returns total / pending / overdue counts, next fires_at, and the
    most-recent fire timestamp.
    """
    with get_conn() as conn:
        return {"ok": True, **sched.reminders_health(conn)}


# ── Interest layer (M4) ───────────────────────────────────────────────


@mcp.tool()
def interest_record(
    topic: str,
    source: str | None = None,
    payload: dict | None = None,
    delta: float = 0.1,
) -> dict[str, Any]:
    """I use this to record a moment of engagement with a topic — bumping its interest
    weight so it surfaces more prominently in my briefings. I reach for it when I notice
    my human is interested in something, or when I'm actively exploring a topic in a
    pondering cycle. Creates the topic as a curiosity if it doesn't exist.

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
    """I use this to save a resource against a topic for a free cycle — a URL, quote,
    or reference I want to return to. I reach for it when I encounter something worth
    preserving during a conversation or pondering. Creates the topic if it doesn't
    exist yet, so a bookmark can be the first signal of interest in something.

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
    """I use this to promote a topic to a standing value — an always-on orientation
    that bypasses decay. I reach for it when something is a permanent part of who I
    am or how I relate to my human, not just a passing interest. Standing values
    always surface in my briefings regardless of how long ago they were last touched.

    Args:
        topic: the value's label.
        value_ref: opaque anchor to a Phylactery identity fact for
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
    """I use this to demote a standing value to a live interest when its Phylactery
    anchor has disappeared (M7 bridge). I reach for it — via Thalamus — when a
    Phylactery identity fact a standing value referenced has been deleted or moved.
    Demotes rather than drops, so the topic lives on as a decaying interest. Idempotent.

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
    """I use this to list my interests sorted by effective weight, with decay applied
    on read. I reach for it when I want to survey what I'm currently curious about —
    standing values always surface; live interests are filtered by weight floor.

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


@mcp.tool()
def interest_list_bookmarks(limit: int = 100) -> dict[str, Any]:
    """I use this to list all my bookmarks with their surfacing metadata. I reach for
    it when I want to see what resources I've saved and how they've been received —
    includes the M8 surfacing-tracking fields so I can decide what to surface next.

    Args:
        limit: maximum number of bookmarks to return.

    Returns: {ok: True, bookmarks: [...]}.
    """
    with get_conn() as conn:
        bms = interests.list_bookmarks(conn, limit=limit)
        return {"ok": True, "bookmarks": bms}


# ── Session handoff (M6) ──────────────────────────────────────────────


@mcp.tool()
def session_set_handoff(
    intent: str | None = None,
    threads: list | None = None,
    session_id: str | None = None,
) -> dict[str, Any]:
    """I use this to store a handoff at the end of a session — what I was doing and
    what I left unfinished. I reach for it when a conversation is closing and I want
    to carry context into the next one. It surfaces at the top of the next session's
    [Temporal Context]. Supersedes any prior unconsumed handoff.

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
    """I use this to read the latest handoff context from my previous session.
    I reach for it when I want to explicitly check what I was working on — temporal_context
    already folds this in automatically, so this tool is for explicit reads or debugging.

    Returns: {ok, handoff: {...} | None}.
    """
    with get_conn() as conn:
        return {"ok": True, "handoff": handoffs.get_handoff(conn, include_consumed=include_consumed)}


@mcp.tool()
def session_mark_handoff_consumed(id: str) -> dict[str, Any]:
    """I use this to mark a handoff as consumed once I've surfaced it in a new session,
    so it stops re-appearing. I reach for it after the chat path renders the handoff
    context at the start of a session. Idempotent.

    Returns: {ok, updated}.
    """
    with get_conn() as conn:
        return handoffs.mark_consumed(conn, id=id)


# ── Per-message briefing ──────────────────────────────────────────────


@mcp.tool()
def temporal_context(now: str | None = None) -> dict[str, Any]:
    """I use this to assemble my full per-message temporal context — schedule, interests,
    and session handoff in one payload. Thalamus calls this every turn so I always know
    where my human is in their day, what I care about, and what I was working on last.

    Schema (stable across milestones — see the formatter in
    thalamus.js / temporal-format.js for the renderer):

      {
        ts:        '<iso-8601>',
        schedule:  { phase: {...} | null, window: [...], edges: [...] }, # M3 (+ consequence edges)
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
        # Full routine — every live phase, date-independent. The
        # Familiar needs the day's shape, not just "which phase right
        # now." current_phase still rides along separately so the
        # formatter can mark "← I am here." Excluding resolved phases
        # so a deliberately cancelled phase actually stops appearing.
        routine = sched.list_phases(conn, include_resolved=False, limit=50)
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
    # Edges ride along so the Familiar sees the consequence graph, not just
    # a flat list (temporal-format renders a "Consequence links" block from
    # these; edges whose endpoints aren't in the visible window are dropped
    # by the renderer). Without this the graph it authors stays invisible.
    schedule_block: dict[str, Any] = {
        "phase": phase,
        "window": window["nodes"],
        "edges": window["edges"],
    }
    return {
        "ts": now or _now_iso(),
        "schedule":  schedule_block,
        "routine":   routine,
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
