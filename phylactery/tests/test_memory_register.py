"""The `register` axis (episodic | me | ward) is separate from granularity.

me/ward are the graduation destination AND can now be written deliberately by
the Familiar (save_memory's register choice). These pin that create() stores the
register, validates it, and that search surfaces it back so the Familiar can tell
a standing identity-grade fact from a passing episodic moment at recall time.

embed_text is mocked so similarity is deterministic (no model needed).
"""

import sqlite3
import pytest
from unittest.mock import patch

from phylactery import memory


_VECS = {
    "Alice is a nurse":   "[1, 0, 0, 0]",
    "nurse":              "[1, 0, 0, 0]",
    "we watched a film":  "[0, 1, 0, 0]",
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


def test_register_defaults_to_episodic():
    c = _conn()
    with patch("phylactery.embed.embed_text", _fake_embed):
        res = memory.create("we watched a film", "daily", conn=c)
        reg = c.execute("SELECT register FROM memories WHERE id=?", (res["id"],)).fetchone()[0]
        assert reg == "episodic"


def test_ward_register_is_stored():
    c = _conn()
    with patch("phylactery.embed.embed_text", _fake_embed):
        res = memory.create("Alice is a nurse", "significant", register="ward", conn=c)
        reg = c.execute("SELECT register FROM memories WHERE id=?", (res["id"],)).fetchone()[0]
        assert reg == "ward"


def test_invalid_register_is_rejected():
    c = _conn()
    with patch("phylactery.embed.embed_text", _fake_embed):
        res = memory.create("x", "daily", register="bogus", conn=c)
        assert res["ok"] is False and "register" in res["error"]
        assert c.execute("SELECT COUNT(*) FROM memories").fetchone()[0] == 0


def test_search_surfaces_the_register():
    c = _conn()
    with patch("phylactery.embed.embed_text", _fake_embed):
        memory.create("Alice is a nurse", "significant", register="ward", conn=c)
        out = memory.search("nurse", max_results=3, conn=c)
        top = out["results"][0]
        assert top["register"] == "ward"  # the Familiar can read which register it came from


def test_list_memories_carries_register():
    """The Knowledge-editor browse list reads register off each item to badge
    me/ward standing truths."""
    c = _conn()
    with patch("phylactery.embed.embed_text", _fake_embed):
        memory.create("Alice is a nurse", "significant", register="ward", conn=c)
        items = memory.list_memories(conn=c)
        assert items and all("register" in it for it in items)
        assert items[0]["register"] == "ward"


def test_read_memory_carries_register():
    """The Knowledge-editor detail view reads register to label the entry."""
    c = _conn()
    with patch("phylactery.embed.embed_text", _fake_embed):
        res = memory.create("Alice is a nurse", "significant", register="ward", conn=c)
        out = memory.read_memory("significant", res["dateKey"], conn=c)
        assert out["ok"] and out["register"] == "ward"



def test_list_memories_register_filter():
    """`register='me'` returns only my own standing views — the read-back the
    chat turn relies on."""
    c = _conn()
    with patch("phylactery.embed.embed_text", _fake_embed):
        memory.create("I think cricket is dull", "significant", register="me", conn=c)
        memory.create("Alice is a nurse", "significant", register="ward", conn=c)
        memory.create("a plain day", "daily", conn=c)
        me = memory.list_memories(conn=c, register="me")
        assert [m["content"] for m in me] == ["I think cricket is dull"]
        assert len(memory.list_memories(conn=c)) == 3
