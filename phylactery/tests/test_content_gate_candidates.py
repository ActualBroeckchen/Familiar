"""list_content_gate_candidates(conn=...) is the input to the Familiar-curated
content-gating re-tag pass (ward-disclosure build spec, Phase B). It must select
ONLY ward-about-self facts still tagged coarse 'ward-private' — never a
third-party fact (subjects_json non-empty), never a fact already re-tagged onto
another audience (family, ward-content-gated, ...).

embed_text is mocked so create()'s embedding is deterministic (no model needed),
matching the pattern in test_memory_by_id.py.
"""

import sqlite3
import pytest
from unittest.mock import patch

from phylactery import memory


_VECS = {
    "My human mentioned feeling anxious at work.":  "[1, 0, 0, 0]",
    "Chen is doing well at their new job.":          "[0, 1, 0, 0]",
    "My human's sister called about the holidays.":  "[0, 0, 1, 0]",
    "My human already opened up this fact once.":    "[0, 0, 0, 1]",
}


def _fake_embed(text):
    return _VECS.get(text, "[1, 1, 1, 1]")


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


def test_only_the_ward_self_ward_private_fact_with_no_subjects_is_returned():
    c = _conn()
    with patch("phylactery.embed.embed_text", _fake_embed):
        # (a) ward-self, ward-private, no subjects — MUST be returned.
        ward_self = memory.create(
            "My human mentioned feeling anxious at work.", "daily",
            date_key="2026-07-01", standalone=True, audience="ward-private",
            subjects=[], conn=c,
        )
        # (b) ward-private but about a third party (subjects_json non-empty) — must NOT.
        third_party = memory.create(
            "Chen is doing well at their new job.", "daily",
            date_key="2026-07-02", standalone=True, audience="ward-private",
            subjects=["v-chen"], conn=c,
        )
        # (c) already on a non-ward-private coarse audience — must NOT.
        other_audience = memory.create(
            "My human's sister called about the holidays.", "daily",
            date_key="2026-07-03", standalone=True, audience="family",
            subjects=[], conn=c,
        )
        # (d) already re-tagged onto the content-gated open audience — must NOT.
        already_opened = memory.create(
            "My human already opened up this fact once.", "daily",
            date_key="2026-07-04", standalone=True, audience="ward-content-gated",
            subjects=[], conn=c,
        )

    candidates = memory.list_content_gate_candidates(conn=c)
    ids = {row["id"] for row in candidates}

    assert ward_self["id"] in ids
    assert third_party["id"] not in ids
    assert other_audience["id"] not in ids
    assert already_opened["id"] not in ids
    assert len(candidates) == 1

    row = candidates[0]
    assert row["id"] == ward_self["id"]
    assert row["content"] == "My human mentioned feeling anxious at work."
    assert "content_tag" in row
    assert "category" in row
