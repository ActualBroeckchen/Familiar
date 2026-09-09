"""Memory lifecycle — distill-only (temporal-bridges Piece 4).

Ward-signed invariant: the pass may ONLY ADD a distilled standing memory. It
never demotes, decays, or deletes an original — the original is left byte-for-
byte identical except a `distilled_at` breadcrumb (so it isn't re-judged).
Opt-in / default-OFF: a no-op unless PROTO_FAMILIAR_MEMORY_LIFECYCLE_ENABLED=1.
"""

import sqlite3
import json
from datetime import date
import pytest
from unittest.mock import patch

from phylactery import memory
from phylactery import consolidate


def _fake_embed(text):
    # Distinct per text so different strings don't read as near-duplicates
    # (a constant vector would make the dedup path treat everything as sim=1.0).
    h = abs(hash(text))
    return f"[{h % 7}, {(h // 7) % 7}, {(h // 49) % 7}, {(h // 343) % 7 + 1}]"


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
    c.execute("CREATE VIRTUAL TABLE memory_vecs USING vec0(memory_id float[4])" if False
              else "CREATE VIRTUAL TABLE memory_vecs USING vec0(memory_id TEXT PRIMARY KEY, embedding float[4])")
    return c


CFG = {"api_key": "x", "base_url": "x", "model": "x"}
REF = date(2026, 7, 1)  # cutoff = 2026-06-01; anything on/before is "aged"


def _seed_aged_fact(c, content, id_hint):
    with patch("phylactery.embed.embed_text", _fake_embed):
        r = memory.create(content, "daily", standalone=True, date_key="2026-05-01",
                          slug=f"fact-{id_hint}", conn=c)
    return r["id"]


def test_disabled_by_default_is_a_noop(monkeypatch):
    monkeypatch.delenv("PROTO_FAMILIAR_MEMORY_LIFECYCLE_ENABLED", raising=False)
    c = _conn()
    _seed_aged_fact(c, "Chen filed the form immediately", "a")
    out = consolidate.run_distillation(c, CFG, lambda cfg, p: "[]", REF)
    assert out["skipped"] is True
    assert out["reason"].startswith("disabled")


def test_hard_off_switch_overrides_enable(monkeypatch):
    monkeypatch.setenv("PROTO_FAMILIAR_MEMORY_LIFECYCLE_ENABLED", "1")
    monkeypatch.setenv("PROTO_FAMILIAR_MEMORY_LIFECYCLE_DISABLED", "1")
    c = _conn()
    _seed_aged_fact(c, "x", "a")
    out = consolidate.run_distillation(c, CFG, lambda cfg, p: "[]", REF)
    assert out.get("skipped") is True


def test_distills_a_pattern_without_touching_the_original(monkeypatch):
    monkeypatch.setenv("PROTO_FAMILIAR_MEMORY_LIFECYCLE_ENABLED", "1")
    monkeypatch.delenv("PROTO_FAMILIAR_MEMORY_LIFECYCLE_DISABLED", raising=False)
    c = _conn()
    src_id = _seed_aged_fact(c, "Chen did the dreaded paperwork right away and felt relief", "a")
    before = c.execute("SELECT content, granularity, register, date_key FROM memories WHERE id=?", (src_id,)).fetchone()

    def _llm(cfg, prompt):
        return json.dumps([{"index": 0, "pattern": "Doing dreaded tasks immediately works well for Chen."}])

    with patch("phylactery.embed.embed_text", _fake_embed):
        out = consolidate.run_distillation(c, CFG, _llm, REF)
    assert out["distilled"] == 1

    # The original is UNCHANGED except the distilled_at breadcrumb in source_json.
    after = c.execute("SELECT content, granularity, register, date_key FROM memories WHERE id=?", (src_id,)).fetchone()
    assert after["content"] == before["content"]
    assert after["granularity"] == before["granularity"]
    assert after["register"] == before["register"]
    assert after["date_key"] == before["date_key"]
    sj = json.loads(c.execute("SELECT source_json FROM memories WHERE id=?", (src_id,)).fetchone()["source_json"])
    assert sj["distilled_at"]

    # A NEW standing (ward-register) memory was added, linked back.
    new_rows = c.execute("SELECT content, register, source_json FROM memories WHERE register='ward'").fetchall()
    assert len(new_rows) == 1
    assert "immediately" in new_rows[0]["content"].lower()
    new_sj = json.loads(new_rows[0]["source_json"])
    assert new_sj["via"] == "distillation"
    assert new_sj["distilled_from"] == src_id


def test_never_deletes_or_demotes_when_no_pattern(monkeypatch):
    monkeypatch.setenv("PROTO_FAMILIAR_MEMORY_LIFECYCLE_ENABLED", "1")
    monkeypatch.delenv("PROTO_FAMILIAR_MEMORY_LIFECYCLE_DISABLED", raising=False)
    c = _conn()
    src_id = _seed_aged_fact(c, "Appointment at noon on July 2", "a")
    with patch("phylactery.embed.embed_text", _fake_embed):
        out = consolidate.run_distillation(c, CFG, lambda cfg, p: "[]", REF)
    assert out["distilled"] == 0
    # Original still present, unchanged, no ward-register memory created.
    assert c.execute("SELECT COUNT(*) FROM memories WHERE id=?", (src_id,)).fetchone()[0] == 1
    assert c.execute("SELECT COUNT(*) FROM memories WHERE register='ward'").fetchone()[0] == 0


def test_does_not_redistill_an_already_stamped_fact(monkeypatch):
    monkeypatch.setenv("PROTO_FAMILIAR_MEMORY_LIFECYCLE_ENABLED", "1")
    monkeypatch.delenv("PROTO_FAMILIAR_MEMORY_LIFECYCLE_DISABLED", raising=False)
    c = _conn()
    src_id = _seed_aged_fact(c, "Chen pattern fact", "a")
    # Stamp it as already distilled.
    c.execute("UPDATE memories SET source_json=? WHERE id=?",
              (json.dumps({"via": "memorization", "distilled_at": "2026-06-15T00:00:00Z"}), src_id))
    c.commit()
    out = consolidate.run_distillation(c, CFG, lambda cfg, p: json.dumps([{"index": 0, "pattern": "x"}]), REF)
    assert out.get("skipped") is True and out["reason"].startswith("no aged")


def test_recent_facts_are_not_considered(monkeypatch):
    monkeypatch.setenv("PROTO_FAMILIAR_MEMORY_LIFECYCLE_ENABLED", "1")
    monkeypatch.delenv("PROTO_FAMILIAR_MEMORY_LIFECYCLE_DISABLED", raising=False)
    c = _conn()
    with patch("phylactery.embed.embed_text", _fake_embed):
        memory.create("Recent fact", "daily", standalone=True, date_key="2026-06-30", slug="fact-recent", conn=c)
    out = consolidate.run_distillation(c, CFG, lambda cfg, p: json.dumps([{"index": 0, "pattern": "x"}]), REF)
    assert out.get("skipped") is True  # 2026-06-30 is after the 2026-06-01 cutoff
