"""Phylactery MCP server.

Tools exposed (stable contract — Thalamus depends on these shapes):

  Liveness:
    health_check            — boot diagnostic

  Identity (always-injected, not vector-retrieved):
    identity_get_all        — return all identity files in canonical order
    identity_append         — append content to an identity file
    identity_update_section — rewrite one section of an identity file (alias)
    identity_rewrite_section — rewrite one section of an identity file

  Memory (RAG-tiered):
    memory_create           — store a new memory (appends on same-date tiers)
    memory_list             — browse memories at a tier, most-recent first
    memory_read             — full content of one memory by granularity+date
    memory_search           — semantic RAG search (falls back to recency)
    memory_update           — overwrite an existing memory (auto-snapshots)
    memory_delete           — delete a memory (auto-snapshots)

  Knowledge graph (GraphRAG):
    graph_node_search       — semantic search + 1-hop GraphRAG
    graph_subgraph          — N-hop subgraph from a node
    graph_node_create       — add a new entity node
    graph_node_list         — list nodes (type-filtered, paginated)
    graph_node_update       — rename/re-describe a node (auto-snapshots)
    graph_node_delete       — delete a node + its edges (auto-snapshots)
    graph_edge_create       — record a relationship between two nodes
    graph_edge_update       — update a relationship type/weight (auto-snapshots)
    graph_edge_delete       — remove a relationship (auto-snapshots)
    graph_full              — full node+edge dump (for Map view)

  Snapshots:
    snapshot_create         — create a manual snapshot
    snapshot_list           — list available snapshots
    snapshot_restore        — restore from a snapshot

  Consolidation (A3):
    consolidate             — roll lower tiers into higher via LLM

Original design by Zari Lewis (Psycheros). See docs/phylactery-build-spec.md.
"""

from __future__ import annotations

from typing import Any, Optional

from mcp.server.fastmcp import FastMCP

from phylactery import __version__
from phylactery.db import get_conn, now_iso
import phylactery.identity as ident
import phylactery.memory as mem
import phylactery.graph as graph
import phylactery.snapshot as snap
import phylactery.consolidate as consol

mcp = FastMCP("phylactery")

_conn = None


def _get_shared_conn():
    global _conn
    if _conn is None:
        _conn = get_conn()
    return _conn


def _c():
    return _get_shared_conn()


# ── Liveness ──────────────────────────────────────────────────────────────────


@mcp.tool()
def health_check() -> dict[str, Any]:
    """Return liveness info. No side effects."""
    return {"ok": True, "service": "phylactery", "version": __version__, "ts": now_iso()}


# ── Identity ──────────────────────────────────────────────────────────────────


@mcp.tool()
def identity_get_all() -> dict[str, Any]:
    """Return all identity files in canonical order.
    Response shape: { self: [{filename, content, promptLabel}], user: [...], ... }
    """
    return ident.get_all(conn=_c())


@mcp.tool()
def identity_append(
    category: str,
    filename: str,
    content: str,
    instanceId: Optional[str] = None,
) -> str:
    """Append content to an identity file (creates the file if missing)."""
    result = ident.append_file(category, filename, content, conn=_c())
    if not result["ok"]:
        return f"Failed: {result['error']}"
    return f"Identity file {category}/{filename} updated."


@mcp.tool()
def identity_update_section(
    category: str,
    filename: str,
    section: str,
    content: str,
    instanceId: Optional[str] = None,
) -> str:
    """Rewrite one markdown section of an identity file. Alias for identity_rewrite_section."""
    result = ident.rewrite_section(category, filename, section, content, conn=_c())
    if not result["ok"]:
        return f"Failed: {result['error']}"
    return f"Section '{section}' of {category}/{filename} rewritten."


@mcp.tool()
def identity_rewrite_section(
    category: str,
    filename: str,
    section: str,
    content: str,
    instanceId: Optional[str] = None,
) -> str:
    """Rewrite one markdown section of an identity file (auto-snapshots first)."""
    result = ident.rewrite_section(category, filename, section, content, conn=_c())
    if not result["ok"]:
        return f"Failed: {result['error']}"
    return f"Section '{section}' of {category}/{filename} rewritten."


# ── Memory ────────────────────────────────────────────────────────────────────


@mcp.tool()
def memory_create(
    content: str,
    granularity: str,
    date: Optional[str] = None,
    slug: Optional[str] = None,
    instanceId: Optional[str] = None,
) -> str:
    """Store a new memory at the given granularity tier.
    For non-significant tiers, appends to the same-date file.
    For significant, slug is derived from content if omitted.
    """
    result = mem.create(content, granularity, date_key=date, slug=slug, conn=_c())
    if not result.get("ok"):
        return f"Memory save failed: {result.get('error', 'unknown')}"
    dk = result.get("dateKey", "")
    if granularity == "significant":
        return f"Memory saved (significant/{dk})."
    return "Memory saved."


@mcp.tool()
def memory_list(
    granularity: Optional[str] = None,
    limit: Optional[int] = None,
    offset: Optional[int] = None,
) -> dict[str, Any]:
    """List memories most-recent first. Returns thin projections with keys."""
    n = max(1, min(200, int(limit or 50)))
    off = max(0, int(offset or 0))
    items = mem.list_memories(granularity=granularity, limit=n, offset=off, conn=_c())
    return {"memories": items}


@mcp.tool()
def memory_read(
    granularity: str,
    date: str,
    slug: Optional[str] = None,
) -> dict[str, Any]:
    """Return full content of one memory by granularity + date (or YYYY-MM-DD_slug)."""
    result = mem.read_memory(granularity, date, slug=slug, conn=_c())
    if not result.get("ok"):
        return result
    return {"content": result["content"]}


@mcp.tool()
def memory_search(
    query: str,
    maxResults: Optional[int] = None,
    instanceId: Optional[str] = None,
    audience: Optional[str] = None,
) -> dict[str, Any]:
    """Semantic RAG search over memories. Returns thin projections with ids and scores."""
    k = max(1, min(20, int(maxResults or 5)))
    aud = audience or "ward-private"
    return mem.search(query, max_results=k, audience=aud, conn=_c())


@mcp.tool()
def memory_update(
    granularity: str,
    date: str,
    content: str,
    editedBy: Optional[str] = None,
    slug: Optional[str] = None,
) -> str:
    """Overwrite an existing memory entry (auto-snapshots first)."""
    result = mem.update_memory(granularity, date, content, slug=slug, conn=_c())
    if not result.get("ok"):
        return f"Update failed: {result.get('error', 'unknown')}"
    return "Memory updated. (Snapshot created before change.)"


@mcp.tool()
def memory_delete(
    granularity: str,
    date: str,
    slug: Optional[str] = None,
    instanceId: Optional[str] = None,
) -> str:
    """Delete a memory entry permanently (auto-snapshots first)."""
    result = mem.delete_memory(granularity, date, slug=slug, conn=_c())
    if not result.get("ok"):
        return f"Delete failed: {result.get('error', 'unknown')}"
    return f"Memory deleted: {result.get('deleted')}. (Snapshot created before deletion.)"


# ── Knowledge graph ───────────────────────────────────────────────────────────


@mcp.tool()
def graph_node_search(
    query: str,
    limit: Optional[int] = None,
    minScore: Optional[float] = None,
    audience: Optional[str] = None,
) -> dict[str, Any]:
    """Semantic search over graph nodes with optional GraphRAG 1-hop expansion.
    Returns { results: [{ node: {id, label, type, description}, score }] }
    """
    k = max(1, min(50, int(limit or 10)))
    ms = float(minScore or 0.3)
    aud = audience or "ward-private"
    return graph.search_nodes(query, limit=k, min_score=ms, audience=aud, conn=_c())


@mcp.tool()
def graph_subgraph(
    nodeId: str,
    depth: Optional[int] = None,
    audience: Optional[str] = None,
) -> dict[str, Any]:
    """Return N-hop subgraph from a node: { nodes: [...], edges: [...] }"""
    d = max(1, min(3, int(depth or 1)))
    aud = audience or "ward-private"
    return graph.get_subgraph(nodeId, depth=d, audience=aud, conn=_c())


@mcp.tool()
def graph_node_create(
    label: str,
    type: Optional[str] = None,
    description: Optional[str] = None,
    instanceId: Optional[str] = None,
) -> dict[str, Any]:
    """Add a new entity node to the knowledge graph. Returns the new node's id."""
    return graph.create_node(label, node_type=type, description=description, conn=_c())


@mcp.tool()
def graph_node_list(
    type: Optional[str] = None,
    limit: Optional[int] = None,
    offset: Optional[int] = None,
) -> dict[str, Any]:
    """List nodes, optionally filtered by type. Paginated."""
    n = max(1, min(1000, int(limit or 500)))
    off = max(0, int(offset or 0))
    return graph.list_nodes(node_type=type, limit=n, offset=off, conn=_c())


@mcp.tool()
def graph_node_update(
    id: str,
    label: Optional[str] = None,
    description: Optional[str] = None,
    instanceId: Optional[str] = None,
) -> str:
    """Rename or re-describe a graph node (auto-snapshots first)."""
    result = graph.update_node(id, label=label, description=description, conn=_c())
    if not result.get("ok"):
        return f"Update failed: {result.get('error', 'unknown')}"
    return "Node updated. (Snapshot created before change.)"


@mcp.tool()
def graph_node_delete(
    id: str,
    instanceId: Optional[str] = None,
) -> str:
    """Delete a graph node and all its edges (auto-snapshots first)."""
    result = graph.delete_node(id, conn=_c())
    if not result.get("ok"):
        return f"Delete failed: {result.get('error', 'unknown')}"
    return f"Node deleted: {result.get('deleted')}. (Snapshot created before deletion.)"


@mcp.tool()
def graph_edge_create(
    fromId: str,
    toId: str,
    type: str,
    weight: Optional[float] = None,
    instanceId: Optional[str] = None,
) -> dict[str, Any]:
    """Record a relationship between two existing graph nodes."""
    w = float(weight) if weight is not None else 1.0
    return graph.create_edge(fromId, toId, type, weight=w, conn=_c())


@mcp.tool()
def graph_edge_update(
    id: str,
    type: Optional[str] = None,
    weight: Optional[float] = None,
    instanceId: Optional[str] = None,
) -> str:
    """Update a relationship's type or weight (auto-snapshots first)."""
    result = graph.update_edge(id, edge_type=type, weight=weight, conn=_c())
    if not result.get("ok"):
        return f"Update failed: {result.get('error', 'unknown')}"
    return "Edge updated. (Snapshot created before change.)"


@mcp.tool()
def graph_edge_delete(
    id: str,
    instanceId: Optional[str] = None,
) -> str:
    """Remove a relationship while keeping both endpoint nodes (auto-snapshots first)."""
    result = graph.delete_edge(id, conn=_c())
    if not result.get("ok"):
        return f"Delete failed: {result.get('error', 'unknown')}"
    return f"Edge deleted: {result.get('deleted')}. (Snapshot created before deletion.)"


@mcp.tool()
def graph_full(
    type: Optional[str] = None,
    limit: Optional[int] = None,
) -> dict[str, Any]:
    """Full node+edge dump for the Knowledge editor Map view."""
    n = max(1, min(2000, int(limit or 500)))
    return graph.get_full_graph(node_type=type, limit=n, conn=_c())


# ── Snapshots ─────────────────────────────────────────────────────────────────


@mcp.tool()
def snapshot_create() -> dict[str, Any]:
    """Create a manual snapshot of the Phylactery database."""
    return snap.create_snapshot(conn=_c())


@mcp.tool()
def snapshot_list() -> dict[str, Any]:
    """List all available snapshots, most recent first."""
    return {"snapshots": snap.list_snapshots(conn=_c())}


@mcp.tool()
def snapshot_restore(snapshotId: str) -> dict[str, Any]:
    """Restore the database from a snapshot. Requires server reconnect after."""
    return snap.restore_snapshot(snapshotId)


# ── Consolidation ─────────────────────────────────────────────────────────────


@mcp.tool()
def consolidate(granularity: Optional[str] = None) -> dict[str, Any]:
    """Roll lower memory tiers into higher via the designated LLM.
    granularity: 'weekly' | 'monthly' | 'yearly' | None (run all).
    Requires PHYLACTERY_LLM_API_KEY (or ENTITY_CORE_LLM_API_KEY) to be set.
    """
    return consol.run_consolidation(granularity=granularity, conn=_c())


# ── Entry point ───────────────────────────────────────────────────────────────


def main() -> None:
    mcp.run(transport="stdio")
