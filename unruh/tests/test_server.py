"""Unit tests for the Unruh MCP server.

Calls the tool functions directly (not over MCP) — the MCP transport
is FastMCP-provided and not what we're testing; we're testing the
return-shape contract Thalamus depends on. If these shapes change,
Thalamus's formatTemporalContext will silently produce garbage.
"""

from __future__ import annotations

import re

from unruh import __version__
from unruh.server import health_check, temporal_context


# Unruh stores LOCAL-naive timestamps (no offset); an offset is still accepted
# on input and normalised away, so the offset suffix is optional here.
ISO_TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:\d{2}|Z)?$")


class TestHealthCheck:
    def test_returns_ok_true(self):
        result = health_check()
        assert result["ok"] is True

    def test_service_name_is_stable(self):
        # Thalamus may log this; renaming would be a breaking observability change.
        assert health_check()["service"] == "unruh"

    def test_version_matches_package(self):
        assert health_check()["version"] == __version__

    def test_ts_is_iso8601(self):
        assert ISO_TS_RE.match(health_check()["ts"]), "ts must be ISO-8601"


class TestTemporalContext:
    def test_returns_stable_top_level_shape(self):
        """Thalamus's formatTemporalContext indexes into these keys
        without optional-chaining the top-level object. If any of these
        disappear, the formatter throws."""
        result = temporal_context()
        assert set(result.keys()) >= {"ts", "schedule", "interests", "handoff"}

    def test_schedule_sub_shape(self):
        sched = temporal_context()["schedule"]
        assert "window" in sched
        assert "phase" in sched
        assert isinstance(sched["window"], list)

    def test_interests_sub_shape(self):
        interests = temporal_context()["interests"]
        assert "standing" in interests
        assert "live" in interests
        assert isinstance(interests["standing"], list)
        assert isinstance(interests["live"], list)

    def test_handoff_sub_shape(self):
        handoff = temporal_context()["handoff"]
        assert "intent" in handoff
        assert "open_threads" in handoff
        assert isinstance(handoff["open_threads"], list)

    # The M1-era "all-empty contract" was true only until M3 wired
    # schedule reads from the DB; the empty-DB case now lives in
    # test_temporal_context.py::test_empty_schedule_returns_empty_window
    # which uses an isolated tmp DB instead of hitting the real one.

    def test_now_argument_is_echoed(self):
        result = temporal_context(now="2026-01-15T10:00:00Z")
        assert result["ts"] == "2026-01-15T10:00:00Z"

    def test_now_default_is_iso(self):
        assert ISO_TS_RE.match(temporal_context()["ts"])
