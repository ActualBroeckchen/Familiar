"""Knowledge graph — nodes + edges + GraphRAG 1-hop recall.

graph_node_search: semantic KNN over node embeddings, with optional
1-hop edge traversal (GraphRAG). Returns entity-core's exact response
shape so thalamus.js's graph assembly loop needs no changes.

graph_full: full node+edge dump for the Knowledge editor Map view.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from phylactery.db import get_conn, new_id, now_iso
from phylactery.snapshot import auto_snapshot
from phylactery.audience import audience_filter_sql


def _node_row_to_dict(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "label": row["label"],
        "type": row["type"] or "",
        "description": row["description"] or "",
    }


def _edge_row_to_dict(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "fromId": row["from_id"],
        "toId": row["to_id"],
        "type": row["type"],
        "customType": row["type"],   # entity-core compat: some paths read customType
        "weight": row["weight"],
    }


# ── Search (GraphRAG) ─────────────────────────────────────────────────────────

def search_nodes(
    query: str,
    limit: int = 10,
    min_score: float = 0.3,
    audience: str = "ward-private",
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        aud_clause, aud_params = audience_filter_sql(audience, col="n.audience")
        try:
            from phylactery.embed import embed_text
            q_vec = embed_text(query)
            rows = conn.execute(f"""
                SELECT n.id, n.label, n.type, n.description, n.audience, v.distance
                FROM graph_node_vecs v
                JOIN graph_nodes n ON n.id = v.node_id
                WHERE v.embedding MATCH ? AND k = ?
                  AND {aud_clause}
                ORDER BY v.distance
            """, [q_vec, limit * 2] + aud_params).fetchall()
            results = []
            for r in rows[:limit]:
                dist = r["distance"] if "distance" in r.keys() else 0.0
                score = max(0.0, 1.0 - dist / 2.0)
                if score < min_score:
                    continue
                results.append({
                    "node": _node_row_to_dict(r),
                    "score": round(score, 4),
                })
        except Exception:
            # Degrade to label-fuzzy search when embeddings unavailable.
            rows = conn.execute(f"""
                SELECT n.id, n.label, n.type, n.description FROM graph_nodes n
                WHERE n.label LIKE ? AND {aud_clause}
                LIMIT ?
            """, [f"%{query}%"] + aud_params + [limit]).fetchall()
            results = [{"node": _node_row_to_dict(r), "score": 0.5} for r in rows]

        return {"results": results}
    finally:
        if own_conn:
            conn.close()


def get_subgraph(
    node_id: str,
    depth: int = 1,
    audience: str = "ward-private",
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        visited_nodes: dict[str, dict] = {}
        visited_edges: dict[str, dict] = {}
        frontier = {node_id}

        for _ in range(max(1, min(depth, 3))):
            if not frontier:
                break
            next_frontier: set[str] = set()
            placeholders = ",".join("?" * len(frontier))
            node_rows = conn.execute(
                f"SELECT id, label, type, description FROM graph_nodes WHERE id IN ({placeholders})",
                list(frontier),
            ).fetchall()
            for r in node_rows:
                visited_nodes[r["id"]] = _node_row_to_dict(r)

            edge_rows = conn.execute(f"""
                SELECT id, from_id, to_id, type, weight FROM graph_edges
                WHERE from_id IN ({placeholders}) OR to_id IN ({placeholders})
            """, list(frontier) + list(frontier)).fetchall()
            for r in edge_rows:
                visited_edges[r["id"]] = _edge_row_to_dict(r)
                next_frontier.add(r["from_id"])
                next_frontier.add(r["to_id"])

            frontier = next_frontier - set(visited_nodes.keys())

        # Backfill labels for every edge endpoint. The BFS above only fetches
        # node rows for each frontier it *expands*, so at the final depth the
        # newly-discovered neighbours appear in `edges` but their node rows
        # (labels/types/descriptions) were never loaded — callers then have to
        # fall back to raw ids. Fetch the stragglers so every edge endpoint
        # comes back with its label.
        endpoint_ids = set()
        for e in visited_edges.values():
            endpoint_ids.add(e["fromId"])
            endpoint_ids.add(e["toId"])
        missing = [nid for nid in endpoint_ids if nid not in visited_nodes]
        if missing:
            ph = ",".join("?" * len(missing))
            rows = conn.execute(
                f"SELECT id, label, type, description FROM graph_nodes WHERE id IN ({ph})",
                missing,
            ).fetchall()
            for r in rows:
                visited_nodes[r["id"]] = _node_row_to_dict(r)

        return {
            "nodes": list(visited_nodes.values()),
            "edges": list(visited_edges.values()),
        }
    finally:
        if own_conn:
            conn.close()


# ── Node CRUD ─────────────────────────────────────────────────────────────────

def create_node(
    label: str,
    node_type: str | None = None,
    description: str | None = None,
    audience: str = "ward-private",
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        now = now_iso()
        node_id = new_id()
        with conn:
            conn.execute(
                "INSERT INTO graph_nodes(id,label,type,description,audience,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                (node_id, label, node_type or "", description or "", audience, now, now),
            )
        _upsert_node_embedding(conn, node_id, label, description or "")
        return {"ok": True, "id": node_id, "label": label, "type": node_type or "", "description": description or ""}
    finally:
        if own_conn:
            conn.close()


def list_nodes(
    node_type: str | None = None,
    limit: int = 500,
    offset: int = 0,
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        if node_type:
            rows = conn.execute(
                "SELECT id,label,type,description FROM graph_nodes WHERE type=? LIMIT ? OFFSET ?",
                (node_type, limit, offset),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id,label,type,description FROM graph_nodes LIMIT ? OFFSET ?",
                (limit, offset),
            ).fetchall()
        return {"nodes": [_node_row_to_dict(r) for r in rows]}
    finally:
        if own_conn:
            conn.close()


def find_nodes(
    query: str,
    node_type: str | None = None,
    limit: int = 10,
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        if node_type:
            rows = conn.execute(
                "SELECT id,label,type,description FROM graph_nodes WHERE label LIKE ? AND type=? LIMIT ?",
                (f"%{query}%", node_type, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id,label,type,description FROM graph_nodes WHERE label LIKE ? LIMIT ?",
                (f"%{query}%", limit),
            ).fetchall()
        return {"nodes": [_node_row_to_dict(r) for r in rows]}
    finally:
        if own_conn:
            conn.close()


def update_node(
    node_id: str,
    label: str | None = None,
    description: str | None = None,
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        auto_snapshot(conn)
        now = now_iso()
        row = conn.execute("SELECT id,label,description FROM graph_nodes WHERE id=?", (node_id,)).fetchone()
        if not row:
            return {"ok": False, "error": f"node {node_id!r} not found"}
        new_label = label if label is not None else row["label"]
        new_desc = description if description is not None else (row["description"] or "")
        with conn:
            conn.execute(
                "UPDATE graph_nodes SET label=?, description=?, updated_at=? WHERE id=?",
                (new_label, new_desc, now, node_id),
            )
        _upsert_node_embedding(conn, node_id, new_label, new_desc)
        return {"ok": True}
    finally:
        if own_conn:
            conn.close()


def delete_node(
    node_id: str,
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        auto_snapshot(conn)
        row = conn.execute("SELECT id FROM graph_nodes WHERE id=?", (node_id,)).fetchone()
        if not row:
            return {"ok": False, "error": f"node {node_id!r} not found"}
        with conn:
            conn.execute("DELETE FROM graph_nodes WHERE id=?", (node_id,))
            _delete_node_embedding(conn, node_id)
        return {"ok": True, "deleted": node_id}
    finally:
        if own_conn:
            conn.close()


# ── Edge CRUD ─────────────────────────────────────────────────────────────────

def create_edge(
    from_id: str,
    to_id: str,
    edge_type: str,
    weight: float = 1.0,
    audience: str = "ward-private",
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        now = now_iso()
        edge_id = new_id()
        with conn:
            conn.execute(
                "INSERT INTO graph_edges(id,from_id,to_id,type,weight,audience,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                (edge_id, from_id, to_id, edge_type, weight, audience, now, now),
            )
        return {"ok": True, "id": edge_id, "fromId": from_id, "toId": to_id, "type": edge_type, "weight": weight}
    finally:
        if own_conn:
            conn.close()


# ── Resolve-or-create (the dedup discipline) ──────────────────────────────────

def _resolve_node(conn: sqlite3.Connection, label: str, node_type: str | None) -> str | None:
    """Exact, case-insensitive label match (optionally constrained by type) —
    the fast path before any embedding. Returns a node id or None."""
    label = (label or "").strip()
    if not label:
        return None
    if node_type:
        row = conn.execute(
            "SELECT id FROM graph_nodes WHERE lower(label)=lower(?) AND (type=? OR type='') ORDER BY (type=?) DESC LIMIT 1",
            (label, node_type, node_type),
        ).fetchone()
    else:
        row = conn.execute(
            "SELECT id FROM graph_nodes WHERE lower(label)=lower(?) LIMIT 1", (label,),
        ).fetchone()
    return row["id"] if row else None


def resolve_or_create_node(conn, label, node_type=None, description=None, audience="ward-private"):
    """Reuse an existing node with the same label, else create one. On reuse the
    node's updated_at is bumped (a lightweight 'confirmed again' signal).
    Returns (node_id, created: bool)."""
    nid = _resolve_node(conn, label, node_type)
    if nid:
        with conn:
            conn.execute("UPDATE graph_nodes SET updated_at=? WHERE id=?", (now_iso(), nid))
        return nid, False
    res = create_node(label, node_type=node_type, description=description, audience=audience, conn=conn)
    return res["id"], True


def relate(from_label, from_type, to_label, to_type, edge_type,
           weight: float = 1.0, audience: str = "ward-private",
           conn: sqlite3.Connection | None = None) -> dict[str, Any]:
    """Resolve-or-create both endpoints by label, then create the edge UNLESS an
    identical (from→to, same type) edge already exists. This is the single
    discipline that keeps the graph from filling with duplicate nodes + edges —
    the memorization loop calls it for every relation it extracts."""
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        flabel, tlabel, etype = (from_label or "").strip(), (to_label or "").strip(), (edge_type or "").strip()
        if not flabel or not tlabel or not etype:
            return {"ok": False, "error": "from_label, to_label, and edge_type are all required"}
        from_id, from_new = resolve_or_create_node(conn, flabel, from_type, audience=audience)
        to_id, to_new = resolve_or_create_node(conn, tlabel, to_type, audience=audience)
        existing = conn.execute(
            "SELECT id FROM graph_edges WHERE from_id=? AND to_id=? AND lower(type)=lower(?) LIMIT 1",
            (from_id, to_id, etype),
        ).fetchone()
        if existing:
            with conn:
                conn.execute("UPDATE graph_edges SET updated_at=? WHERE id=?", (now_iso(), existing["id"]))
            return {"ok": True, "edgeId": existing["id"], "fromId": from_id, "toId": to_id,
                    "type": etype, "edgeCreated": False, "nodesCreated": int(from_new) + int(to_new)}
        edge = create_edge(from_id, to_id, etype, weight=weight, audience=audience, conn=conn)
        return {"ok": True, "edgeId": edge["id"], "fromId": from_id, "toId": to_id,
                "type": etype, "edgeCreated": True, "nodesCreated": int(from_new) + int(to_new)}
    finally:
        if own_conn:
            conn.close()


def update_edge(
    edge_id: str,
    edge_type: str | None = None,
    weight: float | None = None,
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        auto_snapshot(conn)
        now = now_iso()
        row = conn.execute("SELECT id,type,weight FROM graph_edges WHERE id=?", (edge_id,)).fetchone()
        if not row:
            return {"ok": False, "error": f"edge {edge_id!r} not found"}
        new_type = edge_type if edge_type is not None else row["type"]
        new_weight = weight if weight is not None else row["weight"]
        with conn:
            conn.execute(
                "UPDATE graph_edges SET type=?, weight=?, updated_at=? WHERE id=?",
                (new_type, new_weight, now, edge_id),
            )
        return {"ok": True}
    finally:
        if own_conn:
            conn.close()


def delete_edge(
    edge_id: str,
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        auto_snapshot(conn)
        row = conn.execute("SELECT id FROM graph_edges WHERE id=?", (edge_id,)).fetchone()
        if not row:
            return {"ok": False, "error": f"edge {edge_id!r} not found"}
        with conn:
            conn.execute("DELETE FROM graph_edges WHERE id=?", (edge_id,))
        return {"ok": True, "deleted": edge_id}
    finally:
        if own_conn:
            conn.close()


def get_full_graph(
    node_type: str | None = None,
    limit: int = 500,
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    """Full node+edge dump for the Knowledge editor Map view."""
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        node_data = list_nodes(node_type=node_type, limit=limit, conn=conn)
        nodes = node_data["nodes"]
        node_ids = {n["id"] for n in nodes}

        if node_ids:
            placeholders = ",".join("?" * len(node_ids))
            edge_rows = conn.execute(f"""
                SELECT id, from_id, to_id, type, weight FROM graph_edges
                WHERE from_id IN ({placeholders}) AND to_id IN ({placeholders})
            """, list(node_ids) + list(node_ids)).fetchall()
            edges = [_edge_row_to_dict(r) for r in edge_rows]
        else:
            edges = []

        return {"nodes": nodes, "edges": edges}
    finally:
        if own_conn:
            conn.close()


# ── Embedding helpers ─────────────────────────────────────────────────────────

def _upsert_node_embedding(conn: sqlite3.Connection, node_id: str, label: str, description: str) -> None:
    try:
        from phylactery.embed import embed_text
        text = f"{label} {description}".strip()
        vec = embed_text(text)
        # vec0 virtual tables don't honor "INSERT OR REPLACE" — re-embedding an
        # existing node_id raises a UNIQUE-constraint error rather than
        # replacing. Delete-then-insert is the safe pattern (mirrors memory.py).
        conn.execute("DELETE FROM graph_node_vecs WHERE node_id=?", (node_id,))
        conn.execute(
            "INSERT INTO graph_node_vecs(node_id, embedding) VALUES (?, ?)",
            (node_id, vec),
        )
        conn.commit()
    except Exception as e:
        import sys
        print(f"[phylactery] node embedding failed for {node_id}: {e}", file=sys.stderr)


def _delete_node_embedding(conn: sqlite3.Connection, node_id: str) -> None:
    try:
        conn.execute("DELETE FROM graph_node_vecs WHERE node_id=?", (node_id,))
    except Exception:
        pass
