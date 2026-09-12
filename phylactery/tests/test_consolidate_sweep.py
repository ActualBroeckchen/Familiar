"""Consolidation sweeps the whole backlog of past periods, not just the single
most-recent one.

Regression: run_consolidation used to roll up only last week / last month / last
year, so a bulk import of months-old daily notes never fell inside that window
and sat at `daily` forever (surfacing stale months-old entries in recall). The
sweep must roll up EVERY past week that holds >=2 reviewed dailies.

_call_llm and _llm_config are patched so no model / network is needed.
"""

import sqlite3
from datetime import date, timedelta
import pytest
from unittest.mock import patch

from phylactery import memory
from phylactery import consolidate


def _conn():
    try:
        import sqlite_vec
    except ImportError:
        pytest.skip("sqlite-vec not installed")
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.enable_load_extension(True)
    sqlite_vec.load(c)
    c.enable_load_extension(False)
    c.execute("""
        CREATE TABLE memories(
            id TEXT PRIMARY KEY, kind TEXT, register TEXT, granularity TEXT,
            date_key TEXT, slug TEXT, content TEXT, audience TEXT,
            subjects_json TEXT, care_weight TEXT, category TEXT, content_tag TEXT,
            consent_pending INTEGER DEFAULT 0, confidence REAL DEFAULT 1.0, attribution_confidence REAL,
            source_json TEXT, created_at TEXT, updated_at TEXT,
            recall_count INTEGER DEFAULT 0, last_recalled_at TEXT
        )
    """)
    c.execute("CREATE VIRTUAL TABLE memory_vecs USING vec0(memory_id TEXT PRIMARY KEY, embedding float[4])")
    return c


def _rows_at(c, granularity):
    return c.execute(
        "SELECT date_key FROM memories WHERE granularity=? ORDER BY date_key",
        (granularity,),
    ).fetchall()


def _distinct_embedder():
    """A fake embed_text giving every distinct string its own distinct vector, so
    semantic dedup doesn't collapse rows the test means to keep separate (a single
    constant vector makes every fact look identical)."""
    seen: dict[str, str] = {}

    def _embed(text):
        if text not in seen:
            i = len(seen) + 1
            seen[text] = f"[{i}, {i * 2}, {i * 3}, {i * 5}]"
        return seen[text]

    return _embed


def test_sweep_rolls_up_every_past_week_not_just_the_latest():
    c = _conn()
    # Three distinct, well-past weeks each with two reviewed dailies — the shape
    # of a months-old backfill. A Monday for each of three consecutive weeks,
    # all comfortably before "this week".
    base = date.today() - timedelta(days=90)
    monday = base - timedelta(days=base.weekday())
    weeks = [monday, monday - timedelta(days=7), monday - timedelta(days=14)]

    with patch("phylactery.embed.embed_text", _distinct_embedder()), \
         patch("phylactery.consolidate._call_llm", lambda cfg, p: "- rolled up"), \
         patch("phylactery.consolidate._llm_config", lambda: {"api_key": "k", "base_url": "u", "model": "m"}):
        for wk in weeks:
            memory.create(f"note {wk.isoformat()} one", "daily", standalone=True,
                          date_key=wk.isoformat(), conn=c)
            memory.create(f"note {wk.isoformat()} two", "daily", standalone=True,
                          date_key=(wk + timedelta(days=1)).isoformat(), conn=c)

        res = consolidate.run_consolidation(conn=c)

    assert res["ok"], res
    # All three weeks rolled up — not just the most recent.
    assert res["results"]["weekly"]["periods"] == 3
    weekly_rows = _rows_at(c, "weekly")
    assert len(weekly_rows) == 3, f"expected 3 weekly rollups, got {weekly_rows}"
    # And the daily sources were pruned (weekly consolidation prunes what it rolls).
    assert len(_rows_at(c, "daily")) == 0


def test_sweep_leaves_the_current_week_alone():
    c = _conn()
    # The still-accumulating current week must never be rolled — it isn't complete.
    today = date.today()
    this_week_mon = today - timedelta(days=today.weekday())
    with patch("phylactery.embed.embed_text", _distinct_embedder()), \
         patch("phylactery.consolidate._call_llm", lambda cfg, p: "- rolled up"), \
         patch("phylactery.consolidate._llm_config", lambda: {"api_key": "k", "base_url": "u", "model": "m"}):
        memory.create("today a", "daily", standalone=True, date_key=this_week_mon.isoformat(), conn=c)
        memory.create("today b", "daily", standalone=True,
                      date_key=(this_week_mon + timedelta(days=1)).isoformat(), conn=c)
        res = consolidate.run_consolidation(conn=c)

    assert res["results"]["weekly"]["periods"] == 0
    assert len(_rows_at(c, "weekly")) == 0
    assert len(_rows_at(c, "daily")) == 2  # untouched


def test_monthly_rolls_once_not_re_appended_each_pass():
    c = _conn()
    # Two weeklies in a past month → one monthly. A second pass must NOT roll the
    # same month again (monthly doesn't prune weeklies, so the guard matters).
    past_month = (date.today().replace(day=1) - timedelta(days=40)).replace(day=1)
    w1 = past_month  # first-of-month is fine as a stand-in week_start for the test
    w2 = past_month + timedelta(days=7)
    with patch("phylactery.embed.embed_text", lambda t: "[0,0,0,1]"), \
         patch("phylactery.consolidate._call_llm", lambda cfg, p: "- rolled up"), \
         patch("phylactery.consolidate._llm_config", lambda: {"api_key": "k", "base_url": "u", "model": "m"}):
        memory.create("week one", "weekly", date_key=w1.isoformat(), conn=c)
        memory.create("week two", "weekly", date_key=w2.isoformat(), conn=c)
        first = consolidate.run_consolidation(conn=c)
        second = consolidate.run_consolidation(conn=c)

    assert first["results"]["monthly"]["periods"] == 1
    assert second["results"]["monthly"]["periods"] == 0  # already done — not re-rolled
    assert len(_rows_at(c, "monthly")) == 1


def test_granularity_audit_flags_unparseable_migrated_rows():
    # A read-only audit must surface rows the tier ladder can't see: their
    # date_key isn't ISO, so consolidation's date.fromisoformat(...) skips them.
    c = _conn()
    with patch("phylactery.embed.embed_text", _distinct_embedder()):
        # Two healthy dailies (ISO date_key) — distinct vectors so dedup keeps both.
        memory.create("good one", "daily", standalone=True, date_key="2025-05-01", conn=c)
        memory.create("good two", "daily", standalone=True, date_key="2025-05-02", conn=c)
    # A migrated 'weekly' row with a raw, non-ISO stem (the reported mislabel).
    c.execute(
        "INSERT INTO memories(id, kind, register, granularity, date_key, content, "
        "audience, source_json, created_at, updated_at) VALUES "
        "('m-bad','narrative','episodic','weekly','weekly-05-23-2025','a single day', "
        "'ward-private','{\"author\":\"migration:entity-core\",\"originalId\":\"ec-memory:weekly/weekly-05-23-2025\"}','t','t')"
    )
    audit = consolidate.granularity_audit(conn=c)
    assert audit["ok"] is True
    assert audit["unparseable_date_key"]["total"] == 1
    assert audit["unparseable_date_key"]["by_granularity"].get("weekly") == 1
    assert audit["migrated_from_entity_core"].get("weekly") == 1
    assert any(s["date_key"] == "weekly-05-23-2025" and s["migrated"] for s in audit["samples"])
    # The two healthy dailies parse fine and are NOT flagged.
    assert audit["by_granularity"].get("daily") == 2
