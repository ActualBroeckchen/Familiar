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
import sqlite3
from datetime import date, timedelta
from typing import Any

import httpx

from phylactery.db import get_conn, new_id, now_iso
from phylactery.memory import create as memory_create


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
    resp = httpx.post(
        cfg["base_url"],
        headers={"Authorization": f"Bearer {cfg['api_key']}", "Content-Type": "application/json"},
        json={"model": cfg["model"], "messages": [{"role": "user", "content": prompt}],
              "temperature": 0.2, "max_tokens": 4000},
        timeout=60.0,
    )
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]


def _consolidation_prompt(tier_from: str, tier_to: str, entries: list[str]) -> str:
    joined = "\n\n---\n\n".join(entries)
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


def _get_entries_for_period(
    conn: sqlite3.Connection, granularity: str, period_prefix: str
) -> list[dict]:
    rows = conn.execute(
        "SELECT id, date_key, content FROM memories WHERE granularity=? AND date_key LIKE ? AND kind='narrative'",
        (granularity, f"{period_prefix}%"),
    ).fetchall()
    return [{"id": r["id"], "date_key": r["date_key"], "content": r["content"] or ""} for r in rows]


def consolidate_to_weekly(
    conn: sqlite3.Connection,
    cfg: dict,
    reference_date: date | None = None,
) -> dict[str, Any]:
    ref = reference_date or date.today() - timedelta(days=7)
    week_start = _week_start(ref)
    week_key = f"{week_start.isoformat()}_to_{(week_start + timedelta(days=6)).isoformat()}"
    period_prefix = week_start.isoformat()[:7]  # YYYY-MM to catch the week's days

    entries = _get_entries_for_period(conn, "daily", period_prefix)
    entries = [e for e in entries if week_start.isoformat() <= e["date_key"] <= (week_start + timedelta(days=6)).isoformat()]
    if len(entries) < 2:
        return {"ok": True, "skipped": True, "reason": "too few daily entries"}

    summary = _call_llm(cfg, _consolidation_prompt("daily", "weekly", [e["content"] for e in entries]))
    result = memory_create(summary, "weekly", date_key=week_start.isoformat(), conn=conn)
    return {"ok": True, "dateKey": result.get("dateKey"), "sourceDays": len(entries)}


def consolidate_to_monthly(
    conn: sqlite3.Connection,
    cfg: dict,
    reference_date: date | None = None,
) -> dict[str, Any]:
    ref = reference_date or date.today().replace(day=1) - timedelta(days=1)
    month = _month_str(ref)
    entries = _get_entries_for_period(conn, "weekly", month)
    if len(entries) < 2:
        return {"ok": True, "skipped": True, "reason": "too few weekly entries"}
    summary = _call_llm(cfg, _consolidation_prompt("weekly", "monthly", [e["content"] for e in entries]))
    result = memory_create(summary, "monthly", date_key=f"{month}-01", conn=conn)
    return {"ok": True, "dateKey": result.get("dateKey"), "sourceWeeks": len(entries)}


def consolidate_to_yearly(
    conn: sqlite3.Connection,
    cfg: dict,
    reference_date: date | None = None,
) -> dict[str, Any]:
    ref = reference_date or date.today().replace(month=1, day=1) - timedelta(days=1)
    year = _year_str(ref)
    entries = _get_entries_for_period(conn, "monthly", year)
    if len(entries) < 2:
        return {"ok": True, "skipped": True, "reason": "too few monthly entries"}
    summary = _call_llm(cfg, _consolidation_prompt("monthly", "yearly", [e["content"] for e in entries]))
    result = memory_create(summary, "yearly", date_key=f"{year}-01-01", conn=conn)
    return {"ok": True, "dateKey": result.get("dateKey"), "sourceMonths": len(entries)}


def run_consolidation(
    granularity: str | None = None,
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    """Run consolidation for the requested tier (or all tiers if None)."""
    cfg = _llm_config()
    if not cfg:
        return {"ok": False, "error": "No LLM API key configured (PHYLACTERY_LLM_API_KEY or ENTITY_CORE_LLM_API_KEY)"}

    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        results = {}
        tiers = [granularity] if granularity else ["weekly", "monthly", "yearly"]
        for tier in tiers:
            try:
                if tier == "weekly":
                    results["weekly"] = consolidate_to_weekly(conn, cfg)
                elif tier == "monthly":
                    results["monthly"] = consolidate_to_monthly(conn, cfg)
                elif tier == "yearly":
                    results["yearly"] = consolidate_to_yearly(conn, cfg)
            except Exception as e:
                results[tier] = {"ok": False, "error": str(e)}
        return {"ok": True, "results": results}
    finally:
        if own_conn:
            conn.close()
