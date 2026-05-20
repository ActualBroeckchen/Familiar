"""Tests for the temporal_context tool's M3-onwards behaviour.

The shape contract is the boundary with thalamus.js's formatter
(temporal-format.js) — if the keys here drift, the formatter
silently mis-renders or produces an empty section.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from unruh import schedule as sched
from unruh.server import temporal_context
from unruh.db import default_db_path, get_conn


@pytest.fixture
def isolated_db(tmp_path, monkeypatch):
    """Point the default DB path at a temp file for the duration of
    the test. The server's tool functions use get_conn() with no
    args, which resolves via default_db_path() — monkeypatching
    that lets us drive the public API without touching the real DB."""
    db = tmp_path / "test.db"
    monkeypatch.setattr("unruh.db.default_db_path", lambda: db)
    yield db


class TestShape:
    def test_returns_stable_top_level_keys(self, isolated_db):
        result = temporal_context()
        assert set(result.keys()) >= {"ts", "schedule", "interests", "handoff"}

    def test_schedule_block_has_phase_and_window(self, isolated_db):
        result = temporal_context()
        assert "phase" in result["schedule"]
        assert "window" in result["schedule"]
        assert isinstance(result["schedule"]["window"], list)

    def test_interest_block_still_empty_in_m3(self, isolated_db):
        # M4 will populate these. Until then they're empty — the
        # thalamus.js formatter omits the interest sub-section when
        # both lists are empty, so this is the contract.
        result = temporal_context()
        assert result["interests"]["standing"] == []
        assert result["interests"]["live"] == []

    def test_handoff_block_still_empty_in_m3(self, isolated_db):
        # M6 will populate these.
        result = temporal_context()
        assert result["handoff"]["intent"] is None
        assert result["handoff"]["open_threads"] == []


class TestSchedulePopulation:
    def test_empty_schedule_returns_empty_window(self, isolated_db):
        result = temporal_context()
        assert result["schedule"]["phase"] is None
        assert result["schedule"]["window"] == []

    def test_added_event_shows_in_window(self, isolated_db):
        with get_conn() as conn:
            now = datetime.now(timezone.utc)
            sched.add_node(
                conn, type="event", label="Chen's appointment",
                when=(now + timedelta(hours=1)).isoformat(timespec="seconds"),
            )
        result = temporal_context()
        labels = [n["label"] for n in result["schedule"]["window"]]
        assert "Chen's appointment" in labels

    def test_resolved_task_drops_out(self, isolated_db):
        with get_conn() as conn:
            t = sched.add_node(conn, type="task", label="laundry")
            sched.resolve(conn, id=t, resolution="done")
        result = temporal_context()
        labels = [n["label"] for n in result["schedule"]["window"]]
        assert "laundry" not in labels

    def test_current_phase_surfaces(self, isolated_db):
        with get_conn() as conn:
            now = datetime.now(timezone.utc)
            sched.add_node(
                conn, type="phase", label="afternoon work",
                when=(now - timedelta(hours=1)).isoformat(timespec="seconds"),
                end=(now + timedelta(hours=1)).isoformat(timespec="seconds"),
            )
        result = temporal_context()
        assert result["schedule"]["phase"] is not None
        assert result["schedule"]["phase"]["label"] == "afternoon work"
