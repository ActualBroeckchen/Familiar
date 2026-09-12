"""backfill_embeddings heals the migration gap: memories inserted without a
vector (as the entity-core migration does) get embedded so semantic dedup can
see them. embed_text is mocked for determinism."""
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
            consent_pending INTEGER DEFAULT 0, confidence REAL DEFAULT 1.0, attribution_confidence REAL,
            source_json TEXT, created_at TEXT, updated_at TEXT,
            recall_count INTEGER DEFAULT 0, last_recalled_at TEXT
        )
    """)
    c.execute("CREATE VIRTUAL TABLE memory_vecs USING vec0(memory_id TEXT PRIMARY KEY, embedding float[4])")
    return c


def _fake_embed(text):
    return "[0.1, 0.2, 0.3, 0.4]"


def _migrated(c, mid, content):
    # Mimics the migration: INSERT with NO embedding.
    c.execute("INSERT INTO memories(id,kind,granularity,content,audience,created_at,updated_at) "
              "VALUES(?,?,?,?,?,?,?)", (mid, "narrative", "daily", content, "ward-private", "t", "t"))


def test_backfill_embeds_the_gap_and_is_idempotent():
    c = _conn()
    _migrated(c, "m1", "My human loves jasmine tea")
    _migrated(c, "m2", "Chen is visiting Berlin")
    # An already-embedded row must be left alone.
    c.execute("INSERT INTO memories(id,kind,granularity,content,audience,created_at,updated_at) "
              "VALUES('m3','narrative','daily','has a cat','ward-private','t','t')")
    c.execute("INSERT INTO memory_vecs(memory_id, embedding) VALUES('m3','[0.9,0.9,0.9,0.9]')")
    c.commit()

    with patch("phylactery.embed.embed_text", _fake_embed):
        r = memory.backfill_embeddings(conn=c)
    assert r["ok"] and r["embedded"] == 2 and r["remaining"] == 0 and r["total_gap"] == 2
    # Both gap rows now have vectors; the pre-embedded one is untouched.
    assert c.execute("SELECT COUNT(*) AS c FROM memory_vecs").fetchone()["c"] == 3

    with patch("phylactery.embed.embed_text", _fake_embed):
        again = memory.backfill_embeddings(conn=c)
    assert again["embedded"] == 0 and again["total_gap"] == 0


def test_backfill_reports_when_embedder_unavailable():
    c = _conn()
    _migrated(c, "m1", "something")
    c.commit()
    def _boom(*a, **k):
        raise RuntimeError("fastembed unavailable")
    with patch("phylactery.embed.embed_text", _boom):
        r = memory.backfill_embeddings(conn=c)
    assert r["ok"] is False and r["embedded"] == 0 and r["remaining"] == 1
