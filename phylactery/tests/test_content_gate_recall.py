"""Content-gating Phase 4 — the recall-path pipeline test.

Memories tagged with different content_tags, recalled through the REAL store
(`mem.by_timerange` over an in-memory sqlite) with different room topic-grant
maps, asserting visible/invisible. This is the test a pure-function gate test
can't be: it exercises the actual SQL + post-filter assembly, the ward-private
floor, and the fail-closed defaults together.
"""

import sqlite3
import pytest

from phylactery import memory, content_gate


def _conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.execute("""
        CREATE TABLE memories(
            id TEXT PRIMARY KEY, kind TEXT, register TEXT, granularity TEXT,
            date_key TEXT, slug TEXT, content TEXT, audience TEXT,
            subjects_json TEXT, care_weight TEXT, category TEXT, content_tag TEXT,
            consent_pending INTEGER DEFAULT 0, confidence REAL DEFAULT 1.0, attribution_confidence REAL,
            source_json TEXT, created_at TEXT, updated_at TEXT
        )
    """)
    return c


def _add(c, mem_id, content_tag, audience="close-friends", date="2026-07-10"):
    c.execute(
        "INSERT INTO memories(id,kind,granularity,date_key,content,audience,content_tag,updated_at) "
        "VALUES(?,?,?,?,?,?,?,?)",
        (mem_id, "narrative", "daily", date, f"fact {mem_id}", audience, content_tag, date + "T00:00:00"),
    )


def _recall_ids(c, *, audiences, topic_grants):
    r = memory.by_timerange("2026-07-01", "2026-07-31", limit=50,
                            audiences=audiences, topic_grants=topic_grants, conn=c)
    return {m["id"] for m in r["results"]}


# ── The pure gate (mirror-of-JS) sanity ──────────────────────────────

def test_gate_untagged_defaults_to_general_sensitive():
    # An untagged memory needs an explicit general:sensitive grant.
    assert content_gate.memory_visible_to_grants(None, {"general": "open"}) is False
    assert content_gate.memory_visible_to_grants(None, {"general": "sensitive"}) is True


def test_gate_level_ordering():
    assert content_gate.memory_visible_to_grants("medical:open", {"medical": "open"}) is True
    assert content_gate.memory_visible_to_grants("medical:sensitive", {"medical": "open"}) is False
    assert content_gate.memory_visible_to_grants("medical:open", {"medical": "sensitive"}) is True
    assert content_gate.memory_visible_to_grants("medical:open", {}) is False  # absent topic → none


# ── The recall pipeline ──────────────────────────────────────────────

def test_recall_content_gate_visible_and_invisible():
    c = _conn()
    _add(c, "open-med",  "medical:open")
    _add(c, "sens-med",  "medical:sensitive")
    _add(c, "open-gen",  "general:open")
    _add(c, "sens-sex",  "sexuality:sensitive")
    c.commit()

    # A room granted medical:open + general:open (but nothing on sexuality).
    grants = {"general": "open", "medical": "open"}
    seen = _recall_ids(c, audiences=["close-friends"], topic_grants=grants)
    assert seen == {"open-med", "open-gen"}
    assert "sens-med" not in seen   # sensitive needs a sensitive grant
    assert "sens-sex" not in seen   # sexuality not granted at all


def test_recall_ward_sees_all_when_unscoped():
    c = _conn()
    _add(c, "sens-med", "medical:sensitive")
    _add(c, "sens-sex", "sexuality:sensitive")
    c.commit()
    # Ward turn: audiences=None (no floor) AND topic_grants=None (no content gate).
    seen = _recall_ids(c, audiences=None, topic_grants=None)
    assert seen == {"sens-med", "sens-sex"}


def test_recall_ward_private_floor_holds_regardless_of_tag():
    c = _conn()
    # A ward-private memory whose content_tag WOULD pass the topic gate.
    _add(c, "ward-note", "general:open", audience="ward-private")
    _add(c, "shared",    "general:open", audience="close-friends")
    c.commit()
    grants = {"general": "open"}
    # A villager room: audiences excludes 'ward-private' (the coarse floor), so
    # the ward-private row never surfaces even though its tag is granted.
    seen = _recall_ids(c, audiences=["close-friends"], topic_grants=grants)
    assert seen == {"shared"}
    assert "ward-note" not in seen


def test_recall_empty_topic_grants_surfaces_nothing():
    c = _conn()
    _add(c, "open-gen", "general:open")
    c.commit()
    # A stranger/misconfigured room: {} grants → nothing surfaces by content
    # (fail-closed), even for a general:open fact.
    seen = _recall_ids(c, audiences=["close-friends"], topic_grants={})
    assert seen == set()


def test_recall_untagged_memory_fails_closed_for_villager():
    c = _conn()
    _add(c, "untagged", None)
    c.commit()
    # Untagged → treated general:sensitive → a baseline general:open room can't see it.
    seen = _recall_ids(c, audiences=["close-friends"], topic_grants={"general": "open"})
    assert seen == set()
    # But the ward (unscoped) still sees it.
    assert _recall_ids(c, audiences=None, topic_grants=None) == {"untagged"}
