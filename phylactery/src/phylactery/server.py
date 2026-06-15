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
    memory_search_restricted — Pillar D outgoing gate: find ward-private memories matching a draft
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

  Lifecycle (Pillar H):
    lifecycle_pass          — hygiene + consolidation + graduation audit on demand
    graduation_list_pending — ward-block detail graduated but not yet mentioned
    graduation_acknowledge  — mark graduation mentions as surfaced
    backup_export           — passphrase-encrypted single-file backup
    backup_restore          — restore from a passphrase-encrypted backup

  Ward consent (Pillar I):
    remember_map_get        — read the ward's remember consent map
    remember_map_set        — write the ward's remember consent map

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
import phylactery.graduation as grad
import phylactery.scheduler as scheduler
import phylactery.backup as backup
import phylactery.remember as remember

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
    audience: Optional[str] = None,
    subjects: Optional[list[str]] = None,
    care_weight: Optional[str] = None,
    category: Optional[str] = None,
    consent_pending: Optional[bool] = None,
    confidence: Optional[float] = None,
    instanceId: Optional[str] = None,
) -> str:
    """Store a new per-fact memory at the given granularity tier.
    For non-significant tiers, appends to the same-date file.
    For significant, slug is derived from content if omitted.
    audience defaults to ward-private; subjects is a list of villager IDs;
    category is the remember-taxonomy bucket; consent_pending marks records
    awaiting ward approval (the ask path).
    """
    result = mem.create(
        content, granularity, date_key=date, slug=slug,
        audience=audience or "ward-private",
        subjects=subjects or [],
        care_weight=care_weight,
        category=category,
        consent_pending=bool(consent_pending),
        confidence=float(confidence) if confidence is not None else 1.0,
        conn=_c(),
    )
    if not result.get("ok"):
        return f"Memory save failed: {result.get('error', 'unknown')}"
    dk = result.get("dateKey", "")
    if granularity == "significant":
        return f"Memory saved (significant/{dk}) id={result.get('id', '')}."
    return f"Memory saved id={result.get('id', '')}."


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
def memory_search_restricted(
    query: str,
    roomAudience: str,
    threshold: Optional[float] = None,
    maxResults: Optional[int] = None,
) -> dict[str, Any]:
    """I use this to check whether a draft reply I'm about to send contains content
    restricted from the current room. Searches ward-private memories semantically
    close to the query — if any match above threshold the reply should not be sent
    as-is. Returns {hit, topic?, score?}. Always fails open: returns {hit: false}
    on any search error so the outgoing filter never blocks on a lookup failure.
    """
    t = float(threshold) if threshold is not None else 0.70
    k = max(1, min(10, int(maxResults or 3)))
    return mem.search_restricted(query, room_audience=roomAudience, threshold=t, max_results=k, conn=_c())


@mcp.tool()
def memory_update(
    granularity: str,
    date: str,
    content: str,
    editedBy: Optional[str] = None,
    slug: Optional[str] = None,
    audience: Optional[str] = None,
    careWeight: Optional[str] = None,
) -> str:
    """Overwrite an existing memory entry (auto-snapshots first).

    audience: 'ward-private' (default) or a category id — who can see this record.
    careWeight: 'high' (pinned + decay-shielded), 'low', or omit to leave unchanged.
    """
    result = mem.update_memory(
        granularity, date, content, slug=slug,
        audience=audience, care_weight=careWeight, conn=_c(),
    )
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


@mcp.tool()
def memory_list_consent_pending() -> dict[str, Any]:
    """I use this to list memory records I stored with consent_pending=true —
    facts about a villager whose remember setting is 'ask'. I surface these
    to my human and ask whether to keep them; then call memory_confirm_consent
    or memory_drop_pending based on the answer.
    Returns { items: [{ id, category, subjects, brief }] }.
    """
    items = mem.list_consent_pending(conn=_c())
    return {"items": items}


@mcp.tool()
def memory_confirm_consent(ids: list[str]) -> str:
    """I use this to confirm that my human consents to keeping memory records
    I flagged as consent_pending. Clears the pending flag; records become
    permanent. Call after my human says yes to the pending-consent question.
    """
    if not ids:
        return "No ids provided."
    result = mem.confirm_consent(ids, conn=_c())
    n = result.get("confirmed", 0)
    return f"Consent confirmed for {n} record(s). They are now stored permanently."


@mcp.tool()
def memory_drop_pending(ids: list[str]) -> str:
    """I use this to delete memory records my human has declined to keep.
    Hard-deletes consent_pending records by id — no undo, no soft-delete,
    because this is consent revocation. Call after my human says no.
    Auto-snapshots first so an accidental drop can be recovered.
    """
    if not ids:
        return "No ids provided."
    result = mem.drop_pending(ids, conn=_c())
    n = result.get("dropped", 0)
    return f"Dropped {n} consent-pending record(s). (Snapshot created before deletion.)"


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


# ── Lifecycle (Pillar H) ──────────────────────────────────────────────────────


@mcp.tool()
def lifecycle_pass(force: Optional[bool] = None) -> dict[str, Any]:
    """Run one lifecycle pass now: cheap-code hygiene, tier consolidation, and
    the Familiar-led graduation audit. The background scheduler runs this on a
    volume-gated 5-min cadence; this tool forces it on demand. `force` bypasses
    the volume gate.
    """
    return scheduler.run_pass(force=bool(force))


@mcp.tool()
def graduation_list_pending() -> dict[str, Any]:
    """I use this to see ward-block detail I've recently graduated off my
    always-injected surface that my human hasn't been told about yet. I mention
    these in my own voice — non-blocking — so they can pull anything back.
    Returns { items: [{ id, filename, memoryId, summary, createdAt }] }.
    """
    return {"items": grad.list_unacknowledged_graduations(conn=_c())}


@mcp.tool()
def graduation_acknowledge(ids: list[str]) -> str:
    """I call this once I've let my human know about ward-block detail I filed
    away, so I don't keep re-raising the same graduations.
    """
    if not ids:
        return "No ids provided."
    result = grad.acknowledge_graduations(ids, conn=_c())
    return f"Acknowledged {result.get('acknowledged', 0)} graduation notice(s)."


# ── Backup / restore (Pillar H) ───────────────────────────────────────────────


@mcp.tool()
def backup_export(passphrase: str) -> dict[str, Any]:
    """Export my entire self — identity, memory, graph, trackers — to a single
    passphrase-encrypted file my human can keep safe. Returns the file path.
    """
    return backup.export_encrypted(passphrase, conn=_c())


@mcp.tool()
def backup_restore(filePath: str, passphrase: str) -> dict[str, Any]:
    """Restore my whole self from a passphrase-encrypted backup file. Requires
    a server reconnect afterwards (thalamus handles this).
    """
    return backup.restore_encrypted(filePath, passphrase)


# ── Ward consent map (Pillar I) ───────────────────────────────────────────────


@mcp.tool()
def remember_map_get() -> dict[str, Any]:
    """I use this to read my human's remember-consent map — which categories
    of information they've asked me to store freely, ask about, or never store.

    Returns {basics, emotional_content, health_info, relationships, whereabouts}
    where each value is true (store freely), false (never store, drop silently),
    or 'ask' (store as consent_pending and surface to my human for confirmation).
    """
    return remember.get()


@mcp.tool()
def remember_map_set(map: dict[str, Any]) -> dict[str, Any]:
    """I use this to write my human's remember-consent map.

    map must be an object with any subset of the categories:
      basics, emotional_content, health_info, relationships, whereabouts
    Each value must be true, false, or 'ask'.

    Returns {"ok": true, "map": ...} on success, {"ok": false, "errors": [...]} on validation failure.
    """
    return remember.set_map(map)


# ── Entry point ───────────────────────────────────────────────────────────────


def main() -> None:
    scheduler.start()
    mcp.run(transport="stdio")
