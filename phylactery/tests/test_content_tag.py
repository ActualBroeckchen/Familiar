"""Content-gating Phase 3: a per-memory content_tag ("topic:level"), derived
from the content category when the extractor didn't supply one, and backfilled
onto pre-tag rows. Mirrors content-tags.js categoryToTag."""

import sqlite3
import pytest
from unittest.mock import patch

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
            source_json TEXT, created_at TEXT, updated_at TEXT
        )
    """)
    c.execute("CREATE VIRTUAL TABLE memory_vecs USING vec0(memory_id TEXT PRIMARY KEY, embedding float[4])")
    return c


def test_category_to_tag_mapping():
    assert memory.category_to_tag("basics") == "general:open"
    assert memory.category_to_tag("health_info") == "medical:sensitive"
    assert memory.category_to_tag("emotional_content") == "mental-health:sensitive"
    assert memory.category_to_tag("relationships") == "relationships:open"
    assert memory.category_to_tag("whereabouts") == "location:open"
    assert memory.category_to_tag(None) == "general:open"
    assert memory.category_to_tag("nonsense") == "general:open"


def _tag_of(c, mem_id):
    return c.execute("SELECT content_tag FROM memories WHERE id=?", (mem_id,)).fetchone()["content_tag"]


def test_create_derives_tag_from_category_when_none_given():
    c = _conn()
    with patch("phylactery.embed.embed_text", lambda t: "[0,0,0,1]"):
        r = memory.create("felt anxious about the appt", "daily", standalone=True,
                          category="health_info", conn=c)
    assert _tag_of(c, r["id"]) == "medical:sensitive"


def test_create_honours_an_explicit_tag_over_the_category():
    c = _conn()
    with patch("phylactery.embed.embed_text", lambda t: "[0,0,0,1]"):
        r = memory.create("came out to me", "daily", standalone=True,
                          category="basics", content_tag="sexuality:sensitive", conn=c)
    assert _tag_of(c, r["id"]) == "sexuality:sensitive"


def test_backfill_tags_null_rows_from_category_and_is_idempotent():
    c = _conn()
    # Two pre-tag rows (content_tag NULL) with different categories.
    c.execute("INSERT INTO memories(id,kind,category,content_tag,created_at,updated_at) "
              "VALUES('m1','narrative','health_info',NULL,'t','t')")
    c.execute("INSERT INTO memories(id,kind,category,content_tag,created_at,updated_at) "
              "VALUES('m2','narrative','basics','','t','t')")
    # An already-tagged row must not be touched.
    c.execute("INSERT INTO memories(id,kind,category,content_tag,created_at,updated_at) "
              "VALUES('m3','narrative','basics','sexuality:sensitive','t','t')")
    c.commit()

    r = memory.backfill_content_tags(c)
    assert r == {"ok": True, "tagged": 2, "remaining": 0}
    assert _tag_of(c, "m1") == "medical:sensitive"
    assert _tag_of(c, "m2") == "general:open"
    assert _tag_of(c, "m3") == "sexuality:sensitive"  # untouched

    r2 = memory.backfill_content_tags(c)
    assert r2 == {"ok": True, "tagged": 0, "remaining": 0}


def test_update_by_id_sets_and_clears_content_tag():
    c = _conn()
    c.execute("INSERT INTO memories(id,kind,category,content_tag,content,created_at,updated_at) "
              "VALUES('m1','narrative','basics','general:open','x','t','t')")
    c.commit()
    # Re-tag (the ward's edit through the manager UI).
    memory.update_memory_by_id("m1", content_tag="sexuality:sensitive", conn=c)
    assert _tag_of(c, "m1") == "sexuality:sensitive"
    # Clearing (empty string) → NULL → fails closed to general:sensitive at recall.
    memory.update_memory_by_id("m1", content_tag="", conn=c)
    assert _tag_of(c, "m1") is None
    # Omitting content_tag leaves whatever is there untouched.
    memory.update_memory_by_id("m1", content_tag="medical:open", conn=c)
    memory.update_memory_by_id("m1", new_content="y", conn=c)
    assert _tag_of(c, "m1") == "medical:open"


def test_category_to_tag_views_mirrors_node():
    """`views` (an opinion or a taste) → general:open, same as content-tags.js."""
    assert memory.category_to_tag("views") == "general:open"
