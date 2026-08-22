"""Unit tests for the intentions layer (Initiative Pass 3).

Run with: cd unruh && uv run pytest tests/test_intention.py

Fresh in-memory DB per test, matching production db.get_conn().
"""

from __future__ import annotations

import sqlite3

import pytest

from unruh import intention as intentions
from unruh.db import run_migrations


@pytest.fixture
def conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys = ON")
    run_migrations(c)
    yield c
    c.close()


# ── set_intention ─────────────────────────────────────────────────────


def test_set_minimal_and_slug_id(conn):
    r = intentions.set_intention(conn, what="I check in on Chen")
    assert r["ok"] is True
    assert r["id"].startswith("i-check-in-on-chen") or "chen" in r["id"]  # slug from `what`
    row = intentions.get_by_id(conn, id=r["id"])
    assert row["what"] == "I check in on Chen"
    assert row["status"] == "active"
    assert row["trigger"]["kind"] == "none"


def test_set_requires_what(conn):
    assert intentions.set_intention(conn, what="   ")["ok"] is False


def test_set_at_trigger_normalises_local(conn):
    r = intentions.set_intention(conn, what="widen the lead",
                                 trigger={"kind": "at", "at": "2026-07-16T09:00:00Z"})
    assert r["ok"] is True
    row = intentions.get_by_id(conn, id=r["id"])
    assert row["trigger"]["kind"] == "at"
    # Offset-bearing input is canonicalised to local-naive (no 'Z'/offset).
    assert "Z" not in row["trigger"]["at"] and "+" not in row["trigger"]["at"]


def test_set_at_requires_time(conn):
    assert intentions.set_intention(conn, what="x", trigger={"kind": "at"})["ok"] is False


def test_set_phase_round(conn):
    r = intentions.set_intention(conn, what="I review the calendar",
                                 trigger={"kind": "phase", "phase": "morning", "recurring": True},
                                 why="so nothing slips", source="pondering")
    row = intentions.get_by_id(conn, id=r["id"])
    assert row["trigger"] == {"kind": "phase", "at": None, "phase": "morning", "recurring": True}
    assert row["why"] == "so nothing slips"
    assert row["source"] == "pondering"


def test_set_phase_requires_phase(conn):
    assert intentions.set_intention(conn, what="x", trigger={"kind": "phase"})["ok"] is False


def test_recurring_forced_off_for_non_phase(conn):
    r = intentions.set_intention(conn, what="x", trigger={"kind": "at", "at": "2026-07-16T09:00:00"})
    # 'recurring' only means something for a phase round.
    assert intentions.get_by_id(conn, id=r["id"])["trigger"]["recurring"] is False


def test_condition_vocab_filtered(conn):
    r = intentions.set_intention(conn, what="x",
                                 condition={"minContactGapMs": 3600000, "bogusKey": 1})
    cond = intentions.get_by_id(conn, id=r["id"])["condition"]
    assert cond == {"minContactGapMs": 3600000}  # unknown key dropped


def test_refs_stored_and_capped(conn):
    r = intentions.set_intention(conn, what="x", refs=["tea-ritual-x7", "  ", "dentist-k3"] + [f"n{i}" for i in range(20)])
    refs = intentions.get_by_id(conn, id=r["id"])["refs"]
    assert "tea-ritual-x7" in refs and "dentist-k3" in refs
    assert "" not in refs and "  " not in refs
    assert len(refs) <= intentions.MAX_REFS


def test_invalid_trigger_kind_and_visibility(conn):
    assert intentions.set_intention(conn, what="x", trigger={"kind": "whenever"})["ok"] is False
    assert intentions.set_intention(conn, what="x", visibility="secret")["ok"] is False


# ── lifecycle: drop / done / fired ────────────────────────────────────


def test_drop_is_idempotent(conn):
    i = intentions.set_intention(conn, what="x")["id"]
    assert intentions.drop_intention(conn, id=i)["updated"] == 1
    assert intentions.drop_intention(conn, id=i)["updated"] == 0
    assert intentions.get_by_id(conn, id=i)["status"] == "dropped"


def test_done_and_already_done(conn):
    i = intentions.set_intention(conn, what="x")["id"]
    r1 = intentions.complete_intention(conn, id=i)
    assert r1["updated"] == 1 and r1["already_done"] is False
    r2 = intentions.complete_intention(conn, id=i)
    assert r2["already_done"] is True
    assert intentions.complete_intention(conn, id="ghost")["ok"] is False


def test_mark_fired_stamps_today(conn):
    i = intentions.set_intention(conn, what="x")["id"]
    intentions.mark_fired(conn, id=i, now="2026-07-15T09:00:00")
    assert intentions.get_by_id(conn, id=i)["last_fired_date"] == "2026-07-15"


# ── intentions_due: trigger timing ────────────────────────────────────


def test_due_at_time_passed_once(conn):
    i = intentions.set_intention(conn, what="ping",
                                 trigger={"kind": "at", "at": "2026-07-15T09:00:00"})["id"]
    # Before the time: not due.
    assert intentions.intentions_due(conn, now="2026-07-15T08:00:00") == []
    # After: due.
    due = intentions.intentions_due(conn, now="2026-07-15T09:30:00")
    assert [d["id"] for d in due] == [i]
    # Once fired, a one-shot 'at' retires from due.
    intentions.mark_fired(conn, id=i, now="2026-07-15T09:30:00")
    assert intentions.intentions_due(conn, now="2026-07-15T10:00:00") == []


def test_due_phase_round_recurs_daily(conn):
    i = intentions.set_intention(conn, what="review",
                                 trigger={"kind": "phase", "phase": "morning", "recurring": True})["id"]
    # Not my phase → not due.
    assert intentions.intentions_due(conn, now="2026-07-15T09:00:00", current_phase_label="noon") == []
    # My phase → due.
    due = intentions.intentions_due(conn, now="2026-07-15T09:00:00", current_phase_label="morning")
    assert [d["id"] for d in due] == [i]
    # Fired today → not due again today.
    intentions.mark_fired(conn, id=i, now="2026-07-15T09:00:00")
    assert intentions.intentions_due(conn, now="2026-07-15T09:30:00", current_phase_label="morning") == []
    # Next day, same phase → due again (a round recurs).
    assert [d["id"] for d in intentions.intentions_due(conn, now="2026-07-16T09:00:00", current_phase_label="morning")] == [i]


def test_due_nonrecurring_phase_fires_once(conn):
    i = intentions.set_intention(conn, what="one-off",
                                 trigger={"kind": "phase", "phase": "morning"})["id"]
    assert [d["id"] for d in intentions.intentions_due(conn, now="2026-07-15T09:00:00", current_phase_label="morning")] == [i]
    intentions.mark_fired(conn, id=i, now="2026-07-15T09:00:00")
    # Non-recurring: never due again, even a new day.
    assert intentions.intentions_due(conn, now="2026-07-16T09:00:00", current_phase_label="morning") == []


def test_phase_matches_is_forgiving():
    # The reported bug: 'evening' vs the routine label 'Evening' never matched.
    assert intentions.phase_matches("evening", "Evening") is True          # case
    assert intentions.phase_matches("evening", "Evening wind-down") is True  # generic → specific
    assert intentions.phase_matches("Evening wind-down", "evening") is True  # specific → generic
    assert intentions.phase_matches("morning", "evening") is False
    assert intentions.phase_matches("", "Evening") is False
    assert intentions.phase_matches("evening", None) is False


def test_resolve_phase_canonicalises_to_a_real_label():
    labels = ["Morning", "Work", "Evening wind-down"]
    assert intentions.resolve_phase("evening", labels) == ("Evening wind-down", True)   # substring, canonicalised
    assert intentions.resolve_phase("WORK", labels) == ("Work", True)                    # case-insensitive exact
    assert intentions.resolve_phase("nap", labels) == ("nap", False)                     # no match → kept, flagged
    assert intentions.resolve_phase("evening", []) == ("evening", False)                 # no phases defined


def test_due_phase_matches_regardless_of_case_and_label_shape(conn):
    # The exact bug: a round set on 'evening' must fire when the ward's routine
    # phase is labelled 'Evening wind-down'.
    i = intentions.set_intention(conn, what="I check in this evening",
                                 trigger={"kind": "phase", "phase": "evening", "recurring": True})["id"]
    due = intentions.intentions_due(conn, now="2026-07-15T20:00:00", current_phase_label="Evening wind-down")
    assert [d["id"] for d in due] == [i]


def test_set_phase_canonicalises_against_routine_and_warns(conn):
    # With the ward's real phases supplied, a typed word is canonicalised…
    r = intentions.set_intention(conn, what="evening check-in",
                                 trigger={"kind": "phase", "phase": "evening", "recurring": True},
                                 available_phases=["Morning", "Evening wind-down"])
    assert r["ok"] is True and "warning" not in r
    stored = intentions.get_by_id(conn, id=r["id"])
    assert stored["trigger"]["phase"] == "Evening wind-down"   # stored against the real label
    # …and a phase that matches nothing is created but flagged, not silently dead.
    r2 = intentions.set_intention(conn, what="midnight snack reminder",
                                  trigger={"kind": "phase", "phase": "midnight", "recurring": True},
                                  available_phases=["Morning", "Evening wind-down"])
    assert r2["ok"] is True
    assert "warning" in r2 and "midnight" in r2["warning"]


def test_due_excludes_contact_and_none_triggers(conn):
    intentions.set_intention(conn, what="a", trigger={"kind": "on_next_contact"})
    intentions.set_intention(conn, what="b", trigger={"kind": "none"})
    assert intentions.intentions_due(conn, now="2026-07-15T09:00:00", current_phase_label="morning") == []


def test_due_excludes_dropped_and_done(conn):
    i = intentions.set_intention(conn, what="ping",
                                 trigger={"kind": "at", "at": "2026-07-15T09:00:00"})["id"]
    intentions.drop_intention(conn, id=i)
    assert intentions.intentions_due(conn, now="2026-07-15T10:00:00") == []


# ── list + budget counts ──────────────────────────────────────────────


def test_list_active_only_by_default_and_phase_filter(conn):
    a = intentions.set_intention(conn, what="round-m", trigger={"kind": "phase", "phase": "morning", "recurring": True})["id"]
    intentions.set_intention(conn, what="round-n", trigger={"kind": "phase", "phase": "noon", "recurring": True})
    dropped = intentions.set_intention(conn, what="gone")["id"]
    intentions.drop_intention(conn, id=dropped)
    active = intentions.list_intentions(conn)
    assert dropped not in [x["id"] for x in active]
    morning = intentions.list_intentions(conn, phase="morning")
    assert [x["id"] for x in morning] == [a]


def test_budget_counts(conn):
    intentions.set_intention(conn, what="r1", trigger={"kind": "phase", "phase": "morning", "recurring": True})
    intentions.set_intention(conn, what="r2", trigger={"kind": "phase", "phase": "morning", "recurring": True})
    intentions.set_intention(conn, what="one", trigger={"kind": "at", "at": "2026-07-16T09:00:00"})
    assert intentions.count_standing_in_phase(conn, phase="morning") == 2
    assert intentions.count_standing_in_phase(conn, phase="noon") == 0
    assert intentions.count_open_oneshots(conn) == 1  # the 'at' one-off; rounds are recurring


# ── rounds visibility (the Familiar's own choice) ─────────────────────


def test_rounds_visibility_default_shared(conn):
    assert intentions.get_rounds_visibility(conn) == "shared"


def test_set_rounds_visibility_and_validation(conn):
    assert intentions.set_rounds_visibility(conn, value="private")["ok"] is True
    assert intentions.get_rounds_visibility(conn) == "private"
    assert intentions.set_rounds_visibility(conn, value="loud")["ok"] is False


def test_rounds_for_ward_respects_visibility(conn):
    shown = intentions.set_intention(conn, what="I review the calendar",
                                     trigger={"kind": "phase", "phase": "morning", "recurring": True})["id"]
    priv = intentions.set_intention(conn, what="a private round",
                                    trigger={"kind": "phase", "phase": "noon", "recurring": True},
                                    visibility="private")["id"]
    view = intentions.rounds_for_ward(conn)
    ids = [r["id"] for r in view["rounds"]]
    assert shown in ids and priv not in ids
    assert view["hidden_count"] == 1  # existence counted, contents withheld
    assert view["visibility"] == "shared"

    # Flip the GLOBAL default to private: now both are hidden (existence still counted).
    intentions.set_rounds_visibility(conn, value="private")
    view2 = intentions.rounds_for_ward(conn)
    assert view2["rounds"] == [] and view2["hidden_count"] == 2 and view2["visibility"] == "private"
