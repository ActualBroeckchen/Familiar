"""Consolidation tier-guard hardening: key normalization, empty-stub handling,
and replace-not-append rollup writes.

Regressions from the 2026-08-14 store cleanup, all observed live:
- Migrated monthlies keyed 'YYYY-MM' and weeklies keyed 'YYYY-Wnn' were invisible
  to the once-only guards, so the backlog sweep re-rolled Feb–May 2026 into
  duplicate monthlies.
- A zero-length monthly stub (July 2026) marked its month as rolled forever —
  existence, not content, was the guard.
- A re-rolled period APPENDED its regenerated summary onto the existing row via
  memory_create's dedup-merge path, accreting ~24 near-identical generations into
  one 160 KB June 2026 monthly.

_call_llm and _llm_config are patched so no model / network is needed.
"""

import sqlite3
from datetime import date, timedelta
import pytest
from unittest.mock import patch

from phylactery import consolidate
from phylactery import memory


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


def _past_month_first(months_back: int = 2) -> date:
    first = date.today().replace(day=1)
    for _ in range(months_back):
        first = (first - timedelta(days=1)).replace(day=1)
    return first


def _insert_raw(c, mem_id, granularity, date_key, content):
    # Direct insert for rows that predate the ISO-key convention — memory.create
    # is not a path migrated rows took (mirrors the audit test's approach).
    c.execute(
        "INSERT INTO memories(id, kind, register, granularity, date_key, content, "
        "audience, source_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,'{}','t','t')",
        (mem_id, "narrative", "episodic", granularity, date_key, content, "ward-private"),
    )


_CFG = {"api_key": "k", "base_url": "u", "model": "m"}


# ── _normalized_date_key ─────────────────────────────────────────────────────

def test_normalized_date_key_shapes():
    n = consolidate._normalized_date_key
    assert n("2026-06-01") == "2026-06-01"
    assert n("2026-06-01_some-slug") == "2026-06-01"      # significant composite
    assert n("2026-02") == "2026-02-01"                    # migrated monthly
    assert n("2026-W23") == "2026-06-01"                   # migrated weekly → ISO Monday
    assert n("2025-W01") == "2024-12-30"                   # ISO week 1 can start in the prior year
    assert n("2026-W99") is None                           # no such ISO week
    assert n("short") is None
    assert n(None) is None


def test_guard_set_is_normalized_and_skips_empty_rows():
    c = _conn()
    _insert_raw(c, "m-mig", "monthly", "2026-02", "- migrated monthly summary")
    _insert_raw(c, "m-empty", "monthly", "2026-03-01", "   ")
    _insert_raw(c, "m-real", "monthly", "2026-04-01", "- real monthly summary")
    keys = consolidate._existing_date_keys(c, "monthly")
    assert "2026-02-01" in keys        # normalized form — visible to the guard
    assert "2026-03-01" not in keys    # empty stub does not mark a month as rolled
    assert "2026-04-01" in keys


# ── once-only guards vs migrated keys and empty stubs ───────────────────────

def test_migrated_yyyy_mm_monthly_blocks_reroll():
    c = _conn()
    m = _past_month_first(2)
    with patch("phylactery.embed.embed_text", _distinct_embedder()):
        memory.create("week one", "weekly", date_key=m.isoformat(), conn=c)
        memory.create("week two", "weekly", date_key=(m + timedelta(days=7)).isoformat(), conn=c)
    # The month is already rolled — but under the pre-normalization key format.
    _insert_raw(c, "m-mig", "monthly", m.strftime("%Y-%m"), "- migrated monthly summary")
    with patch("phylactery.consolidate._llm_config", lambda: _CFG):
        res = consolidate.run_consolidation(granularity="monthly", conn=c)
    assert res["ok"]
    assert res["results"]["monthly"]["periods"] == 0   # seen as already rolled


def test_empty_monthly_stub_is_rerolled_and_claimed():
    c = _conn()
    m = _past_month_first(2)
    with patch("phylactery.embed.embed_text", _distinct_embedder()):
        memory.create("week one", "weekly", date_key=m.isoformat(), conn=c)
        memory.create("week two", "weekly", date_key=(m + timedelta(days=7)).isoformat(), conn=c)
    _insert_raw(c, "m-stub", "monthly", f"{m.isoformat()}", "")
    with patch("phylactery.consolidate._call_llm", lambda cfg, p: "- fresh rollup"), \
         patch("phylactery.consolidate._llm_config", lambda: _CFG):
        res = consolidate.run_consolidation(granularity="monthly", conn=c)
    assert res["results"]["monthly"]["periods"] == 1
    rows = c.execute("SELECT content FROM memories WHERE granularity='monthly'").fetchall()
    assert len(rows) == 1                               # the stub was claimed, not joined
    assert rows[0]["content"].strip() == "- fresh rollup"


# ── replace-not-append on re-roll ────────────────────────────────────────────

def test_rerolled_monthly_replaces_instead_of_appending():
    c = _conn()
    m = _past_month_first(2)
    _insert_raw(c, "w-one", "weekly", m.isoformat(), "- week one")
    _insert_raw(c, "w-two", "weekly", (m + timedelta(days=7)).isoformat(), "- week two")
    _insert_raw(c, "m-old", "monthly", f"{m.isoformat()}", "- old generation of the summary")
    with patch("phylactery.consolidate._call_llm", lambda cfg, p: "- new generation"), \
         patch("phylactery.consolidate._llm_config", lambda: _CFG):
        res = consolidate.consolidate_to_monthly(c, _CFG, reference_date=m + timedelta(days=10))
    assert res["ok"], res
    rows = c.execute("SELECT content FROM memories WHERE granularity='monthly'").fetchall()
    assert len(rows) == 1
    assert rows[0]["content"] == "- new generation"    # replaced, not appended


def test_empty_llm_summary_is_refused_not_stored():
    c = _conn()
    m = _past_month_first(2)
    _insert_raw(c, "w-one", "weekly", m.isoformat(), "- week one")
    _insert_raw(c, "w-two", "weekly", (m + timedelta(days=7)).isoformat(), "- week two")
    with patch("phylactery.consolidate._call_llm", lambda cfg, p: "   "), \
         patch("phylactery.consolidate._llm_config", lambda: _CFG):
        res = consolidate.consolidate_to_monthly(c, _CFG, reference_date=m + timedelta(days=10))
    assert res["ok"] is False
    assert "empty summary" in res["error"]
    assert c.execute("SELECT COUNT(*) c FROM memories WHERE granularity='monthly'").fetchone()["c"] == 0
