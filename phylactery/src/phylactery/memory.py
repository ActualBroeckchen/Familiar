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
from phylactery.audience import audience_filter_sql, WARD_PRIVATE

VALID_GRANULARITIES = {"daily", "weekly", "monthly", "yearly", "significant"}

_INSTANCE_ID = "proto-familiar"

# Retrieval-decay constants (signed off: 180d half-life, careWeight:high floor=0.5).
_DECAY_HALF_LIFE_DAYS = 180.0
_DECAY_FLOOR_HIGH_CARE = 0.5


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


# ── Retrieval-decay ───────────────────────────────────────────────────────────

def _decay_weight(last_recalled_at: str | None, care_weight: str | None) -> float:
    """Compute the retrieval-decay multiplier for a single memory record.

    Formula (signed off): weight = 0.5 ^ (days_since_recall / 180)
    - Never-recalled records get weight=1.0 (no penalty for fresh/unvisited records).
    - careWeight:high floor=0.5 (high-care facts can never decay below half weight).
    - Multiplied into the similarity score; never used as a filter cutoff.
    """
    if last_recalled_at is None:
        weight = 1.0
    else:
        try:
            ts = last_recalled_at.rstrip("Z").split("+")[0]
            recalled = datetime.fromisoformat(ts)
            days = max(0.0, (datetime.utcnow() - recalled).total_seconds() / 86400.0)
            weight = 0.5 ** (days / _DECAY_HALF_LIFE_DAYS)
        except Exception:
            weight = 1.0
    if care_weight == "high":
        weight = max(weight, _DECAY_FLOOR_HIGH_CARE)
    return weight


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
                       m.care_weight, m.last_recalled_at,
                       v.distance
                FROM memory_vecs v
                JOIN memories m ON m.id = v.memory_id
                WHERE v.embedding MATCH ? AND k = ?
                  AND {aud_clause}
                ORDER BY v.distance
            """, [q_vec, max_results * 2] + aud_params).fetchall()
            # Convert distance → similarity, apply retrieval-decay, re-sort.
            # score = similarity × decay_weight (down-rank only; never a filter cutoff).
            scored = []
            for r in rows:
                dist = r["distance"] if "distance" in r.keys() else 0.0
                similarity = max(0.0, 1.0 - dist / 2.0)
                dw = _decay_weight(r["last_recalled_at"], r["care_weight"])
                score = similarity * dw
                scored.append({"id": r["id"], "granularity": r["granularity"], "date": r["date_key"],
                               "excerpt": (r["content"] or "")[:300], "score": round(score, 4)})
            scored.sort(key=lambda x: x["score"], reverse=True)
            results = scored[:max_results]
        except Exception:
            # Vector search unavailable (fastembed/sqlite-vec not ready) — degrade to recency.
            rows = conn.execute(f"""
                SELECT id, granularity, date_key, content FROM memories
                WHERE kind='narrative' AND {aud_clause}
                ORDER BY updated_at DESC LIMIT ?
            """, aud_params + [max_results]).fetchall()
            results = [{"id": r["id"], "granularity": r["granularity"], "date": r["date_key"],
                        "excerpt": (r["content"] or "")[:300], "score": 0.5} for r in rows]

        # Pillar H: recall tracking. Pure observability — bumps recall_count
        # and last_recalled_at for everything actually surfaced, so the
        # graduation gate can tell front-of-mind records from never-recalled
        # ones. Does NOT reorder or filter anything. Never raised into the
        # caller's path: a tracking failure can't break a recall.
        try:
            _touch_recall(conn, [r["id"] for r in results])
        except Exception as e:
            import sys
            print(f"[phylactery] recall tracking failed (ignored): {e}", file=sys.stderr)

        return {"results": results}
    finally:
        if own_conn:
            conn.close()


def _touch_recall(conn: sqlite3.Connection, ids: list[str]) -> None:
    """Bump recall_count + stamp last_recalled_at for surfaced records."""
    ids = [i for i in ids if i]
    if not ids:
        return
    placeholders = ",".join("?" * len(ids))
    with conn:
        conn.execute(
            f"UPDATE memories SET recall_count = recall_count + 1, last_recalled_at = ? "
            f"WHERE id IN ({placeholders})",
            [now_iso()] + ids,
        )


# ── Create ────────────────────────────────────────────────────────────────────

def create(
    content: str,
    granularity: str,
    date_key: str | None = None,
    slug: str | None = None,
    source_author: str = _INSTANCE_ID,
    audience: str = "ward-private",
    subjects: list[str] | None = None,
    care_weight: str | None = None,
    category: str | None = None,
    consent_pending: bool = False,
    confidence: float = 1.0,
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
        subj_json = json.dumps(subjects or [])

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
                    audience,subjects_json,care_weight,category,consent_pending,
                    confidence,source_json,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, (rec_id, "narrative", "episodic", granularity, dk, slug,
                  content, audience, subj_json, care_weight, category,
                  1 if consent_pending else 0, max(0.0, min(1.0, confidence)),
                  source, now, now))

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


# ── Consent flow (Pillar C) ───────────────────────────────────────────────────

def list_consent_pending(conn: sqlite3.Connection | None = None) -> list[dict]:
    """Return thin projections of all consent_pending=1 records."""
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT id, category, subjects_json, content FROM memories "
            "WHERE consent_pending=1 AND kind='narrative' ORDER BY created_at ASC",
        ).fetchall()
        results = []
        for r in rows:
            subjects = []
            try:
                subjects = json.loads(r["subjects_json"] or "[]")
            except Exception:
                pass
            results.append({
                "id": r["id"],
                "category": r["category"],
                "subjects": subjects,
                "brief": (r["content"] or "")[:120],
            })
        return results
    finally:
        if own_conn:
            conn.close()


def confirm_consent(ids: list[str], conn: sqlite3.Connection | None = None) -> dict[str, Any]:
    """Clear consent_pending flag for the given record IDs. Ward said yes."""
    if not ids:
        return {"ok": True, "confirmed": 0}
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        placeholders = ",".join("?" * len(ids))
        with conn:
            result = conn.execute(
                f"UPDATE memories SET consent_pending=0, updated_at=? WHERE id IN ({placeholders}) AND consent_pending=1",
                [now_iso()] + list(ids),
            )
        return {"ok": True, "confirmed": result.rowcount}
    finally:
        if own_conn:
            conn.close()


def drop_pending(ids: list[str], conn: sqlite3.Connection | None = None) -> dict[str, Any]:
    """Hard-delete consent_pending records. Ward said no — honour the refusal."""
    if not ids:
        return {"ok": True, "dropped": 0}
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        auto_snapshot(conn)
        placeholders = ",".join("?" * len(ids))
        rows = conn.execute(
            f"SELECT id FROM memories WHERE id IN ({placeholders}) AND consent_pending=1",
            list(ids),
        ).fetchall()
        rec_ids = [r["id"] for r in rows]
        if not rec_ids:
            return {"ok": True, "dropped": 0}
        with conn:
            p2 = ",".join("?" * len(rec_ids))
            conn.execute(f"DELETE FROM memories WHERE id IN ({p2})", rec_ids)
        for rid in rec_ids:
            _delete_embedding(conn, rid)
        return {"ok": True, "dropped": len(rec_ids)}
    finally:
        if own_conn:
            conn.close()


# ── Restricted-content search (Pillar D) ─────────────────────────────────────

def search_restricted(
    query: str,
    room_audience: str,
    threshold: float = 0.70,
    max_results: int = 3,
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    """Find ward-private memories semantically close to query.

    Returns {hit: True, topic, score} if any ward-private memory matches above
    threshold in a non-ward-private room. Returns {hit: False} when the room is
    ward-private (no restriction applies) or no match exceeds threshold.

    Always fails open — a vector-search error returns {hit: False} so the
    outgoing filter never blocks a reply on a search failure.
    """
    if room_audience == WARD_PRIVATE:
        return {"hit": False}
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        try:
            from phylactery.embed import embed_text
            q_vec = embed_text(query[:2000])
            rows = conn.execute("""
                SELECT m.id, m.content, v.distance
                FROM memory_vecs v
                JOIN memories m ON m.id = v.memory_id
                WHERE v.embedding MATCH ? AND k = ?
                  AND m.audience = 'ward-private'
                  AND m.kind = 'narrative'
                ORDER BY v.distance
                LIMIT ?
            """, [q_vec, max_results * 2, max_results]).fetchall()
            for r in rows:
                dist = r["distance"] if "distance" in r.keys() else 2.0
                score = max(0.0, 1.0 - dist / 2.0)
                if score >= threshold:
                    topic = (r["content"] or "")[:80].split("\n")[0].strip()
                    return {"hit": True, "topic": topic, "score": round(score, 4)}
        except Exception:
            pass  # vector search unavailable — fail open
        return {"hit": False}
    finally:
        if own_conn:
            conn.close()
