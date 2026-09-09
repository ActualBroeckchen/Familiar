"""Temporal recall — memory.by_timerange (temporal-bridges Piece 3) and the
_schedule_refs cross-store surfacer (Piece 2).

by_timerange answers "what was happening around these days" by the calendar-date
prefix of date_key (so YYYY-MM-DD_slug rows fall in range by their day), is
audience-gated exactly like search, and returns newest day first.
"""

import sqlite3
import json
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
    return c


def _mk(c, id, date_key, content, audience="ward-private", source_json=None):
    c.execute(
        "INSERT INTO memories(id,kind,register,granularity,date_key,content,audience,source_json,created_at,updated_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?)",
        (id, "narrative", "episodic", "daily", date_key, content, audience, source_json,
         "2026-07-01T00:00:00", "2026-07-01T00:00:00"),
    )
    c.commit()


# ── _schedule_refs (Piece 2) ────────────────────────────────────────

def test_schedule_refs_absent():
    assert memory._schedule_refs(None) is None
    assert memory._schedule_refs('{"via":"memorization"}') is None
    assert memory._schedule_refs("not json") is None


def test_schedule_refs_present():
    sj = json.dumps({"via": "memorization", "schedule_refs": ["dinner-x7", "schmidt-kh"]})
    assert memory._schedule_refs(sj) == ["dinner-x7", "schmidt-kh"]


def test_schedule_refs_filters_empties():
    sj = json.dumps({"schedule_refs": ["a", "", None, "b"]})
    assert memory._schedule_refs(sj) == ["a", "b"]


# ── by_timerange ────────────────────────────────────────────────────

def test_returns_memories_in_the_day_span():
    c = _conn()
    _mk(c, "m1", "2026-07-01", "before the span")
    _mk(c, "m2", "2026-07-02", "inside the span A")
    _mk(c, "m3", "2026-07-03", "inside the span B")
    _mk(c, "m4", "2026-07-05", "after the span")
    out = memory.by_timerange("2026-07-02", "2026-07-03", conn=c)
    ids = {r["id"] for r in out["results"]}
    assert ids == {"m2", "m3"}


def test_date_slug_keys_fall_in_range_by_their_day():
    c = _conn()
    _mk(c, "sig", "2026-07-02_therapy-session", "a significant, slugged memory")
    out = memory.by_timerange("2026-07-02", "2026-07-02", conn=c)
    assert [r["id"] for r in out["results"]] == ["sig"]


def test_newest_day_first():
    c = _conn()
    _mk(c, "old", "2026-07-02", "older")
    _mk(c, "new", "2026-07-04", "newer")
    out = memory.by_timerange("2026-07-01", "2026-07-10", conn=c)
    assert [r["id"] for r in out["results"]] == ["new", "old"]


def test_swapped_bounds_are_normalised():
    c = _conn()
    _mk(c, "m", "2026-07-03", "x")
    out = memory.by_timerange("2026-07-05", "2026-07-01", conn=c)  # from > to
    assert [r["id"] for r in out["results"]] == ["m"]
    assert out["from"] == "2026-07-01" and out["to"] == "2026-07-05"


def test_audience_gate_excludes_out_of_room_memories():
    c = _conn()
    _mk(c, "priv", "2026-07-02", "ward-only", audience="ward-private")
    _mk(c, "shared", "2026-07-02", "shared", audience="village")
    # A room cleared only for 'village' must not see the ward-private memory.
    out = memory.by_timerange("2026-07-02", "2026-07-02", audiences=["village"], conn=c)
    assert [r["id"] for r in out["results"]] == ["shared"]


def test_schedule_refs_surface_on_results():
    c = _conn()
    sj = json.dumps({"via": "memorization", "schedule_refs": ["schmidt-kh"]})
    _mk(c, "m", "2026-07-02", "session with Schmidt", source_json=sj)
    out = memory.by_timerange("2026-07-02", "2026-07-02", conn=c)
    assert out["results"][0]["schedule_refs"] == ["schmidt-kh"]
