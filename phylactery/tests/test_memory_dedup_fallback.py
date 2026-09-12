"""Dedup must survive a dead vector stack (fastembed model missing, or sqlite-vec
unloadable) via the lexical fallback — otherwise the consent queue floods with the
same facts every session (the reported pile-up). embed_text is patched to RAISE,
simulating the degraded install; a plain in-memory sqlite (no vec0) stands in for
a store where memory_vecs is unusable."""
import sqlite3
import pytest
from unittest.mock import patch

from phylactery import memory


def _plain_conn():
    """A memories table with NO vec table — the 'sqlite-vec unavailable' case."""
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
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
    return c


def _boom(*a, **k):
    raise RuntimeError("fastembed model unavailable")


def test_lexical_fallback_folds_pending_restatement_when_vectors_dead():
    c = _plain_conn()
    with patch("phylactery.embed.embed_text", _boom):
        r1 = memory.create("My human is anxious about work deadlines", "daily",
                           standalone=True, consent_pending=True, category="emotional_content", conn=c)
        # Verbatim restatement — lexical containment must catch it despite no vectors.
        r2 = memory.create("My human is anxious about work deadlines", "daily",
                           standalone=True, consent_pending=True, category="emotional_content", conn=c)
    assert r2.get("merged") is True
    assert r2["id"] == r1["id"]
    n = c.execute("SELECT COUNT(*) AS c FROM memories WHERE consent_pending=1").fetchone()["c"]
    assert n == 1, f"expected 1 pending row after fold, got {n}"


def test_lexical_fallback_drops_pending_dup_of_confirmed_when_vectors_dead():
    c = _plain_conn()
    with patch("phylactery.embed.embed_text", _boom):
        memory.create("My human has a cat named Biscuit", "daily",
                      standalone=True, consent_pending=False, category="basics", conn=c)
        rp = memory.create("My human has a cat named Biscuit", "daily",
                           standalone=True, consent_pending=True, category="basics", conn=c)
    assert rp.get("already_known") is True
    n = c.execute("SELECT COUNT(*) AS c FROM memories WHERE consent_pending=1").fetchone()["c"]
    assert n == 0, "a pending restatement of a confirmed memory must not be queued"


def test_lexical_fallback_keeps_distinct_facts_separate():
    c = _plain_conn()
    with patch("phylactery.embed.embed_text", _boom):
        a = memory.create("My human has a dentist appointment Tuesday", "daily",
                          standalone=True, consent_pending=True, category="basics", conn=c)
        b = memory.create("My human's car is due for an oil change", "daily",
                          standalone=True, consent_pending=True, category="basics", conn=c)
    assert a["id"] != b["id"]
    n = c.execute("SELECT COUNT(*) AS c FROM memories").fetchone()["c"]
    assert n == 2


def test_vector_health_reports_unhealthy_when_embedder_down():
    c = _plain_conn()
    with patch("phylactery.embed.embed_text", _boom):
        h = memory.vector_health(conn=c)
    assert h["ok"] is True
    assert h["healthy"] is False
    assert h["dedup_mode"] == "lexical-fallback"
    assert h["embed_ok"] is False
