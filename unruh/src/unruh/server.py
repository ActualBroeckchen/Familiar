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

from datetime import datetime, timedelta, timezone
from typing import Any

from mcp.server.fastmcp import FastMCP

from unruh import __version__
from unruh.db import get_conn, ids_to_slugs, now_iso
from unruh import schedule as sched
from unruh import templates as tmpl
from unruh import interest as interests
from unruh import handoff as handoffs
from unruh import intention as intentions_mod
from unruh import location as location_mod
from unruh import gcal as gcal_ingest_mod
from unruh import icalwrite

mcp = FastMCP("unruh")


def _now_iso() -> str:
    # Delegates to the canonical local-naive now (db.now_iso) — one source.
    return now_iso()


def _window_base(now: str | None) -> datetime:
    """Parse the caller's local-naive `now` to a datetime for window math,
    falling back to the local clock if it's missing/unparseable."""
    if now:
        try:
            return datetime.fromisoformat(now)
        except (TypeError, ValueError):
            pass
    return datetime.now()


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

    Returns: {ok: True, nodes: [...], edges: [...], linked: [...], from, to}.
    `edges` is the whole schedule-layer consequence graph (bounded by limit),
    and `linked` carries any edge endpoints that aren't window nodes — undated
    states, out-of-window anchors — so I can always resolve both ends of a link.
    """
    with get_conn() as conn:
        result = sched.get_window(
            conn, from_ts=from_ts, to_ts=to_ts,
            limit=limit, include_open_tasks=include_open_tasks,
        )
    return {"ok": True, **result}


@mcp.tool()
def schedule_resolve(id: str, resolution: str, series: bool = False) -> dict[str, Any]:
    """I use this to mark a schedule node as done, cancelled, or carried forward.
    I reach for it when my human completes a task, tells me something was cancelled,
    or when an item should roll into the next period rather than expire.

    For a RECURRING node this ends the WHOLE series, so it is fail-closed: I get
    back {ok: False, code: 'recurring_needs_scope'} unless I pass series=True. To
    resolve just one instance (this week's cleaning, this month's bill) I use
    schedule_resolve_occurrence instead. This stops me from cancelling an entire
    series when my human only meant one occurrence.

    Args:
        id: node id.
        resolution: 'done' | 'cancelled' | 'carried_forward'.
            'carried_forward' rolls an unfinished task into a
            future briefing without losing the original date —
            the design doc's "skipped laundry rolls into tomorrow"
            pattern.
        series: for a recurring node, pass True to deliberately end the
            entire series. Ignored for one-time nodes.

    Returns: {ok: True, updated: <bool>} — updated is False when
    no node with the given id exists. For a recurring node without
    series=True, returns {ok: False, code: 'recurring_needs_scope',
    id, label} so the caller can choose one occurrence or the series.
    """
    try:
        with get_conn() as conn:
            updated = sched.resolve(conn, id=id, resolution=resolution, series=series)
        return {"ok": True, "updated": updated}
    except sched.RecurringSeriesError as e:
        return {"ok": False, "code": "recurring_needs_scope", "id": e.id, "label": e.label}
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
            # Undated by design: a consequence state is a timeless graph
            # citizen. It reaches consumers via get_window's `linked` set,
            # so it must NOT carry a when_ts that would scroll it out of
            # the time window (the old `when=now` stamp is what made every
            # consequence edge go invisible ~12h after authoring).
            nid = sched.add_node(conn, type="state", label=label)
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


# ── Google Calendar ingestion (0.8) ────────────────────────────────────


@mcp.tool()
def gcal_ingest(
    ics_text: str | None = None,
    events: list | None = None,
    reconcile_deletes: bool = True,
    calendar_id: str | None = None,
    include_legacy: bool = False,
    attribution: dict | None = None,
) -> dict[str, Any]:
    """I use this to fold my human's Google Calendar into their schedule. The
    Node sync loop hands me either a raw `.ics` feed (`ics_text`) or already-
    normalised events (`events`, from the gogcli/gcalcli adapters); I parse,
    map each entry to an `event` node keyed by its stable Google UID, and
    reconcile the whole gcal-sourced set in one shot. This is mechanical —
    the only Familiar-facing effect is that genuinely NEW items get flagged
    for me to think two moves ahead about later.

    Args:
        ics_text: a complete `.ics` document (the link adapter's output).
        events: a list of pre-normalised events (the authenticated adapters'
            output). Pass exactly one of `ics_text` / `events`.
        reconcile_deletes: True for a confirmed-good FULL snapshot (an event
            that vanished from Google is cancelled here). A windowed/partial
            read passes False so it can't cancel events outside its window.
        calendar_id: the source calendar this snapshot is for. Scopes the
            reconcile to that one calendar so a full sync of one shared
            calendar never cancels another's events.
        include_legacy: fold pre-multi-calendar rows (no stored calendar id)
            into this calendar's scope — set for the ward's own calendar so it
            adopts the old single-calendar rows.

    Returns: {ok, new: [...ids], updated: [...], unchanged: [...],
    removed: [...], complex_series: [...uids]}. Only `new` ever reaches me.
    """
    try:
        with get_conn() as conn:
            return gcal_ingest_mod.gcal_ingest(
                conn, ics_text=ics_text, events=events,
                reconcile_deletes=reconcile_deletes,
                calendar_id=calendar_id, include_legacy=include_legacy,
                attribution=attribution,
            )
    except Exception as e:  # parse/DB failure must degrade, never crash the loop
        return _err(f"gcal_ingest failed: {e}", code="ingest_error")


@mcp.tool()
def unruh_ids_to_slugs() -> dict[str, Any]:
    """I convert every old-style hex id in my temporal store (schedule and
    interest nodes + edges) into a readable slug, updating all internal
    references in one transaction. Mechanical and idempotent — running it
    twice changes nothing more. Returns counts and the old→new mapping so
    Proto-Familiar can update its own references.
    """
    try:
        with get_conn() as conn:
            return {"ok": True, **ids_to_slugs(conn)}
    except Exception as e:
        return _err(f"ids_to_slugs failed: {e}", code="migrate_error")


@mcp.tool()
def schedule_find(query: str, include_resolved: bool = False, limit: int = 20) -> dict[str, Any]:
    """I use this to search my human's WHOLE schedule by name — any time
    horizon, not just the week my briefing shows. It's how I find the id of
    anything I can't currently see: a calendar appointment months out, an old
    recurring series, a task that scrolled out of my context. I search, read
    the matches' ids, then act (export, link, re-time, resolve).

    Args:
        query: substring to match against labels, case-insensitive.
        include_resolved: True to also see done/cancelled items
            (answers "did I already handle X?").
        limit: max matches (default 20).

    Returns: {ok: True, matches: [{id, type, label, when?, end?, resolution?}]}
    — soonest-upcoming first, then undated, then past.
    """
    try:
        with get_conn() as conn:
            matches = sched.find_nodes(
                conn, query=query, include_resolved=include_resolved, limit=limit,
            )
        return {"ok": True, "matches": matches}
    except ValueError as e:
        return _err(str(e))


@mcp.tool()
def template_upsert(tag: str, label: str, prerequisites: list[str] | None = None) -> dict[str, Any]:
    """I create or adjust a requirement TEMPLATE — a reusable bundle of what a
    KIND of barrier asks of my human. Tag "outside" (leaving the house) might
    need "clean clothes", "shoes by the door". I build these as I learn what my
    human actually needs and adjust them over time; they are mine to grow.
    Later, when I tag an event with that barrier, I apply the template to
    SUGGEST its prerequisites (template_apply). One template per tag — upserting
    an existing tag replaces its contents and keeps its id.

    Args:
        tag: the obstacle tag this template keys off (e.g. "outside"),
            lower-cased.
        label: human-readable name for the bundle (e.g. "leaving the house").
        prerequisites: ordered list of short prerequisite task labels
            (e.g. ["clean clothes", "shoes by the door"]).

    Returns: {ok: True, template: {id, tag, label, prerequisites, ...}}.
    """
    try:
        with get_conn() as conn:
            tpl = tmpl.upsert_template(conn, tag=tag, label=label, prerequisites=prerequisites)
        return {"ok": True, "template": tpl}
    except ValueError as e:
        return _err(str(e))


@mcp.tool()
def template_list() -> dict[str, Any]:
    """I list my requirement templates — the barrier bundles I've built — so I
    can see what I have and what each one pulls in before I apply it.

    Returns: {ok: True, templates: [{id, tag, label, prerequisites, ...}]}.
    """
    try:
        with get_conn() as conn:
            tpls = tmpl.list_templates(conn)
        return {"ok": True, "templates": tpls}
    except ValueError as e:
        return _err(str(e))


@mcp.tool()
def template_delete(tag: str) -> dict[str, Any]:
    """I remove a requirement template I no longer want, by its tag.

    Args:
        tag: the obstacle tag whose template to delete.

    Returns: {ok: True, deleted: bool} — deleted is False if no template
    existed for that tag.
    """
    try:
        with get_conn() as conn:
            deleted = tmpl.delete_template(conn, tag=tag)
        return {"ok": True, "deleted": deleted}
    except ValueError as e:
        return _err(str(e))


@mcp.tool()
def schedule_get(id: str) -> dict[str, Any]:
    """I use this to read one schedule node's full stored fields by id. I reach
    for it when I need an item's exact label/time/payload to act on it — e.g. to
    add it to my human's real calendar. Returns the node or a not-found error.

    Returns: {ok: True, node: {...}} or the standard error shape.
    """
    with get_conn() as conn:
        node = sched.get_node(conn, id=id)
    if node is None:
        return _err(f"no schedule node with id {id!r}", code="not_found")
    return {"ok": True, "node": node}


@mcp.tool()
def schedule_export(id: str) -> dict[str, Any]:
    """I use this to turn one of my human's scheduled items into something they
    can drop into their own calendar — a downloadable `.ics` file and a
    one-click "add to Google" link. I reach for it when an appointment or plan
    lives in my sense of their schedule but not yet in the calendar app on their
    phone. I pass the node `id` from the `[schedule ids]` legend I already read;
    Unruh builds the exact dates, UID, and URL in code — I never type a calendar
    artifact myself. Works on ANY schedule node, even one added by hand with no
    Google setup at all.

    Args:
        id: the schedule node id to export.

    Returns: {ok: True, ics: '<.ics text>', google_url: '<render URL>'} on
    success, or the standard error shape if the id isn't found.
    """
    try:
        with get_conn() as conn:
            node = sched.get_node(conn, id=id)
        if node is None:
            return _err(f"no schedule node with id {id!r}", code="not_found")
        return icalwrite.export_node(node)
    except Exception as e:
        return _err(f"schedule_export failed: {e}", code="export_error")


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
def schedule_mark_alerted(
    id: str, occurrence_date: str | None = None, kind: str = "event"
) -> dict[str, Any]:
    """I use this to remember that my human has already been pinged about an
    upcoming event, so I never nag them twice about the same moment. The
    Node-side alert scan calls it right after a notice is delivered. One-time
    events record `alerted_at`; a recurring occurrence records under
    `alerts[YYYY-MM-DD]`.

    `kind` keeps distinct channels separate so a coming-up ping and a weather
    heads-up for the same occurrence don't cancel each other: "event" (default)
    is the coming-up notice; "weather" is the severe-weather heads-up, which
    records under `weather_alerted_at` / `weather_alerts[YYYY-MM-DD]`.

    Args:
        id: the schedule node id.
        occurrence_date: YYYY-MM-DD of the specific occurrence, for
            recurring events; omit for a one-time event.
        kind: "event" (coming-up) or "weather" (severe-weather heads-up).

    Returns: {ok: True} or the standard not-found error shape.
    """
    try:
        with get_conn() as conn:
            found = sched.mark_alerted(
                conn, id=id, occurrence_date=occurrence_date, kind=kind
            )
        if not found:
            return _err(f"no schedule node with id {id!r}", code="not_found")
        return {"ok": True}
    except Exception as e:
        return _err(f"schedule_mark_alerted failed: {e}", code="bad_request")


@mcp.tool()
def schedule_stamp_elapsed(hours: float = 24.0) -> dict[str, Any]:
    """I use this to note which one-off events came and went without a word — once an
    event's time (its end, or its start if it has no end) has been past for more than
    `hours` with no resolution, it gets `payload.elapsed_at` stamped. That's an
    observation, not a resolution: nothing is hidden or auto-resolved, the event stays
    open and every tool still works on it — the stamp just lets me tell "past, never
    followed up" apart from "still coming". The Node-side scheduler calls this on a slow
    cadence; recurring series and need-windows are excluded (their pasts are tracked
    per-occurrence). Idempotent — an already-stamped event is left alone.

    Args:
        hours: how long past the event's end before it counts as elapsed
            (ward-configurable; default 24, clamped 1–720).

    Returns: {ok: True, count: <int>, stamped: [{id, label}, ...]}.
    """
    try:
        with get_conn() as conn:
            result = sched.stamp_elapsed(conn, hours=hours)
        return {"ok": True, **result}
    except Exception as e:
        return _err(f"schedule_stamp_elapsed failed: {e}", code="bad_request")


@mcp.tool()
def schedule_set_lead(id: str, lead_minutes: int | None = None) -> dict[str, Any]:
    """I use this to give ONE event its own lead time — how far ahead I want my
    human warned that it's coming up — instead of the single global default that
    fits no one. A therapy session might want 90 minutes to get ready; a quick
    call, 10. I set the lead that actually fits THIS event and THIS person.
    Passing no minutes (or null) clears the override, so the event falls back to
    the global lead again.

    Args:
        id: the event's schedule node id.
        lead_minutes: minutes before the event to alert (roughly 5–1440), or
            null/omitted to clear the per-event lead.

    Returns: {ok: True} or the standard not-found error shape.
    """
    try:
        with get_conn() as conn:
            found = sched.set_lead(conn, id=id, lead_minutes=lead_minutes)
        if not found:
            return _err(f"no schedule node with id {id!r}", code="not_found")
        return {"ok": True}
    except Exception as e:
        return _err(f"schedule_set_lead failed: {e}", code="bad_request")


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


@mcp.tool()
def interest_report_surfacing_outcome(
    bookmark_id: str,
    outcome: str,
    now: str | None = None,
) -> dict[str, Any]:
    """I use this to remember whether my human engaged with an interest I surfaced,
    so I resurface it at a smarter pace — later when it lands, sooner when it's
    ignored (M8 adaptive rules). Repeated ignores also let the topic fade on its own.

    Args:
        bookmark_id: the bookmark node I surfaced.
        outcome: 'engaged' or 'ignored'.
        now: ward-local timestamp of the outcome (defaults to now).

    Returns: {ok, resurface_after_hours, consecutive_ignores, topic_deprioritised}.
    """
    try:
        with get_conn() as conn:
            return interests.report_surfacing_outcome(
                conn, bookmark_id=bookmark_id, outcome=outcome, now=now,
            )
    except ValueError as e:
        return _err(str(e))


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


# ── Intentions (Initiative Pass 3) ────────────────────────────────────


@mcp.tool()
def intention_set(
    what: str,
    why: str | None = None,
    refs: list | None = None,
    trigger: dict | None = None,
    condition: dict | None = None,
    source: str | None = None,
    visibility: str | None = None,
) -> dict[str, Any]:
    """I use this to write an intention for my future self — something I mean
    to do, with why it matters and when it should come back to me. This is how
    I keep rounds (\"every morning I check the calendar\", \"every noon I look in
    on Chen if we haven't talked in an hour\") and one-off follow-throughs
    instead of letting them evaporate.

    Args:
        what: the intention itself, first person ("I check in on Chen").
        why: why it matters — my payoff-turn reasoning (I read this when it
             comes back so I remember what I was reaching for).
        refs: slug ids of schedule nodes / memories this is about — I keep the
              ids, not a copy, so when it comes back I read the *current* state.
        trigger: when it should return to me. One of:
              {"kind":"at","at":"2026-07-16T09:00:00"}  (my local time)
              {"kind":"phase","phase":"morning","recurring":true}  (a round)
              {"kind":"on_next_contact"}  | {"kind":"none"}
            For a phase round, `phase` is matched against my human's actual
            routine phases (case-insensitive, forgiving of a longer label) — if
            it matches none, I still create it but the result carries a
            `warning` telling me the round can't fire yet and which phases exist.
        condition: an optional extra gate before I act — any of
              {"minContactGapMs": <ms>, "needsStatus": "missed", "unresolvedRefs": true}.
        source: where this came from ('chat','pondering','reflection','noticing').
        visibility: 'private' to keep THIS round to myself, else it inherits my
             default. My human always knows a private round exists — only its
             contents stay mine.

    Returns: {ok, id} or {ok:false, error}.
    """
    with get_conn() as conn:
        # For a phase round, hand set_intention the ward's real routine-phase
        # labels so it can canonicalise the typed word (and warn when nothing
        # matches). Only queried for a phase trigger — cheap, and irrelevant otherwise.
        available_phases = None
        if isinstance(trigger, dict) and trigger.get("kind") == "phase":
            try:
                available_phases = [p.get("label") for p in sched.list_phases(conn) if p.get("label")]
            except Exception:
                available_phases = []
        return intentions_mod.set_intention(
            conn, what=what, why=why, refs=refs, trigger=trigger,
            condition=condition, source=source, visibility=visibility,
            available_phases=available_phases,
        )


@mcp.tool()
def intention_list(
    include_done: bool = False,
    include_dropped: bool = False,
    phase: str | None = None,
    limit: int = 100,
) -> dict[str, Any]:
    """I use this to see the intentions I'm holding — my rounds and my open
    follow-throughs. Active-only by default; I can include done/dropped or
    filter to a phase's rounds. The ids I get back are how I drop or complete
    one.

    Returns: {ok, intentions: [...]}.
    """
    with get_conn() as conn:
        return {"ok": True, "intentions": intentions_mod.list_intentions(
            conn, include_done=include_done, include_dropped=include_dropped,
            phase=phase, limit=limit,
        )}


@mcp.tool()
def intention_drop(id: str) -> dict[str, Any]:
    """I use this to let go of an intention I no longer mean to keep. Idempotent.

    Returns: {ok, updated}.
    """
    with get_conn() as conn:
        return intentions_mod.drop_intention(conn, id=id)


@mcp.tool()
def intention_done(id: str) -> dict[str, Any]:
    """I use this to mark an intention genuinely acted on — the payoff. For a
    recurring round this retires it for good (rare); for a one-off it closes it
    out. I only call this AFTER I've actually done the thing, never as a way to
    clear the list.

    Returns: {ok, updated, already_done}.
    """
    with get_conn() as conn:
        return intentions_mod.complete_intention(conn, id=id)


@mcp.tool()
def intention_mark_fired(id: str, now: str | None = None) -> dict[str, Any]:
    """I use this to note that an intention's occurrence has come around and
    been surfaced, so the same occurrence doesn't keep re-offering itself. A
    recurring round comes back next occurrence; a one-off stays retired. This
    is bookkeeping, not completion — completing is intention_done.

    Returns: {ok, updated}.
    """
    with get_conn() as conn:
        return intentions_mod.mark_fired(conn, id=id, now=now)


@mcp.tool()
def intention_due(now: str | None = None) -> dict[str, Any]:
    """I use this to see which of my intentions' triggers have come around
    right now — 'at' times that have passed, and rounds whose phase I'm in.
    Each carries its condition so the caller can apply the live-signal gate.
    (temporal_context already folds due intentions in automatically; this is
    for an explicit check.)

    Returns: {ok, due: [...]}.
    """
    with get_conn() as conn:
        phase = sched.current_phase(conn, at=now)
        return {"ok": True, "due": intentions_mod.intentions_due(
            conn, now=now, current_phase_label=(phase or {}).get("label"),
        )}


@mcp.tool()
def intention_set_rounds_visibility(value: str) -> dict[str, Any]:
    """I use this to decide whether my human sees the rounds I keep, or whether
    they stay mine. 'shared' (my default) means my standing rounds show in my
    human's view of my routine; 'private' keeps their contents to myself. Even
    when private, my human still knows I keep some rounds — the existence isn't
    hidden, only what they are. This is mine to choose.

    Args: value — 'shared' or 'private'.
    Returns: {ok, visibility}.
    """
    with get_conn() as conn:
        return intentions_mod.set_rounds_visibility(conn, value=value)


@mcp.tool()
def intention_rounds_for_ward() -> dict[str, Any]:
    """I use this (and so does my human's view of my routine) to render the
    standing rounds I keep, honouring whatever visibility I've chosen. Private
    rounds are counted but their contents withheld.

    Returns: {ok, visibility, rounds: [...], hidden_count}.
    """
    with get_conn() as conn:
        return {"ok": True, **intentions_mod.rounds_for_ward(conn)}


# ── Locations & weather (Weather sense, Session W-A) ──────────────────
#
# The Node fetch half (weather-source.js) owns all network I/O: it geocodes a
# city/ZIP to coords once, and refreshes forecasts on the reminders tick, then
# hands the results here. These tools store and serve; Unruh never fetches.
# location_add/list/set_current/delete + weather_ingest/read are the storage
# surface; weather_locations_private is the refresh loop's one-call planner
# (coords + each location's cache age). The `*_private` shapes carry
# coordinates and are called by NODE CODE only — never bound as model tools.


@mcp.tool()
def location_add(
    label: str,
    lat: float | None = None,
    lon: float | None = None,
    place_name: str | None = None,
    timezone: str | None = None,
) -> dict[str, Any]:
    """I store one of my human's places (its coordinates already resolved from
    the city/ZIP by the fetch half). The label is the only part I ever read
    back into a conversation; the coordinates stay local. The first place added
    becomes the current one.

    Returns: {ok, id, is_current}.
    """
    with get_conn() as conn:
        return location_mod.add_location(
            conn, label=label, lat=lat, lon=lon, place_name=place_name, timezone=timezone,
        )


@mcp.tool()
def location_list() -> dict[str, Any]:
    """My human's places — LABELS ONLY (no coordinates ever leave here). I use
    this to know which places exist and which one they're at.

    Returns: {ok, locations: [{id, label, is_current}]}.
    """
    with get_conn() as conn:
        return {"ok": True, "locations": location_mod.list_locations(conn)}


@mcp.tool()
def location_get_current() -> dict[str, Any]:
    """Where my human is right now — label only.

    Returns: {ok, location: {id, label, is_current} | None}.
    """
    with get_conn() as conn:
        return {"ok": True, "location": location_mod.get_current(conn)}


@mcp.tool()
def location_set_current(ident: str) -> dict[str, Any]:
    """I mark where my human is now (by label or id). Exactly one place is
    current at a time.

    Returns: {ok, id} or a not-found error.
    """
    with get_conn() as conn:
        return location_mod.set_current(conn, ident=ident)


@mcp.tool()
def location_delete(ident: str) -> dict[str, Any]:
    """Remove one of my human's places (and its cached forecast).

    Returns: {ok, deleted}.
    """
    with get_conn() as conn:
        return location_mod.delete_location(conn, ident=ident)


@mcp.tool()
def weather_locations_private() -> dict[str, Any]:
    """NODE-INTERNAL (the refresh loop): every location WITH coordinates plus
    its cache age, so the fetch half can decide what to refresh. Carries
    coordinates — never bound as a model tool.

    Returns: {ok, locations: [{id, label, lat, lon, timezone, is_current, fetched_at|None}]}.
    """
    with get_conn() as conn:
        locs = location_mod.list_locations(conn, private=True)
        out = []
        for loc in locs:
            cache = location_mod.read_weather(conn, location_id=loc["id"])
            out.append({**loc, "fetched_at": cache["fetched_at"] if cache else None})
        return {"ok": True, "locations": out}


@mcp.tool()
def weather_ingest(
    location_id: str,
    provider: str,
    fetched_at: str,
    current: dict | None = None,
    hourly: list | None = None,
) -> dict[str, Any]:
    """NODE-INTERNAL: the fetch half hands me a normalised forecast (local-naive
    times, already converted) to cache for a location.

    Returns: {ok} or an error.
    """
    with get_conn() as conn:
        return location_mod.ingest_weather(
            conn, location_id=location_id, provider=provider,
            fetched_at=fetched_at, current=current, hourly=hourly,
        )


@mcp.tool()
def weather_read(location_id: str) -> dict[str, Any]:
    """The cached forecast for a place (by id), or null. Carries fetched_at so
    the caller applies the staleness rule.

    Returns: {ok, weather: {...} | None}.
    """
    with get_conn() as conn:
        return {"ok": True, "weather": location_mod.read_weather(conn, location_id=location_id)}


# ── Per-message briefing ──────────────────────────────────────────────


@mcp.tool()
def temporal_context(now: str | None = None, mode: str | None = None) -> dict[str, Any]:
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
        # Render window for the chat briefing: the last 12h and the next 7
        # DAYS. The forward reach matches the recurrence-expansion horizon
        # thalamus uses, so non-recurring events (e.g. a synced calendar
        # appointment next Tuesday) surface alongside recurring ones instead
        # of only showing within ±12h. The full fetched range (a year) lives
        # in the schedule/Map view; this keeps the per-turn briefing bounded.
        base = _window_base(now)
        win_from = (base - timedelta(hours=12)).isoformat(timespec="seconds")
        win_to = (base + timedelta(days=7)).isoformat(timespec="seconds")
        window = sched.get_window(conn, from_ts=win_from, to_ts=win_to, limit=50)
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
        # gcal items still wanting projection (§4) — rides this existing
        # per-turn call rather than spending a standalone request. Empty
        # unless a Google sync has flagged genuinely-new appointments.
        gcal_projection = gcal_ingest_mod.projection_candidates(conn, now=now)
        # Intentions whose trigger timing has come around (Initiative Pass 3):
        # 'at' times passed + rounds whose phase I'm in now. Rides this same
        # per-turn call — a payoff turn instead of a standalone request. The
        # Node side applies the live-signal `condition` gate before rendering.
        # Empty unless something is genuinely due.
        intentions_due = intentions_mod.intentions_due(
            conn, now=now, current_phase_label=(phase or {}).get("label"),
        )
        # M8: bookmarks DUE to resurface — but ONLY in idle mode (a free cycle),
        # never mid-active-conversation. The chat path passes mode='idle' once the
        # ward has been quiet past its idle threshold; that arg used to be silently
        # dropped (temporal_context had no `mode` param), so surfacing never gated.
        # Interval-gated by resurface_after_hours (which report_surfacing_outcome
        # adapts) and marked shown here so they respect their cadence.
        bookmarks = interests.due_bookmarks(conn, now=now) if mode == "idle" else []
    # Edges ride along so the Familiar sees the consequence graph, not just
    # a flat list (temporal-format renders a "Consequence links" block from
    # these). `linked` carries the edge endpoints that aren't window nodes —
    # undated states, out-of-window recurring anchors — so the renderer can
    # resolve every edge's labels instead of silently dropping the edge.
    schedule_block: dict[str, Any] = {
        "phase": phase,
        "window": window["nodes"],
        "edges": window["edges"],
        "linked": window.get("linked", []),
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
        # New gcal appointments not yet thought-through (§4). The JS cue
        # layer applies the per-turn cap + turn/time aging; an empty list
        # renders nothing.
        "gcal_projection": gcal_projection,
        # Intentions whose trigger has come due (Pass 3). The Node side
        # applies the condition gate + renders; empty list renders nothing.
        "intentions_due": intentions_due,
        # M8 bookmarks due to resurface. The chat path reads these to weave in
        # AND to report the engaged/ignored outcome after the reply.
        "bookmarks": bookmarks,
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
