"""Unit tests for schedule-node → `.ics` / Google-URL export (§2).

Run with: cd unruh && uv run pytest tests/test_icalwrite.py
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone

import pytest

from unruh import icalwrite, schedule as sched
from unruh.db import run_migrations


@pytest.fixture
def conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys = ON")
    run_migrations(c)
    yield c
    c.close()


def test_build_ics_structure_and_utc_dtstart():
    node = {
        "id": "abc123", "label": "Dentist", "type": "event",
        "when": "2026-07-02T14:00:00", "end": "2026-07-02T14:45:00",
        "payload": {"location": "12 High St", "description": "bring referral"},
    }
    ics = icalwrite.build_ics(node, now=datetime(2026, 6, 1, tzinfo=timezone.utc))
    assert "BEGIN:VCALENDAR" in ics and "END:VCALENDAR" in ics
    assert "BEGIN:VEVENT" in ics and "END:VEVENT" in ics
    assert "UID:abc123@proto-familiar" in ics
    assert "SUMMARY:Dentist" in ics
    assert "LOCATION:12 High St" in ics
    # DTSTART is a real UTC instant ('…Z'), converted from local-naive in code.
    assert "DTSTART:" in ics and "Z" in ics.split("DTSTART:")[1][:20]
    # CRLF line endings per RFC 5545.
    assert "\r\n" in ics


def test_all_day_uses_value_date():
    node = {"id": "h", "label": "Holiday", "type": "event",
            "when": "2026-07-02T00:00:00", "payload": {"all_day": True}}
    ics = icalwrite.build_ics(node)
    assert "DTSTART;VALUE=DATE:20260702" in ics
    # all-day default end is +1 day.
    assert "DTEND;VALUE=DATE:20260703" in ics


def test_text_escaping():
    node = {"id": "e", "label": "Lunch, with Sam; bring notes\nand pen",
            "when": "2026-07-02T12:00:00", "payload": {}}
    ics = icalwrite.build_ics(node)
    assert "SUMMARY:Lunch\\, with Sam\\; bring notes\\nand pen" in ics


def test_google_url_has_template_and_dates():
    node = {"id": "g", "label": "Dentist", "type": "event",
            "when": "2026-07-02T14:00:00", "end": "2026-07-02T14:45:00",
            "payload": {"location": "12 High St"}}
    url = icalwrite.build_google_url(node)
    assert url.startswith("https://calendar.google.com/calendar/render?")
    assert "action=TEMPLATE" in url
    assert "text=Dentist" in url
    assert "dates=" in url and "%2F" in url  # encoded "/" between start/end
    assert "location=12%20High%20St" in url


def test_missing_end_defaults_one_hour_timed():
    node = {"id": "n", "label": "Call", "when": "2026-07-02T14:00:00", "payload": {}}
    ics = icalwrite.build_ics(node)
    start = ics.split("DTSTART:")[1][:16]
    end = ics.split("DTEND:")[1][:16]
    # End is one hour after start (both UTC basic) — exact delta is tz-stable.
    sh = int(start[9:11]); eh = int(end[9:11])
    assert (eh - sh) % 24 == 1


def test_export_node_shape():
    node = {"id": "x", "label": "Thing", "when": "2026-07-02T09:00:00", "payload": {}}
    out = icalwrite.export_node(node)
    assert out["ok"] is True
    assert out["ics"].startswith("BEGIN:VCALENDAR")
    assert out["google_url"].startswith("https://calendar.google.com")


def test_get_node_then_export_roundtrip(conn):
    nid = sched.add_node(conn, type="event", label="Review",
                         when="2026-07-02T15:00:00", end="2026-07-02T16:00:00")
    node = sched.get_node(conn, id=nid)
    assert node is not None and node["label"] == "Review"
    out = icalwrite.export_node(node)
    assert out["ok"] and "SUMMARY:Review" in out["ics"]
    assert sched.get_node(conn, id="nonexistent") is None
