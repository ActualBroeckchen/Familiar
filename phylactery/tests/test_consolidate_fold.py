"""Past-session ingestion folds into an already-consolidated span instead of
orphaning or clobbering it.

The reported bug: a session from weeks ago is ingested, minting a *past-dated*
daily. But that week was already rolled into a weekly summary and its original
dailies were PRUNED. Before the fix:

  - a single late daily never re-qualified (the ≥2 floor) → it sat orphaned at
    `daily` forever, surfacing as a stale fragment; and
  - two-or-more late dailies regenerated the weekly from ONLY the newcomers and
    REPLACED the row → the original week's summary was clobbered (data loss).

The fix: a week that already has a rollup re-qualifies with even one new daily,
and the existing summary is fed back into the LLM as the prior summary to fold
into — so nothing the original held is lost. Monthly/yearly don't prune their
sources, so they regenerate completely; they only need to re-roll when a newer
source appears (a re-ingested week folding upward), and that must terminate.

_call_llm / _llm_config / embed_text are patched — no model or network.
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
            consent_pending INTEGER DEFAULT 0, confidence REAL DEFAULT 1.0,
            source_json TEXT, created_at TEXT, updated_at TEXT,
            recall_count INTEGER DEFAULT 0, last_recalled_at TEXT
        )
    """)
    c.execute("CREATE VIRTUAL TABLE memory_vecs USING vec0(memory_id TEXT PRIMARY KEY, embedding float[4])")
    return c


def _distinct_embedder():
    seen: dict[str, str] = {}

    def _embed(text):
        if text not in seen:
            i = len(seen) + 1
            seen[text] = f"[{i}, {i * 2}, {i * 3}, {i * 5}]"
        return seen[text]

    return _embed


def _rows_at(c, granularity):
    return c.execute(
        "SELECT id, content, date_key FROM memories WHERE granularity=? ORDER BY date_key",
        (granularity,),
    ).fetchall()


class _Recorder:
    """A fake _call_llm that records every prompt it saw and returns a summary that
    echoes the newest daily it was asked to fold, so the resulting rollup content is
    observable across passes."""

    def __init__(self):
        self.prompts = []

    def __call__(self, cfg, prompt):
        self.prompts.append(prompt)
        return f"- rolled ({len(self.prompts)})"


def test_single_late_daily_folds_into_existing_week_not_orphaned():
    c = _conn()
    ref = date(2026, 1, 7)  # Wed → week of Mon 2026-01-05 … Sun 2026-01-11
    rec = _Recorder()
    with patch("phylactery.embed.embed_text", _distinct_embedder()), \
         patch("phylactery.consolidate._call_llm", rec), \
         patch("phylactery.consolidate._llm_config", lambda: {"api_key": "k", "base_url": "u", "model": "m"}):
        # First: two dailies roll into a weekly, and the dailies are pruned.
        memory.create("Monday walk", "daily", standalone=True, date_key="2026-01-06", conn=c)
        memory.create("Tuesday lunch", "daily", standalone=True, date_key="2026-01-07", conn=c)
        consolidate.consolidate_to_weekly(c, cfg={}, reference_date=ref)
        assert len(_rows_at(c, "weekly")) == 1
        assert len(_rows_at(c, "daily")) == 0
        prior_summary = _rows_at(c, "weekly")[0]["content"]

        # A past session is ingested: ONE late daily lands in that same, already-rolled week.
        memory.create("Friday phone call", "daily", standalone=True, date_key="2026-01-09", conn=c)

        # The whole-backlog sweep must now re-qualify this week off a single daily…
        assert consolidate._week_start(ref) in consolidate._distinct_past_weeks(c)
        res = consolidate.run_consolidation(conn=c)

    assert res["ok"], res
    # Still exactly one weekly row (replaced, not a second row); the late daily pruned.
    assert len(_rows_at(c, "weekly")) == 1
    assert len(_rows_at(c, "daily")) == 0
    # The re-roll folded: its prompt carried BOTH the prior summary and the newcomer,
    # so nothing the original week held could be lost.
    fold_prompt = rec.prompts[-1]
    assert prior_summary in fold_prompt, "prior weekly summary was not fed back in — clobber risk"
    assert "Friday phone call" in fold_prompt
    assert "fold" in fold_prompt.lower()


def test_multiple_late_dailies_do_not_clobber_the_prior_summary():
    c = _conn()
    ref = date(2026, 2, 4)  # week of Mon 2026-02-02 … Sun 2026-02-08
    rec = _Recorder()
    with patch("phylactery.embed.embed_text", _distinct_embedder()), \
         patch("phylactery.consolidate._call_llm", rec), \
         patch("phylactery.consolidate._llm_config", lambda: {"api_key": "k", "base_url": "u", "model": "m"}):
        memory.create("Mon", "daily", standalone=True, date_key="2026-02-02", conn=c)
        memory.create("Tue", "daily", standalone=True, date_key="2026-02-03", conn=c)
        consolidate.consolidate_to_weekly(c, cfg={}, reference_date=ref)
        prior_summary = _rows_at(c, "weekly")[0]["content"]

        # Two late dailies re-land in the already-rolled week.
        memory.create("Wed late", "daily", standalone=True, date_key="2026-02-04", conn=c)
        memory.create("Thu late", "daily", standalone=True, date_key="2026-02-05", conn=c)
        consolidate.run_consolidation(conn=c)

    assert len(_rows_at(c, "weekly")) == 1
    fold_prompt = rec.prompts[-1]
    # The prior summary was folded in (not discarded), and both newcomers are present.
    assert prior_summary in fold_prompt
    assert "Wed late" in fold_prompt and "Thu late" in fold_prompt


def test_a_week_with_no_new_dailies_and_a_rollup_is_left_alone():
    c = _conn()
    ref = date(2026, 3, 4)
    with patch("phylactery.embed.embed_text", _distinct_embedder()), \
         patch("phylactery.consolidate._call_llm", lambda cfg, p: "- rolled"), \
         patch("phylactery.consolidate._llm_config", lambda: {"api_key": "k", "base_url": "u", "model": "m"}):
        memory.create("A", "daily", standalone=True, date_key="2026-03-02", conn=c)
        memory.create("B", "daily", standalone=True, date_key="2026-03-03", conn=c)
        consolidate.consolidate_to_weekly(c, cfg={}, reference_date=ref)
        # No new dailies since — the week has a rollup but nothing to fold. Idempotent.
        assert consolidate._week_start(ref) not in consolidate._distinct_past_weeks(c)
        res = consolidate.run_consolidation(conn=c)
    assert res["results"]["weekly"]["periods"] == 0
    assert len(_rows_at(c, "weekly")) == 1


def test_newer_weekly_re_rolls_the_month_once_then_terminates():
    c = _conn()
    # Two weeklies in a past month → one monthly. Then simulate the monthly having
    # been rolled in a PRIOR session (age its updated_at back), which is exactly the
    # state a re-ingested week creates: a source now newer than the rollup.
    past_month = (date.today().replace(day=1) - timedelta(days=40)).replace(day=1)
    w1 = past_month
    w2 = past_month + timedelta(days=7)
    with patch("phylactery.embed.embed_text", lambda t: "[0,0,0,1]"), \
         patch("phylactery.consolidate._call_llm", lambda cfg, p: "- rolled up"), \
         patch("phylactery.consolidate._llm_config", lambda: {"api_key": "k", "base_url": "u", "model": "m"}):
        memory.create("week one", "weekly", date_key=w1.isoformat(), conn=c)
        memory.create("week two", "weekly", date_key=w2.isoformat(), conn=c)
        first = consolidate.run_consolidation(conn=c)
        assert first["results"]["monthly"]["periods"] == 1

        # The monthly was written "long ago"; its weeklies are now newer than it.
        c.execute("UPDATE memories SET updated_at='2000-01-01T00:00:00+00:00' WHERE granularity='monthly'")
        c.commit()

        second = consolidate.run_consolidation(conn=c)   # a newer source → re-roll once
        third = consolidate.run_consolidation(conn=c)     # rollup now newest → no-op

    assert second["results"]["monthly"]["periods"] == 1, "a newer weekly must re-roll the month"
    assert third["results"]["monthly"]["periods"] == 0, "re-roll must terminate, not loop"
    assert len(_rows_at(c, "monthly")) == 1
