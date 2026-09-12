"""Recall-side audience gate (Pillar E).

audience_in_sql turns the room's allowed audience-tag SET (computed JS-side by
visibleAudiences) into a WHERE fragment, and memory.search routes recall through
it. The leak being closed: a non-ward room must NOT see ward-private records.
embed_text is mocked so search is deterministic.
"""

import sqlite3
import pytest
from unittest.mock import patch

from phylactery import memory
from phylactery.audience import audience_in_sql


def test_audience_in_sql_none_empty_list():
    assert audience_in_sql(None) == ("1=1", [])          # ward sees all
    assert audience_in_sql([]) == ("0=1", [])            # cleared for nothing
    clause, params = audience_in_sql(["friends", "strangers"])
    assert clause == "audience IN (?,?)" and params == ["friends", "strangers"]
    # custom column (graph)
    assert audience_in_sql(["x"], col="n.audience")[0] == "n.audience IN (?)"


_VECS = {
    # Distinct enough not to dedup-merge (sim well below the 0.78 threshold), but
    # with only two rows the KNN returns both regardless of distance.
    "secret": "[1, 0, 0, 0]",
    "shared thing": "[0, 1, 0, 0]",
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
            subjects_json TEXT, care_weight TEXT, category TEXT, content_tag TEXT,
            consent_pending INTEGER DEFAULT 0, confidence REAL DEFAULT 1.0, attribution_confidence REAL,
            source_json TEXT, created_at TEXT, updated_at TEXT,
            recall_count INTEGER DEFAULT 0, last_recalled_at TEXT
        )
    """)
    c.execute("CREATE VIRTUAL TABLE memory_vecs USING vec0(memory_id TEXT PRIMARY KEY, embedding float[4])")
    return c


def test_ward_private_never_surfaces_in_a_shared_room():
    c = _conn()
    with patch("phylactery.embed.embed_text", _fake_embed):
        memory.create("secret", "daily", standalone=True, audience="ward-private", conn=c)
        memory.create("shared thing", "daily", standalone=True, audience="friends", conn=c)

        # Ward (audiences=None) sees both.
        ward = memory.search("secret", audiences=None, conn=c)
        assert {r["excerpt"] for r in ward["results"]} == {"secret", "shared thing"}

        # A friends room sees only the friends record — ward-private is gone.
        room = memory.search("secret", audiences=["friends"], conn=c)
        got = {r["excerpt"] for r in room["results"]}
        assert got == {"shared thing"}
        assert "secret" not in got  # the leak that's being closed

        # A room cleared for nothing sees nothing.
        none = memory.search("secret", audiences=[], conn=c)
        assert none["results"] == []
