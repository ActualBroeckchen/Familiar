"""Interest-layer logic — standing values, live interests, curiosities,
active pursuits, and bookmarks.

This is the M4 surface, complementing the M3 schedule layer in
docs/unruh-design.md. Pure functions over a sqlite3.Connection so
they're trivial to unit-test with an in-memory DB.

Node shapes by type:

  type='standing_value' — always-on identity-level orientation
                          (e.g. "caring for the user"). Never decays.
                          payload.value_ref optionally points at an
                          entity-core identity fact for the M7
                          bidirectional bridge.
  type='live_interest'  — accumulated engagement, decays on read.
  type='curiosity'      — low-weight initial recording. Just a
                          rendering label — same shape as live_interest.
  type='active_pursuit' — high-weight rendering label. Same shape.
  type='bookmark'       — a thing Familiar saved for a free cycle.
                          payload.resource is the link/identifier;
                          payload.note holds context. Linked to its
                          topic via an outbound 'bookmarked' edge.

Edge kinds (from the design doc):
  'engaged_with'  — Familiar ↔ Topic (placeholder for the eventual
                    explicit self-node; not heavily used in M4)
  'derived_from'  — Topic ↔ Session (provenance)
  'related_to'    — Topic ↔ Topic (rabbit-hole traversal)
  'bookmarked'    — Bookmark → Topic

Weight model (Decision 8 from the implementation plan):
  effective_weight = raw_weight * exp(-(now - last_touched) / tau)
  Computed on read, never persisted — so a missed-decay-tick can never
  corrupt state. Standing values bypass decay (always return raw).

  record() bumps with the decay-then-add rule: the stored raw weight
  is decayed to its current effective value before the delta is
  added. Without this, rapid engagement would let weight accumulate
  faster than the model can sensibly reason about — the same interest
  bumped 100 times over a year would read as "weight 10" with no
  acknowledgement that 99 of those bumps were ancient.
"""

from __future__ import annotations

import json
import math
import sqlite3
from datetime import datetime, timezone
from typing import Any

from .db import new_id, now_iso

# ── Allowed values. Surfaced as constants so tests + the MCP layer
# can validate against them without re-typing strings. ──────────────

INTEREST_NODE_TYPES = {
    "standing_value", "active_pursuit", "live_interest", "curiosity", "bookmark",
}
INTEREST_EDGE_KINDS = {
    "engaged_with", "derived_from", "related_to", "bookmarked",
}

# Tier classification by effective weight. Thresholds inclusive on the
# lower bound. Render labels only — the stored `type` doesn't change
# automatically; `interest_set_standing` is the one manual promotion.
TIER_THRESHOLDS = [
    ("active_pursuit", 2.0),
    ("live_interest",  0.5),
    ("curiosity",      0.0),
]

# Decay half-life in days. The design doc commits to "a real interest
# survives a few days of inattention but isn't accumulating forever".
# 5 days → 24h decays a weight by ~18%, 5d halves it, 30d brings it
# to ~0.2% of its original value. Settings-tunable in M5.
DEFAULT_TAU_DAYS = 5.0

# How much a single record() call bumps the raw weight by default.
# The chat path will eventually pass varied deltas (long response →
# bigger bump, etc — M5's instrumentation). For M4, 0.1 is a sane
# placeholder: ten interactions cross into 'live_interest' tier
# (0.5 threshold) at zero decay.
DEFAULT_RECORD_DELTA = 0.1

# How many days an interest with no activity rides on its standing-
# value-or-explicit-record before becoming irrelevant in the surface.
# Used as a hard floor on min_weight in list_interests so the rendering
# doesn't include essentially-zero-weight noise.
MIN_SURFACED_WEIGHT = 0.01


# ── Decay maths ──────────────────────────────────────────────────────


def effective_weight(
    raw_weight: float | None,
    last_touched: str | None,
    *,
    now: datetime | None = None,
    tau_days: float = DEFAULT_TAU_DAYS,
) -> float:
    """Apply exponential decay since last_touched. Returns 0.0 when
    raw_weight or last_touched is missing — i.e. uninitialised /
    standing-value-shaped nodes that haven't been bumped yet.

    Pure function. No side effects. Same inputs → same outputs."""
    if raw_weight is None or last_touched is None:
        return 0.0
    if raw_weight <= 0:
        return 0.0
    n = now if now is not None else datetime.now(timezone.utc)
    last = datetime.fromisoformat(last_touched)
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    elapsed_days = (n - last).total_seconds() / 86_400.0
    if elapsed_days <= 0:
        return raw_weight
    return raw_weight * math.exp(-elapsed_days / tau_days)


def tier_for_weight(weight: float) -> str:
    """Classify by effective weight. Render-only — doesn't alter the
    stored node type. Standing values bypass this; callers check the
    stored type before tiering."""
    for label, threshold in TIER_THRESHOLDS:
        if weight >= threshold:
            return label
    return "curiosity"


# ── Writes ────────────────────────────────────────────────────────────


def _find_by_label(conn: sqlite3.Connection, label: str) -> sqlite3.Row | None:
    """Look up an interest-layer node by exact label. Skips bookmark
    nodes (bookmarks aren't topics; they reference topics)."""
    return conn.execute(
        """SELECT * FROM nodes
            WHERE layer = 'interest' AND label = ?
              AND type != 'bookmark'
            LIMIT 1""",
        (label.strip(),),
    ).fetchone()


def _insert_node(
    conn: sqlite3.Connection,
    *,
    node_type: str,
    label: str,
    payload: dict | None,
    weight: float | None,
    ts: str,
) -> str:
    """Insert an interest-layer node and return its new id. Single
    INSERT path for record / bookmark / set_standing so the column
    list lives in exactly one place. Validates node_type against
    INTEREST_NODE_TYPES — mirrors schedule.add_node's enforcement so
    a typo in a future caller fails loudly instead of writing an
    un-renderable type into the graph."""
    if node_type not in INTEREST_NODE_TYPES:
        raise ValueError(
            f"unknown interest node type {node_type!r}; "
            f"expected one of {sorted(INTEREST_NODE_TYPES)}"
        )
    node_id = new_id()
    conn.execute(
        """INSERT INTO nodes
               (id, layer, type, label, payload_json, when_ts, end_ts,
                resolution, weight, last_touched, created_at, updated_at)
           VALUES (?, 'interest', ?, ?, ?, NULL, NULL,
                   NULL, ?, ?, ?, ?)""",
        (node_id, node_type, label, json.dumps(payload or {}), weight, ts, ts, ts),
    )
    return node_id


def _insert_edge(
    conn: sqlite3.Connection,
    *,
    src_id: str,
    dst_id: str,
    kind: str,
    ts: str,
) -> str:
    """Insert an interest-layer edge and return its new id. Validates
    `kind` against INTEREST_EDGE_KINDS for the same reason _insert_node
    validates type."""
    if kind not in INTEREST_EDGE_KINDS:
        raise ValueError(
            f"unknown interest edge kind {kind!r}; "
            f"expected one of {sorted(INTEREST_EDGE_KINDS)}"
        )
    edge_id = new_id()
    conn.execute(
        """INSERT INTO edges (id, src_id, dst_id, kind, payload_json, created_at)
           VALUES (?, ?, ?, ?, '{}', ?)""",
        (edge_id, src_id, dst_id, kind, ts),
    )
    return edge_id


def record(
    conn: sqlite3.Connection,
    *,
    topic: str,
    source: str | None = None,
    payload: dict | None = None,
    delta: float = DEFAULT_RECORD_DELTA,
    tau_days: float = DEFAULT_TAU_DAYS,
) -> dict[str, Any]:
    """Record a moment of engagement with `topic`. Creates the node as
    a curiosity if it doesn't exist; otherwise applies decay-then-add
    so accumulated weight reflects recent engagement rather than
    historical sum.

    Standing values are excluded from the bump — the design says they
    don't accumulate weight, they just have it always-on. record()
    on a standing value updates last_touched (so we know when it was
    last engaged with for provenance) but the weight stays put.

    Returns {ok, id, type, raw_weight, effective_weight}.
    """
    if not topic or not topic.strip():
        raise ValueError("topic is required and must be non-empty")
    if delta < 0:
        raise ValueError("delta must be non-negative")

    topic = topic.strip()
    ts = now_iso()
    payload_dict = dict(payload or {})
    if source:
        payload_dict.setdefault("source", source)

    existing = _find_by_label(conn, topic)

    if existing is None:
        # First mention. Create as curiosity with the delta as its
        # initial raw weight. last_touched=now so the first decay
        # calculation starts from this instant.
        node_id = _insert_node(
            conn, node_type="curiosity", label=topic,
            payload=payload_dict, weight=delta, ts=ts,
        )
        return {
            "ok": True, "id": node_id, "type": "curiosity",
            "raw_weight": delta, "effective_weight": delta,
        }

    # Existing node. Standing values: touch but don't change weight.
    if existing["type"] == "standing_value":
        conn.execute(
            "UPDATE nodes SET last_touched = ?, updated_at = ? WHERE id = ?",
            (ts, ts, existing["id"]),
        )
        return {
            "ok": True, "id": existing["id"], "type": "standing_value",
            "raw_weight": existing["weight"] or 0.0,
            "effective_weight": existing["weight"] or 0.0,
        }

    # Decay-then-add: stored weight reflects "current effective" at
    # the moment of the new bump. Means rapid engagement doesn't
    # accumulate unboundedly — steady-state weight is bounded by the
    # bump rate vs tau.
    decayed = effective_weight(
        existing["weight"], existing["last_touched"],
        tau_days=tau_days,
    )
    new_raw = decayed + delta
    conn.execute(
        "UPDATE nodes SET weight = ?, last_touched = ?, updated_at = ? WHERE id = ?",
        (new_raw, ts, ts, existing["id"]),
    )
    return {
        "ok": True, "id": existing["id"], "type": existing["type"],
        "raw_weight": new_raw, "effective_weight": new_raw,
    }


def bookmark(
    conn: sqlite3.Connection,
    *,
    topic: str,
    resource: str,
    note: str | None = None,
) -> dict[str, Any]:
    """Save a resource against a topic for a free cycle. Creates the
    topic as a curiosity if it doesn't exist yet (so a bookmark can be
    the first signal of interest in something), then makes a bookmark
    node + `bookmarked` edge.

    Returns {ok, bookmark_id, topic_id, edge_id}.
    """
    if not topic or not topic.strip():
        raise ValueError("topic is required")
    if not resource or not resource.strip():
        raise ValueError("resource is required")

    # Ensure the topic exists. Use record() so a first-time bookmark
    # registers a small engagement bump for the topic too — the user
    # *did* notice this thing, even if it was just to bookmark it.
    rec = record(conn, topic=topic)
    topic_id = rec["id"]

    ts = now_iso()
    payload = {"resource": resource.strip()}
    if note: payload["note"] = note.strip()
    bookmark_id = _insert_node(
        conn, node_type="bookmark", label=topic.strip(),
        payload=payload, weight=None, ts=ts,
    )
    edge_id = _insert_edge(
        conn, src_id=bookmark_id, dst_id=topic_id, kind="bookmarked", ts=ts,
    )
    return {"ok": True, "bookmark_id": bookmark_id, "topic_id": topic_id, "edge_id": edge_id}


def set_standing(
    conn: sqlite3.Connection,
    *,
    topic: str,
    value_ref: str | None = None,
    weight: float = 1.0,
) -> dict[str, Any]:
    """Promote a topic to a standing value (or create one outright).

    `value_ref` is an opaque string anchor to an entity-core identity
    fact — stored as payload.value_ref for the M7 bidirectional bridge
    to validate. M4 doesn't enforce that it points at a real fact;
    it's a free-form pointer that later milestones make structural.

    The given `weight` becomes the stored raw weight. Standing values
    bypass decay so this value always renders verbatim in the surface.
    """
    if not topic or not topic.strip():
        raise ValueError("topic is required")
    topic = topic.strip()

    existing = _find_by_label(conn, topic)
    ts = now_iso()
    payload = {}
    if value_ref: payload["value_ref"] = value_ref.strip()

    if existing is None:
        node_id = _insert_node(
            conn, node_type="standing_value", label=topic,
            payload=payload, weight=weight, ts=ts,
        )
        return {"ok": True, "id": node_id, "created": True}

    # Existing: promote whatever type it was. Preserve any prior
    # payload fields (don't overwrite, just add value_ref).
    prior_payload = json.loads(existing["payload_json"] or "{}")
    if value_ref: prior_payload["value_ref"] = value_ref.strip()
    conn.execute(
        """UPDATE nodes
              SET type = 'standing_value', weight = ?,
                  payload_json = ?, last_touched = ?, updated_at = ?
            WHERE id = ?""",
        (weight, json.dumps(prior_payload), ts, ts, existing["id"]),
    )
    return {"ok": True, "id": existing["id"], "created": False}


# ── Reads ──────────────────────────────────────────────────────────────


def _node_row_to_dict(row: sqlite3.Row, *, eff_weight: float, tier: str) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id":    row["id"],
        "type":  row["type"],
        "label": row["label"],
        "weight":           eff_weight,
        "raw_weight":       row["weight"] if row["weight"] is not None else 0.0,
        "last_touched":     row["last_touched"],
        "tier":  tier,
    }
    payload = json.loads(row["payload_json"] or "{}")
    if payload: out["payload"] = payload
    # Surface value_ref at top level too — the M7 standing-value bridge
    # in thalamus reads it directly without digging into payload.
    if payload.get("value_ref"): out["value_ref"] = payload["value_ref"]
    return out


def demote_standing(conn: sqlite3.Connection, *, id: str) -> dict[str, Any]:
    """Demote a standing value to a live interest (M7). Called when the
    entity-core fact it anchored has disappeared — we demote rather than
    drop, so the topic survives as a normal (decaying) interest instead
    of vanishing.

    Refreshes last_touched to now so it surfaces once at full weight and
    then decays from here, rather than instantly aging out. Keeps the
    (now-stale) value_ref in payload for provenance. No-op (demoted=0)
    if the id is unknown or isn't currently a standing value.

    Returns {ok, demoted}.
    """
    ts = now_iso()
    cur = conn.execute(
        """UPDATE nodes
              SET type = 'live_interest', last_touched = ?, updated_at = ?
            WHERE id = ? AND layer = 'interest' AND type = 'standing_value'""",
        (ts, ts, id),
    )
    return {"ok": True, "demoted": cur.rowcount}


def list_interests(
    conn: sqlite3.Connection,
    *,
    limit: int = 20,
    min_weight: float = MIN_SURFACED_WEIGHT,
    include_standing: bool = True,
    tau_days: float = DEFAULT_TAU_DAYS,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Return interests for surfacing in [Temporal Context].

    Returns:
      {
        ok: True,
        standing: [...],  # standing_value nodes; bypass min_weight
        live:     [...],  # everything else (curiosity / live_interest /
                          # active_pursuit) sorted by effective weight desc
      }

    Bookmarks are NOT included here — they belong in their own block
    (the design doc separates bookmarked-for-later from active-interest
    surface). A future formatter change may add a bookmarks line; for
    M4 we just keep them queryable via the underlying tables.
    """
    rows = conn.execute(
        """SELECT * FROM nodes
            WHERE layer = 'interest' AND type != 'bookmark'""",
    ).fetchall()

    standing_out: list[dict[str, Any]] = []
    live_out:     list[dict[str, Any]] = []

    for row in rows:
        if row["type"] == "standing_value":
            if not include_standing:
                continue
            w = row["weight"] if row["weight"] is not None else 0.0
            standing_out.append(_node_row_to_dict(row, eff_weight=w, tier="standing_value"))
            continue
        w = effective_weight(row["weight"], row["last_touched"], now=now, tau_days=tau_days)
        if w < min_weight:
            continue
        live_out.append(_node_row_to_dict(row, eff_weight=w, tier=tier_for_weight(w)))

    # Standing values sorted alphabetically (stable surface across turns).
    standing_out.sort(key=lambda n: n["label"].lower())
    # Live interests sorted by effective weight, highest first.
    live_out.sort(key=lambda n: n["weight"], reverse=True)
    live_out = live_out[:limit]

    return {"ok": True, "standing": standing_out, "live": live_out}


def list_bookmarks(
    conn: sqlite3.Connection,
    *,
    limit: int = 20,
) -> list[dict[str, Any]]:
    """Return bookmarks sorted by recency (most recently saved first).
    Each bookmark carries `topic_id` resolved from its `bookmarked`
    edge so the caller can render "<bookmark> → <topic>"."""
    # Secondary sort by id keeps the order deterministic when two
    # bookmarks land in the same second (created_at is at second
    # precision; back-to-back bookmarks would otherwise tie).
    rows = conn.execute(
        """SELECT b.*, e.dst_id AS topic_id, t.label AS topic_label
             FROM nodes b
             LEFT JOIN edges e ON e.src_id = b.id AND e.kind = 'bookmarked'
             LEFT JOIN nodes t ON t.id = e.dst_id
            WHERE b.layer = 'interest' AND b.type = 'bookmark'
            ORDER BY b.created_at DESC, b.id DESC
            LIMIT ?""",
        (limit,),
    ).fetchall()
    out: list[dict[str, Any]] = []
    for row in rows:
        item = {
            "id":          row["id"],
            "label":       row["label"],
            "topic_id":    row["topic_id"],
            "topic_label": row["topic_label"],
            "created_at":  row["created_at"],
        }
        payload = json.loads(row["payload_json"] or "{}")
        if payload: item["payload"] = payload
        out.append(item)
    return out
