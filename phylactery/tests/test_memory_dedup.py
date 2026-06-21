"""Semantic dedup-merge at memory write time.

The "82 queued, only 5 new" bug: significant / consent-pending memories were
inserted with no similarity check, so paraphrase duplicates piled up. create()
now folds a near-duplicate into the existing entry instead. These pin that:
near-identical → confirm (no new row, no append); additive near-dup → merge
(append the new detail); distinct → a normal new row.

embed_text is mocked so similarity is deterministic (no model needed).
"""

import sqlite3
import pytest
from unittest.mock import patch

from phylactery import memory


# Fixed 4-dim vectors per content, chosen so L2 distance lands in known bands
# (similarity = 1 - distance/2, the scale create() dedups on):
#   A vs A        : dist 0      → sim 1.00  (identical → confirm)
#   A vs C        : dist ~0.345 → sim ~0.83 (merge band [0.78, 0.85))
#   A vs B        : dist ~1.414 → sim ~0.29 (distinct)
_VECS = {
    "Alice is stressed about work":        "[1, 0, 0, 0]",
    "Alice has been stressed by her job":  "[0.94, 0.34, 0, 0]",
    "Bob baked a chocolate cake":          "[0, 1, 0, 0]",
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


def _count(c):
    return c.execute("SELECT COUNT(*) FROM memories").fetchone()[0]


def test_near_identical_confirms_without_a_new_row():
    c = _conn()
    with patch("phylactery.embed.embed_text", _fake_embed):
        a = memory.create("Alice is stressed about work", "significant", consent_pending=True, conn=c)
        assert _count(c) == 1
        # Same fact again → folds into the existing entry, no second row.
        b = memory.create("Alice is stressed about work", "significant", consent_pending=True, conn=c)
        assert b["merged"] is True and b.get("identical") is True
        assert b["id"] == a["id"]
        assert _count(c) == 1


def test_additive_near_duplicate_merges_the_new_detail():
    c = _conn()
    with patch("phylactery.embed.embed_text", _fake_embed):
        a = memory.create("Alice is stressed about work", "significant", consent_pending=True, conn=c)
        b = memory.create("Alice has been stressed by her job", "significant", consent_pending=True, conn=c)
        assert b["merged"] is True and b["id"] == a["id"]
        assert _count(c) == 1  # no new row
        content = c.execute("SELECT content FROM memories WHERE id=?", (a["id"],)).fetchone()[0]
        assert "stressed about work" in content and "stressed by her job" in content  # both folded in


def test_distinct_fact_inserts_a_new_row():
    c = _conn()
    with patch("phylactery.embed.embed_text", _fake_embed):
        memory.create("Alice is stressed about work", "significant", consent_pending=True, conn=c)
        b = memory.create("Bob baked a chocolate cake", "significant", consent_pending=True, conn=c)
        assert not b.get("merged")
        assert _count(c) == 2


def test_additive_dup_at_different_consent_level_inserts_new():
    """New unconsented detail must NOT be folded into an already-consented
    memory (that would slip it past consent) — it gets its own row."""
    c = _conn()
    with patch("phylactery.embed.embed_text", _fake_embed):
        memory.create("Alice is stressed about work", "significant", consent_pending=False, conn=c)  # confirmed
        b = memory.create("Alice has been stressed by her job", "significant", consent_pending=True, conn=c)  # pending, additive
        assert not b.get("merged")
        assert _count(c) == 2
