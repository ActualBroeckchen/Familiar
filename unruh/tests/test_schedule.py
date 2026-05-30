"""Unit tests for the schedule layer.

Run with: cd unruh && uv run pytest

Each test uses a fresh in-memory DB (via the `conn` fixture) so
tests are isolated and the on-disk data/unruh.db is never touched.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from unruh import schedule as sched
from unruh.db import MIGRATIONS_DIR, run_migrations, now_iso


@pytest.fixture
def conn():
    """Fresh in-memory DB with migrations applied. Uses deferred-
    transaction mode (no isolation_level=None) to match production
    db.get_conn() after the #A4 fix, so tests exercise the same
    commit/rollback semantics the real connection does."""
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys = ON")
    run_migrations(c)
    yield c
    c.close()


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds")


# ── Migrations ────────────────────────────────────────────────────────


class TestMigrations:
    def test_migrations_directory_exists(self):
        assert MIGRATIONS_DIR.exists()
        assert any(MIGRATIONS_DIR.glob("*.sql")), "expected at least one migration"

    def test_migrations_are_idempotent(self, conn):
        # Re-running should be a no-op (no exceptions).
        run_migrations(conn)
        run_migrations(conn)
        row = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
        assert int(row["value"]) >= 1

    def test_expected_tables_exist(self, conn):
        tables = {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert {"meta", "nodes", "edges"} <= tables


# ── Writes ────────────────────────────────────────────────────────────


class TestAddNode:
    def test_event_round_trip(self, conn):
        now = now_iso()
        nid = sched.add_node(conn, type="event", label="Chen's appointment", when=now)
        row = conn.execute("SELECT * FROM nodes WHERE id = ?", (nid,)).fetchone()
        assert row["type"] == "event"
        assert row["label"] == "Chen's appointment"
        assert row["when_ts"] == now
        assert row["layer"] == "schedule"

    def test_task_without_when_is_allowed(self, conn):
        # An open task without a deadline — the "general to do" case.
        nid = sched.add_node(conn, type="task", label="reply to email")
        row = conn.execute("SELECT when_ts, resolution FROM nodes WHERE id=?", (nid,)).fetchone()
        assert row["when_ts"] is None
        assert row["resolution"] is None

    def test_phase_requires_end(self, conn):
        with pytest.raises(ValueError, match="phase nodes require an 'end'"):
            sched.add_node(conn, type="phase", label="morning", when=now_iso())

    def test_event_requires_when(self, conn):
        with pytest.raises(ValueError, match="requires a 'when'"):
            sched.add_node(conn, type="event", label="X")

    def test_unknown_type_rejected(self, conn):
        with pytest.raises(ValueError, match="unknown schedule node type"):
            sched.add_node(conn, type="mystery", label="X", when=now_iso())

    def test_blank_label_rejected(self, conn):
        with pytest.raises(ValueError, match="label is required"):
            sched.add_node(conn, type="task", label="   ")


class TestAddEdge:
    def test_edge_round_trip(self, conn):
        a = sched.add_node(conn, type="task", label="prep")
        b = sched.add_node(conn, type="event", label="interview", when=now_iso())
        eid = sched.add_edge(conn, src=a, dst=b, kind="requires")
        row = conn.execute("SELECT * FROM edges WHERE id=?", (eid,)).fetchone()
        assert row["kind"] == "requires"
        assert row["src_id"] == a and row["dst_id"] == b

    def test_unknown_kind_rejected(self, conn):
        a = sched.add_node(conn, type="task", label="a")
        b = sched.add_node(conn, type="task", label="b")
        with pytest.raises(ValueError, match="unknown schedule edge kind"):
            sched.add_edge(conn, src=a, dst=b, kind="invents")

    def test_self_edge_rejected(self, conn):
        a = sched.add_node(conn, type="task", label="a")
        with pytest.raises(ValueError, match="cannot connect a node to itself"):
            sched.add_edge(conn, src=a, dst=a, kind="requires")

    def test_fk_violation_on_stale_id(self, conn):
        a = sched.add_node(conn, type="task", label="a")
        with pytest.raises(sqlite3.IntegrityError):
            sched.add_edge(conn, src=a, dst="00000000nope", kind="requires")

    def test_edges_cascade_when_node_deleted(self, conn):
        a = sched.add_node(conn, type="task", label="a")
        b = sched.add_node(conn, type="task", label="b")
        sched.add_edge(conn, src=a, dst=b, kind="requires")
        conn.execute("DELETE FROM nodes WHERE id = ?", (a,))
        remaining = conn.execute("SELECT COUNT(*) AS n FROM edges").fetchone()["n"]
        assert remaining == 0


class TestResolve:
    def test_done_transition(self, conn):
        t = sched.add_node(conn, type="task", label="laundry")
        assert sched.resolve(conn, id=t, resolution="done")
        row = conn.execute("SELECT resolution FROM nodes WHERE id=?", (t,)).fetchone()
        assert row["resolution"] == "done"

    def test_unknown_id_returns_false(self, conn):
        assert sched.resolve(conn, id="not-an-id", resolution="done") is False

    def test_bad_resolution_rejected(self, conn):
        t = sched.add_node(conn, type="task", label="x")
        with pytest.raises(ValueError, match="unknown resolution"):
            sched.resolve(conn, id=t, resolution="kinda done")


# ── Update / delete (M9b) ─────────────────────────────────────────────


class TestUpdateNode:
    def test_update_label(self, conn):
        t = sched.add_node(conn, type="task", label="old")
        assert sched.update_node(conn, id=t, label="new")
        row = conn.execute("SELECT label FROM nodes WHERE id=?", (t,)).fetchone()
        assert row["label"] == "new"

    def test_update_when_and_end(self, conn):
        t = sched.add_node(conn, type="task", label="x")
        assert sched.update_node(conn, id=t, when="2030-01-01T12:00:00+00:00", end="2030-01-01T13:00:00+00:00")
        row = conn.execute("SELECT when_ts, end_ts FROM nodes WHERE id=?", (t,)).fetchone()
        assert row["when_ts"] == "2030-01-01T12:00:00+00:00"
        assert row["end_ts"]  == "2030-01-01T13:00:00+00:00"

    def test_update_clears_when_with_empty_string(self, conn):
        t = sched.add_node(conn, type="event", label="x", when="2030-01-01T12:00:00+00:00")
        assert sched.update_node(conn, id=t, when="")
        row = conn.execute("SELECT when_ts FROM nodes WHERE id=?", (t,)).fetchone()
        assert row["when_ts"] is None

    def test_update_replaces_payload(self, conn):
        t = sched.add_node(conn, type="task", label="x", payload={"a": 1, "b": 2})
        assert sched.update_node(conn, id=t, payload={"c": 3})
        import json as _json
        row = conn.execute("SELECT payload_json FROM nodes WHERE id=?", (t,)).fetchone()
        assert _json.loads(row["payload_json"]) == {"c": 3}

    def test_update_unknown_id_returns_false(self, conn):
        assert sched.update_node(conn, id="nope", label="x") is False

    def test_update_no_fields_returns_false(self, conn):
        t = sched.add_node(conn, type="task", label="x")
        assert sched.update_node(conn, id=t) is False

    def test_update_empty_label_rejected(self, conn):
        t = sched.add_node(conn, type="task", label="x")
        with pytest.raises(ValueError, match="label cannot be cleared"):
            sched.update_node(conn, id=t, label="   ")

    def test_update_does_not_touch_interest_layer_nodes(self, conn):
        # Manually insert an interest-layer node and confirm update_node ignores it.
        conn.execute(
            "INSERT INTO nodes (id, layer, type, label, payload_json, created_at, updated_at) "
            "VALUES ('iv', 'interest', 'live_interest', 'curiosity', '{}', ?, ?)",
            (now_iso(), now_iso()),
        )
        assert sched.update_node(conn, id="iv", label="hijacked") is False
        row = conn.execute("SELECT label FROM nodes WHERE id='iv'").fetchone()
        assert row["label"] == "curiosity"


class TestDeleteNode:
    def test_delete_existing(self, conn):
        t = sched.add_node(conn, type="task", label="kill me")
        assert sched.delete_node(conn, id=t)
        row = conn.execute("SELECT id FROM nodes WHERE id=?", (t,)).fetchone()
        assert row is None

    def test_delete_cascades_edges(self, conn):
        a = sched.add_node(conn, type="task", label="a")
        b = sched.add_node(conn, type="task", label="b")
        sched.add_edge(conn, src=a, dst=b, kind="causes")
        assert sched.delete_node(conn, id=a)
        # Edge should also be gone (ON DELETE CASCADE).
        rows = conn.execute("SELECT COUNT(*) AS n FROM edges").fetchone()
        assert rows["n"] == 0

    def test_delete_unknown_id_returns_false(self, conn):
        assert sched.delete_node(conn, id="nope") is False

    def test_delete_does_not_touch_interest_layer(self, conn):
        conn.execute(
            "INSERT INTO nodes (id, layer, type, label, payload_json, created_at, updated_at) "
            "VALUES ('iv2', 'interest', 'live_interest', 'curiosity', '{}', ?, ?)",
            (now_iso(), now_iso()),
        )
        assert sched.delete_node(conn, id="iv2") is False
        row = conn.execute("SELECT id FROM nodes WHERE id='iv2'").fetchone()
        assert row is not None


# ── Reads ─────────────────────────────────────────────────────────────


class TestGetWindow:
    def test_empty_db_returns_empty_lists(self, conn):
        result = sched.get_window(conn)
        assert result["nodes"] == []
        assert result["edges"] == []
        assert "from" in result and "to" in result

    def test_node_inside_window_is_returned(self, conn):
        now = datetime.now(timezone.utc)
        nid = sched.add_node(conn, type="event", label="in-window",
                             when=_iso(now + timedelta(hours=1)))
        result = sched.get_window(conn)
        assert any(n["id"] == nid for n in result["nodes"])

    def test_node_far_outside_window_is_excluded(self, conn):
        now = datetime.now(timezone.utc)
        sched.add_node(conn, type="event", label="far past",
                       when=_iso(now - timedelta(days=10)))
        result = sched.get_window(conn)
        assert result["nodes"] == []

    def test_open_task_with_no_when_is_included_by_default(self, conn):
        nid = sched.add_node(conn, type="task", label="open task")
        result = sched.get_window(conn)
        assert any(n["id"] == nid for n in result["nodes"])

    def test_open_task_can_be_excluded(self, conn):
        sched.add_node(conn, type="task", label="open task")
        result = sched.get_window(conn, include_open_tasks=False)
        assert result["nodes"] == []

    def test_resolved_task_with_no_when_is_excluded(self, conn):
        t = sched.add_node(conn, type="task", label="done task")
        sched.resolve(conn, id=t, resolution="done")
        result = sched.get_window(conn)
        # Resolved + no when → falls out of both window and open-task branches.
        assert not any(n["id"] == t for n in result["nodes"])

    def test_edges_touching_returned_nodes_are_included(self, conn):
        now = datetime.now(timezone.utc)
        a = sched.add_node(conn, type="task", label="prep",
                           when=_iso(now + timedelta(hours=1)))
        b = sched.add_node(conn, type="event", label="interview",
                           when=_iso(now + timedelta(hours=2)))
        eid = sched.add_edge(conn, src=a, dst=b, kind="requires")
        result = sched.get_window(conn)
        assert any(e["id"] == eid for e in result["edges"])

    def test_limit_respected(self, conn):
        now = datetime.now(timezone.utc)
        for i in range(10):
            sched.add_node(conn, type="event", label=f"e{i}",
                           when=_iso(now + timedelta(minutes=i)))
        result = sched.get_window(conn, limit=3)
        assert len(result["nodes"]) == 3

    def test_explicit_window(self, conn):
        a_when = "2026-05-18T10:00:00+00:00"
        sched.add_node(conn, type="event", label="in", when=a_when)
        sched.add_node(conn, type="event", label="out", when="2026-06-01T10:00:00+00:00")
        result = sched.get_window(
            conn, from_ts="2026-05-18T00:00:00+00:00",
                  to_ts="2026-05-19T00:00:00+00:00",
        )
        labels = {n["label"] for n in result["nodes"]}
        assert labels == {"in"}


class TestCurrentPhase:
    def test_none_when_no_phase(self, conn):
        assert sched.current_phase(conn) is None

    def test_returns_containing_phase(self, conn):
        # Phase from 1h ago to 1h from now → should contain 'now'.
        now = datetime.now(timezone.utc)
        sched.add_node(conn, type="phase", label="now-phase",
                       when=_iso(now - timedelta(hours=1)),
                       end=_iso(now + timedelta(hours=1)))
        result = sched.current_phase(conn)
        assert result is not None
        assert result["label"] == "now-phase"

    def test_boundary_belongs_to_starting_phase(self, conn):
        # Two back-to-back phases. At the boundary instant, the LATER
        # one (whose when_ts equals 'at') wins. The earlier one's
        # end_ts equals 'at', and the SQL uses `at < end_ts`, so it
        # falls out — the later one's `when_ts <= at` matches.
        boundary = "2026-05-18T12:00:00+00:00"
        sched.add_node(conn, type="phase", label="morning",
                       when="2026-05-18T09:00:00+00:00", end=boundary)
        sched.add_node(conn, type="phase", label="afternoon",
                       when=boundary, end="2026-05-18T17:00:00+00:00")
        result = sched.current_phase(conn, at=boundary)
        assert result is not None
        assert result["label"] == "afternoon"


# ── Node payload round-trip ───────────────────────────────────────────


class TestPayload:
    def test_payload_round_trips(self, conn):
        nid = sched.add_node(conn, type="task", label="x",
                             payload={"source": "user", "tags": ["urgent"]})
        result = sched.get_window(conn)
        node = next(n for n in result["nodes"] if n["id"] == nid)
        assert node["payload"] == {"source": "user", "tags": ["urgent"]}

    def test_empty_payload_is_dropped_from_wire(self, conn):
        nid = sched.add_node(conn, type="task", label="x")
        result = sched.get_window(conn)
        node = next(n for n in result["nodes"] if n["id"] == nid)
        assert "payload" not in node
