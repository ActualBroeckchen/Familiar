"""ids_to_slugs: re-key legacy hex memory ids to readable slugs, following every
reference (embeddings + graduation_log), idempotently. Mirrors the graph re-key."""
import sqlite3
import re
import pytest

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
    c.execute("CREATE TABLE graduation_log(id TEXT PRIMARY KEY, memory_id TEXT, register TEXT)")
    return c


_HEX = "0123456789abcdef0123456789abcdef"
_HEX2 = "fedcba9876543210fedcba9876543210"


def _seed_legacy(c, mid, content):
    c.execute("INSERT INTO memories(id,kind,granularity,content,audience,slug,created_at,updated_at) "
              "VALUES(?,?,?,?,?,?,?,?)", (mid, "narrative", "daily", content, "ward-private", "s", "t", "t"))
    c.execute("INSERT INTO memory_vecs(memory_id, embedding) VALUES(?, ?)", (mid, "[0.1, 0.2, 0.3, 0.4]"))


def test_rekeys_legacy_ids_and_follows_references():
    c = _conn()
    _seed_legacy(c, _HEX, "My human loves jasmine tea")
    c.execute("INSERT INTO graduation_log(id, memory_id, register) VALUES('g1', ?, 'ward')", (_HEX,))
    # A row that already has a slug id must be left alone.
    c.execute("INSERT INTO memories(id,kind,granularity,content,audience,created_at,updated_at) "
              "VALUES('already-slug-k3','narrative','daily','x','ward-private','t','t')")
    c.commit()

    r = memory.ids_to_slugs(conn=c)
    assert r["ok"] and r["remapped"] == 1
    new = r["mapping"][_HEX]
    assert new.startswith("my-human-loves") and re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", new)

    # memories row re-keyed; slug row untouched.
    assert c.execute("SELECT 1 FROM memories WHERE id=?", (new,)).fetchone()
    assert not c.execute("SELECT 1 FROM memories WHERE id=?", (_HEX,)).fetchone()
    assert c.execute("SELECT 1 FROM memories WHERE id='already-slug-k3'").fetchone()
    # embedding followed (bytes preserved, no re-embed needed).
    assert c.execute("SELECT 1 FROM memory_vecs WHERE memory_id=?", (new,)).fetchone()
    assert not c.execute("SELECT 1 FROM memory_vecs WHERE memory_id=?", (_HEX,)).fetchone()
    # graduation reference followed.
    assert c.execute("SELECT memory_id FROM graduation_log WHERE id='g1'").fetchone()["memory_id"] == new


def test_idempotent():
    c = _conn()
    _seed_legacy(c, _HEX2, "Chen is visiting Berlin")
    c.commit()
    first = memory.ids_to_slugs(conn=c)
    assert first["remapped"] == 1
    second = memory.ids_to_slugs(conn=c)
    assert second["remapped"] == 0 and second["mapping"] == {}
