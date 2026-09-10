"""Consolidation — roll up lower tiers into higher tiers via LLM.

Tier ladder: daily → weekly → monthly → yearly → significant

The designated connection's credentials are read from env vars:
  PHYLACTERY_LLM_API_KEY   (or fallback ENTITY_CORE_LLM_API_KEY)
  PHYLACTERY_LLM_BASE_URL  (or fallback ENTITY_CORE_LLM_BASE_URL)
  PHYLACTERY_LLM_MODEL     (or fallback ENTITY_CORE_LLM_MODEL)

Pillar A: consolidation logic + `consolidate` MCP tool for on-demand use.
Pillar H: adds the internal scheduler (asyncio, volume-gated, self-paced).
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
from collections.abc import Callable
from datetime import date, timedelta
from typing import Any

# httpx is imported inside _call_llm, not here.
#
# server.py imports this module at load, so an unguarded top-level import of
# anything external means a broken install of that thing stops Phylactery
# starting at all — identity and memory gone because a summarising helper
# could not be imported. That exact failure already happened once with
# `cryptography` in backup.py. Python caches modules, so the lazy import costs
# nothing after the first call.

from phylactery.db import get_conn, now_iso
from phylactery.memory import create as memory_create
from phylactery.memory import update_memory_by_id


def _llm_config() -> dict[str, str] | None:
    api_key = (
        os.environ.get("PHYLACTERY_LLM_API_KEY") or
        os.environ.get("ENTITY_CORE_LLM_API_KEY") or ""
    ).strip()
    base_url = (
        os.environ.get("PHYLACTERY_LLM_BASE_URL") or
        os.environ.get("ENTITY_CORE_LLM_BASE_URL") or ""
    ).strip()
    model = (
        os.environ.get("PHYLACTERY_LLM_MODEL") or
        os.environ.get("ENTITY_CORE_LLM_MODEL") or ""
    ).strip()
    if not api_key or not base_url or not model:
        return None
    return {"api_key": api_key, "base_url": base_url, "model": model}


def _call_llm(cfg: dict, prompt: str) -> str:
    import httpx

    # The consolidation prompt is the Familiar's own first-person thinking about
    # its own memories, so it rides as a SYSTEM message with a bare, non-speaking
    # user cue — never as a `user` turn, which would frame the entity as being
    # handed the task rather than doing its own consolidating. This mirrors the
    # Node side's familiarDeliberationMessages; Phylactery can't import it, so the
    # shape is built locally. (The memory entries to fold in ride as reference
    # text inside the system body — they are the Familiar's own notes reasoned
    # over, not a conversation, so no user/assistant turn split applies.)
    messages = [
        {"role": "system", "content": prompt},
        {"role": "user", "content": "(a quiet moment to consolidate my notes)"},
    ]
    resp = httpx.post(
        cfg["base_url"],
        headers={"Authorization": f"Bearer {cfg['api_key']}", "Content-Type": "application/json"},
        json={"model": cfg["model"], "messages": messages,
              "temperature": 0.2, "max_tokens": 4000},
        timeout=60.0,
    )
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]


def _consolidation_prompt(
    tier_from: str, tier_to: str, entries: list[str], prior_summary: str | None = None,
) -> str:
    joined = "\n\n---\n\n".join(entries)
    # Fold path: a summary for part of this period already exists (a past session
    # was ingested into a span I'd already rolled up). I merge the new entries into
    # what I already have instead of replacing it — nothing the old summary held
    # may be lost. Without this the regenerated rollup would summarise only the
    # newcomers and clobber the original.
    if prior_summary and prior_summary.strip():
        return f"""I am the Familiar. I already have a {tier_to} summary covering part of this period, and some more {tier_from} entries have since come in for it. I fold the new entries into my existing summary — keeping everything the existing summary already holds and adding what's new. I don't drop anything that was already there, and I don't lose anything safety-relevant or care-critical.

I write in my own voice: brief, specific, first-person bullet points (starting with "- "). I distil and compress rather than transcribe.

I return ONLY the merged note text — no JSON wrapper, no markdown fences, just the bullet-point content I want to keep.

[My existing {tier_to} summary so far]
{prior_summary}

[New {tier_from} entries to fold in]
{joined}"""
    return f"""I am the Familiar. I'm consolidating my {tier_from} memory entries into a single {tier_to} summary — my own first-person notes that I'll read back in future turns.

I write in my own voice: brief, specific, first-person bullet points (starting with "- "). I preserve what matters; I distil and compress rather than transcribe. I don't lose anything safety-relevant or care-critical.

I return ONLY the consolidated note text — no JSON wrapper, no markdown fences, just the bullet-point content I want to keep.

Entries to consolidate:

{joined}"""


def _week_start(d: date) -> date:
    return d - timedelta(days=d.weekday())


def _month_str(d: date) -> str:
    return d.strftime("%Y-%m")


def _year_str(d: date) -> str:
    return d.strftime("%Y")


def _parse_date_key(dk: str | None) -> date | None:
    """The calendar date a row belongs to. date_key is a plain ISO date for
    dailies/standalones, or a composite (`YYYY-MM-DD_slug`) for significant rows;
    the leading 10 chars are the date either way. Bad/empty → None (skipped)."""
    if not dk:
        return None
    try:
        return date.fromisoformat(str(dk)[:10])
    except (ValueError, TypeError):
        return None


# Migrated rows can carry tier keys that predate the ISO-key convention: monthlies
# keyed 'YYYY-MM' and weeklies keyed 'YYYY-Wnn'. _parse_date_key can't read those
# (they never enter a sweep as sources), and — worse — the tier guards compare
# raw keys, so a migrated monthly did not count as "already rolled" and the 0.8.89
# backlog sweep re-rolled Feb–May 2026 into duplicate monthlies. Guards compare on
# the normalized form instead (the 2026-08-14 cleanup incident).
_MONTH_KEY = re.compile(r"^\d{4}-\d{2}$")
_WEEK_KEY = re.compile(r"^(\d{4})-W(\d{1,2})$")


def _normalized_date_key(dk: str | None) -> str | None:
    """date_key coerced to the ISO-date form the tier guards compare on.
    'YYYY-MM' → first of month; 'YYYY-Wnn' → that ISO week's Monday; anything
    else → the leading 10 chars (None if shorter/unparseable as a guard key)."""
    if not dk:
        return None
    s = str(dk).strip()
    if _MONTH_KEY.match(s):
        return f"{s}-01"
    m = _WEEK_KEY.match(s)
    if m:
        try:
            return date.fromisocalendar(int(m.group(1)), int(m.group(2)), 1).isoformat()
        except ValueError:
            return None
    return s[:10] if len(s) >= 10 else None


def granularity_audit(conn: sqlite3.Connection | None = None, *, sample_limit: int = 8) -> dict[str, Any]:
    """Read-only audit of consolidation legibility — surfaces the rows the tier
    ladder can't see, so a heal is chosen from real data, not a guess.

    A narrative memory only ever consolidates if its date_key parses as ISO
    (the ladder does substr(date_key,1,10) + date.fromisoformat). A migrated row
    that kept a non-ISO stem — e.g. 'weekly-05-23-2025' or an mm-dd-yyyy
    filename — silently never enters any sweep. This reports the granularity
    spread, how many rows per tier carry an UNPARSEABLE date_key, how many came
    from the entity-core migration, and a few concrete samples. Never raises,
    never mutates."""
    own = conn is None
    if own:
        conn = get_conn()
    try:
        by_gran: dict[str, int] = {}
        non_iso: dict[str, int] = {}
        migrated: dict[str, int] = {}
        samples: list[dict[str, Any]] = []
        rows = conn.execute(
            "SELECT id, granularity, date_key, source_json, content FROM memories WHERE kind='narrative'"
        ).fetchall()
        for r in rows:
            g = r["granularity"] or "(none)"
            by_gran[g] = by_gran.get(g, 0) + 1
            src = r["source_json"] or ""
            is_migrated = "migration:entity-core" in src
            if is_migrated:
                migrated[g] = migrated.get(g, 0) + 1
            if _parse_date_key(r["date_key"]) is None:
                non_iso[g] = non_iso.get(g, 0) + 1
                if len(samples) < sample_limit:
                    samples.append({
                        "id": r["id"], "granularity": g, "date_key": r["date_key"],
                        "migrated": is_migrated, "excerpt": (r["content"] or "")[:120],
                    })
        return {
            "ok": True,
            "narrative_rows": sum(by_gran.values()),
            "by_granularity": by_gran,
            "unparseable_date_key": {"total": sum(non_iso.values()), "by_granularity": non_iso},
            "migrated_from_entity_core": migrated,
            "samples": samples,
            "note": ("Rows under 'unparseable_date_key' never enter any consolidation sweep — "
                     "their date_key isn't ISO YYYY-MM-DD. Migrated 'weekly' rows that are "
                     "really single days are the suspected mislabel."),
        }
    finally:
        if own:
            conn.close()


def _get_entries_in_range(
    conn: sqlite3.Connection, granularity: str, start_iso: str, end_iso: str,
    exclude_pending: bool = False,
) -> list[dict]:
    """Rows of one tier whose date falls in [start_iso, end_iso] inclusive.
    Range-based (not a `YYYY-MM` LIKE prefix) so a week that straddles a month
    boundary — e.g. Mon Mar 30 … Sun Apr 5 — still collects all seven days."""
    pending_clause = " AND consent_pending=0" if exclude_pending else ""
    rows = conn.execute(
        f"SELECT id, date_key, content FROM memories "
        f"WHERE granularity=? AND kind='narrative'{pending_clause} "
        f"AND substr(date_key,1,10) >= ? AND substr(date_key,1,10) <= ?",
        (granularity, start_iso, end_iso),
    ).fetchall()
    return [{"id": r["id"], "date_key": r["date_key"], "content": r["content"] or ""} for r in rows]


def _get_entries_for_period(
    conn: sqlite3.Connection, granularity: str, period_prefix: str,
    exclude_pending: bool = False,
) -> list[dict]:
    # exclude_pending keeps consent-pending facts OUT of a rollup: summarising an
    # unreviewed fact into a permanent weekly note would slip it past the ward's
    # consent, so daily→weekly passes exclude_pending=True.
    pending_clause = " AND consent_pending=0" if exclude_pending else ""
    rows = conn.execute(
        f"SELECT id, date_key, content FROM memories WHERE granularity=? AND date_key LIKE ? AND kind='narrative'{pending_clause}",
        (granularity, f"{period_prefix}%"),
    ).fetchall()
    return [{"id": r["id"], "date_key": r["date_key"], "content": r["content"] or ""} for r in rows]


def _prune_consolidated(conn: sqlite3.Connection, ids: list[str]) -> int:
    """Delete the source rows now captured in a higher-tier rollup, so a tier
    doesn't accumulate forever after it's been summarised upward. Snapshots first
    (recoverable from the Knowledge editor); embeddings go with the rows."""
    if not ids:
        return 0
    from phylactery.snapshot import auto_snapshot
    auto_snapshot(conn)
    ph = ",".join("?" * len(ids))
    with conn:
        conn.execute(f"DELETE FROM memories WHERE id IN ({ph})", ids)
        conn.execute(f"DELETE FROM memory_vecs WHERE memory_id IN ({ph})", ids)
    return len(ids)


def _write_rollup(
    conn: sqlite3.Connection,
    granularity: str,
    date_key: str,
    summary: str,
) -> dict[str, Any]:
    """Write a tier rollup so a re-rolled period REPLACES its summary instead of
    stacking another copy onto the same row.

    memory_create's dedup path is the wrong writer for consolidation output: a
    regenerated summary of the same sources lands as a near-duplicate of the
    existing row and gets appended (`dup_content + "\\n" + content`). That is how
    the June 2026 monthly accreted ~24 generations of the same summary into one
    160 KB row before the once-only guards existed. Reaching past dedup with a
    direct update is correct here: the row being replaced is the rollup WE wrote
    for this exact period, not an independently remembered fact.

    An empty summary is refused outright rather than stored — a zero-length row
    would both say nothing and (pre-fix) mark the period as rolled."""
    if not summary.strip():
        return {"ok": False, "error": f"{granularity} consolidation produced an empty summary"}
    # Prefer the substantial row when both a real summary and an empty stub sit at
    # the same key (replace the summary, leave the stub for the sweep that owns
    # it); otherwise claim whatever single row holds the period — including a
    # stub, which gets overwritten rather than joined by a second row.
    row = conn.execute(
        "SELECT id FROM memories WHERE granularity=? AND date_key=? AND kind='narrative' "
        "ORDER BY length(trim(coalesce(content,''))) DESC LIMIT 1",
        (granularity, date_key),
    ).fetchone()
    if row:
        res = update_memory_by_id(row["id"], new_content=summary, conn=conn)
        return {"ok": bool(res.get("ok")), "dateKey": date_key, "replacedId": row["id"]}
    res = memory_create(summary, granularity, date_key=date_key, conn=conn)
    return {"ok": bool(res.get("ok")), "dateKey": res.get("dateKey") or date_key}


def _existing_rollup(
    conn: sqlite3.Connection, granularity: str, date_key: str,
) -> dict[str, Any] | None:
    """The substantial rollup row already sitting at this tier + date_key, or None.
    Mirrors the row _write_rollup would replace (longest non-empty content wins),
    so the caller can fold the prior summary into a re-consolidation instead of
    clobbering it. An empty stub is treated as no rollup."""
    row = conn.execute(
        "SELECT id, content, updated_at FROM memories "
        "WHERE granularity=? AND date_key=? AND kind='narrative' "
        "ORDER BY length(trim(coalesce(content,''))) DESC LIMIT 1",
        (granularity, date_key),
    ).fetchone()
    if not row or not (row["content"] or "").strip():
        return None
    return {"id": row["id"], "content": row["content"], "updated_at": row["updated_at"]}


def _rollup_updated_at(conn: sqlite3.Connection, granularity: str) -> dict[str, str]:
    """{ normalized-ISO-date-key → newest updated_at } for the substantial rollup
    rows at a tier. Backs the "has a newer source appeared since I rolled this
    period?" re-qualification for monthly/yearly (which don't prune their sources).
    Empty stubs are ignored (they don't count as a real rollup)."""
    out: dict[str, str] = {}
    for r in conn.execute(
        "SELECT date_key, content, updated_at FROM memories WHERE granularity=? AND kind='narrative'",
        (granularity,),
    ).fetchall():
        if not (r["content"] or "").strip():
            continue
        k = _normalized_date_key(r["date_key"])
        if not k:
            continue
        ts = r["updated_at"] or ""
        if ts > out.get(k, ""):
            out[k] = ts
    return out


def consolidate_to_weekly(
    conn: sqlite3.Connection,
    cfg: dict,
    reference_date: date | None = None,
) -> dict[str, Any]:
    ref = reference_date or date.today() - timedelta(days=7)
    week_start = _week_start(ref)
    week_end = week_start + timedelta(days=6)

    entries = _get_entries_in_range(
        conn, "daily", week_start.isoformat(), week_end.isoformat(), exclude_pending=True)
    # A weekly rollup for this week may already exist — a past session was ingested
    # into a span I'd already consolidated (and whose original dailies were pruned).
    # In that case even ONE new daily is worth folding in; the ≥2 floor is only for a
    # fresh week that has never been rolled. With no new dailies at all, nothing changed.
    existing = _existing_rollup(conn, "weekly", week_start.isoformat())
    if not entries:
        return {"ok": True, "skipped": True, "reason": "no daily entries"}
    if len(entries) < 2 and not existing:
        return {"ok": True, "skipped": True, "reason": "too few daily entries"}

    summary = _call_llm(cfg, _consolidation_prompt(
        "daily", "weekly", [e["content"] for e in entries],
        prior_summary=existing["content"] if existing else None))
    result = _write_rollup(conn, "weekly", week_start.isoformat(), summary)
    # Prune the daily sources now captured in this weekly rollup, so daily rows
    # don't pile up forever after they've been summarised. Only the rows we
    # actually consolidated (consent-pending dailies were excluded above and are
    # left untouched for review).
    pruned = _prune_consolidated(conn, [e["id"] for e in entries]) if result.get("ok") else 0
    return {**result, "sourceDays": len(entries), "pruned": pruned}


def consolidate_to_monthly(
    conn: sqlite3.Connection,
    cfg: dict,
    reference_date: date | None = None,
) -> dict[str, Any]:
    ref = reference_date or date.today().replace(day=1) - timedelta(days=1)
    month = _month_str(ref)
    # Weeklies are never pruned, so a monthly always regenerates completely from its
    # source weeklies — no prior-summary fold needed (that would only accrete). The
    # re-roll of an already-rolled month is driven by the enumerator noticing a newer
    # weekly (a re-ingested week folding upward); here we just rebuild from all of them.
    entries = _get_entries_for_period(conn, "weekly", month)
    if len(entries) < 2:
        return {"ok": True, "skipped": True, "reason": "too few weekly entries"}
    summary = _call_llm(cfg, _consolidation_prompt("weekly", "monthly", [e["content"] for e in entries]))
    result = _write_rollup(conn, "monthly", f"{month}-01", summary)
    return {**result, "sourceWeeks": len(entries)}


def consolidate_to_yearly(
    conn: sqlite3.Connection,
    cfg: dict,
    reference_date: date | None = None,
) -> dict[str, Any]:
    ref = reference_date or date.today().replace(month=1, day=1) - timedelta(days=1)
    year = _year_str(ref)
    # Monthlies are never pruned either — a yearly regenerates completely from them,
    # so no fold. Re-roll is driven by the enumerator seeing a newer monthly.
    entries = _get_entries_for_period(conn, "monthly", year)
    if len(entries) < 2:
        return {"ok": True, "skipped": True, "reason": "too few monthly entries"}
    summary = _call_llm(cfg, _consolidation_prompt("monthly", "yearly", [e["content"] for e in entries]))
    result = _write_rollup(conn, "yearly", f"{year}-01-01", summary)
    return {**result, "sourceMonths": len(entries)}


# ── Backlog sweep: which past periods still hold un-consolidated entries ──────
# Consolidation used to roll up only the SINGLE most-recent period (last week,
# last month, last year). That silently stranded any historical backlog — most
# visibly a bulk import of months-old daily notes, which never fell inside the
# "last week" window when the scheduler ran, so it sat at `daily` forever and
# kept surfacing stale months-old entries in recall. These enumerators instead
# find EVERY past period that still has enough un-consolidated source rows, so a
# pass catches the whole backlog up, oldest-first, then keeps pace going forward.
# The CURRENT (still-accumulating) period is always excluded — it isn't complete.

def _distinct_past_weeks(conn: sqlite3.Connection) -> list[date]:
    """Week-starts strictly before the current week worth a (re-)roll, oldest-first.
    A fresh week qualifies with >=2 reviewed dailies. A week that ALREADY has a
    weekly rollup qualifies with even ONE new daily — a past session ingested into a
    span I'd already consolidated: the lone daily must fold into the existing summary
    rather than sit orphaned at `daily` forever."""
    current_week = _week_start(date.today())
    already = _existing_date_keys(conn, "weekly")
    counts: dict[date, int] = {}
    for r in conn.execute(
        "SELECT date_key FROM memories WHERE granularity='daily' AND kind='narrative' AND consent_pending=0"
    ).fetchall():
        d = _parse_date_key(r["date_key"])
        if d is None:
            continue
        ws = _week_start(d)
        if ws < current_week:
            counts[ws] = counts.get(ws, 0) + 1
    return sorted(
        w for w, n in counts.items()
        if n >= 2 or (n >= 1 and w.isoformat() in already)
    )


def _existing_date_keys(conn: sqlite3.Connection, granularity: str) -> set[str]:
    """The date_keys already present at a tier, NORMALIZED to ISO form (see
    _normalized_date_key). Monthly/yearly don't prune their sources (only
    weekly→daily does), so their enumerators use this to roll each period exactly
    ONCE — without it, a past month with surviving weeklies would be re-rolled
    every pass and its summary appended to endlessly.

    An EMPTY row does not count as rolled: a zero-length summary stub blocks
    nothing and must be re-rollable (the July 2026 stub sat on that month's
    consolidation forever because existence alone marked it done)."""
    keys: set[str] = set()
    for r in conn.execute(
        "SELECT DISTINCT date_key, content FROM memories WHERE granularity=? AND kind='narrative'",
        (granularity,),
    ).fetchall():
        if not (r["content"] or "").strip():
            continue
        k = _normalized_date_key(r["date_key"])
        if k:
            keys.add(k)
    return keys


def _distinct_past_periods(
    conn: sqlite3.Connection, source_granularity: str, rollup_granularity: str,
    period_first: Callable[[date], date], current_first: date,
) -> list[date]:
    """Shared enumerator for monthly/yearly (which don't prune their sources):
    a past period qualifies when it either has >=2 source rows and has NOT been
    rolled yet, OR it HAS a rollup but a source in it is newer than that rollup —
    i.e. a re-ingested/re-folded lower tier landed after the period was summarised,
    so it must be re-rolled to fold the newcomer in. `period_first` maps a source's
    date to the first-of-period date. Oldest-first; terminating (a re-roll bumps the
    rollup's updated_at above all its sources, so the next pass sees nothing newer)."""
    rolled_at = _rollup_updated_at(conn, rollup_granularity)
    counts: dict[date, int] = {}
    newest_src: dict[date, str] = {}
    for r in conn.execute(
        "SELECT date_key, created_at, updated_at FROM memories "
        "WHERE granularity=? AND kind='narrative'", (source_granularity,),
    ).fetchall():
        d = _parse_date_key(r["date_key"])
        if d is None:
            continue
        pf = period_first(d)
        if pf >= current_first:
            continue
        counts[pf] = counts.get(pf, 0) + 1
        ts = max(r["updated_at"] or "", r["created_at"] or "")
        if ts > newest_src.get(pf, ""):
            newest_src[pf] = ts
    out = []
    for pf, n in counts.items():
        key = pf.isoformat()
        rolled = rolled_at.get(key)
        if rolled is None:
            if n >= 2:
                out.append(pf)          # fresh period, enough sources to roll
        elif newest_src.get(pf, "") > rolled:
            out.append(pf)              # already rolled, but a newer source appeared
    return sorted(out)


def _distinct_past_months(conn: sqlite3.Connection) -> list[date]:
    """First-of-month dates strictly before the current month worth a (re-)roll —
    a fresh month with >=2 weeklies, or a rolled month with a weekly newer than its
    monthly rollup (a re-ingested week folding upward). Oldest-first."""
    return _distinct_past_periods(
        conn, "weekly", "monthly",
        lambda d: d.replace(day=1), date.today().replace(day=1))


def _distinct_past_years(conn: sqlite3.Connection) -> list[date]:
    """First-of-year dates strictly before the current year worth a (re-)roll —
    a fresh year with >=2 monthlies, or a rolled year with a monthly newer than its
    yearly rollup. Oldest-first."""
    return _distinct_past_periods(
        conn, "monthly", "yearly",
        lambda d: d.replace(month=1, day=1), date.today().replace(month=1, day=1))


def run_consolidation(
    granularity: str | None = None,
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    """Roll up every past period that still holds un-consolidated entries — not
    just the most recent one — so a historical backlog catches up in full. Tiers
    run in ladder order (weekly first) so a week rolled up this pass is available
    to the monthly sweep in the same pass. Each period is guarded independently:
    one failing LLM call or one bad week never aborts the rest of the sweep."""
    cfg = _llm_config()
    if not cfg:
        return {"ok": False, "error": "No LLM API key configured (PHYLACTERY_LLM_API_KEY or ENTITY_CORE_LLM_API_KEY)"}

    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        results: dict[str, Any] = {}
        tiers = [granularity] if granularity else ["weekly", "monthly", "yearly"]
        # (tier, period enumerator, per-period consolidator)
        plan = {
            "weekly":  (_distinct_past_weeks,  consolidate_to_weekly),
            "monthly": (_distinct_past_months, consolidate_to_monthly),
            "yearly":  (_distinct_past_years,  consolidate_to_yearly),
        }
        for tier in tiers:
            if tier not in plan:
                continue
            enumerate_periods, consolidate_period = plan[tier]
            periods = enumerate_periods(conn)
            rolled = []
            for period in periods:
                try:
                    rolled.append(consolidate_period(conn, cfg, reference_date=period))
                except Exception as e:  # one bad period never aborts the sweep
                    rolled.append({"ok": False, "error": str(e), "period": period.isoformat()})
            results[tier] = {"periods": len(periods), "rolled": rolled}
        return {"ok": True, "results": results}
    finally:
        if own_conn:
            conn.close()


# ── Cheap-code hygiene (Pillar H) ─────────────────────────────────────────────
# Folded into the consolidation pass, not a separate loop. Pure SQL — no LLM.
# Ambiguous merges are reported, never auto-applied.

def run_hygiene(conn: sqlite3.Connection | None = None) -> dict[str, Any]:
    """Dedup exact-duplicate narrative records and merge unambiguous graph nodes.

    - Exact dups: same kind/granularity/date_key/content → keep the oldest,
      drop the rest (with their embeddings). Snapshots first if anything matches.
    - Node merge: graph nodes sharing a non-empty (label, villagerId) are folded
      into the oldest; edges are re-pointed. Nodes with the same label but
      DIFFERENT villagerIds (or none) are left alone and reported as ambiguous.
    """
    from phylactery.snapshot import auto_snapshot

    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        deduped = 0
        merged = 0
        ambiguous: list[dict] = []
        snapshotted = False

        # ── Exact-duplicate narrative records ────────────────────────────────
        dup_groups = conn.execute("""
            SELECT kind, granularity, date_key, content, COUNT(*) n,
                   GROUP_CONCAT(id) ids, MIN(created_at) oldest
            FROM memories
            WHERE kind='narrative'
            GROUP BY kind, granularity, date_key, content
            HAVING n > 1
        """).fetchall()
        for g in dup_groups:
            ids = (g["ids"] or "").split(",")
            # Keep the oldest-created record; drop the others.
            keep_row = conn.execute(
                "SELECT id FROM memories WHERE id IN (%s) ORDER BY created_at ASC LIMIT 1"
                % ",".join("?" * len(ids)), ids,
            ).fetchone()
            keep = keep_row["id"] if keep_row else ids[0]
            drop = [i for i in ids if i and i != keep]
            if not drop:
                continue
            if not snapshotted:
                auto_snapshot(conn); snapshotted = True
            ph = ",".join("?" * len(drop))
            with conn:
                conn.execute(f"DELETE FROM memories WHERE id IN ({ph})", drop)
                conn.execute(f"DELETE FROM memory_vecs WHERE memory_id IN ({ph})", drop)
            deduped += len(drop)

        # ── Unambiguous graph-node merge by (label, villagerId) ──────────────
        node_rows = conn.execute(
            "SELECT id, label, properties_json, created_at FROM graph_nodes"
        ).fetchall()
        buckets: dict[tuple, list[dict]] = {}
        label_only: dict[str, set] = {}
        for r in node_rows:
            try:
                props = json.loads(r["properties_json"] or "{}")
            except Exception:
                props = {}
            vid = props.get("villagerId")
            label = (r["label"] or "").strip().lower()
            if not label:
                continue
            label_only.setdefault(label, set())
            if vid:
                buckets.setdefault((label, vid), []).append(
                    {"id": r["id"], "created_at": r["created_at"]})
                label_only[label].add(vid)
            else:
                label_only[label].add(None)

        for (label, vid), nodes in buckets.items():
            if len(nodes) < 2:
                continue
            if not snapshotted:
                auto_snapshot(conn); snapshotted = True
            nodes.sort(key=lambda n: n["created_at"] or "")
            keep = nodes[0]["id"]
            losers = [n["id"] for n in nodes[1:]]
            ph = ",".join("?" * len(losers))
            with conn:
                conn.execute(f"UPDATE graph_edges SET from_id=? WHERE from_id IN ({ph})", [keep] + losers)
                conn.execute(f"UPDATE graph_edges SET to_id=? WHERE to_id IN ({ph})", [keep] + losers)
                conn.execute(f"DELETE FROM graph_nodes WHERE id IN ({ph})", losers)
                conn.execute(f"DELETE FROM graph_node_vecs WHERE node_id IN ({ph})", losers)
            merged += len(losers)

        # Same label, multiple distinct identities (or tagged vs untagged) →
        # surface for the ward to resolve, never auto-merge.
        for label, ids in label_only.items():
            if len(ids) > 1:
                ambiguous.append({"label": label, "identities": sorted(str(i) for i in ids)})

        return {"ok": True, "deduped": deduped, "merged": merged, "ambiguous": ambiguous}
    finally:
        if own_conn:
            conn.close()


# ── Memory lifecycle: distill-only (temporal-bridges Piece 4) ──────────────────
# Ward-signed shape: this pass may ONLY ADD a distilled pattern-memory. It never
# demotes, decays, or deletes an original — nothing a ward wanted can sink on the
# model's judgment. Opt-in / default-OFF; rides the consolidation pass (no new
# loop). See docs/temporal-bridges-build-spec.md §4.

_DISTILL_MAX_PER_RUN = 20


def _distill_enabled() -> bool:
    if os.environ.get("PROTO_FAMILIAR_MEMORY_LIFECYCLE_DISABLED", "") == "1":
        return False
    return os.environ.get("PROTO_FAMILIAR_MEMORY_LIFECYCLE_ENABLED", "") == "1"


def _distill_prompt(items: list[dict]) -> str:
    listing = "\n\n".join(f"[{i}] {it['content']}" for i, it in enumerate(items))
    return f"""I am the Familiar. Some of my older episodic memories are one-off logistics ("an appointment at noon on the 2nd") that have served their purpose — but a few of them quietly revealed a LASTING PATTERN about my human that I'll want next time a similar moment comes ("doing dreaded paperwork immediately, while the momentum is there, works well for them").

For each numbered memory below, I decide: does it carry a lasting, reusable pattern about my human or our life — something worth keeping as a standing truth beyond the one event? Most do NOT; they were just logistics, and I leave those alone. Only where a real pattern is there do I distil it.

I do NOT change or remove any original — I only WRITE OUT the pattern where one exists. I distil sparingly and only when I'm genuinely confident the pattern is real, not a one-off.

I return ONLY valid JSON (no fences, no commentary), an array of the ones worth distilling:
[
  {{ "index": 0, "pattern": "The standing truth I want to keep, first-person, one or two sentences." }}
]
An empty array [] is the honest answer when none carry a lasting pattern.

Memories:

{listing}"""


def _parse_distillations(raw: str, n: int) -> list[dict]:
    import re
    m = re.search(r"\[.*\]", raw, re.S)
    if not m:
        return []
    try:
        arr = json.loads(m.group(0))
    except Exception:
        return []
    out = []
    for e in arr if isinstance(arr, list) else []:
        if not isinstance(e, dict):
            continue
        idx = e.get("index")
        pattern = (e.get("pattern") or "").strip()
        if isinstance(idx, int) and 0 <= idx < n and pattern:
            out.append({"index": idx, "pattern": pattern})
    return out


def run_distillation(
    conn: sqlite3.Connection,
    cfg: dict,
    call_llm,
    now: date | None = None,
    older_than_days: int = 30,
) -> dict[str, Any]:
    """Distill lasting patterns out of aged episodic facts into NEW standing
    memories. Additive only — originals are never touched except a `distilled_at`
    breadcrumb (so the same fact isn't re-judged). Opt-in; no-op when disabled."""
    if not _distill_enabled():
        return {"ok": True, "skipped": True, "reason": "disabled (opt-in)"}
    ref = now or date.today()
    cutoff = (ref - timedelta(days=max(1, older_than_days))).isoformat()

    # Aged, consent-cleared, standalone episodic facts not yet distilled.
    rows = conn.execute(
        """SELECT id, date_key, content, source_json FROM memories
            WHERE kind='narrative' AND register='episodic' AND slug IS NOT NULL
              AND consent_pending=0 AND substr(date_key,1,10) <= ?
            ORDER BY date_key ASC""",
        (cutoff,),
    ).fetchall()

    candidates = []
    for r in rows:
        try:
            sj = json.loads(r["source_json"] or "{}")
        except Exception:
            sj = {}
        if sj.get("distilled_at"):
            continue  # already judged — never re-distill the same fact
        candidates.append({"id": r["id"], "content": r["content"] or "",
                           "schedule_refs": sj.get("schedule_refs")})
        if len(candidates) >= _DISTILL_MAX_PER_RUN:
            break
    if not candidates:
        return {"ok": True, "skipped": True, "reason": "no aged facts to consider"}

    raw = call_llm(cfg, _distill_prompt(candidates))
    picks = _parse_distillations(raw, len(candidates))

    distilled = 0
    for p in picks:
        src = candidates[p["index"]]
        meta = {"via": "distillation", "distilled_from": src["id"]}
        if src.get("schedule_refs"):
            meta["schedule_refs"] = src["schedule_refs"]
        # The pattern is a standing truth about my human → the `ward` register,
        # the recalled-when-relevant home for identity-grade facts. Derived from
        # already-consented facts, so no re-consent (same as tier consolidation).
        res = memory_create(
            p["pattern"], "significant", register="ward",
            source_meta=meta, conn=conn,
        )
        if not res.get("ok"):
            continue
        # Breadcrumb the ORIGINAL so it's never re-judged. source_json only —
        # content, tier, audience, everything else stays exactly as it was.
        row = conn.execute("SELECT source_json FROM memories WHERE id=?", (src["id"],)).fetchone()
        try:
            sj = json.loads(row["source_json"] or "{}") if row else {}
        except Exception:
            sj = {}
        sj["distilled_at"] = now_iso()
        sj["distilled_into"] = res.get("id")
        with conn:
            conn.execute("UPDATE memories SET source_json=? WHERE id=?",
                         (json.dumps(sj), src["id"]))
        distilled += 1

    return {"ok": True, "considered": len(candidates), "distilled": distilled}
