"""Attribution confidence — how sure the Familiar is about WHO a memory is
about, kept separate from `confidence` (whether it happened). A fuzzy-attribution
memory must be DOWNWEIGHTED in recall, never dropped: a solid fact whose target
is unresolved should sink below confident ones but stay retrievable for a later
sweep. Unset (old rows / omitted writes) must be treated as fully attributed.

embed_text is mocked so similarity is deterministic (no model needed).
"""

import sqlite3
import pytest
from unittest.mock import patch

from phylactery import memory
from phylactery.memory import _attribution_weight, _ATTRIBUTION_FLOOR


_VECS = {"Alice is a nurse": "[1, 0, 0, 0]", "nurse": "[1, 0, 0, 0]"}


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
            subjects_json TEXT, care_weight TEXT, category TEXT, content_tag TEXT,
            consent_pending INTEGER DEFAULT 0, confidence REAL DEFAULT 1.0,
            attribution_confidence REAL,
            source_json TEXT, created_at TEXT, updated_at TEXT,
            recall_count INTEGER DEFAULT 0, last_recalled_at TEXT
        )
    """)
    c.execute("CREATE VIRTUAL TABLE memory_vecs USING vec0(memory_id TEXT PRIMARY KEY, embedding float[4])")
    return c


# ── the pure ranking multiplier ──────────────────────────────────────

def test_attribution_weight_unset_is_full():
    # Old rows and writes that omit it are never retroactively downweighted.
    assert _attribution_weight(None) == 1.0
    assert _attribution_weight("not a number") == 1.0


def test_attribution_weight_clamps_and_floors():
    assert _attribution_weight(0.3) == 0.3
    assert _attribution_weight(1.5) == 1.0           # clamp high
    assert _attribution_weight(0.0) == _ATTRIBUTION_FLOOR   # never zero → never filtered out
    assert _attribution_weight(-2) == _ATTRIBUTION_FLOOR


# ── stored + surfaced through the real store ─────────────────────────

def test_create_persists_attribution_confidence():
    c = _conn()
    with patch("phylactery.embed.embed_text", _fake_embed):
        res = memory.create("Alice is a nurse", "significant", attribution_confidence=0.3, conn=c)
        stored = c.execute("SELECT attribution_confidence FROM memories WHERE id=?", (res["id"],)).fetchone()[0]
        assert stored == 0.3


def test_create_defaults_to_null_when_omitted():
    c = _conn()
    with patch("phylactery.embed.embed_text", _fake_embed):
        res = memory.create("Alice is a nurse", "significant", conn=c)
        stored = c.execute("SELECT attribution_confidence FROM memories WHERE id=?", (res["id"],)).fetchone()[0]
        assert stored is None


def test_search_downweights_fuzzy_attribution_but_never_drops_it():
    # Same content/vector, same freshness → attribution is the only differentiator.
    hi = _conn()
    with patch("phylactery.embed.embed_text", _fake_embed):
        memory.create("Alice is a nurse", "significant", conn=hi)   # unset → weight 1.0
        top_hi = memory.search("nurse", max_results=3, conn=hi)["results"][0]

    lo = _conn()
    with patch("phylactery.embed.embed_text", _fake_embed):
        memory.create("Alice is a nurse", "significant", attribution_confidence=0.3, conn=lo)
        res_lo = memory.search("nurse", max_results=3, conn=lo)
        top_lo = res_lo["results"][0]

    # Fuzzy attribution sinks the score...
    assert top_lo["score"] < top_hi["score"]
    # ...but the memory is STILL returned (downweight, never a cutoff)...
    assert len(res_lo["results"]) == 1
    # ...and it's flagged so the Familiar can see the attribution is soft.
    assert top_lo.get("attribution_confidence") == 0.3
    assert "attribution_confidence" not in top_hi   # confident one carries no flag
