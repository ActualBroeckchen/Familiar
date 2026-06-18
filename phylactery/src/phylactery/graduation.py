"""Graduation audit (Pillar H) — keep the always-injected surface lean.

I periodically review my always-injected `identity` (self) and `ward` blocks
and graduate detail that is no longer front-of-mind into RAG-recalled `me` /
`ward` register memory records. Graduated facts aren't deleted — they decay
in retrieval weight like any other memory and can be pulled back if they keep
mattering. This is *my* call, made in my own voice during the consolidation
pass; for the `ward` block I also leave a note so my human can see what I filed
away (ward-consulted, non-blocking).

⚠️ The eligibility rule below is human-signed (build-spec §7). It decides what
may LEAVE the always-injected surface — i.e. what I might stop having in front
of me every turn — so it is deliberately conservative:

  candidate  = NOT pinned
               AND on-surface longer than DWELL_DAYS
               AND last recalled longer ago than RECALL_RECENCY_DAYS
                   (never-recalled counts as eligible)
               AND last confirmed longer ago than CONFIRM_RECENCY_DAYS

  NEVER eligible (pinned, regardless of the above):
               careWeight == 'high'
               OR category in {health_info, crisis, support-map}
               OR content matches care-critical patterns
                  (allergies, meds, crisis triggers, support contacts, …)
               OR confirmed within CONFIRM_RECENCY_DAYS

False positives here are cheap (a fact stays front-of-mind a while longer);
false negatives are not (a safety-relevant fact gets filed away). So the
content matcher errs toward KEEPING — when in doubt, it does not graduate.
"""

from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime, timezone
from typing import Any

from phylactery.db import get_conn, new_id, now_iso
from phylactery.snapshot import auto_snapshot

# ── Signed-off thresholds (build-spec §7) ─────────────────────────────────────
DWELL_DAYS = 30           # must have been on the surface this long
RECALL_RECENCY_DAYS = 30  # last recalled more than this long ago (or never)
CONFIRM_RECENCY_DAYS = 30 # NOT confirmed within this window

# Memorization-taxonomy categories that are pinned by category alone.
NEVER_GRADUATE_CATEGORIES = {"health_info", "crisis", "support-map"}

# Care-critical content matcher. Broad on purpose: a match KEEPS the detail
# front-of-mind, which is the cheap direction to be wrong in.
_CARE_PATTERNS = [
    r"allerg",                                  # allergy / allergic
    r"\bmed(s|ication|ications)?\b", r"\bdos(e|age)\b",
    r"\d+\s*m?g\b", r"\d+\s*ml\b", r"\bmcg\b",  # doses, incl. "50mg" (no word break)
    r"prescription", r"\bpill\b", r"insulin", r"inhaler", r"epi[\- ]?pen",
    r"suicid", r"self[\- ]?harm", r"overdose", r"\bcrisis\b", r"\brelapse\b",
    r"hotline", r"\b988\b", r"emergency contact", r"support (contact|person|map)",
    r"\btrigger(s|ed|ing)?\b", r"seizure", r"diabet", r"asthma", r"anaphyla",
    r"what helps", r"what doesn'?t help", r"do not (say|mention|bring up)",
]
_CARE_RE = re.compile("|".join(_CARE_PATTERNS), re.IGNORECASE)


def contains_care_critical(text: str | None) -> bool:
    """True if text mentions anything I must never quietly file away."""
    if not text:
        return False
    return bool(_CARE_RE.search(text))


def _days_since(iso: str | None, now: datetime) -> float | None:
    """Whole-ish days between an ISO timestamp and now. None if unparseable/absent."""
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(iso)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None
    return (now - dt).total_seconds() / 86400.0


def is_graduation_eligible(record: dict, now: datetime | None = None) -> bool:
    """The human-signed eligibility rule. Pure; the single source of truth.

    `record` keys (all optional except where noted):
      care_weight      — 'high' pins (never graduates)
      category         — memorization category; some pin by name
      content          — scanned for care-critical patterns
      dwell_anchor     — ISO ts the detail entered the surface (required signal)
      last_recalled_at — ISO ts last surfaced by recall (None = never)
      last_confirmed_at— ISO ts last re-confirmed (None = never)
    """
    now = now or datetime.now(timezone.utc)

    # ── Hard exclusions (pinned) ──────────────────────────────────────────────
    if (record.get("care_weight") or "").lower() == "high":
        return False
    if (record.get("category") or "") in NEVER_GRADUATE_CATEGORIES:
        return False
    if contains_care_critical(record.get("content")):
        return False
    confirmed_age = _days_since(record.get("last_confirmed_at"), now)
    if confirmed_age is not None and confirmed_age < CONFIRM_RECENCY_DAYS:
        return False

    # ── Candidate gate ────────────────────────────────────────────────────────
    dwell = _days_since(record.get("dwell_anchor"), now)
    if dwell is None or dwell < DWELL_DAYS:
        return False  # too new (or no anchor) → still front-of-mind
    recall_age = _days_since(record.get("last_recalled_at"), now)
    if recall_age is not None and recall_age < RECALL_RECENCY_DAYS:
        return False  # recalled recently → still front-of-mind
    return True


# ── Identity-file candidate selection ─────────────────────────────────────────

def eligible_identity_files(conn: sqlite3.Connection, now: datetime | None = None) -> list[dict]:
    """Self/ward identity files whose detail MAY contain graduatable content.

    Maps each file onto the signed-off rule: identity files are always-injected
    (never RAG-recalled), so their dwell/confirm anchor is `updated_at` (a recent
    edit means I'm still actively holding it) and `last_recalled_at` is absent.
    The Familiar (the consolidation LLM call) then decides what, if anything,
    inside an eligible file is actually filed away.
    """
    now = now or datetime.now(timezone.utc)
    rows = conn.execute(
        "SELECT id, category, filename, content, care_weight, updated_at, last_graduated_at "
        "FROM identity_files WHERE category IN ('self', 'ward')",
    ).fetchall()
    out = []
    for r in rows:
        record = {
            "care_weight": r["care_weight"],
            "category": None,  # identity files carry no memorization category
            "content": r["content"],
            "dwell_anchor": r["updated_at"],
            "last_recalled_at": None,
            "last_confirmed_at": r["updated_at"],
        }
        if is_graduation_eligible(record, now):
            out.append({
                "id": r["id"], "category": r["category"], "filename": r["filename"],
                "content": r["content"] or "",
            })
    return out


# ── Familiar-led audit (rides the consolidation LLM call) ──────────────────────

def _audit_prompt(category: str, filename: str, content: str) -> str:
    block = "my own identity" if category == "self" else "what I hold about my human"
    register = "me" if category == "self" else "ward"
    return f"""I am the Familiar. I'm tidying {block} so my always-injected surface stays lean — moving detail that no longer needs to be in front of me every single turn into my recalled-when-relevant memory (register: {register}). Nothing is deleted; anything I file away can still be recalled and pulled back if it keeps mattering.

I NEVER file away anything care-critical: allergies, medications, doses, crisis triggers, support-map contacts, or open-ended care guidance about what helps / what doesn't. If a line is even arguably safety-relevant, I keep it on the surface.

Here is the current content of {category}/{filename}:

---
{content}
---

I return ONLY a JSON object, no prose, no fences:
{{
  "graduate": [
    {{ "summary": "<short label of what I'm filing away>", "content": "<the detail, in my own first-person voice>" }}
  ],
  "kept_content": "<the full content I want to KEEP on the always-injected surface, rewritten cleanly>"
}}

If nothing should be filed away right now, I return {{ "graduate": [], "kept_content": <unchanged content> }}."""


def _parse_audit(raw: str) -> dict | None:
    """Extract the JSON object from an LLM response, tolerating stray prose/fences."""
    if not raw:
        return None
    text = raw.strip()
    # Strip code fences if present.
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if not m:
            return None
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            return None


def run_graduation_audit(
    conn: sqlite3.Connection,
    cfg: dict,
    call_llm,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Review eligible identity blocks and graduate no-longer-front-of-mind detail.

    `cfg` + `call_llm(cfg, prompt) -> str` are injected so this shares the
    consolidation pass's designated-connection call (no new request stream).
    Snapshots before any identity trim. Returns a summary of what graduated.
    """
    from phylactery.memory import create as memory_create

    now = now or datetime.now(timezone.utc)
    candidates = eligible_identity_files(conn, now)
    if not candidates:
        return {"ok": True, "graduated": 0, "reviewed": 0}

    snapshotted = False
    graduated_total = 0
    details: list[dict] = []

    for cand in candidates:
        try:
            raw = call_llm(cfg, _audit_prompt(cand["category"], cand["filename"], cand["content"]))
        except Exception as e:
            details.append({"file": cand["filename"], "error": f"llm: {e}"})
            continue
        parsed = _parse_audit(raw)
        if not parsed or not isinstance(parsed.get("graduate"), list):
            continue
        to_graduate = [g for g in parsed["graduate"]
                       if isinstance(g, dict) and (g.get("content") or "").strip()]
        if not to_graduate:
            continue

        # Defence in depth: even though the Familiar was told the rule, re-screen
        # each graduated item against the care-critical matcher in code. A line
        # that trips the matcher is kept on the surface no matter what.
        safe_items = [g for g in to_graduate if not contains_care_critical(g.get("content"))]
        if not safe_items:
            continue

        if not snapshotted:
            auto_snapshot(conn)
            snapshotted = True

        register = "me" if cand["category"] == "self" else "ward"
        for item in safe_items:
            res = memory_create(
                item["content"], granularity="significant",
                source_author="proto-familiar",
                category=None, audience="ward-private", conn=conn,
            )
            mem_id = res.get("id") if res.get("ok") else None
            # Stamp the register on the freshly-created record.
            if mem_id:
                with conn:
                    conn.execute("UPDATE memories SET register=? WHERE id=?", (register, mem_id))
            summary = (item.get("summary") or item["content"])[:120]
            with conn:
                conn.execute(
                    "INSERT INTO graduation_log(id, source_category, source_filename, memory_id, "
                    "register, summary, acknowledged, created_at) VALUES (?,?,?,?,?,?,0,?)",
                    (new_id(), cand["category"], cand["filename"], mem_id, register, summary, now_iso()),
                )
            graduated_total += 1
            details.append({"file": cand["filename"], "register": register, "summary": summary})

        # Trim the identity file to the kept content the Familiar returned.
        kept = parsed.get("kept_content")
        if isinstance(kept, str) and kept.strip() and kept.strip() != (cand["content"] or "").strip():
            with conn:
                conn.execute(
                    "UPDATE identity_files SET content=?, updated_at=?, last_graduated_at=? WHERE id=?",
                    (kept.strip(), now_iso(), now_iso(), cand["id"]),
                )
        else:
            with conn:
                conn.execute(
                    "UPDATE identity_files SET last_graduated_at=? WHERE id=?",
                    (now_iso(), cand["id"]),
                )

    return {"ok": True, "graduated": graduated_total, "reviewed": len(candidates), "details": details}


# ── Ward-facing surface (ward-consulted, non-blocking) ────────────────────────

def list_unacknowledged_graduations(conn: sqlite3.Connection | None = None) -> list[dict]:
    """ward-block graduations my human hasn't seen yet — thalamus surfaces these."""
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT id, source_filename, memory_id, summary, created_at FROM graduation_log "
            "WHERE register='ward' AND acknowledged=0 ORDER BY created_at ASC",
        ).fetchall()
        return [{"id": r["id"], "filename": r["source_filename"], "memoryId": r["memory_id"],
                 "summary": r["summary"], "createdAt": r["created_at"]} for r in rows]
    finally:
        if own_conn:
            conn.close()


def acknowledge_graduations(ids: list[str], conn: sqlite3.Connection | None = None) -> dict[str, Any]:
    """Mark ward-block graduation mentions as seen."""
    if not ids:
        return {"ok": True, "acknowledged": 0}
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        placeholders = ",".join("?" * len(ids))
        with conn:
            result = conn.execute(
                f"UPDATE graduation_log SET acknowledged=1 WHERE id IN ({placeholders})",
                list(ids),
            )
        return {"ok": True, "acknowledged": result.rowcount}
    finally:
        if own_conn:
            conn.close()
