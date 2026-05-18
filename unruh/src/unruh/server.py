"""Unruh MCP server.

Tools exposed (stable contract — Thalamus depends on these shapes):

  Liveness:
    health_check       — boot diagnostic

  Schedule (M3):
    schedule_add_node     — create event / task / phase / state
    schedule_add_edge     — connect two nodes with a causal/temporal kind
    schedule_get_window   — read items in a time window (+ touching edges)
    schedule_resolve      — mark a task/event done/cancelled/carried

  Briefing (called per-message by Thalamus):
    temporal_context   — assembled handoff + schedule + interests payload

Interest-layer tools (interest_*) land in M4; the temporal_context
payload already has placeholder keys for them so the formatter in
thalamus.js renders cleanly even when M4 isn't shipped yet.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from mcp.server.fastmcp import FastMCP

from unruh import __version__
from unruh.db import get_conn
from unruh import schedule as sched

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


# ── Per-message briefing ──────────────────────────────────────────────


@mcp.tool()
def temporal_context(now: str | None = None) -> dict[str, Any]:
    """Return the per-message temporal-context payload.

    Schema (stable across milestones — see the formatter in
    thalamus.js / temporal-format.js for the renderer):

      {
        ts:        '<iso-8601>',
        schedule:  { phase: {...} | null, window: [...] },
        interests: { standing: [...], live: [...] },   # M4 populates
        handoff:   { intent: ..., open_threads: [...] } # M6 populates
      }

    M3 populates `schedule`. Empty sub-blocks render as empty in
    the prompt; Thalamus's formatter omits the [Temporal Context]
    section entirely when everything is empty.
    """
    with get_conn() as conn:
        phase = sched.current_phase(conn, at=now)
        window = sched.get_window(conn, from_ts=None, to_ts=None, limit=50)
    schedule_block: dict[str, Any] = {"phase": phase, "window": window["nodes"]}
    return {
        "ts": now or _now_iso(),
        "schedule":  schedule_block,
        "interests": {"standing": [], "live": []},
        "handoff":   {"intent": None, "open_threads": []},
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
