"""Semantic dedup-merge at memory write time.

The "82 queued, only 5 new" bug: significant / consent-pending memories were
inserted with no similarity check, so paraphrase duplicates piled up. create()
now folds a near-duplicate into the existing entry instead. These pin that:
near-identical → confirm (no new row, no append); additive near-dup → merge
(append the new detail); distinct → a normal new row.

embed_text is mocked so similarity is deterministic (no model needed).
"""

import sqlite3
import pytest
from unittest.mock import patch

from phylactery import memory


# Fixed 4-dim vectors per content, chosen so L2 distance lands in known bands
# (similarity = 1 - distance/2, the scale create() dedups on):
#   A vs A        : dist 0      → sim 1.00  (identical → confirm)
#   A vs C        : dist ~0.345 → sim ~0.83 (merge band [0.78, 0.85))
#   A vs B        : dist ~1.414 → sim ~0.29 (distinct)
_VECS = {
    "Alice is stressed about work":        "[1, 0, 0, 0]",
    "Alice has been stressed by her job":  "[0.94, 0.34, 0, 0]",
    "Bob baked a chocolate cake":          "[0, 1, 0, 0]",
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
            subjects_json TEXT, care_weight TEXT, category TEXT, content_tag TEXT,
            consent_pending INTEGER DEFAULT 0, confidence REAL DEFAULT 1.0, attribution_confidence REAL,
            source_json TEXT, created_at TEXT, updated_at TEXT,
            recall_count INTEGER DEFAULT 0, last_recalled_at TEXT
        )
    """)
    c.execute("CREATE VIRTUAL TABLE memory_vecs USING vec0(memory_id TEXT PRIMARY KEY, embedding float[4])")
    return c


def _count(c):
    return c.execute("SELECT COUNT(*) FROM memories").fetchone()[0]


def test_near_identical_confirms_without_a_new_row():
    c = _conn()
    with patch("phylactery.embed.embed_text", _fake_embed):
        a = memory.create("Alice is stressed about work", "significant", consent_pending=True, conn=c)
        assert _count(c) == 1
        # Same fact again → folds into the existing entry, no second row.
        b = memory.create("Alice is stressed about work", "significant", consent_pending=True, conn=c)
        assert b["merged"] is True and b.get("identical") is True
        assert b["id"] == a["id"]
        assert _count(c) == 1


def test_additive_near_duplicate_merges_the_new_detail():
    c = _conn()
    with patch("phylactery.embed.embed_text", _fake_embed):
        a = memory.create("Alice is stressed about work", "significant", consent_pending=True, conn=c)
        b = memory.create("Alice has been stressed by her job", "significant", consent_pending=True, conn=c)
        assert b["merged"] is True and b["id"] == a["id"]
        assert _count(c) == 1  # no new row
        content = c.execute("SELECT content FROM memories WHERE id=?", (a["id"],)).fetchone()[0]
        assert "stressed about work" in content and "stressed by her job" in content  # both folded in


def test_distinct_fact_inserts_a_new_row():
    c = _conn()
    with patch("phylactery.embed.embed_text", _fake_embed):
        memory.create("Alice is stressed about work", "significant", consent_pending=True, conn=c)
        b = memory.create("Bob baked a chocolate cake", "significant", consent_pending=True, conn=c)
        assert not b.get("merged")
        assert _count(c) == 2


def test_additive_dup_at_different_consent_level_inserts_new():
    """With the new pending-dedup logic: a pending fact that near-dups an
    already-confirmed memory is dropped (already_known=True), not inserted
    separately. This avoids re-asking the ward about a fact they already
    greenlit; the confirmed content stays unchanged."""
    c = _conn()
    with patch("phylactery.embed.embed_text", _fake_embed):
        confirmed = memory.create("Alice is stressed about work", "significant", consent_pending=False, conn=c)
        b = memory.create("Alice has been stressed by her job", "significant", consent_pending=True, conn=c)
        # Now returns already_known:True, merged:True (pending dropped, not inserted)
        assert b.get("merged") is True
        assert b.get("already_known") is True
        assert b["id"] == confirmed["id"]
        assert _count(c) == 1  # no new row


# ── Standalone daily facts (Part C — correct tiering) ────────────────────────
# The memorization pipeline lands discrete facts at the `daily` tier with
# standalone=True so each keeps its own row + metadata, consolidates, and decays
# — instead of being mis-filed as permanent `significant`. These pin that shape.

def test_standalone_daily_facts_get_their_own_rows():
    c = _conn()
    with patch("phylactery.embed.embed_text", _fake_embed):
        memory.create("Alice is stressed about work", "daily", standalone=True, consent_pending=True, conn=c)
        b = memory.create("Bob baked a chocolate cake", "daily", standalone=True, consent_pending=True, conn=c)
        assert not b.get("merged")
        assert _count(c) == 2  # two distinct standalone rows, NOT one date bucket
        for row in c.execute("SELECT date_key, slug FROM memories").fetchall():
            assert "_" not in row["date_key"]  # plain YYYY-MM-DD → consolidation's range filter catches it
            assert row["slug"]                 # slug marks it standalone so the bucket never absorbs it


def test_standalone_daily_dedups_like_significant():
    c = _conn()
    with patch("phylactery.embed.embed_text", _fake_embed):
        a = memory.create("Alice is stressed about work", "daily", standalone=True, consent_pending=True, conn=c)
        b = memory.create("Alice has been stressed by her job", "daily", standalone=True, consent_pending=True, conn=c)
        assert b["merged"] is True and b["id"] == a["id"]
        assert _count(c) == 1


def test_plain_daily_bucket_and_standalone_fact_stay_separate():
    """A standalone fact and the plain daily journal share the date but must not
    bleed into one another: the fact is its own slugged row; journal lines append
    into the slug-NULL bucket."""
    c = _conn()
    with patch("phylactery.embed.embed_text", _fake_embed):
        memory.create("Alice is stressed about work", "daily", standalone=True, consent_pending=True, conn=c)
        memory.create("- went for a walk", "daily", conn=c)      # plain journal line → new bucket
        memory.create("- had lunch with Bob", "daily", conn=c)   # appends into the same bucket
        assert _count(c) == 2  # one fact row + one journal bucket (not three)
        bucket = c.execute("SELECT content FROM memories WHERE slug IS NULL").fetchone()
        assert "went for a walk" in bucket["content"] and "had lunch with Bob" in bucket["content"]


# ── Pending dedup (aggressive queue collapse) ─────────────────────────────────

def test_two_pending_near_identical_facts_merge():
    """Two pending facts that are near-identical fold into one row."""
    c = _conn()
    with patch("phylactery.embed.embed_text", _fake_embed):
        a = memory.create("Alice is stressed about work", "significant", consent_pending=True, conn=c)
        assert _count(c) == 1
        # Second near-identical pending fact → merged
        b = memory.create("Alice is stressed about work", "significant", consent_pending=True, conn=c)
        assert b["merged"] is True
        assert b["id"] == a["id"]
        assert _count(c) == 1  # no new row


def test_pending_fact_near_dups_confirmed_fact_drops_pending():
    """A pending fact that near-dups an already-CONFIRMED memory is dropped
    (already_known:True), and the confirmed row's content is left unchanged."""
    c = _conn()
    with patch("phylactery.embed.embed_text", _fake_embed):
        # Create a confirmed (consented) memory
        confirmed = memory.create("Alice is stressed about work", "significant", consent_pending=False, conn=c)
        assert _count(c) == 1
        confirmed_id = confirmed["id"]
        # Fetch the confirmed content for later comparison
        confirmed_content_before = c.execute(
            "SELECT content FROM memories WHERE id=?", (confirmed_id,)
        ).fetchone()[0]

        # Now try to create a near-dup pending fact
        result = memory.create("Alice has been stressed by her job", "significant", consent_pending=True, conn=c)

        # Should return already_known:True, merged:True, with the confirmed ID
        assert result["merged"] is True
        assert result.get("already_known") is True
        assert result["id"] == confirmed_id
        assert _count(c) == 1  # no new row created

        # Confirmed content must be unchanged
        confirmed_content_after = c.execute(
            "SELECT content FROM memories WHERE id=?", (confirmed_id,)
        ).fetchone()[0]
        assert confirmed_content_after == confirmed_content_before


def test_pending_dedup_is_audience_agnostic():
    """A pending fact dedups against a matching fact filed under a different audience."""
    c = _conn()
    with patch("phylactery.embed.embed_text", _fake_embed):
        # Create a pending fact with audience A
        a = memory.create(
            "Alice is stressed about work", "significant",
            consent_pending=True, audience="private-only", conn=c
        )
        assert _count(c) == 1

        # Create another pending fact with audience B, same content
        b = memory.create(
            "Alice is stressed about work", "significant",
            consent_pending=True, audience="shared-with-bob", conn=c
        )

        # Should merge despite different audiences
        assert b["merged"] is True
        assert b["id"] == a["id"]
        assert _count(c) == 1


def test_confirmed_store_still_avoids_over_merging():
    """Regression: the confirmed-store path (consent_pending=False) still inserts
    a new row when two facts are similar but not identical (below 0.78 threshold)."""
    c = _conn()
    with patch("phylactery.embed.embed_text", _fake_embed):
        # Create first confirmed fact (high-similarity pair but just below merge threshold)
        # We'll use a distinct fact pair to ensure they don't merge
        a = memory.create("Bob baked a chocolate cake", "significant", consent_pending=False, conn=c)
        assert _count(c) == 1

        # Create a distinct second fact that should NOT merge with the first
        b = memory.create("Alice is stressed about work", "significant", consent_pending=False, conn=c)

        # These are distinct (sim ~0.29), so a new row should be inserted
        assert not b.get("merged")
        assert _count(c) == 2
