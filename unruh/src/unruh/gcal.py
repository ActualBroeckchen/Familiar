"""Google-Calendar ingestion → schedule nodes (mechanical, change-gated).

The inbound half of the Google integration (build spec §1). Pure over a
sqlite connection — no network (the Node adapters fetch bytes; `ical.py`
parses them; this maps the normalized events to schedule nodes and
reconciles the whole gcal-sourced set in one shot).

The contract that matters downstream: `gcal_ingest` returns the **change
classification** — `{new, updated, unchanged, removed}` — and ONLY the
`new` ids ever reach the Familiar (the projection cue, §4). A re-sync that
changes nothing returns empty `new` and prompts nothing. This is the
anti-clog guarantee: change detection is code-gated, not LLM-gated.

Reconcile rules (§1.3), keyed by `payload.gcal_uid`:
  - uid unseen                         → add_node + needs_projection  → new
  - uid seen, last_modified advanced   → update in place (keep id +    → updated
    edges + needs_projection)            consequence edges)
  - uid seen, unchanged                → no-op                        → unchanged
  - status=cancelled, or a seen uid    → resolve(node,'cancelled')    → removed
    absent from a confirmed full snapshot (record kept, not hard-deleted)

Two robustness guards on deletion reconcile (the single most important
inbound rule, §1.3):
  - It runs ONLY when `reconcile_deletes=True` AND the snapshot parsed at
    least one event — an empty/failed fetch never cancels everything.
  - It only cancels nodes whose `when_ts` is still in the FUTURE. A past
    event (or an aged-out occurrence of an expanded complex series) absent
    from a forward-looking snapshot has simply happened, not been deleted.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from .db import now_iso, to_local_naive
from . import schedule as sched

# Payload keys the sync OWNS (overwritten on every update). Everything else
# in an existing node's payload — needs_projection, per-occurrence
# resolutions, anything the Familiar attached — is preserved across updates.
_SYNC_OWNED_KEYS = (
    "source", "gcal_uid", "gcal_last_modified", "all_day",
    "location", "description", "recurrence", "gcal_expanded_from",
)


def _sync_payload(ev: dict[str, Any]) -> dict[str, Any]:
    """The sync-owned payload fields for a normalized event."""
    out: dict[str, Any] = {
        "source": "gcal",
        "gcal_uid": ev["uid"],
        "gcal_last_modified": ev.get("last_modified"),
        "all_day": bool(ev.get("all_day")),
    }
    if ev.get("location"):
        out["location"] = ev["location"]
    if ev.get("description"):
        out["description"] = ev["description"]
    if ev.get("recurrence"):
        out["recurrence"] = ev["recurrence"]
    if ev.get("expanded_from"):
        out["gcal_expanded_from"] = ev["expanded_from"]
    return out


def list_gcal_nodes(conn: sqlite3.Connection) -> dict[str, sqlite3.Row]:
    """Every schedule node the sync manages (payload.source == 'gcal'),
    keyed by its gcal_uid. One query — the reconcile compares the snapshot
    against this whole set."""
    rows = conn.execute(
        """SELECT * FROM nodes
            WHERE layer = 'schedule'
              AND json_extract(payload_json, '$.source') = 'gcal'"""
    ).fetchall()
    out: dict[str, sqlite3.Row] = {}
    for r in rows:
        uid = json.loads(r["payload_json"] or "{}").get("gcal_uid")
        if uid:
            out[uid] = r
    return out


def _content_differs(existing: sqlite3.Row, ev: dict[str, Any]) -> bool:
    """Whether the mapped fields of `ev` differ from the stored node — used
    when a feed omits LAST-MODIFIED so we can't trust the timestamp alone."""
    if existing["label"] != (ev.get("summary") or "(untitled)"):
        return True
    if (existing["when_ts"] or None) != (to_local_naive(ev.get("start")) or None):
        return True
    if (existing["end_ts"] or None) != (to_local_naive(ev.get("end")) or None):
        return True
    old = json.loads(existing["payload_json"] or "{}")
    new = _sync_payload(ev)
    return any(old.get(k) != v for k, v in new.items())


def gcal_ingest(
    conn: sqlite3.Connection,
    *,
    ics_text: str | None = None,
    events: list[dict[str, Any]] | None = None,
    reconcile_deletes: bool = True,
    now: str | None = None,
) -> dict[str, Any]:
    """Reconcile a Google-Calendar snapshot into the schedule layer.

    Pass EITHER `ics_text` (a raw `.ics` feed — parsed here via ical.py) OR
    `events` (already-normalized events from the gogcli/gcalcli adapters).
    Returns `{ok, new, updated, unchanged, removed, complex_series}` — the
    id lists the sync loop routes (only `new` reaches the projection cue).
    """
    from . import ical  # local import keeps the module import-light

    now_local = now or now_iso()
    complex_series: list[str] = []
    if events is None:
        parsed = ical.parse_ical(ics_text or "")
        events = parsed["events"]
        complex_series = parsed["complex_series"]
    events = events or []

    existing = list_gcal_nodes(conn)
    seen_uids: set[str] = set()
    new_ids: list[str] = []
    updated_ids: list[str] = []
    unchanged_ids: list[str] = []
    removed_ids: list[str] = []

    for ev in events:
        uid = ev.get("uid")
        if not uid:
            continue
        seen_uids.add(uid)
        node = existing.get(uid)
        cancelled = ev.get("status") == "cancelled"

        if node is None:
            if cancelled:
                continue  # never-seen + already cancelled → nothing to do
            payload = _sync_payload(ev)
            payload["needs_projection"] = True  # first insert only (§1.2)
            try:
                nid = sched.add_node(
                    conn, type="event", label=ev.get("summary") or "(untitled)",
                    when=ev.get("start"), end=ev.get("end"), payload=payload,
                )
                new_ids.append(nid)
            except ValueError:
                continue  # a malformed event is skipped, not fatal
            continue

        if cancelled:
            sched.resolve(conn, id=node["id"], resolution="cancelled")
            removed_ids.append(node["id"])
            continue

        # Skip when LAST-MODIFIED is present and not advanced; otherwise diff.
        stored_lm = json.loads(node["payload_json"] or "{}").get("gcal_last_modified")
        incoming_lm = ev.get("last_modified")
        if incoming_lm and stored_lm and incoming_lm <= stored_lm:
            unchanged_ids.append(node["id"])
            continue
        if not _content_differs(node, ev):
            unchanged_ids.append(node["id"])
            continue

        # Update in place — keep the node id (and its consequence edges), and
        # preserve every non-sync-owned payload key (needs_projection, etc).
        merged = json.loads(node["payload_json"] or "{}")
        merged.update(_sync_payload(ev))
        sched.update_node(
            conn, id=node["id"], label=ev.get("summary") or "(untitled)",
            when=ev.get("start"), end=ev.get("end"), payload=merged,
        )
        updated_ids.append(node["id"])

    # Deletion reconcile — only on a confirmed-good full snapshot that parsed
    # at least one event, and only for still-future nodes (§1.3 guards).
    if reconcile_deletes and events:
        for uid, node in existing.items():
            if uid in seen_uids or node["resolution"]:
                continue
            when_local = to_local_naive(node["when_ts"]) if node["when_ts"] else None
            if when_local and when_local < now_local:
                continue  # past / aged-out occurrence → not a deletion
            sched.resolve(conn, id=node["id"], resolution="cancelled")
            removed_ids.append(node["id"])

    return {
        "ok": True,
        "new": new_ids,
        "updated": updated_ids,
        "unchanged": unchanged_ids,
        "removed": removed_ids,
        "complex_series": complex_series,
    }
