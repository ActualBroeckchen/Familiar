"""relate() is the resolve-or-create + edge-dedup discipline the memorization
loop drives so the graph populates itself without piling up duplicate nodes and
edges. The Familiar "almost never saves to the graph" was the bug; auto-routing
extracted relations is the fix, and these pin the dedup that keeps it clean.

Embeddings degrade to a no-op (no vec table, no model) — create_node swallows
the embedding failure — so the fixture only needs the two relational tables.
"""

import sqlite3

from phylactery.graph import relate, resolve_or_create_node


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.execute(
        "CREATE TABLE graph_nodes (id TEXT PRIMARY KEY, label TEXT, type TEXT, "
        "description TEXT, audience TEXT, created_at TEXT, updated_at TEXT)"
    )
    c.execute(
        "CREATE TABLE graph_edges (id TEXT PRIMARY KEY, from_id TEXT, to_id TEXT, "
        "type TEXT, weight REAL, audience TEXT, created_at TEXT, updated_at TEXT)"
    )
    return c


def _node_count(c):
    return c.execute("SELECT COUNT(*) FROM graph_nodes").fetchone()[0]


def _edge_count(c):
    return c.execute("SELECT COUNT(*) FROM graph_edges").fetchone()[0]


def test_relate_creates_both_nodes_and_the_edge():
    c = _conn()
    r = relate("Alice", "person", "Acme", "organisation", "works_at", conn=c)
    assert r["ok"] and r["edgeCreated"] is True
    assert r["nodesCreated"] == 2
    assert _node_count(c) == 2
    assert _edge_count(c) == 1


def test_resolve_or_create_reuses_existing_label_case_insensitively():
    c = _conn()
    nid, created = resolve_or_create_node(c, "Alice", "person")
    assert created is True
    again, created2 = resolve_or_create_node(c, "alice", "person")
    assert created2 is False and again == nid
    assert _node_count(c) == 1


def test_repeated_relation_dedups_nodes_and_edge():
    c = _conn()
    relate("Alice", "person", "Acme", "organisation", "works_at", conn=c)
    # Same edge again, different casing — must reuse both nodes AND the edge.
    r = relate("alice", "person", "ACME", "organisation", "Works_At", conn=c)
    assert r["ok"] and r["edgeCreated"] is False
    assert r["nodesCreated"] == 0
    assert _node_count(c) == 2
    assert _edge_count(c) == 1


def test_shared_node_is_reused_across_distinct_edges():
    c = _conn()
    relate("Alice", "person", "Acme", "organisation", "works_at", conn=c)
    relate("Alice", "person", "Portland", "place", "lives_in", conn=c)
    # Alice node reused; only Portland is new → 3 nodes, 2 distinct edges.
    assert _node_count(c) == 3
    assert _edge_count(c) == 2


def test_missing_endpoint_or_type_is_rejected_without_writing():
    c = _conn()
    assert relate("", "person", "Acme", "organisation", "works_at", conn=c)["ok"] is False
    assert relate("Alice", "person", "Acme", "organisation", "", conn=c)["ok"] is False
    assert _node_count(c) == 0 and _edge_count(c) == 0
