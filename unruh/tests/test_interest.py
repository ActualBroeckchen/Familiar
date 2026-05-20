"""Unit tests for the interest layer (M4).

Run with: cd unruh && uv run pytest tests/test_interest.py

Each test uses a fresh in-memory DB so tests are isolated and the
on-disk data/unruh.db is never touched. Decay maths is tested with
deterministic timestamps so flakiness from real-time elapsing
during the test isn't a concern.
"""

from __future__ import annotations

import math
import sqlite3
from datetime import datetime, timedelta, timezone

import pytest

from unruh import interest as interests
from unruh.db import run_migrations


@pytest.fixture
def conn():
    """Fresh in-memory DB with migrations applied."""
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys = ON")
    run_migrations(c)
    yield c
    c.close()


# ── Decay maths ────────────────────────────────────────────────────────


class TestEffectiveWeight:
    def test_returns_zero_for_missing_inputs(self):
        assert interests.effective_weight(None, "2026-01-01T00:00:00+00:00") == 0.0
        assert interests.effective_weight(1.0, None) == 0.0
        assert interests.effective_weight(None, None) == 0.0

    def test_no_decay_when_just_touched(self):
        now = datetime(2026, 5, 1, tzinfo=timezone.utc)
        result = interests.effective_weight(
            raw_weight=1.0,
            last_touched=now.isoformat(),
            now=now,
            tau_days=5.0,
        )
        assert result == pytest.approx(1.0)

    def test_one_tau_halves_to_1_over_e(self):
        # After exactly tau_days elapsed, weight = original * exp(-1) ≈ 0.368
        now = datetime(2026, 5, 6, tzinfo=timezone.utc)
        five_days_ago = (now - timedelta(days=5)).isoformat()
        result = interests.effective_weight(
            raw_weight=1.0, last_touched=five_days_ago, now=now, tau_days=5.0,
        )
        assert result == pytest.approx(1.0 / math.e, rel=1e-3)

    def test_far_past_decays_to_near_zero(self):
        now = datetime(2026, 5, 1, tzinfo=timezone.utc)
        long_ago = (now - timedelta(days=30)).isoformat()
        result = interests.effective_weight(
            raw_weight=1.0, last_touched=long_ago, now=now, tau_days=5.0,
        )
        assert result < 0.01

    def test_naive_iso_string_assumed_utc(self):
        # Older rows might have last_touched without tz info.
        # effective_weight must not blow up on those.
        now = datetime(2026, 5, 6, tzinfo=timezone.utc)
        five_days_ago_naive = (now.replace(tzinfo=None) - timedelta(days=5)).isoformat()
        result = interests.effective_weight(
            raw_weight=1.0, last_touched=five_days_ago_naive, now=now, tau_days=5.0,
        )
        assert result == pytest.approx(1.0 / math.e, rel=1e-3)


# ── Tier classification ───────────────────────────────────────────────


class TestTierForWeight:
    def test_curiosity_under_0_5(self):
        assert interests.tier_for_weight(0.0)  == "curiosity"
        assert interests.tier_for_weight(0.1)  == "curiosity"
        assert interests.tier_for_weight(0.49) == "curiosity"

    def test_live_interest_above_0_5(self):
        assert interests.tier_for_weight(0.5)  == "live_interest"
        assert interests.tier_for_weight(1.0)  == "live_interest"
        assert interests.tier_for_weight(1.99) == "live_interest"

    def test_active_pursuit_above_2(self):
        assert interests.tier_for_weight(2.0)  == "active_pursuit"
        assert interests.tier_for_weight(10.0) == "active_pursuit"


# ── record() ─────────────────────────────────────────────────────────


class TestRecord:
    def test_first_call_creates_as_curiosity(self, conn):
        result = interests.record(conn, topic="owl feather aerodynamics")
        assert result["ok"]
        assert result["type"] == "curiosity"
        assert result["raw_weight"] == pytest.approx(0.1)

    def test_decay_then_add_caps_accumulation(self, conn):
        """Decay-then-add: bumping the same topic right after a previous
        bump roughly doubles the weight (no time elapsed → no decay).
        Bumping after a long gap decays first, then adds — so the new
        weight is mostly the fresh delta, not 2× the original."""
        interests.record(conn, topic="x", delta=1.0)
        # Same-moment bump: almost no decay, weight ≈ 2.0
        r2 = interests.record(conn, topic="x", delta=1.0)
        assert r2["raw_weight"] == pytest.approx(2.0, rel=1e-2)

        # Now simulate a very stale last_touched via direct UPDATE,
        # then bump again. Without decay-then-add, weight would be
        # 3.0. With decay-then-add, it should be ~1.0.
        conn.execute(
            "UPDATE nodes SET last_touched = ? WHERE label = 'x'",
            ("2020-01-01T00:00:00+00:00",),
        )
        r3 = interests.record(conn, topic="x", delta=1.0)
        # Decayed contribution from old weight is essentially 0 after
        # years of decay; new weight is ~delta.
        assert r3["raw_weight"] == pytest.approx(1.0, abs=0.01)

    def test_record_on_standing_value_does_not_bump(self, conn):
        interests.set_standing(conn, topic="caring for the user", weight=1.0)
        result = interests.record(conn, topic="caring for the user", delta=10.0)
        # Standing values: last_touched updates, weight stays put.
        assert result["raw_weight"] == pytest.approx(1.0)
        assert result["type"] == "standing_value"

    def test_blank_topic_rejected(self, conn):
        with pytest.raises(ValueError, match="topic is required"):
            interests.record(conn, topic="   ")

    def test_negative_delta_rejected(self, conn):
        with pytest.raises(ValueError, match="delta must be non-negative"):
            interests.record(conn, topic="x", delta=-0.1)

    def test_source_stored_in_payload(self, conn):
        interests.record(conn, topic="x", source="token_volume")
        row = conn.execute("SELECT payload_json FROM nodes WHERE label='x'").fetchone()
        import json
        payload = json.loads(row["payload_json"])
        assert payload.get("source") == "token_volume"


# ── Insert-helper validation ──────────────────────────────────────────


class TestInsertValidation:
    def test_insert_node_rejects_unknown_type(self, conn):
        from unruh.db import now_iso
        with pytest.raises(ValueError, match="unknown interest node type"):
            interests._insert_node(
                conn, node_type="nonsense", label="x",
                payload={}, weight=1.0, ts=now_iso(),
            )

    def test_insert_node_accepts_each_known_type(self, conn):
        from unruh.db import now_iso
        for t in interests.INTEREST_NODE_TYPES:
            nid = interests._insert_node(
                conn, node_type=t, label=f"label-{t}",
                payload={}, weight=1.0, ts=now_iso(),
            )
            assert nid

    def test_insert_edge_rejects_unknown_kind(self, conn):
        from unruh.db import now_iso, new_id
        with pytest.raises(ValueError, match="unknown interest edge kind"):
            interests._insert_edge(
                conn, src_id=new_id(), dst_id=new_id(),
                kind="nonsense", ts=now_iso(),
            )


# ── bookmark() ───────────────────────────────────────────────────────


class TestBookmark:
    def test_creates_node_and_edge(self, conn):
        result = interests.bookmark(
            conn, topic="biomimetic engineering",
            resource="https://example.com/article",
            note="Came up in conversation",
        )
        assert result["bookmark_id"] and result["topic_id"] and result["edge_id"]

        # Verify the bookmark exists with the right payload.
        bookmark_row = conn.execute(
            "SELECT * FROM nodes WHERE id = ?", (result["bookmark_id"],),
        ).fetchone()
        assert bookmark_row["type"] == "bookmark"
        import json
        payload = json.loads(bookmark_row["payload_json"])
        assert payload["resource"] == "https://example.com/article"
        assert payload["note"] == "Came up in conversation"

        # Verify the edge connects bookmark → topic.
        edge_row = conn.execute(
            "SELECT * FROM edges WHERE id = ?", (result["edge_id"],),
        ).fetchone()
        assert edge_row["src_id"] == result["bookmark_id"]
        assert edge_row["dst_id"] == result["topic_id"]
        assert edge_row["kind"] == "bookmarked"

    def test_creates_topic_if_missing(self, conn):
        result = interests.bookmark(
            conn, topic="brand new thing", resource="https://x.com",
        )
        topic_row = conn.execute(
            "SELECT type FROM nodes WHERE id = ?", (result["topic_id"],),
        ).fetchone()
        assert topic_row["type"] == "curiosity"  # auto-created

    def test_uses_existing_topic_when_present(self, conn):
        rec = interests.record(conn, topic="established interest", delta=0.5)
        bm = interests.bookmark(
            conn, topic="established interest", resource="https://y.com",
        )
        assert bm["topic_id"] == rec["id"]

    def test_blank_resource_rejected(self, conn):
        with pytest.raises(ValueError, match="resource is required"):
            interests.bookmark(conn, topic="x", resource="   ")


# ── set_standing() ──────────────────────────────────────────────────


class TestSetStanding:
    def test_creates_new_standing_value(self, conn):
        result = interests.set_standing(
            conn, topic="caring for the user", value_ref="self/my_wants.md#wellbeing",
        )
        assert result["created"]
        row = conn.execute("SELECT * FROM nodes WHERE id = ?", (result["id"],)).fetchone()
        assert row["type"] == "standing_value"
        import json
        payload = json.loads(row["payload_json"])
        assert payload["value_ref"] == "self/my_wants.md#wellbeing"

    def test_promotes_existing_curiosity(self, conn):
        rec = interests.record(conn, topic="emerging value", delta=0.5)
        result = interests.set_standing(
            conn, topic="emerging value", value_ref="some/path",
        )
        assert not result["created"]
        assert result["id"] == rec["id"]  # same node, promoted
        row = conn.execute("SELECT type FROM nodes WHERE id = ?", (rec["id"],)).fetchone()
        assert row["type"] == "standing_value"


# ── list_interests() ────────────────────────────────────────────────


class TestListInterests:
    def test_empty_db_returns_empty_lists(self, conn):
        result = interests.list_interests(conn)
        assert result["standing"] == []
        assert result["live"] == []

    def test_standing_values_always_surface_regardless_of_min_weight(self, conn):
        interests.set_standing(conn, topic="caring", weight=0.5)
        result = interests.list_interests(conn, min_weight=999.0)
        assert len(result["standing"]) == 1
        assert result["standing"][0]["label"] == "caring"

    def test_live_interests_sorted_by_effective_weight_desc(self, conn):
        interests.record(conn, topic="a", delta=0.5)
        interests.record(conn, topic="b", delta=2.0)
        interests.record(conn, topic="c", delta=1.0)
        result = interests.list_interests(conn)
        labels = [n["label"] for n in result["live"]]
        assert labels == ["b", "c", "a"]

    def test_min_weight_filters_live(self, conn):
        interests.record(conn, topic="tiny", delta=0.005)  # below default min_weight
        interests.record(conn, topic="big",  delta=1.0)
        result = interests.list_interests(conn)
        labels = [n["label"] for n in result["live"]]
        assert "tiny" not in labels
        assert "big" in labels

    def test_limit_respected_on_live(self, conn):
        for i in range(15):
            interests.record(conn, topic=f"t{i}", delta=1.0)
        result = interests.list_interests(conn, limit=5)
        assert len(result["live"]) == 5

    def test_tier_label_included(self, conn):
        interests.record(conn, topic="curio", delta=0.1)
        interests.record(conn, topic="livi",  delta=1.0)
        interests.record(conn, topic="actv",  delta=3.0)
        result = interests.list_interests(conn)
        tiers = {n["label"]: n["tier"] for n in result["live"]}
        assert tiers["curio"] == "curiosity"
        assert tiers["livi"]  == "live_interest"
        assert tiers["actv"]  == "active_pursuit"

    def test_bookmarks_excluded(self, conn):
        interests.bookmark(conn, topic="some topic", resource="x")
        result = interests.list_interests(conn)
        # The topic shows up (auto-created by bookmark), but the
        # bookmark node itself does NOT — bookmarks have their own
        # block in the briefing.
        types = {n["type"] for n in result["live"]}
        assert "bookmark" not in types

    def test_include_standing_false(self, conn):
        interests.set_standing(conn, topic="standing")
        interests.record(conn, topic="live", delta=1.0)
        result = interests.list_interests(conn, include_standing=False)
        assert result["standing"] == []
        assert any(n["label"] == "live" for n in result["live"])


# ── list_bookmarks() ────────────────────────────────────────────────


class TestListBookmarks:
    def test_returns_bookmark_with_topic_label(self, conn):
        bm = interests.bookmark(
            conn, topic="owl wings", resource="https://x.com",
        )
        result = interests.list_bookmarks(conn)
        assert len(result) == 1
        assert result[0]["id"] == bm["bookmark_id"]
        assert result[0]["topic_label"] == "owl wings"
        assert result[0]["payload"]["resource"] == "https://x.com"

    def test_sorted_most_recent_first(self, conn):
        # Use direct INSERTs with controlled timestamps so we're
        # testing the sort rather than the second-precision tie that
        # back-to-back interests.bookmark() calls would produce in
        # the same test millisecond.
        from unruh.db import new_id
        for ts, label in [
            ("2026-05-01T10:00:00+00:00", "older"),
            ("2026-05-02T10:00:00+00:00", "newer"),
        ]:
            conn.execute(
                """INSERT INTO nodes (id, layer, type, label, payload_json,
                                       when_ts, end_ts, resolution, weight,
                                       last_touched, created_at, updated_at)
                   VALUES (?, 'interest', 'bookmark', ?, '{}', NULL, NULL,
                           NULL, NULL, ?, ?, ?)""",
                (new_id(), label, ts, ts, ts),
            )
        result = interests.list_bookmarks(conn)
        assert [b["label"] for b in result] == ["newer", "older"]
