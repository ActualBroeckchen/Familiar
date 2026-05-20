"""Unit tests for the session-handoff layer (M6).

Run with: cd unruh && uv run pytest tests/test_handoff.py

Fresh in-memory DB per test (deferred-transaction mode, matching
production db.get_conn()).
"""

from __future__ import annotations

import sqlite3

import pytest

from unruh import handoff as handoffs
from unruh.db import run_migrations


@pytest.fixture
def conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys = ON")
    run_migrations(c)
    yield c
    c.close()


# ── set_handoff ───────────────────────────────────────────────────────


class TestSetHandoff:
    def test_stores_intent_and_threads(self, conn):
        r = handoffs.set_handoff(
            conn,
            intent="helping debug the auth flow",
            threads=["the JWT refresh bug", "httpOnly cookies?"],
            session_id="sess-1",
        )
        assert r["ok"] and r["id"] and not r["skipped"]
        h = handoffs.get_handoff(conn)
        assert h["intent"] == "helping debug the auth flow"
        assert h["open_threads"] == ["the JWT refresh bug", "httpOnly cookies?"]
        assert h["session_id"] == "sess-1"
        assert h["consumed"] is False

    def test_empty_handoff_is_skipped(self, conn):
        r = handoffs.set_handoff(conn, intent="   ", threads=[])
        assert r["skipped"] is True
        assert r["id"] is None
        assert handoffs.get_handoff(conn) is None

    def test_intent_only_is_stored(self, conn):
        r = handoffs.set_handoff(conn, intent="just chatting")
        assert not r["skipped"]
        assert handoffs.get_handoff(conn)["open_threads"] == []

    def test_threads_only_is_stored(self, conn):
        r = handoffs.set_handoff(conn, threads=["unresolved thing"])
        assert not r["skipped"]
        h = handoffs.get_handoff(conn)
        assert h["intent"] is None
        assert h["open_threads"] == ["unresolved thing"]

    def test_blank_threads_filtered_out(self, conn):
        handoffs.set_handoff(conn, intent="x", threads=["real", "  ", "", "  also real "])
        assert handoffs.get_handoff(conn)["open_threads"] == ["real", "also real"]

    def test_caps_runaway_intent_and_threads(self, conn):
        # Untrusted LLM output: a wall of text + too many threads must
        # be bounded so it can't bloat every future prompt.
        handoffs.set_handoff(
            conn,
            intent="x" * 5000,
            threads=["t" * 5000] + [f"thread {i}" for i in range(50)],
        )
        h = handoffs.get_handoff(conn)
        assert len(h["intent"]) == handoffs.MAX_INTENT_CHARS
        assert len(h["open_threads"]) == handoffs.MAX_THREADS
        assert all(len(t) <= handoffs.MAX_THREAD_CHARS for t in h["open_threads"])

    def test_new_handoff_supersedes_prior_unconsumed(self, conn):
        first = handoffs.set_handoff(conn, intent="first session")
        second = handoffs.set_handoff(conn, intent="second session")
        # Only the second is live.
        live = handoffs.get_handoff(conn)
        assert live["id"] == second["id"]
        assert live["intent"] == "second session"
        # The first was superseded (consumed), not deleted.
        assert handoffs.mark_consumed(conn, id=first["id"])["updated"] == 0  # already consumed


# ── get_handoff ───────────────────────────────────────────────────────


class TestGetHandoff:
    def test_none_when_empty(self, conn):
        assert handoffs.get_handoff(conn) is None

    def test_excludes_consumed_by_default(self, conn):
        r = handoffs.set_handoff(conn, intent="done soon")
        handoffs.mark_consumed(conn, id=r["id"])
        assert handoffs.get_handoff(conn) is None

    def test_include_consumed_returns_latest(self, conn):
        r = handoffs.set_handoff(conn, intent="archived")
        handoffs.mark_consumed(conn, id=r["id"])
        h = handoffs.get_handoff(conn, include_consumed=True)
        assert h is not None
        assert h["intent"] == "archived"
        assert h["consumed"] is True


# ── mark_consumed ─────────────────────────────────────────────────────


class TestMarkConsumed:
    def test_marks_and_stops_surfacing(self, conn):
        r = handoffs.set_handoff(conn, intent="surface me once")
        assert handoffs.get_handoff(conn) is not None
        upd = handoffs.mark_consumed(conn, id=r["id"])
        assert upd["updated"] == 1
        assert handoffs.get_handoff(conn) is None

    def test_idempotent_on_already_consumed(self, conn):
        r = handoffs.set_handoff(conn, intent="x")
        handoffs.mark_consumed(conn, id=r["id"])
        assert handoffs.mark_consumed(conn, id=r["id"])["updated"] == 0

    def test_unknown_id_is_noop(self, conn):
        assert handoffs.mark_consumed(conn, id="does-not-exist")["updated"] == 0


# ── End-to-end lifecycle ──────────────────────────────────────────────


class TestLifecycle:
    def test_session_boundary_flow(self, conn):
        # Session A ends → write handoff.
        a = handoffs.set_handoff(
            conn, intent="was outlining the essay", threads=["intro paragraph"],
            session_id="A",
        )
        # Session B's first message surfaces it.
        surfaced = handoffs.get_handoff(conn)
        assert surfaced["id"] == a["id"]
        # ...then marks it consumed.
        handoffs.mark_consumed(conn, id=surfaced["id"])
        # Session B's later messages see nothing.
        assert handoffs.get_handoff(conn) is None
        # Session B ends → new handoff, independent of the consumed one.
        b = handoffs.set_handoff(conn, intent="finished the essay", session_id="B")
        assert handoffs.get_handoff(conn)["id"] == b["id"]
