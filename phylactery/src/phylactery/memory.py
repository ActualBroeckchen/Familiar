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
from phylactery.audience import audience_filter_sql, audience_in_sql, WARD_PRIVATE

VALID_GRANULARITIES = {"daily", "weekly", "monthly", "yearly", "significant"}

# The `register` axis is SEPARATE from granularity (phylactery-design.md §9):
#   episodic — lived moments extracted from conversation (the default)
#   me       — a standing truth about the Familiar itself
#   ward     — a standing truth about the human
# me/ward are the graduation destination (Pillar H) AND can now be written
# deliberately by the Familiar via save_memory's register choice.
VALID_REGISTERS = {"episodic", "me", "ward"}

_INSTANCE_ID = "proto-familiar"

# Retrieval-decay constants (signed off: 180d half-life, careWeight:high floor=0.5).
_DECAY_HALF_LIFE_DAYS = 180.0
_DECAY_FLOOR_HIGH_CARE = 0.5

# Semantic dedup at write time (the "82 queued, only 5 new" fix). Similarity is
# the same `1 - distance/2` scale memory.search() ranks with. Conservative on
# purpose — only fold in clear paraphrase duplicates, so two genuinely different
# facts are never conflated. Tunable; merges/confirms are logged so they can be
# audited and the thresholds adjusted against real behaviour.
#   sim >= _DEDUP_IDENTICAL_MIN  → near-identical restatement: confirm, no append
#   _DEDUP_MERGE_MIN <= sim < …  → additive near-dup: fold the new detail in
_DEDUP_MERGE_MIN = 0.78       # ≈ cosine 0.90
_DEDUP_IDENTICAL_MIN = 0.85   # ≈ cosine 0.95


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
        "register": row["register"],
        "title": head,
        "content": content,
        "audience": row["audience"] or "ward-private",
        "care_weight": row["care_weight"],
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
    audiences=None,
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    # audiences: the room's allowed audience-tag set (None = ward sees all),
    # computed JS-side by visibleAudiences(). The recall gate (Pillar E).
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        aud_clause, aud_params = audience_in_sql(audiences)
        try:
            from phylactery.embed import embed_text
            q_vec = embed_text(query)
            # KNN via sqlite-vec.
            rows = conn.execute(f"""
                SELECT m.id, m.granularity, m.register, m.date_key, m.content, m.audience,
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
                scored.append({"id": r["id"], "granularity": r["granularity"], "register": r["register"],
                               "date": r["date_key"], "excerpt": (r["content"] or "")[:300], "score": round(score, 4)})
            scored.sort(key=lambda x: x["score"], reverse=True)
            results = scored[:max_results]
        except Exception:
            # Vector search unavailable (fastembed/sqlite-vec not ready) — degrade to recency.
            rows = conn.execute(f"""
                SELECT id, granularity, register, date_key, content FROM memories
                WHERE kind='narrative' AND {aud_clause}
                ORDER BY updated_at DESC LIMIT ?
            """, aud_params + [max_results]).fetchall()
            results = [{"id": r["id"], "granularity": r["granularity"], "register": r["register"],
                        "date": r["date_key"], "excerpt": (r["content"] or "")[:300], "score": 0.5} for r in rows]

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

def _norm_text(s: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9 ]+", " ", (s or "").lower()).split())


def _lexically_contained(new: str, existing: str) -> bool:
    """Cheap check: is the new content's text already present in the existing
    entry? Avoids appending a paraphrase whose words are already there."""
    n = _norm_text(new)
    return bool(n) and n in _norm_text(existing)


def _find_near_duplicate(conn: sqlite3.Connection, content: str, audience: str,
                         standalone_only: bool = False):
    """Nearest existing narrative memory to `content`, if it's similar enough to
    be a duplicate. Returns (id, content, consent_pending, similarity) or None.
    Degrades to None (→ normal insert) if embeddings are unavailable.

    standalone_only restricts the search to per-fact / significant rows (those
    with a slug), so a discrete extracted fact dedups against other discrete
    facts and never folds itself into a date-bucketed daily journal blob."""
    try:
        from phylactery.embed import embed_text
        q_vec = embed_text(content)
        aud_clause, aud_params = audience_filter_sql(audience)
        slug_clause = " AND m.slug IS NOT NULL" if standalone_only else ""
        row = conn.execute(f"""
            SELECT m.id, m.content, m.consent_pending, v.distance
            FROM memory_vecs v
            JOIN memories m ON m.id = v.memory_id
            WHERE v.embedding MATCH ? AND k = ?
              AND m.kind='narrative'{slug_clause} AND {aud_clause}
            ORDER BY v.distance
            LIMIT 1
        """, [q_vec, 10] + aud_params).fetchone()
        if not row:
            return None
        sim = max(0.0, 1.0 - row["distance"] / 2.0)
        if sim < _DEDUP_MERGE_MIN:
            return None
        return (row["id"], row["content"], row["consent_pending"], sim)
    except Exception:
        return None


def _dedup_merge(conn, content, audience, consent_pending, now, source,
                 standalone_only: bool = False):
    """If `content` duplicates an existing memory, fold it in and return a
    create-style result; otherwise return None (caller inserts normally)."""
    dup = _find_near_duplicate(conn, content, audience, standalone_only=standalone_only)
    if dup is None:
        return None
    dup_id, dup_content, dup_pending, sim = dup

    # Near-identical restatement → confirm the existing entry, add nothing.
    # (Appending identical text is pure bloat; the knowledge is already held.)
    if sim >= _DEDUP_IDENTICAL_MIN:
        with conn:
            conn.execute("UPDATE memories SET updated_at=? WHERE id=?", (now, dup_id))
        import sys
        print(f"[phylactery] dedup: confirmed existing memory {dup_id} (sim {sim:.2f}); skipped near-identical duplicate", file=sys.stderr)
        return {"ok": True, "id": dup_id, "merged": True, "identical": True}

    # Additive near-dup. Only fold in when the existing entry and the new one
    # share consent status — folding unconsented new detail into an already
    # CONSENTED memory would slip it past consent, so in that case fall through
    # to a normal insert (the new detail gets its own consent pass).
    if bool(dup_pending) != bool(consent_pending):
        return None

    if not _lexically_contained(content, dup_content):
        new_content = (dup_content or "") + "\n" + content
        with conn:
            conn.execute("UPDATE memories SET content=?, updated_at=? WHERE id=?", (new_content, now, dup_id))
        _upsert_embedding(conn, dup_id, new_content)
        import sys
        print(f"[phylactery] dedup: merged into memory {dup_id} (sim {sim:.2f})", file=sys.stderr)
    else:
        with conn:
            conn.execute("UPDATE memories SET updated_at=? WHERE id=?", (now, dup_id))
    return {"ok": True, "id": dup_id, "merged": True}


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
    standalone: bool = False,
    register: str = "episodic",
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    if granularity not in VALID_GRANULARITIES:
        return {"ok": False, "error": f"invalid granularity: {granularity!r}"}
    if register not in VALID_REGISTERS:
        return {"ok": False, "error": f"invalid register: {register!r}"}
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        now = now_iso()
        rec_id = new_id()
        subj_json = json.dumps(subjects or [])

        # Three storage shapes:
        #   • significant  → its own row keyed `date_slug` (a permanent, rare milestone).
        #   • standalone   → its own row keyed by the plain date, but carrying per-fact
        #     metadata (category / subjects / consent). This is how the memorization
        #     pipeline lands discrete claimable facts at the `daily` tier so they
        #     consolidate and decay like the doc intends — instead of every fact being
        #     mis-filed as `significant`. The slug marks the row as a standalone fact so
        #     the daily-journal bucket (below) never appends into it, and the plain
        #     date_key keeps it inside consolidation's date-range roll-up.
        #   • bucket       → the date-bucketed daily/weekly/… journal: one row per
        #     (tier, date), new content appended as bullets. slug stays NULL.
        is_standalone = granularity == "significant" or standalone
        if granularity == "significant":
            if not slug:
                slug = _derive_slug(None, content)
            dk = f"{date_key or _today()}_{slug}"
        elif standalone:
            dk = date_key or _today()
            if not slug:
                slug = _derive_slug(None, content) or f"fact-{rec_id[:8]}"
        else:
            dk = date_key or _today()
            slug = None

        source = json.dumps({"author": source_author, "via": "memorization", "at": now})

        # Semantic dedup/merge — fold a near-identical fact into an existing
        # memory instead of piling up paraphrase duplicates (the consent-queue
        # bloat). Scoped to per-fact rows (significant / standalone) and any
        # consent-pending write; plain daily journal buckets keep their
        # date-bucketed append below. A per-fact row only dedups against other
        # per-fact rows, never into a journal bucket.
        if content and content.strip() and (is_standalone or consent_pending):
            merged = _dedup_merge(conn, content, audience, consent_pending, now, source,
                                  standalone_only=is_standalone)
            if merged is not None:
                return merged

        with conn:
            # Date-bucketed journal tiers: APPEND to the existing bucket if one
            # exists. The `slug IS NULL` guard keeps this off standalone fact
            # rows that share the same plain date_key.
            if not is_standalone:
                existing = conn.execute(
                    "SELECT id, content FROM memories WHERE granularity=? AND date_key=? AND slug IS NULL AND kind='narrative'",
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
            """, (rec_id, "narrative", register, granularity, dk, slug,
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
                "SELECT id,granularity,register,date_key,content,audience,care_weight FROM memories WHERE granularity=? AND kind='narrative' ORDER BY date_key DESC LIMIT ? OFFSET ?",
                (granularity, limit, offset),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id,granularity,register,date_key,content,audience,care_weight FROM memories WHERE kind='narrative' ORDER BY date_key DESC LIMIT ? OFFSET ?",
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
            "SELECT content, register, audience, care_weight FROM memories WHERE granularity=? AND date_key=? AND kind='narrative'",
            (granularity, dk),
        ).fetchone()
        if not row:
            return {"ok": False, "error": f"no {granularity} memory at {dk!r}"}
        return {
            "ok": True,
            "content": row["content"] or "",
            "register": row["register"],
            "audience": row["audience"] or "ward-private",
            "care_weight": row["care_weight"],
        }
    finally:
        if own_conn:
            conn.close()


# ── Update / Delete ───────────────────────────────────────────────────────────

def update_memory(
    granularity: str,
    date_key: str,
    new_content: str,
    slug: str | None = None,
    audience: str | None = None,
    care_weight: str | None = None,
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        auto_snapshot(conn)
        dk = f"{date_key}_{slug}" if slug else date_key
        now = now_iso()
        # Build SET clause dynamically — only update fields the caller provided.
        sets = ["content=?", "updated_at=?"]
        params: list = [new_content, now]
        if audience is not None:
            sets.append("audience=?")
            params.append(audience)
        if care_weight is not None:
            sets.append("care_weight=?")
            params.append(care_weight if care_weight != "" else None)
        params += [granularity, dk]
        # granularity+date_key is unique ONLY for the journal bucket (slug NULL) and
        # for significant rows (slug is baked into the composite date_key). It is
        # NOT unique for standalone per-fact rows — a whole day's facts share one
        # plain date_key. So a no-slug update must scope to slug IS NULL, or it would
        # overwrite EVERY standalone fact on that date with the same content. Those
        # are addressed by id instead (update_memory_by_id).
        scope = "" if slug else " AND slug IS NULL"
        result = conn.execute(
            f"UPDATE memories SET {', '.join(sets)} WHERE granularity=? AND date_key=? AND kind='narrative'{scope}",
            params,
        )
        if result.rowcount == 0:
            return {"ok": False, "error": f"no {granularity} journal memory at {dk!r} (per-fact rows are addressed by id)"}
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
        # Same uniqueness caveat as update_memory: a no-slug delete must scope to the
        # journal bucket (slug IS NULL), or it would delete an arbitrary one of the
        # many standalone facts that share a plain date_key. Per-fact rows are
        # deleted by id instead (delete_memory_by_id).
        scope = "" if slug else " AND slug IS NULL"
        row = conn.execute(
            f"SELECT id FROM memories WHERE granularity=? AND date_key=? AND kind='narrative'{scope}",
            (granularity, dk),
        ).fetchone()
        if not row:
            return {"ok": False, "error": f"no {granularity} journal memory at {dk!r} (per-fact rows are addressed by id)"}
        rec_id = row["id"]
        with conn:
            conn.execute("DELETE FROM memories WHERE id=?", (rec_id,))
            _delete_embedding(conn, rec_id)
        return {"ok": True, "deleted": dk}
    finally:
        if own_conn:
            conn.close()


# ── By-id addressing (the unique handle) ───────────────────────────────────────
# granularity+date_key is NOT unique for standalone per-fact rows — many share one
# plain date (e.g. a whole day's extracted facts) — so the only reliable address
# for those is the row id. These power the by-id read/edit/move/delete surface the
# Knowledge editor and the Familiar's management tools use.

def read_memory_by_id(
    mem_id: str,
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        row = conn.execute(
            "SELECT id, granularity, register, date_key, slug, content, audience, care_weight "
            "FROM memories WHERE id=? AND kind='narrative'",
            (mem_id,),
        ).fetchone()
        if not row:
            return {"ok": False, "error": f"no memory with id {mem_id!r}"}
        return {
            "ok": True,
            "id": row["id"],
            "granularity": row["granularity"],
            "register": row["register"],
            "date": row["date_key"],
            "slug": row["slug"],
            "content": row["content"] or "",
            "audience": row["audience"] or "ward-private",
            "care_weight": row["care_weight"],
        }
    finally:
        if own_conn:
            conn.close()


def update_memory_by_id(
    mem_id: str,
    new_content: str | None = None,
    audience: str | None = None,
    care_weight: str | None = None,
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        auto_snapshot(conn)
        row = conn.execute(
            "SELECT id FROM memories WHERE id=? AND kind='narrative'", (mem_id,)
        ).fetchone()
        if not row:
            return {"ok": False, "error": f"no memory with id {mem_id!r}"}
        sets, params = ["updated_at=?"], [now_iso()]
        if new_content is not None:
            sets.append("content=?")
            params.append(new_content)
        if audience is not None:
            sets.append("audience=?")
            params.append(audience)
        if care_weight is not None:
            sets.append("care_weight=?")
            params.append(care_weight if care_weight != "" else None)
        params.append(mem_id)
        with conn:
            conn.execute(f"UPDATE memories SET {', '.join(sets)} WHERE id=?", params)
        if new_content is not None:
            _upsert_embedding(conn, mem_id, new_content)
        return {"ok": True, "id": mem_id}
    finally:
        if own_conn:
            conn.close()


def delete_memory_by_id(
    mem_id: str,
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        auto_snapshot(conn)
        row = conn.execute(
            "SELECT id FROM memories WHERE id=? AND kind='narrative'", (mem_id,)
        ).fetchone()
        if not row:
            return {"ok": False, "error": f"no memory with id {mem_id!r}"}
        with conn:
            conn.execute("DELETE FROM memories WHERE id=?", (mem_id,))
            _delete_embedding(conn, mem_id)
        return {"ok": True, "deleted": mem_id}
    finally:
        if own_conn:
            conn.close()


def move_memory_date(
    mem_id: str,
    new_date: str,
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    """Re-date a memory addressed by its id — the fix for facts mis-filed under the
    wrong day (e.g. a whole import landing in today's bucket because no date was
    passed at create time). Content and slug are untouched; only the day moves."""
    if not new_date or not re.match(r"^\d{4}-\d{2}-\d{2}$", new_date.strip()):
        return {"ok": False, "error": "new_date must be a calendar date, YYYY-MM-DD"}
    new_date = new_date.strip()
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        auto_snapshot(conn)
        row = conn.execute(
            "SELECT id, granularity, slug FROM memories WHERE id=? AND kind='narrative'",
            (mem_id,),
        ).fetchone()
        if not row:
            return {"ok": False, "error": f"no memory with id {mem_id!r}"}
        # significant rows carry the slug INSIDE date_key (YYYY-MM-DD_slug); standalone
        # rows keep the plain date in date_key with the slug in its own column; journal
        # buckets have no slug. Rebuild date_key to match the row's shape.
        if row["granularity"] == "significant" and row["slug"]:
            new_dk = f"{new_date}_{row['slug']}"
        else:
            new_dk = new_date
        with conn:
            conn.execute(
                "UPDATE memories SET date_key=?, updated_at=? WHERE id=?",
                (new_dk, now_iso(), mem_id),
            )
        return {"ok": True, "id": mem_id, "date": new_dk}
    finally:
        if own_conn:
            conn.close()


# ── Embedding helpers ─────────────────────────────────────────────────────────

def _upsert_embedding(conn: sqlite3.Connection, record_id: str, content: str) -> None:
    try:
        from phylactery.embed import embed_text
        vec = embed_text(content[:2000])
        # sqlite-vec (vec0) virtual tables do NOT honor "INSERT OR REPLACE" /
        # UPSERT conflict resolution — re-embedding an existing memory_id raises
        # "UNIQUE constraint failed on memory_vecs primary key" instead of
        # replacing. Delete-then-insert is the documented safe pattern.
        conn.execute("DELETE FROM memory_vecs WHERE memory_id=?", (record_id,))
        conn.execute(
            "INSERT INTO memory_vecs(memory_id, embedding) VALUES (?, ?)",
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
