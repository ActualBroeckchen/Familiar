"""Provenance tracking for villager-contributed memories (Pass 2).

When a villager acts through the Familiar on Discord to write a memory,
the write records WHO caused it (via `source_meta`). This lets the Familiar
weigh the source later (trust a known friend vs. a stranger).

These tests pin _source_label (the compact display of a memory's source) and
the `source_meta` parameter to create() that makes audit trails real.
"""

import sqlite3
import pytest
from unittest.mock import patch
import json

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
            consent_pending INTEGER DEFAULT 0, confidence REAL DEFAULT 1.0, attribution_confidence REAL,
            source_json TEXT, created_at TEXT, updated_at TEXT,
            recall_count INTEGER DEFAULT 0, last_recalled_at TEXT
        )
    """)
    c.execute("CREATE VIRTUAL TABLE memory_vecs USING vec0(memory_id TEXT PRIMARY KEY, embedding float[4])")
    return c


# ── _source_label: compact display of a memory's source ────────────────────

def test_source_label_none_json():
    """None source_json → None (my own writes, no source display)."""
    result = memory._source_label(None)
    assert result is None


def test_source_label_invalid_json():
    """Malformed JSON → None (degrade gracefully)."""
    result = memory._source_label('not json at all')
    assert result is None


def test_source_label_memorization_write():
    """A memory I wrote myself (via='memorization') → None (don't clutter results)."""
    source_json = json.dumps({
        "author": "proto-familiar",
        "via": "memorization",
        "at": "2026-07-06T14:30:00Z"
    })
    result = memory._source_label(source_json)
    assert result is None, "my own writes should not surface a source"


def test_source_label_discord_villager_with_id():
    """A villager-contributed memory displays the source."""
    source_json = json.dumps({
        "via": "discord-villager",
        "villager": "Schmidt",
        "villagerId": "v9"
    })
    result = memory._source_label(source_json)
    assert result == "Schmidt (via discord-villager)"


def test_source_label_discord_villager_no_id():
    """A villager with no id still displays the name."""
    source_json = json.dumps({
        "via": "discord-villager",
        "villager": "Alice"
    })
    result = memory._source_label(source_json)
    assert result == "Alice (via discord-villager)"


def test_source_label_fallback_to_author_field():
    """Fallback: if no 'villager' key, use 'author' field."""
    source_json = json.dumps({
        "via": "discord-villager",
        "author": "Bob"
    })
    result = memory._source_label(source_json)
    assert result == "Bob (via discord-villager)"


def test_source_label_via_only():
    """If neither villager nor author is present, just return the via string."""
    source_json = json.dumps({
        "via": "telegram-relay"
    })
    result = memory._source_label(source_json)
    assert result == "telegram-relay"


def test_source_label_empty_villager_field():
    """Empty string for villager → return the via string only."""
    source_json = json.dumps({
        "via": "discord-villager",
        "villager": ""
    })
    result = memory._source_label(source_json)
    assert result == "discord-villager", "empty villager falls back to via"


# ── create() with source_meta: audit trail for villager writes ──────────────

def test_create_with_source_meta_discord_villager():
    """create() with source_meta stores the villager provenance in source_json."""
    c = _conn()
    result = memory.create(
        "I learned Alice is stressing about work",
        granularity="significant",
        source_meta={"via": "discord-villager", "villager": "Schmidt", "villagerId": "v9"},
        conn=c
    )
    assert result.get("ok") is not False, "create should succeed"

    # Fetch the row and check source_json
    rec_id = result["id"]
    row = c.execute("SELECT source_json FROM memories WHERE id=?", (rec_id,)).fetchone()
    assert row is not None
    source = json.loads(row["source_json"])

    # The source should have both the original metadata AND the provided source_meta
    assert source["via"] == "discord-villager", "via should be overridden by source_meta"
    assert source["villager"] == "Schmidt"
    assert source["villagerId"] == "v9"


def test_create_with_source_meta_merges_with_defaults():
    """source_meta merges into the default source dict (author, at remain)."""
    c = _conn()
    result = memory.create(
        "A new fact",
        granularity="daily",
        source_meta={"via": "discord-villager", "villager": "Alice"},
        conn=c
    )

    rec_id = result["id"]
    row = c.execute("SELECT source_json FROM memories WHERE id=?", (rec_id,)).fetchone()
    source = json.loads(row["source_json"])

    # Original fields should still be there
    assert "author" in source, "should still have author field"
    assert "at" in source, "should still have at timestamp"
    # Provided source_meta should override via
    assert source["via"] == "discord-villager"
    assert source["villager"] == "Alice"


def test_create_without_source_meta_uses_defaults():
    """Without source_meta, the source is my own (author + memorization)."""
    c = _conn()
    result = memory.create(
        "My journal entry",
        granularity="daily",
        conn=c
    )

    rec_id = result["id"]
    row = c.execute("SELECT source_json FROM memories WHERE id=?", (rec_id,)).fetchone()
    source = json.loads(row["source_json"])

    # Default provenance (my own)
    assert source["via"] == "memorization"
    assert "author" in source
    assert "at" in source


def test_create_source_meta_partial_override():
    """source_meta can add keys without overriding everything."""
    c = _conn()
    result = memory.create(
        "A fact",
        granularity="significant",
        source_meta={"villager": "Charlie"},  # Only set villager
        conn=c
    )

    rec_id = result["id"]
    row = c.execute("SELECT source_json FROM memories WHERE id=?", (rec_id,)).fetchone()
    source = json.loads(row["source_json"])

    # source_meta.villager should be set
    assert source["villager"] == "Charlie"
    # But the default author/at should remain (now overridden by source_meta if it sets via)
    assert "author" in source or "via" in source


def test_create_with_source_meta_standalone_fact():
    """source_meta works with standalone=True facts."""
    c = _conn()
    result = memory.create(
        "Important standing memory",
        granularity="daily",
        standalone=True,
        source_meta={"via": "discord-villager", "villager": "Dave", "villagerId": "v5"},
        conn=c
    )

    assert result.get("ok") is not False
    rec_id = result["id"]
    row = c.execute("SELECT source_json FROM memories WHERE id=?", (rec_id,)).fetchone()
    source = json.loads(row["source_json"])

    assert source["via"] == "discord-villager"
    assert source["villager"] == "Dave"
    assert source["villagerId"] == "v5"
