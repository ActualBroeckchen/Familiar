"""Weekly consolidation prunes the daily sources it rolls up, and never touches
consent-pending dailies — those stay out of the summary (so an unreviewed fact
can't be baked into a permanent weekly note) and out of the prune.

embed_text and _call_llm are mocked so no model / network is needed.
"""

import sqlite3
from datetime import date
import pytest
from unittest.mock import patch

from phylactery import memory
from phylactery import consolidate


_VECS = {
    "Monday walk":     "[1, 0, 0, 0]",
    "Tuesday lunch":   "[0, 1, 0, 0]",
    "Secret pending":  "[0, 0, 1, 0]",
}


def _fake_embed(text):
    return _VECS.get(text, "[0, 0, 0, 1]")


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
            subjects_json TEXT, care_weight TEXT, category TEXT,
            consent_pending INTEGER DEFAULT 0, confidence REAL DEFAULT 1.0,
            source_json TEXT, created_at TEXT, updated_at TEXT,
            recall_count INTEGER DEFAULT 0, last_recalled_at TEXT
        )
    """)
    c.execute("CREATE VIRTUAL TABLE memory_vecs USING vec0(memory_id TEXT PRIMARY KEY, embedding float[4])")
    return c


def _ids_at(c, granularity):
    return [r[0] for r in c.execute("SELECT id FROM memories WHERE granularity=?", (granularity,)).fetchall()]


def test_weekly_consolidation_prunes_sources_and_spares_pending():
    c = _conn()
    ref = date(2026, 1, 7)  # Wednesday → week of Mon 2026-01-05 … Sun 2026-01-11
    captured = {}

    def _fake_llm(cfg, prompt):
        captured["prompt"] = prompt
        return "- consolidated week"

    with patch("phylactery.embed.embed_text", _fake_embed), \
         patch("phylactery.consolidate._call_llm", _fake_llm):
        a = memory.create("Monday walk", "daily", standalone=True, date_key="2026-01-06", conn=c)
        b = memory.create("Tuesday lunch", "daily", standalone=True, date_key="2026-01-07", conn=c)
        p = memory.create("Secret pending", "daily", standalone=True, date_key="2026-01-08",
                          consent_pending=True, conn=c)

        res = consolidate.consolidate_to_weekly(c, cfg={}, reference_date=ref)

    assert res["ok"] and res.get("pruned") == 2
    # A weekly rollup now exists…
    assert len(_ids_at(c, "weekly")) == 1
    # …the two reviewed dailies were pruned, the consent-pending one survived.
    remaining_daily = _ids_at(c, "daily")
    assert remaining_daily == [p["id"]]
    assert a["id"] not in remaining_daily and b["id"] not in remaining_daily
    # The pending fact's content never entered the summary prompt (no consent leak).
    assert "Secret pending" not in captured["prompt"]
    assert "Monday walk" in captured["prompt"] and "Tuesday lunch" in captured["prompt"]


def test_pruned_daily_embeddings_go_too():
    c = _conn()
    ref = date(2026, 1, 7)
    with patch("phylactery.embed.embed_text", _fake_embed), \
         patch("phylactery.consolidate._call_llm", lambda cfg, p: "- week"):
        memory.create("Monday walk", "daily", standalone=True, date_key="2026-01-06", conn=c)
        memory.create("Tuesday lunch", "daily", standalone=True, date_key="2026-01-07", conn=c)
        consolidate.consolidate_to_weekly(c, cfg={}, reference_date=ref)
    # Only the weekly summary's embedding remains; the two daily vecs were deleted.
    vec_count = c.execute("SELECT COUNT(*) FROM memory_vecs").fetchone()[0]
    assert vec_count == 1
