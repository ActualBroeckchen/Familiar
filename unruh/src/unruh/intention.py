"""Intentions layer (Initiative Pass 3) — a future the Familiar writes for
itself.

A first-class "my intention" object with a what, a why, refs, a trigger, and
an optional condition. The substrate for planning, follow-through, and
*rounds* (phase-bound standing intentions — "every morning I go over the
calendar", "every noon I check in on Chen if we haven't talked in an hour").

Pure functions over a sqlite3.Connection, same shape as schedule.py /
interest.py / handoff.py — trivially unit-testable with an in-memory DB.

Division of labour (deliberate): this module owns STORAGE and TRIGGER
TIMING (is an 'at' time past? is this the intention's phase right now? has
this occurrence already fired?). It does NOT evaluate the `condition`
vocabulary — that gate needs live signals (the ward's contact gap, the needs
ledger, whether a ref is still unresolved) that live on the Node side, so
`intentions_due` returns each due intention WITH its condition attached for
the caller to apply. Keeping the live-signal gate where the signals are is
the "gate in code, near the data" discipline.

Refs are stored as slug ids and NEVER snapshotted — they are dereferenced
fresh whenever the intention surfaces, so a payoff turn reasons over the
current state of the thing, not a stale copy.

Time is LOCAL-naive throughout (the ward's wall-clock, no offset), exactly
like schedule.py — the Familiar writes plain local time and does no tz math.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from .db import insert_with_slug_retry, now_iso, to_local_naive

# ── Allowed values (surfaced so the MCP layer + tests validate without
# re-typing strings) ─────────────────────────────────────────────────

TRIGGER_KINDS   = {"at", "phase", "on_next_contact", "none"}
INTENTION_STATUSES = {"active", "done", "dropped"}
VISIBILITIES    = {"shared", "private"}
# The condition vocabulary — a tiny rules-engine tripwire. Each key is an
# extra gate the Node side applies to a trigger-due intention before it acts.
CONDITION_KEYS  = {"minContactGapMs", "needsStatus", "unresolvedRefs"}

# Defensive caps at the storage boundary (what/why can come from an LLM).
MAX_WHAT_CHARS = 400
MAX_WHY_CHARS  = 600
MAX_REFS       = 12

DEFAULT_ROUNDS_VISIBILITY = "shared"  # transparency unless the Familiar opts out


def _today_local(now: str | None = None) -> str:
    """The local calendar date (YYYY-MM-DD) of `now` (or now())."""
    return (now or now_iso())[:10]


def _clean_refs(refs: list | None) -> list[str]:
    out: list[str] = []
    for r in (refs or []):
        s = str(r).strip()
        if s:
            out.append(s)
        if len(out) >= MAX_REFS:
            break
    return out


def _clean_condition(condition: dict | None) -> dict:
    """Keep only recognised vocab keys; drop anything else silently (an
    unknown key would be a gate nobody evaluates — a silent no-op that
    reads as a constraint). Values are passed through as-is; the Node-side
    evaluator validates their types when it applies them."""
    if not isinstance(condition, dict):
        return {}
    return {k: condition[k] for k in condition if k in CONDITION_KEYS}


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id":            row["id"],
        "what":          row["what"],
        "why":           row["why"],
        "refs":          json.loads(row["refs_json"] or "[]"),
        "trigger": {
            "kind":      row["trigger_kind"],
            "at":        row["trigger_at"],
            "phase":     row["trigger_phase"],
            "recurring": bool(row["recurring"]),
        },
        "condition":     json.loads(row["condition_json"] or "{}"),
        "status":        row["status"],
        "source":        row["source"],
        "visibility":    row["visibility"],
        "last_fired_date": row["last_fired_date"],
        "created_at":    row["created_at"],
        "updated_at":    row["updated_at"],
    }


# ── Writes ────────────────────────────────────────────────────────────


def phase_matches(trigger_phase: str | None, current_label: str | None) -> bool:
    """Forgiving phase-trigger match. The Familiar types a day-part word
    ('evening'); the ward's routine phase carries a real, possibly custom label
    ('Evening wind-down'). Match case-insensitively, and either way as a
    substring — so a generic trigger still fires against a specifically-named
    phase, and a legacy round starts working without being re-created. Empty on
    either side is no match. (This is the due-time safety net; set_intention
    also canonicalises the label up front — see resolve_phase.)"""
    t = (trigger_phase or "").strip().lower()
    c = (current_label or "").strip().lower()
    if not t or not c:
        return False
    return t == c or t in c or c in t


def resolve_phase(typed: str, available_labels: list[str]) -> tuple[str, bool]:
    """Resolve a typed phase word to a real routine-phase label at SET time, so
    a round is stored against the exact label it will later be checked against.
    Case-insensitive exact wins; else a unique substring match (either
    direction). Returns (canonical_label, matched). No or ambiguous match keeps
    the typed word and matched=False, so the caller can warn the Familiar rather
    than silently create an unfulfillable trigger."""
    t = (typed or "").strip()
    tl = t.lower()
    labels = [l.strip() for l in (available_labels or []) if isinstance(l, str) and l.strip()]
    exact = [l for l in labels if l.lower() == tl]
    if exact:
        return exact[0], True
    subs = [l for l in labels if tl and (tl in l.lower() or l.lower() in tl)]
    if len(subs) == 1:
        return subs[0], True
    return t, False


def set_intention(
    conn: sqlite3.Connection,
    *,
    what: str,
    why: str | None = None,
    refs: list | None = None,
    trigger: dict | None = None,
    condition: dict | None = None,
    source: str | None = None,
    visibility: str | None = None,
    available_phases: list[str] | None = None,
) -> dict[str, Any]:
    """Record a new intention. `trigger` is a dict:
        {"kind": "at",   "at": "2026-07-16T09:00:00"}
        {"kind": "phase","phase": "morning", "recurring": true}   # a round
        {"kind": "on_next_contact"}
        {"kind": "none"}   # a tell-shaped intention with no when
    Returns {ok, id} or {ok: False, error}.
    """
    what_clean = (what or "").strip()[:MAX_WHAT_CHARS]
    if not what_clean:
        return {"ok": False, "error": "what is required"}

    trig = trigger or {"kind": "none"}
    kind = trig.get("kind", "none")
    if kind not in TRIGGER_KINDS:
        return {"ok": False, "error": f"trigger.kind must be one of {sorted(TRIGGER_KINDS)}"}

    trigger_at = to_local_naive(trig.get("at")) if kind == "at" else None
    if kind == "at" and not trigger_at:
        return {"ok": False, "error": "trigger.at is required (local ISO) when kind='at'"}
    trigger_phase = (trig.get("phase") or "").strip() or None if kind == "phase" else None
    if kind == "phase" and not trigger_phase:
        return {"ok": False, "error": "trigger.phase is required when kind='phase'"}
    # Canonicalise a phase round to a real routine-phase label at set time, so it
    # is stored against the exact label intentions_due checks — and, when nothing
    # matches, warn instead of silently creating a round that can never fire.
    phase_warning = None
    if kind == "phase" and trigger_phase and available_phases is not None:
        trigger_phase, matched = resolve_phase(trigger_phase, available_phases)
        if not matched:
            labs = ", ".join(sorted({l.strip() for l in available_phases if isinstance(l, str) and l.strip()}))
            phase_warning = (
                f"No routine phase matches '{trigger_phase}', so this round won't fire until one does. "
                + (f"Your phases right now: {labs}. Tie it to one of those, or add a '{trigger_phase}' phase to the routine."
                   if labs else "There are no routine phases defined yet — add one (e.g. an evening block) and this round will start firing.")
            )
    # recurring only means anything for a phase round; force 0 otherwise so a
    # one-shot 'at' can't accidentally read as re-firing.
    recurring = 1 if (kind == "phase" and trig.get("recurring")) else 0

    if visibility is not None and visibility not in VISIBILITIES:
        return {"ok": False, "error": f"visibility must be one of {sorted(VISIBILITIES)} or omitted"}

    ts = now_iso()
    why_clean = (why or "").strip()[:MAX_WHY_CHARS] or None
    refs_clean = _clean_refs(refs)
    cond_clean = _clean_condition(condition)

    new_id = insert_with_slug_retry(
        conn,
        """INSERT INTO intentions
               (id, what, why, refs_json, trigger_kind, trigger_at, trigger_phase,
                recurring, condition_json, status, source, visibility,
                last_fired_date, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?, ?)""",
        lambda nid: (nid, what_clean, why_clean, json.dumps(refs_clean), kind,
                     trigger_at, trigger_phase, recurring, json.dumps(cond_clean),
                     source, visibility, ts, ts),
        label=what_clean, kind="intention",
    )
    result = {"ok": True, "id": new_id}
    if phase_warning:
        result["warning"] = phase_warning
    return result


def drop_intention(conn: sqlite3.Connection, *, id: str) -> dict[str, Any]:
    """Let go of an intention (status='dropped'). Idempotent. Returns
    {ok, updated}."""
    ts = now_iso()
    cur = conn.execute(
        "UPDATE intentions SET status='dropped', updated_at=? WHERE id=? AND status!='dropped'",
        (ts, id),
    )
    return {"ok": True, "updated": cur.rowcount}


def complete_intention(conn: sqlite3.Connection, *, id: str) -> dict[str, Any]:
    """Mark an intention done — the payoff, once genuinely acted on. For a
    recurring round this is a rare hard stop (the round is retired), not the
    per-occurrence dedup (that's mark_fired). Returns {ok, updated,
    already_done}."""
    row = conn.execute("SELECT status FROM intentions WHERE id=?", (id,)).fetchone()
    if row is None:
        return {"ok": False, "error": "not found"}
    if row["status"] == "done":
        return {"ok": True, "updated": 0, "already_done": True}
    ts = now_iso()
    cur = conn.execute(
        "UPDATE intentions SET status='done', updated_at=? WHERE id=?", (ts, id),
    )
    return {"ok": True, "updated": cur.rowcount, "already_done": False}


def mark_fired(conn: sqlite3.Connection, *, id: str, now: str | None = None) -> dict[str, Any]:
    """Record that this occurrence fired, for per-occurrence dedup. Stamps
    last_fired_date with today's local date so `intentions_due` won't re-offer
    the same occurrence (a recurring round re-fires next day; a one-shot never
    re-fires once stamped). Firing is NOT completing — the Familiar still
    calls complete_intention when the intention is genuinely done. Returns
    {ok, updated}."""
    ts = now_iso()
    cur = conn.execute(
        "UPDATE intentions SET last_fired_date=?, updated_at=? WHERE id=?",
        (_today_local(now), ts, id),
    )
    return {"ok": True, "updated": cur.rowcount}


# ── Reads ─────────────────────────────────────────────────────────────


def list_intentions(
    conn: sqlite3.Connection,
    *,
    include_done: bool = False,
    include_dropped: bool = False,
    phase: str | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    """List intentions, newest first. Active-only by default."""
    clauses, params = [], []
    if not include_done:    clauses.append("status != 'done'")
    if not include_dropped: clauses.append("status != 'dropped'")
    if phase is not None:
        clauses.append("trigger_kind='phase' AND trigger_phase=?")
        params.append(phase.strip())
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    rows = conn.execute(
        f"SELECT * FROM intentions{where} ORDER BY created_at DESC, id DESC LIMIT ?",
        (*params, limit),
    ).fetchall()
    return [_row_to_dict(r) for r in rows]


def intentions_due(
    conn: sqlite3.Connection,
    *,
    now: str | None = None,
    current_phase_label: str | None = None,
) -> list[dict[str, Any]]:
    """Active intentions whose TRIGGER TIMING is satisfied right now. The
    caller still applies the `condition` gate (returned on each) using live
    signals this module doesn't have.

    Timing rules:
      - kind='at': trigger_at <= now, and not already fired (last_fired_date
        is NULL — a one-shot 'at' fires once; a stamp retires it from due).
      - kind='phase': trigger_phase == current_phase_label. Recurring rounds
        are due when last_fired_date != today (once per day the phase runs);
        a non-recurring phase intention is due until it has ever fired.
      - kind='on_next_contact' / 'none': never time-due here (contact-boundary
        and ambient intentions are surfaced/handled elsewhere).
    """
    now = now or now_iso()
    today = _today_local(now)
    out: list[dict[str, Any]] = []
    rows = conn.execute("SELECT * FROM intentions WHERE status='active'").fetchall()
    for row in rows:
        kind = row["trigger_kind"]
        if kind == "at":
            if row["trigger_at"] and row["trigger_at"] <= now and not row["last_fired_date"]:
                out.append(_row_to_dict(row))
        elif kind == "phase":
            if phase_matches(row["trigger_phase"], current_phase_label):
                if row["recurring"]:
                    if row["last_fired_date"] != today:
                        out.append(_row_to_dict(row))
                elif not row["last_fired_date"]:
                    out.append(_row_to_dict(row))
    return out


def get_by_id(conn: sqlite3.Connection, *, id: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM intentions WHERE id=?", (id,)).fetchone()
    return _row_to_dict(row) if row else None


# ── Budget count helpers (the Node side enforces the caps) ───────────


def count_standing_in_phase(conn: sqlite3.Connection, *, phase: str) -> int:
    """How many active standing rounds are bound to a phase — for the
    standing-intentions-per-phase budget."""
    return conn.execute(
        """SELECT COUNT(*) AS n FROM intentions
            WHERE status='active' AND trigger_kind='phase' AND recurring=1 AND trigger_phase=?""",
        (phase.strip(),),
    ).fetchone()["n"]


def count_open_oneshots(conn: sqlite3.Connection) -> int:
    """Active, non-recurring intentions — for the open-one-shots budget."""
    return conn.execute(
        """SELECT COUNT(*) AS n FROM intentions
            WHERE status='active' AND recurring=0""",
    ).fetchone()["n"]


# ── Rounds visibility (the Familiar owns whether the ward sees its rounds) ─


def get_rounds_visibility(conn: sqlite3.Connection) -> str:
    """The GLOBAL rounds-visibility default from meta ('shared' unless the
    Familiar has chosen otherwise). Per-intention `visibility` overrides
    this for a single round."""
    row = conn.execute("SELECT value FROM meta WHERE key='rounds_visibility'").fetchone()
    val = row["value"] if row else None
    return val if val in VISIBILITIES else DEFAULT_ROUNDS_VISIBILITY


def set_rounds_visibility(conn: sqlite3.Connection, *, value: str) -> dict[str, Any]:
    """Set the global rounds-visibility default. The Familiar's call: whether
    its standing rounds are legible to the ward by default."""
    if value not in VISIBILITIES:
        return {"ok": False, "error": f"value must be one of {sorted(VISIBILITIES)}"}
    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES('rounds_visibility', ?)", (value,),
    )
    return {"ok": True, "visibility": value}


def rounds_for_ward(conn: sqlite3.Connection) -> dict[str, Any]:
    """The ward-facing "the Familiar's rounds" view. Standing rounds (active,
    recurring, phase-bound), respecting the Familiar's visibility choice:
    the GLOBAL default, overridable per-intention. A round the Familiar has
    made private is counted (its EXISTENCE is never hidden — no covert
    cognition) but its contents are withheld. Returns:
      { visibility, rounds: [{id, what, phase}], hidden_count }
    """
    global_vis = get_rounds_visibility(conn)
    rows = conn.execute(
        """SELECT * FROM intentions
            WHERE status='active' AND trigger_kind='phase' AND recurring=1
            ORDER BY trigger_phase, created_at""",
    ).fetchall()
    shown, hidden = [], 0
    for r in rows:
        effective = r["visibility"] or global_vis
        if effective == "private":
            hidden += 1
            continue
        shown.append({"id": r["id"], "what": r["what"], "phase": r["trigger_phase"]})
    return {"visibility": global_vis, "rounds": shown, "hidden_count": hidden}
