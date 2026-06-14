"""Memory layer — tiered records with RAG recall.

Granularity tiers: daily | weekly | monthly | yearly | significant
Significant memories use composite key YYYY-MM-DD_slug — preserved from
entity-core's contract so thalamus.js's parseMemoryKey() needs no changes.

Audience-gated at query time: enrich() passes audienceTag so the store
returns only records the room is cleared for.
"""

from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime, date
from typing import Any

from phylactery.db import get_conn, new_id, now_iso
from phylactery.snapshot import auto_snapshot
from phylactery.audience import audience_filter_sql

VALID_GRANULARITIES = {"daily", "weekly", "monthly", "yearly", "significant"}

_INSTANCE_ID = "proto-familiar"


def _derive_slug(title: str | None, content: str) -> str:
    source = (title or content[:80]).strip()
    slug = re.sub(r"[^a-z0-9]+", "-", source.lower()).strip("-")
    return slug[:60] or f"memory-{now_iso()[:10]}"


def _today() -> str:
    return date.today().isoformat()


def _row_to_thin(row: sqlite3.Row) -> dict:
    """Thin projection for recall results — id rides in, body stays server-side."""
    return {
        "id": row["id"],
        "granularity": row["granularity"],
        "date": row["date_key"],
        "excerpt": (row["content"] or "")[:300],
    }


def _row_to_list_item(row: sqlite3.Row) -> dict:
    content = row["content"] or ""
    head = content.split("\n")[0][:80] if content else ""
    return {
        "id": row["id"],
        "key": row["date_key"] or "",
        "granularity": row["granularity"],
        "title": head,
        "content": content,
    }


# ── Search (RAG) ──────────────────────────────────────────────────────────────

def search(
    query: str,
    max_results: int = 5,
    audience: str = "ward-private",
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        aud_clause, aud_params = audience_filter_sql(audience)
        try:
            from phylactery.embed import embed_text
            q_vec = embed_text(query)
            # KNN via sqlite-vec.
            rows = conn.execute(f"""
                SELECT m.id, m.granularity, m.date_key, m.content, m.audience,
                       v.distance
                FROM memory_vecs v
                JOIN memories m ON m.id = v.memory_id
                WHERE v.embedding MATCH ? AND k = ?
                  AND {aud_clause}
                ORDER BY v.distance
            """, [q_vec, max_results * 2] + aud_params).fetchall()
            # Normalise distance to score in [0,1] (lower distance = higher score).
            # sqlite-vec returns L2 distance for float vectors; cosine approximation:
            # score = max(0, 1 - distance/2) for unit vectors.
            results = []
            for r in rows[:max_results]:
                dist = r["distance"] if "distance" in r.keys() else 0.0
                score = max(0.0, 1.0 - dist / 2.0)
                thin = {"id": r["id"], "granularity": r["granularity"], "date": r["date_key"],
                        "excerpt": (r["content"] or "")[:300], "score": round(score, 4)}
                results.append(thin)
        except Exception:
            # Vector search unavailable (fastembed/sqlite-vec not ready) — degrade to recency.
            rows = conn.execute(f"""
                SELECT id, granularity, date_key, content FROM memories
                WHERE kind='narrative' AND {aud_clause}
                ORDER BY updated_at DESC LIMIT ?
            """, aud_params + [max_results]).fetchall()
            results = [{"id": r["id"], "granularity": r["granularity"], "date": r["date_key"],
                        "excerpt": (r["content"] or "")[:300], "score": 0.5} for r in rows]

        return {"results": results}
    finally:
        if own_conn:
            conn.close()


# ── Create ────────────────────────────────────────────────────────────────────

def create(
    content: str,
    granularity: str,
    date_key: str | None = None,
    slug: str | None = None,
    source_author: str = _INSTANCE_ID,
    audience: str = "ward-private",
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    if granularity not in VALID_GRANULARITIES:
        return {"ok": False, "error": f"invalid granularity: {granularity!r}"}
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        now = now_iso()
        rec_id = new_id()

        if granularity == "significant":
            if not slug:
                slug = _derive_slug(None, content)
            dk = f"{date_key or _today()}_{slug}"
        else:
            dk = date_key or _today()
            slug = None

        source = json.dumps({"author": source_author, "via": "memorization", "at": now})

        with conn:
            # For non-significant tiers: APPEND to existing date entry if one exists.
            if granularity != "significant":
                existing = conn.execute(
                    "SELECT id, content FROM memories WHERE granularity=? AND date_key=? AND kind='narrative'",
                    (granularity, dk),
                ).fetchone()
                if existing:
                    new_content = (existing["content"] or "") + "\n" + content
                    conn.execute(
                        "UPDATE memories SET content=?, updated_at=?, source_json=? WHERE id=?",
                        (new_content, now, source, existing["id"]),
                    )
                    _upsert_embedding(conn, existing["id"], new_content)
                    return {"ok": True, "id": existing["id"], "dateKey": dk, "appended": True}

            conn.execute("""
                INSERT INTO memories(id,kind,register,granularity,date_key,slug,content,
                    audience,source_json,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?)
            """, (rec_id, "narrative", "episodic", granularity, dk, slug,
                  content, audience, source, now, now))

        _upsert_embedding(conn, rec_id, content)
        return {"ok": True, "id": rec_id, "dateKey": dk}
    finally:
        if own_conn:
            conn.close()


# ── Read ──────────────────────────────────────────────────────────────────────

def list_memories(
    granularity: str | None = None,
    limit: int = 50,
    offset: int = 0,
    conn: sqlite3.Connection | None = None,
) -> list[dict]:
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        if granularity:
            rows = conn.execute(
                "SELECT id,granularity,date_key,content FROM memories WHERE granularity=? AND kind='narrative' ORDER BY date_key DESC LIMIT ? OFFSET ?",
                (granularity, limit, offset),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id,granularity,date_key,content FROM memories WHERE kind='narrative' ORDER BY date_key DESC LIMIT ? OFFSET ?",
                (limit, offset),
            ).fetchall()
        return [_row_to_list_item(r) for r in rows]
    finally:
        if own_conn:
            conn.close()


def read_memory(
    granularity: str,
    date_key: str,
    slug: str | None = None,
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        # Significant memories: date_key may be YYYY-MM-DD_slug composite or plain date.
        if slug:
            dk = f"{date_key}_{slug}"
        else:
            dk = date_key
        row = conn.execute(
            "SELECT content FROM memories WHERE granularity=? AND date_key=? AND kind='narrative'",
            (granularity, dk),
        ).fetchone()
        if not row:
            return {"ok": False, "error": f"no {granularity} memory at {dk!r}"}
        return {"ok": True, "content": row["content"] or ""}
    finally:
        if own_conn:
            conn.close()


# ── Update / Delete ───────────────────────────────────────────────────────────

def update_memory(
    granularity: str,
    date_key: str,
    new_content: str,
    slug: str | None = None,
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        auto_snapshot(conn)
        dk = f"{date_key}_{slug}" if slug else date_key
        now = now_iso()
        result = conn.execute(
            "UPDATE memories SET content=?, updated_at=? WHERE granularity=? AND date_key=? AND kind='narrative'",
            (new_content, now, granularity, dk),
        )
        if result.rowcount == 0:
            return {"ok": False, "error": f"no {granularity} memory at {dk!r}"}
        conn.commit()
        # Re-embed updated content.
        row = conn.execute("SELECT id FROM memories WHERE granularity=? AND date_key=?", (granularity, dk)).fetchone()
        if row:
            _upsert_embedding(conn, row["id"], new_content)
        return {"ok": True}
    finally:
        if own_conn:
            conn.close()


def delete_memory(
    granularity: str,
    date_key: str,
    slug: str | None = None,
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        auto_snapshot(conn)
        dk = f"{date_key}_{slug}" if slug else date_key
        row = conn.execute(
            "SELECT id FROM memories WHERE granularity=? AND date_key=? AND kind='narrative'",
            (granularity, dk),
        ).fetchone()
        if not row:
            return {"ok": False, "error": f"no {granularity} memory at {dk!r}"}
        rec_id = row["id"]
        with conn:
            conn.execute("DELETE FROM memories WHERE id=?", (rec_id,))
            _delete_embedding(conn, rec_id)
        return {"ok": True, "deleted": dk}
    finally:
        if own_conn:
            conn.close()


# ── Embedding helpers ─────────────────────────────────────────────────────────

def _upsert_embedding(conn: sqlite3.Connection, record_id: str, content: str) -> None:
    try:
        from phylactery.embed import embed_text
        vec = embed_text(content[:2000])
        conn.execute(
            "INSERT OR REPLACE INTO memory_vecs(memory_id, embedding) VALUES (?, ?)",
            (record_id, vec),
        )
        conn.commit()
    except Exception as e:
        import sys
        print(f"[phylactery] embedding failed for {record_id}: {e}", file=sys.stderr)


def _delete_embedding(conn: sqlite3.Connection, record_id: str) -> None:
    try:
        conn.execute("DELETE FROM memory_vecs WHERE memory_id=?", (record_id,))
    except Exception:
        pass
