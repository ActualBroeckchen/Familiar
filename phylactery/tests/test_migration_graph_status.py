"""Tests for migrate_graph's status classification.

The status field governs whether the auto-migration prestart hook retries:
  'absent' — no graph.db in the source (nothing to import; terminal)
  'empty'  — graph.db present but holds no rows (terminal)
  'failed' — graph.db holds rows but none could be imported (retry-worthy)
  'ok'     — nodes/edges imported or already present (terminal)

A bare boolean marker can't tell 'ok' from 'failed'/'absent', which is what
wedged a partial migration's graph empty forever. These tests pin the
distinction.
"""

import sqlite3
from pathlib import Path

from phylactery.migrate_from_entity_core import migrate_graph
from phylactery.db import get_conn


def _make_graph_db(path: Path, *, nodes=(), edges=()) -> None:
    g = sqlite3.connect(str(path))
    g.execute("CREATE TABLE nodes (id TEXT PRIMARY KEY, label TEXT, type TEXT, description TEXT)")
    g.execute("CREATE TABLE edges (id TEXT PRIMARY KEY, fromId TEXT, toId TEXT, type TEXT, weight REAL)")
    g.executemany("INSERT INTO nodes VALUES (?,?,?,?)", nodes)
    g.executemany("INSERT INTO edges VALUES (?,?,?,?,?)", edges)
    g.commit()
    g.close()


def _make_unrecognised_db(path: Path) -> None:
    """A graph.db with rows but no nodes/edges tables the migrator knows."""
    g = sqlite3.connect(str(path))
    g.execute("CREATE TABLE mystery (id TEXT PRIMARY KEY, blob TEXT)")
    g.executemany("INSERT INTO mystery VALUES (?,?)", [("1", "a"), ("2", "b")])
    g.commit()
    g.close()


def test_absent_when_no_graph_db(tmp_path):
    conn = get_conn(tmp_path / "phylactery.db")
    result = migrate_graph(conn, tmp_path, dry_run=True)
    assert result["status"] == "absent"
    assert result["db_found"] is False


def test_empty_when_graph_db_has_no_rows(tmp_path):
    _make_graph_db(tmp_path / "graph.db")  # tables exist, zero rows
    conn = get_conn(tmp_path / "phylactery.db")
    result = migrate_graph(conn, tmp_path, dry_run=True)
    assert result["status"] == "empty"
    assert result["db_found"] is True
    assert result["source_rows"] == 0


def test_failed_when_rows_present_but_schema_unrecognised(tmp_path):
    _make_unrecognised_db(tmp_path / "graph.db")
    conn = get_conn(tmp_path / "phylactery.db")
    result = migrate_graph(conn, tmp_path, dry_run=True)
    assert result["status"] == "failed"
    assert result["db_found"] is True


def test_ok_when_nodes_imported(tmp_path):
    _make_graph_db(
        tmp_path / "graph.db",
        nodes=[("n1", "Melian", "person", "my human")],
        edges=[("e1", "n1", "n1", "self", 1.0)],
    )
    conn = get_conn(tmp_path / "phylactery.db")
    result = migrate_graph(conn, tmp_path, dry_run=True)
    assert result["status"] == "ok"
    assert result["source_rows"] == 2
    assert result["nodes_imported"] == 1
    assert result["edges_imported"] == 1
