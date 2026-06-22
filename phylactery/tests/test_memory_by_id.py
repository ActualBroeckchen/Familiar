"""By-id addressing is the unique handle. granularity+date_key can't single out a
standalone per-fact row — a whole day's extracted facts share one plain date — so
read/edit/move/delete of a specific fact must go by id. These pin that, plus the
move-date fix for facts imported into the wrong day (the 159-into-today bug).

embed_text is mocked so create()'s embedding is deterministic (no model needed).
"""

import sqlite3
import pytest
from unittest.mock import patch

from phylactery import memory


# Distinct vectors per fact so the create-time dedup (sim ≥ 0.78 merges) keeps the
# two same-day facts as SEPARATE rows — that separation is exactly what by-id
# addressing has to handle.
_VECS = {
    "Alice started a new job":            "[1, 0, 0, 0]",
    "Alice started a job at the clinic":  "[1, 0, 0, 0]",
    "Bob adopted a dog":                  "[0, 1, 0, 0]",
    "A real milestone":                   "[0, 0, 1, 0]",
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
            subjects_json TEXT, care_weight TEXT, category TEXT,
            consent_pending INTEGER DEFAULT 0, confidence REAL DEFAULT 1.0,
            source_json TEXT, created_at TEXT, updated_at TEXT,
            recall_count INTEGER DEFAULT 0, last_recalled_at TEXT
        )
    """)
    c.execute("CREATE VIRTUAL TABLE memory_vecs USING vec0(memory_id TEXT PRIMARY KEY, embedding float[4])")
    return c


def _two_facts_same_day(c):
    """Two standalone facts sharing one plain date — the collision case."""
    with patch("phylactery.embed.embed_text", _fake_embed):
        a = memory.create("Alice started a new job", "daily", date_key="2026-06-22",
                           slug="fact-a", standalone=True, conn=c)
        b = memory.create("Bob adopted a dog", "daily", date_key="2026-06-22",
                           slug="fact-b", standalone=True, conn=c)
    return a["id"], b["id"]


def test_read_by_id_distinguishes_rows_that_share_a_date():
    c = _conn()
    a_id, b_id = _two_facts_same_day(c)
    assert a_id != b_id
    a = memory.read_memory_by_id(a_id, conn=c)
    b = memory.read_memory_by_id(b_id, conn=c)
    assert a["ok"] and "Alice" in a["content"]
    assert b["ok"] and "Bob" in b["content"]
    # The exact bug the UI hit: a date-only read returns whichever comes first for
    # BOTH — by-id keeps them apart.
    assert a["content"] != b["content"]


def test_read_by_id_missing_is_a_clean_error():
    c = _conn()
    res = memory.read_memory_by_id("nope", conn=c)
    assert res["ok"] is False and "nope" in res["error"]


def test_move_date_refiles_a_standalone_fact_and_leaves_content():
    c = _conn()
    a_id, _ = _two_facts_same_day(c)
    res = memory.move_memory_date(a_id, "2026-01-03", conn=c)
    assert res["ok"] and res["date"] == "2026-01-03"
    row = c.execute("SELECT date_key, slug, content FROM memories WHERE id=?", (a_id,)).fetchone()
    assert row["date_key"] == "2026-01-03"   # only the day moved
    assert row["slug"] == "fact-a"            # slug untouched
    assert "Alice" in row["content"]          # content untouched


def test_move_date_rebuilds_the_composite_key_for_significant():
    c = _conn()
    with patch("phylactery.embed.embed_text", _fake_embed):
        m = memory.create("A real milestone", "significant", date_key="2026-06-22",
                          slug="milestone", conn=c)
    res = memory.move_memory_date(m["id"], "2025-12-31", conn=c)
    assert res["ok"] and res["date"] == "2025-12-31_milestone"
    dk = c.execute("SELECT date_key FROM memories WHERE id=?", (m["id"],)).fetchone()["date_key"]
    assert dk == "2025-12-31_milestone"


def test_move_date_rejects_a_bad_date_without_touching_anything():
    c = _conn()
    a_id, _ = _two_facts_same_day(c)
    res = memory.move_memory_date(a_id, "june 22", conn=c)
    assert res["ok"] is False
    assert c.execute("SELECT date_key FROM memories WHERE id=?", (a_id,)).fetchone()["date_key"] == "2026-06-22"


def test_update_by_id_changes_content_and_audience():
    c = _conn()
    a_id, b_id = _two_facts_same_day(c)
    with patch("phylactery.embed.embed_text", _fake_embed):
        res = memory.update_memory_by_id(a_id, new_content="Alice started a job at the clinic",
                                         audience="family", conn=c)
    assert res["ok"]
    row = c.execute("SELECT content, audience FROM memories WHERE id=?", (a_id,)).fetchone()
    assert "clinic" in row["content"] and row["audience"] == "family"
    # the sibling sharing the date is untouched
    assert "Bob" in c.execute("SELECT content FROM memories WHERE id=?", (b_id,)).fetchone()["content"]


def test_delete_by_id_removes_only_the_targeted_row():
    c = _conn()
    a_id, b_id = _two_facts_same_day(c)
    res = memory.delete_memory_by_id(a_id, conn=c)
    assert res["ok"] and res["deleted"] == a_id
    assert c.execute("SELECT COUNT(*) FROM memories WHERE id=?", (a_id,)).fetchone()[0] == 0
    assert c.execute("SELECT COUNT(*) FROM memories WHERE id=?", (b_id,)).fetchone()[0] == 1


# ── The mass-overwrite guard (audit finding) ───────────────────────────────────
# update_memory / delete_memory address by granularity+date, which is unique ONLY
# for the journal bucket (slug NULL). They must NEVER touch the standalone per-fact
# rows that share that plain date — those are by-id only.

def _journal_plus_two_facts(c):
    with patch("phylactery.embed.embed_text", _fake_embed):
        memory.create("the day's running summary", "daily", date_key="2026-06-22", conn=c)  # journal bucket, slug NULL
    a_id, b_id = _two_facts_same_day(c)  # two standalone facts on the same date
    return a_id, b_id


def test_update_by_date_touches_only_the_journal_bucket_not_the_facts():
    c = _conn()
    a_id, b_id = _journal_plus_two_facts(c)
    with patch("phylactery.embed.embed_text", _fake_embed):
        res = memory.update_memory("daily", "2026-06-22", "rewritten summary", conn=c)
    assert res["ok"]
    # the journal bucket changed…
    bucket = c.execute("SELECT content FROM memories WHERE granularity='daily' AND date_key='2026-06-22' AND slug IS NULL").fetchone()
    assert "rewritten summary" in bucket["content"]
    # …and the two standalone facts are UNTOUCHED (the mass-overwrite bug)
    assert "Alice" in c.execute("SELECT content FROM memories WHERE id=?", (a_id,)).fetchone()["content"]
    assert "Bob"   in c.execute("SELECT content FROM memories WHERE id=?", (b_id,)).fetchone()["content"]


def test_delete_by_date_removes_only_the_journal_bucket_not_the_facts():
    c = _conn()
    a_id, b_id = _journal_plus_two_facts(c)
    res = memory.delete_memory("daily", "2026-06-22", conn=c)
    assert res["ok"]
    assert c.execute("SELECT COUNT(*) FROM memories WHERE granularity='daily' AND date_key='2026-06-22' AND slug IS NULL").fetchone()[0] == 0
    # both per-fact rows survive
    assert c.execute("SELECT COUNT(*) FROM memories WHERE id IN (?,?)", (a_id, b_id)).fetchone()[0] == 2


def test_update_by_date_with_no_journal_bucket_is_a_clean_miss_not_a_mass_write():
    c = _conn()
    a_id, b_id = _two_facts_same_day(c)  # ONLY standalone facts, no journal bucket
    with patch("phylactery.embed.embed_text", _fake_embed):
        res = memory.update_memory("daily", "2026-06-22", "should hit nothing", conn=c)
    assert res["ok"] is False  # nothing to update → clean miss, not a silent mass-overwrite
    assert "Alice" in c.execute("SELECT content FROM memories WHERE id=?", (a_id,)).fetchone()["content"]
    assert "Bob"   in c.execute("SELECT content FROM memories WHERE id=?", (b_id,)).fetchone()["content"]
