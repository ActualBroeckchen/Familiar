"""Tests for the seed-routine loader."""

from __future__ import annotations

import pytest

from unruh.db import get_conn
from unruh.seed import seed_today


@pytest.fixture
def isolated_db(tmp_path, monkeypatch):
    db = tmp_path / "test.db"
    monkeypatch.setattr("unruh.db.default_db_path", lambda: db)
    yield db


class TestSeedRoutine:
    def test_first_run_inserts_phases_and_anchors(self, isolated_db):
        summary = seed_today()
        assert summary["phases_added"] > 0
        assert summary["events_added"] > 0
        assert summary["skipped"] == 0

        # Verify phases + anchors landed and the 'during' edges connect them.
        with get_conn() as conn:
            phases = conn.execute(
                "SELECT * FROM nodes WHERE layer='schedule' AND type='phase'"
            ).fetchall()
            events = conn.execute(
                "SELECT * FROM nodes WHERE layer='schedule' AND type='event'"
            ).fetchall()
            edges = conn.execute(
                "SELECT * FROM edges WHERE kind='during'"
            ).fetchall()
        assert len(phases) > 0
        assert len(events) > 0
        assert len(edges) == len(events)  # each anchor event has one 'during' edge

    def test_second_run_skips_existing(self, isolated_db):
        first  = seed_today()
        second = seed_today()
        # Second run finds same-label phases for today already there
        # and skips them — only anchor events are re-added (their
        # de-dup story is replace-mode, not implicit skip).
        assert second["phases_added"] == 0
        assert second["skipped"] == first["phases_added"]

    def test_replace_overwrites_phases(self, isolated_db):
        first = seed_today()
        again = seed_today(replace=True)
        assert again["phases_added"] == first["phases_added"]
        assert again["skipped"] == 0

    def test_month_end_does_not_crash(self, isolated_db):
        """Regression guard: prior `dt.replace(day=day+1)` raised
        ValueError on the 31st of 30-day months and on Feb 28/29
        because day 31 (or 29/30) doesn't exist in the next month
        viewed from .replace's perspective. timedelta(days=1) handles
        this correctly. Test runs seed for a few known-bad dates."""
        from datetime import datetime, timezone
        from unruh.seed import _phase_end_today
        for bad_date in [
            datetime(2026, 5, 31, 12, 0, tzinfo=timezone.utc),   # May 31 → June 1
            datetime(2026, 1, 31, 12, 0, tzinfo=timezone.utc),   # Jan 31 → Feb 1
            datetime(2026, 4, 30, 12, 0, tzinfo=timezone.utc),   # Apr 30 → May 1
            datetime(2024, 2, 29, 12, 0, tzinfo=timezone.utc),   # Leap day → Mar 1
            datetime(2026, 2, 28, 12, 0, tzinfo=timezone.utc),   # Non-leap Feb 28 → Mar 1
            datetime(2026, 12, 31, 12, 0, tzinfo=timezone.utc),  # Dec 31 → Jan 1 next year
        ]:
            # The wrap-around case (end <= start triggers next-day).
            result = _phase_end_today("23:00", "06:00", bad_date)
            assert result, f"_phase_end_today crashed for {bad_date.date().isoformat()}"

    def test_replace_does_not_touch_user_events(self, isolated_db):
        from unruh import schedule as sched
        seed_today()
        with get_conn() as conn:
            # User-created event (no seeded marker) on the same day.
            from datetime import datetime, timezone
            now = datetime.now(timezone.utc).isoformat(timespec="seconds")
            user_event = sched.add_node(conn, type="event", label="user thing", when=now)

        seed_today(replace=True)

        with get_conn() as conn:
            row = conn.execute("SELECT id FROM nodes WHERE id=?", (user_event,)).fetchone()
        assert row is not None, "user-created events must survive --replace"
