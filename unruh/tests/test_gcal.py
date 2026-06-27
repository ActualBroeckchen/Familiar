"""Unit tests for Google-Calendar ingestion (build spec §1).

Run with: cd unruh && uv run pytest tests/test_gcal.py

Covers the iCal parser (ical.py) and the change-classifying upsert
(gcal.py) against fixture `.ics` strings — no network, per §1.5.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime

import pytest

from unruh import gcal, ical, schedule as sched
from unruh.db import run_migrations, to_local_naive


@pytest.fixture
def conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys = ON")
    run_migrations(c)
    yield c
    c.close()


def _vevent(uid, start, summary="Thing", extra=""):
    return (
        "BEGIN:VEVENT\n"
        f"UID:{uid}\n"
        f"DTSTART:{start}\n"
        f"SUMMARY:{summary}\n"
        f"{extra}"
        "END:VEVENT\n"
    )


def _cal(*vevents):
    return "BEGIN:VCALENDAR\nVERSION:2.0\n" + "".join(vevents) + "END:VCALENDAR\n"


# ── Parser ─────────────────────────────────────────────────────────────


def test_parse_basic_utc_event():
    text = _cal(_vevent("a@google.com", "20260702T140000Z", "Dentist",
                         "DTEND:20260702T144500Z\nLOCATION:12 High St\n"))
    out = ical.parse_ical(text)
    assert len(out["events"]) == 1
    ev = out["events"][0]
    assert ev["uid"] == "a@google.com"
    assert ev["summary"] == "Dentist"
    assert ev["start"].startswith("2026-07-02T14:00:00")
    assert ev["end"].startswith("2026-07-02T14:45:00")
    assert ev["location"] == "12 High St"
    assert ev["all_day"] is False
    assert ev["status"] == "confirmed"


def test_parse_all_day_event():
    text = _cal("BEGIN:VEVENT\nUID:b\nDTSTART;VALUE=DATE:20260702\nSUMMARY:Holiday\nEND:VEVENT\n")
    ev = ical.parse_ical(text)["events"][0]
    assert ev["all_day"] is True
    assert ev["start"].startswith("2026-07-02T00:00:00")


def test_parse_line_unfolding_and_escapes():
    text = _cal("BEGIN:VEVENT\nUID:c\nDTSTART:20260702T090000Z\n"
                "SUMMARY:bring referral\\, please\nDESCRIPTION:line one\\nline two\n"
                "  and a folded tail\nEND:VEVENT\n")
    ev = ical.parse_ical(text)["events"][0]
    assert ev["summary"] == "bring referral, please"
    assert "line one\nline two and a folded tail" == ev["description"]


def test_cancelled_status_parsed():
    text = _cal(_vevent("d", "20260702T140000Z", extra="STATUS:CANCELLED\n"))
    ev = ical.parse_ical(text)["events"][0]
    assert ev["status"] == "cancelled"


def test_event_without_uid_skipped():
    text = _cal("BEGIN:VEVENT\nDTSTART:20260702T140000Z\nSUMMARY:no uid\nEND:VEVENT\n")
    assert ical.parse_ical(text)["events"] == []


# ── Recurrence: subset mapping ─────────────────────────────────────────


def test_simple_weekly_maps_to_recurrence():
    # 2026-07-02 is a Thursday.
    text = _cal(_vevent("w", "20260702T090000Z", extra="RRULE:FREQ=WEEKLY\n"))
    ev = ical.parse_ical(text)["events"][0]
    assert ev["recurrence"] == {"freq": "weekly"}


def test_biweekly_interval_maps():
    text = _cal(_vevent("w2", "20260702T090000Z", extra="RRULE:FREQ=WEEKLY;INTERVAL=2\n"))
    ev = ical.parse_ical(text)["events"][0]
    assert ev["recurrence"] == {"freq": "weekly", "interval": 2}


def test_monthly_last_friday_maps_with_js_weekday():
    # last Friday of every month; recurrence.js consumes JS getDay (FR=5).
    text = _cal(_vevent("m", "20260626T090000Z",
                        extra="RRULE:FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1\n"))
    ev = ical.parse_ical(text)["events"][0]
    assert ev["recurrence"] == {"freq": "monthly", "bysetpos": -1, "byweekday": 5}


def test_until_maps():
    text = _cal(_vevent("u", "20260702T090000Z",
                        extra="RRULE:FREQ=DAILY;UNTIL=20260710T000000Z\n"))
    ev = ical.parse_ical(text)["events"][0]
    assert ev["recurrence"]["freq"] == "daily"
    assert ev["recurrence"]["until"] == "2026-07-10"


# ── Recurrence: §1.4 fallback expansion ────────────────────────────────


def test_multiday_weekly_expands_to_occurrences():
    # MWF every week — NOT in the subset, so it materialises as occurrences.
    now = datetime(2026, 6, 29)  # a Monday
    text = _cal(_vevent("mwf", "20260629T090000Z",
                        extra="RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR\n"))
    out = ical.parse_ical(text, now=now)
    assert "mwf" in out["complex_series"]
    occs = out["events"]
    assert len(occs) > 3
    # Synthetic uids carry the occurrence date, so re-sync reconciles them.
    assert all(e["uid"].startswith("mwf#") for e in occs)
    assert all(e["recurrence"] is None and e["expanded_from"] == "mwf" for e in occs)
    # Only Mon/Wed/Fri.
    for e in occs:
        wd = datetime.fromisoformat(e["start"].replace("Z", "+00:00")).weekday()
        assert wd in (0, 2, 4)


def test_fallback_horizon_bounded():
    now = datetime(2026, 1, 1)
    text = _cal(_vevent("daily-mwf", "20260101T090000Z",
                        extra="RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU\n"))
    out = ical.parse_ical(text, now=now)
    # 90-day horizon, daily → ~91 occurrences, never unbounded.
    assert 80 <= len(out["events"]) <= 95


# ── Ingest: change classification ──────────────────────────────────────


def _ingest(conn, text, **kw):
    return gcal.gcal_ingest(conn, ics_text=text, **kw)


def test_new_updated_unchanged_removed(conn):
    future = "20990702T140000Z"
    text = _cal(_vevent("x@g", future, "Dentist"))
    r1 = _ingest(conn, text)
    assert len(r1["new"]) == 1 and not r1["updated"] and not r1["removed"]
    node_id = r1["new"][0]

    # Re-sync unchanged → nothing new.
    r2 = _ingest(conn, text)
    assert not r2["new"] and r2["unchanged"] == [node_id]

    # Advance LAST-MODIFIED + change the title → updated, id preserved.
    text2 = _cal(_vevent("x@g", future, "Dentist (moved)",
                         extra="LAST-MODIFIED:20260620T090000Z\n"))
    r3 = _ingest(conn, text2)
    assert r3["updated"] == [node_id] and not r3["new"]
    row = conn.execute("SELECT label FROM nodes WHERE id=?", (node_id,)).fetchone()
    assert row["label"] == "Dentist (moved)"

    # Vanish from a confirmed full snapshot → cancelled (future event).
    other = _cal(_vevent("y@g", future, "Lunch"))
    r4 = _ingest(conn, other)
    assert node_id in r4["removed"]
    row = conn.execute("SELECT resolution FROM nodes WHERE id=?", (node_id,)).fetchone()
    assert row["resolution"] == "cancelled"


def test_needs_projection_only_on_insert(conn):
    future = "20990702T140000Z"
    r1 = _ingest(conn, _cal(_vevent("np@g", future, "A")))
    nid = r1["new"][0]
    p = json.loads(conn.execute("SELECT payload_json FROM nodes WHERE id=?", (nid,)).fetchone()["payload_json"])
    assert p["needs_projection"] is True
    assert p["source"] == "gcal" and p["gcal_uid"] == "np@g"

    # Familiar "thinks it through" → clears the flag; an update must not re-set it.
    p2 = dict(p); p2.pop("needs_projection")
    sched.update_node(conn, id=nid, payload=p2)
    _ingest(conn, _cal(_vevent("np@g", future, "A2", extra="LAST-MODIFIED:20260620T090000Z\n")))
    p3 = json.loads(conn.execute("SELECT payload_json FROM nodes WHERE id=?", (nid,)).fetchone()["payload_json"])
    assert "needs_projection" not in p3  # preserved-as-cleared, never resurrected


def test_empty_snapshot_never_cancels(conn):
    future = "20990702T140000Z"
    r1 = _ingest(conn, _cal(_vevent("keep@g", future, "Keep")))
    nid = r1["new"][0]
    # An empty (but "successful") fetch must be a no-op for deletions.
    r2 = _ingest(conn, _cal())  # zero VEVENTs
    assert not r2["removed"]
    row = conn.execute("SELECT resolution FROM nodes WHERE id=?", (nid,)).fetchone()
    assert row["resolution"] is None


def test_windowed_read_does_not_reconcile_deletes(conn):
    future = "20990702T140000Z"
    r1 = _ingest(conn, _cal(_vevent("a@g", future), _vevent("b@g", future)))
    assert len(r1["new"]) == 2
    # A partial/windowed read missing b@g, with reconcile_deletes=False.
    r2 = _ingest(conn, _cal(_vevent("a@g", future)), reconcile_deletes=False)
    assert not r2["removed"]


def test_past_event_absent_is_not_a_deletion(conn):
    past = "20200101T090000Z"
    r1 = _ingest(conn, _cal(_vevent("old@g", past, "Old")))
    nid = r1["new"][0]
    # Future-only snapshot; the past event aged out of view, not deleted.
    r2 = _ingest(conn, _cal(_vevent("new@g", "20990101T090000Z")))
    assert nid not in r2["removed"]
    row = conn.execute("SELECT resolution FROM nodes WHERE id=?", (nid,)).fetchone()
    assert row["resolution"] is None


# Projection candidates use a 14-day horizon from `now`; pin both for
# determinism. Floating local-naive DTSTART (no Z) stores as-is.
NOW = "2026-06-26T12:00:00"
SOON = "20260628T140000"   # +2 days, in horizon
FAR = "20260801T090000"    # +36 days, beyond horizon


def test_projection_candidates_flagged_in_horizon(conn):
    r = _ingest(conn, _cal(_vevent("p@g", SOON, "Dentist")))
    nid = r["new"][0]
    cands = gcal.projection_candidates(conn, now=NOW)
    assert [c["id"] for c in cands] == [nid]
    assert cands[0]["label"] == "Dentist"


def test_projection_candidate_drops_after_consequence_edge(conn):
    # Auto-clear (§4.3): once the Familiar links a consequence, it's gone.
    r = _ingest(conn, _cal(_vevent("p2@g", SOON, "Interview")))
    nid = r["new"][0]
    state_id = sched.add_node(conn, type="state", label="calm", when="2026-06-20T09:00:00")
    sched.add_edge(conn, src=nid, dst=state_id, kind="causes",
                   payload={"valence": "help", "condition": "on_resolve"})
    assert gcal.projection_candidates(conn, now=NOW) == []


def test_projection_candidate_excludes_out_of_horizon_and_resolved(conn):
    r = _ingest(conn, _cal(_vevent("near@g", SOON), _vevent("far@g", FAR)))
    cands = gcal.projection_candidates(conn, now=NOW)
    # Only the near one (the far one is past the 14-day horizon).
    assert len(cands) == 1
    # Resolving the near one removes it too.
    sched.resolve(conn, id=cands[0]["id"], resolution="done")
    assert gcal.projection_candidates(conn, now=NOW) == []


def test_ingest_threads_now_into_fallback_horizon(conn):
    # A complex (multi-BYDAY) series expands over a 90-day horizon. The horizon
    # must anchor to the `now` passed to gcal_ingest — not the wall clock — so
    # ingest stays consistent with a standalone parse at the same now (and is
    # deterministic in tests). DTSTART is floating-local so no tz shift muddies
    # the count.
    text = _cal(_vevent("mwf2@g", "20260629T090000", extra="RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR\n"))
    expected = len(ical.parse_ical(text, now=datetime.fromisoformat(NOW))["events"])
    r = gcal.gcal_ingest(conn, ics_text=text, now=NOW)
    inserted = conn.execute(
        "SELECT COUNT(*) n FROM nodes WHERE json_extract(payload_json,'$.source')='gcal'"
    ).fetchone()["n"]
    assert inserted == expected == len(r["new"])
    assert expected > 3  # the series really did expand (not a degenerate 1)


def test_ingest_events_list_path(conn):
    # The authenticated-adapter path: pre-normalised events, not .ics text.
    ev = {
        "uid": "evlist@g", "summary": "Meeting", "start": "20990702T140000Z".replace("Z", "+00:00"),
        "end": None, "all_day": False, "recurrence": None, "location": None,
        "description": None, "status": "confirmed", "last_modified": None,
    }
    r = gcal.gcal_ingest(conn, events=[ev])
    assert len(r["new"]) == 1
