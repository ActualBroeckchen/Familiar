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

from phylactery.db import get_conn, insert_with_slug_retry, new_id, slug_id, now_iso
from phylactery.snapshot import auto_snapshot
from phylactery.audience import audience_filter_sql, audience_in_sql, WARD_PRIVATE
from phylactery.content_gate import memory_visible_to_grants

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

# The consent-review queue collapses MORE aggressively than the permanent store.
# A not-yet-reviewed fact only needs to reach the ward ONCE; a reworded
# restatement that lands just under the conservative store threshold should still
# fold into its pending sibling instead of asking twice. Moderate on purpose:
# high enough that two genuinely distinct pending facts stay separable for
# review (over-merging pendings is the one lossy failure — the ward would review
# a blob and lose the ability to keep one / drop the other), low enough to catch
# same-fact paraphrases the 0.78 store bar misses. Tunable against real queues.
_DEDUP_PENDING_MERGE_MIN = 0.70  # ≈ cosine 0.85


def _derive_slug(title: str | None, content: str) -> str:
    source = (title or content[:80]).strip()
    slug = re.sub(r"[^a-z0-9]+", "-", source.lower()).strip("-")
    return slug[:60] or f"memory-{now_iso()[:10]}"


def _today() -> str:
    return date.today().isoformat()


def _source_label(source_json: str | None) -> str | None:
    """A compact 'who caused this' label for recall results — surfaced ONLY when a
    memory was written by someone other than me (e.g. a villager acting through me
    on Discord). Returns None for my own memorization writes (the common case) so
    normal results stay clean. This is the Familiar-facing half of provenance: it
    lets me SEE a memory's source when I recall it, and decide whether to trust it."""
    if not source_json:
        return None
    try:
        s = json.loads(source_json)
    except Exception:
        return None
    via = s.get("via")
    if not via or via == "memorization":
        return None
    who = s.get("villager") or s.get("author")
    return f"{who} (via {via})" if who else str(via)


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
        "content_tag": (row["content_tag"] if "content_tag" in row.keys() else None) or "",
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


# The lowest a fuzzy-attribution memory can be pushed in ranking. It always
# stays retrievable (a floor, never zero) — the point is "downweight, never
# lose": a solid fact whose WHO is unresolved sinks below confident ones but is
# still there for a later sweep to fix.
_ATTRIBUTION_FLOOR = 0.2


def _attribution_weight(attribution_confidence) -> float:
    """Ranking multiplier for how sure we are WHO a memory is about. Unset/None
    (old rows, or a write that omitted it) → 1.0, so nothing is retroactively
    downweighted. A set value is clamped into [floor, 1.0] so a low-attribution
    memory is down-ranked but never filtered out."""
    if attribution_confidence is None:
        return 1.0
    try:
        v = float(attribution_confidence)
    except (TypeError, ValueError):
        return 1.0
    return max(_ATTRIBUTION_FLOOR, min(1.0, v))


# ── Search (RAG) ──────────────────────────────────────────────────────────────

def search(
    query: str,
    max_results: int = 5,
    audiences=None,
    topic_grants=None,
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    # audiences: the room's allowed audience-tag set (None = ward sees all),
    # computed JS-side by visibleAudiences() — the coarse provenance/ward-private
    # floor (Pillar E). topic_grants: the room's per-topic grant map (Phase 4
    # content gate) — None = ward/unscoped (no content filter). Both compose:
    # a memory surfaces only if it clears the audience floor AND its content_tag
    # is visible to the room's topic grants. Fail-closed at both.
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    gating = isinstance(topic_grants, dict)
    try:
        aud_clause, aud_params = audience_in_sql(audiences)
        try:
            from phylactery.embed import embed_text
            q_vec = embed_text(query)
            # KNN via sqlite-vec. Overfetch more when content-gating so the
            # per-row topic filter still leaves enough to return.
            k = max_results * (4 if gating else 2)
            rows = conn.execute(f"""
                SELECT m.id, m.granularity, m.register, m.date_key, m.content, m.audience,
                       m.content_tag, m.care_weight, m.last_recalled_at, m.source_json,
                       m.attribution_confidence,
                       v.distance
                FROM memory_vecs v
                JOIN memories m ON m.id = v.memory_id
                WHERE v.embedding MATCH ? AND k = ?
                  AND {aud_clause}
                ORDER BY v.distance
            """, [q_vec, k] + aud_params).fetchall()
            # Convert distance → similarity, apply retrieval-decay, re-sort.
            # score = similarity × decay_weight × attribution_weight
            # (down-rank only; never a filter cutoff). attribution_weight is the
            # memory's attribution_confidence, or 1.0 when unset — so a fact whose
            # WHO is fuzzy sinks in ranking but is never lost, while old/omitted
            # rows are untouched.
            scored = []
            for r in rows:
                if gating and not memory_visible_to_grants(r["content_tag"], topic_grants):
                    continue  # content-tag gate: not shared with this room
                dist = r["distance"] if "distance" in r.keys() else 0.0
                similarity = max(0.0, 1.0 - dist / 2.0)
                dw = _decay_weight(r["last_recalled_at"], r["care_weight"])
                aw = _attribution_weight(r["attribution_confidence"] if "attribution_confidence" in r.keys() else None)
                score = similarity * dw * aw
                item = {"id": r["id"], "granularity": r["granularity"], "register": r["register"],
                        "date": r["date_key"], "excerpt": (r["content"] or "")[:300], "score": round(score, 4)}
                if aw < 1.0:
                    item["attribution_confidence"] = round(aw, 2)
                lbl = _source_label(r["source_json"])
                if lbl:
                    item["source"] = lbl
                refs = _schedule_refs(r["source_json"])
                if refs:
                    item["schedule_refs"] = refs
                scored.append(item)
            scored.sort(key=lambda x: x["score"], reverse=True)
            results = scored[:max_results]
        except Exception:
            # Vector search unavailable (fastembed/sqlite-vec not ready) — degrade to recency.
            # Overfetch when gating so the post-filter still leaves enough.
            k = max_results * (4 if gating else 1)
            rows = conn.execute(f"""
                SELECT id, granularity, register, date_key, content, content_tag FROM memories
                WHERE kind='narrative' AND {aud_clause}
                ORDER BY updated_at DESC LIMIT ?
            """, aud_params + [k]).fetchall()
            results = [{"id": r["id"], "granularity": r["granularity"], "register": r["register"],
                        "date": r["date_key"], "excerpt": (r["content"] or "")[:300], "score": 0.5}
                       for r in rows
                       if not gating or memory_visible_to_grants(r["content_tag"], topic_grants)][:max_results]

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


def _schedule_refs(source_json: str | None) -> list[str] | None:
    """The schedule-node slugs a memory was cross-referenced to at extraction
    time (temporal-bridges Piece 2). Surfaced on recall so I can walk from a
    remembered fact to the scheduled moment it belongs to. None when absent."""
    if not source_json:
        return None
    try:
        s = json.loads(source_json)
    except Exception:
        return None
    refs = s.get("schedule_refs")
    if isinstance(refs, list) and refs:
        return [str(r) for r in refs if r]
    return None


def by_timerange(
    from_date: str,
    to_date: str,
    limit: int = 12,
    audiences=None,
    topic_grants=None,
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    """Recall memories anchored to a span of DAYS — 'what was happening around
    then' — the temporal counterpart to semantic search (temporal-bridges
    Piece 3). Compares on the calendar-date prefix so date_slug keys
    ('2026-07-02_foo') fall in range by their day. Audience-gated exactly like
    search: the coarse `audiences` floor AND the Phase 4 content-tag gate
    (`topic_grants`). Newest day first. No embedding call — an indexed read.
    `from_date`/`to_date` are inclusive YYYY-MM-DD bounds."""
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    gating = isinstance(topic_grants, dict)
    try:
        lo = str(from_date)[:10]
        hi = str(to_date)[:10]
        if lo > hi:
            lo, hi = hi, lo
        aud_clause, aud_params = audience_in_sql(audiences)
        k = max(1, min(50, int(limit or 12)))
        # Overfetch when content-gating so the per-row topic filter still leaves
        # enough rows to satisfy the limit.
        fetch = k * 4 if gating else k
        rows = conn.execute(f"""
            SELECT id, granularity, register, date_key, content, content_tag, source_json
              FROM memories
             WHERE kind='narrative'
               AND substr(date_key,1,10) BETWEEN ? AND ?
               AND {aud_clause}
             ORDER BY date_key DESC, updated_at DESC
             LIMIT ?
        """, [lo, hi] + aud_params + [fetch]).fetchall()
        results = []
        for r in rows:
            if gating and not memory_visible_to_grants(r["content_tag"], topic_grants):
                continue  # content-tag gate: not shared with this room
            item = {
                "id": r["id"], "granularity": r["granularity"], "register": r["register"],
                "date": r["date_key"], "excerpt": (r["content"] or "")[:300],
            }
            lbl = _source_label(r["source_json"])
            if lbl:
                item["source"] = lbl
            refs = _schedule_refs(r["source_json"])
            if refs:
                item["schedule_refs"] = refs
            results.append(item)
            if len(results) >= k:
                break
        return {"results": results, "from": lo, "to": hi}
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
                         standalone_only: bool = False, *,
                         threshold: float = _DEDUP_MERGE_MIN,
                         ignore_audience: bool = False):
    """Nearest existing narrative memory to `content`, if it's similar enough to
    be a duplicate. Returns (id, content, consent_pending, similarity) or None.
    Degrades to None (→ normal insert) if embeddings are unavailable.

    standalone_only restricts the search to per-fact / significant rows (those
    with a slug), so a discrete extracted fact dedups against other discrete
    facts and never folds itself into a date-bucketed daily journal blob.

    threshold is the minimum similarity to count as a duplicate — the confirmed
    store uses the conservative default; the pending queue passes a looser bar.
    ignore_audience drops the audience-scope filter: a not-yet-reviewed fact is a
    duplicate of the same fact regardless of which room-tag it was derived under
    (audience still gates where a memory SURFACES, just not whether it's a dup)."""
    try:
        from phylactery.embed import embed_text
        q_vec = embed_text(content)
        if ignore_audience:
            aud_clause, aud_params = "1=1", []
        else:
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
        if sim < threshold:
            return None
        return (row["id"], row["content"], row["consent_pending"], sim)
    except Exception:
        return None


def vector_health(conn: sqlite3.Connection | None = None) -> dict:
    """Probe the vector stack that semantic dedup depends on, so a silent
    degradation is observable (CLAUDE.md: failures that matter must be visible).
    Reports whether the embedder loads and whether memory_vecs is queryable,
    and which dedup mode is therefore in effect. Never raises."""
    own = conn is None
    if own:
        conn = get_conn()
    try:
        embed_ok, embed_err = False, None
        try:
            from phylactery.embed import embed_text
            embed_text("health probe")
            embed_ok = True
        except Exception as e:
            embed_err = f"{type(e).__name__}: {e}"
        vec_ok, vec_err, vec_rows, mem_rows = False, None, None, None
        try:
            vec_rows = conn.execute("SELECT COUNT(*) AS c FROM memory_vecs").fetchone()["c"]
            mem_rows = conn.execute(
                "SELECT COUNT(*) AS c FROM memories WHERE kind='narrative'"
            ).fetchone()["c"]
            vec_ok = True
        except Exception as e:
            vec_err = f"{type(e).__name__}: {e}"
        healthy = embed_ok and vec_ok
        return {
            "ok": True,
            "healthy": healthy,
            "dedup_mode": "semantic" if healthy else "lexical-fallback",
            "embed_ok": embed_ok, "embed_error": embed_err,
            "vec_ok": vec_ok, "vec_error": vec_err,
            "vec_rows": vec_rows, "memory_rows": mem_rows,
        }
    finally:
        if own:
            conn.close()


def remap_audiences(conn: sqlite3.Connection | None = None, id_map: dict | None = None) -> dict:
    """Rewrite stored category-id `audience` values after the Village
    category-slug migration (Node side): a memory / graph node / graph edge whose
    audience is an OLD category id becomes its NEW slug.

    Only rows whose audience is a key in `id_map` are touched — 'ward-private' and
    anything already on a slug are left alone — so this is idempotent (a second
    run matches nothing). Fail-safe: an empty/malformed map is a no-op, and a
    same-value entry (old == new) is skipped. Never raises."""
    own = conn is None
    if own:
        conn = get_conn()
    try:
        if not isinstance(id_map, dict) or not id_map:
            return {"ok": True, "memories": 0, "nodes": 0, "edges": 0}
        mem = nodes = edges = 0
        for old, new in id_map.items():
            if not old or not new or old == new:
                continue
            mem   += conn.execute("UPDATE memories    SET audience=? WHERE audience=?", (new, old)).rowcount
            nodes += conn.execute("UPDATE graph_nodes SET audience=? WHERE audience=?", (new, old)).rowcount
            edges += conn.execute("UPDATE graph_edges SET audience=? WHERE audience=?", (new, old)).rowcount
        conn.commit()
        return {"ok": True, "memories": mem, "nodes": nodes, "edges": edges}
    finally:
        if own:
            conn.close()


def backfill_content_tags(conn: sqlite3.Connection | None = None, limit: int | None = None) -> dict:
    """Set `content_tag` on narrative memories that don't have one yet (rows from
    before Phase 3), deriving it from the stored `category` via category_to_tag.
    Idempotent — a second run finds none. Runs in the background at boot when a
    gap is seen (mirrors the embedding backfill). Never raises."""
    own = conn is None
    if own:
        conn = get_conn()
    try:
        q = ("SELECT id, category FROM memories "
             "WHERE kind='narrative' AND (content_tag IS NULL OR content_tag='')")
        if isinstance(limit, int) and limit > 0:
            q += f" LIMIT {int(limit)}"
        rows = conn.execute(q).fetchall()
        n = 0
        for r in rows:
            conn.execute("UPDATE memories SET content_tag=? WHERE id=?",
                         (category_to_tag(r["category"]), r["id"]))
            n += 1
        conn.commit()
        remaining = conn.execute(
            "SELECT COUNT(*) AS c FROM memories "
            "WHERE kind='narrative' AND (content_tag IS NULL OR content_tag='')"
        ).fetchone()["c"]
        return {"ok": True, "tagged": n, "remaining": remaining}
    finally:
        if own:
            conn.close()


def _find_lexical_duplicate(conn: sqlite3.Connection, content: str, audience: str,
                            standalone_only: bool = False, *,
                            ignore_audience: bool = False, limit: int = 300):
    """Embedding-FREE duplicate finder — the graceful-degradation net for when
    the vector stack is unavailable (fastembed model not downloaded, or the
    sqlite-vec extension can't load). Without this, a dead vector stack silently
    disables ALL dedup and the consent queue floods with the same facts every
    session — a silent failure with only an stderr line as signal.

    Conservative on purpose: matches only when the new fact's normalized text is
    CONTAINED in an existing entry (equality included), i.e. the new fact adds
    nothing lexically. That can't conflate two genuinely different facts (the
    risk the vector threshold guards against), so it's safe to run even when
    vectors are healthy — it just catches verbatim / near-verbatim restatements
    the vector search might rank a hair below threshold, or rows that never got
    embedded. Returns (id, content, consent_pending, 1.0) or None.
    """
    n_new = _norm_text(content)
    if not n_new:
        return None
    if ignore_audience:
        aud_clause, aud_params = "1=1", []
    else:
        aud_clause, aud_params = audience_filter_sql(audience)
    slug_clause = " AND slug IS NOT NULL" if standalone_only else ""
    rows = conn.execute(f"""
        SELECT id, content, consent_pending FROM memories
        WHERE kind='narrative'{slug_clause} AND {aud_clause}
        ORDER BY updated_at DESC
        LIMIT ?
    """, aud_params + [limit]).fetchall()
    for r in rows:
        if n_new in _norm_text(r["content"] or ""):
            return (r["id"], r["content"], r["consent_pending"], 1.0)
    return None


def _find_duplicate(conn, content, audience, standalone_only, *,
                    threshold, ignore_audience):
    """Vector-first duplicate finder with a lexical fallback. The vector path
    catches paraphrase; the lexical path is the net when vectors are down or a
    row was never embedded. Returns the vector hit if there is one, else the
    lexical hit, else None."""
    dup = _find_near_duplicate(conn, content, audience, standalone_only=standalone_only,
                               threshold=threshold, ignore_audience=ignore_audience)
    if dup is not None:
        return dup
    return _find_lexical_duplicate(conn, content, audience,
                                   standalone_only=standalone_only, ignore_audience=ignore_audience)


def _dedup_merge_pending(conn, content, audience, now, standalone_only: bool):
    """Dedup for a not-yet-reviewed (consent_pending) incoming fact.

    The review queue's job is to show the ward each distinct new thing ONCE, so
    it collapses harder than the permanent store and ignores audience scoping:
      - near-dup of another PENDING fact → fold together, so the queue holds one
        candidate instead of five paraphrases (the reported pile-up).
      - near-dup of an already-CONFIRMED memory → DROP the incoming: the ward
        already greenlit this, re-asking is the churn they complained about. The
        confirmed row is left UNTOUCHED — new unreviewed wording never folds into
        a memory that already passed consent (that would slip text past review).
    Returns a create-style result on a hit, or None (caller inserts normally)."""
    dup = _find_duplicate(conn, content, audience, standalone_only,
                          threshold=_DEDUP_PENDING_MERGE_MIN, ignore_audience=True)
    if dup is None:
        return None
    dup_id, dup_content, dup_pending, sim = dup
    import sys
    if not dup_pending:
        # Already known and consented — honour it silently, don't re-ask.
        print(f"[phylactery] dedup: pending fact already held as confirmed memory {dup_id} "
              f"(sim {sim:.2f}); dropped without re-asking", file=sys.stderr)
        return {"ok": True, "id": dup_id, "merged": True, "already_known": True}
    # Both pending — safe to collapse into the sibling already in the queue.
    if sim >= _DEDUP_IDENTICAL_MIN or _lexically_contained(content, dup_content):
        with conn:
            conn.execute("UPDATE memories SET updated_at=? WHERE id=?", (now, dup_id))
        print(f"[phylactery] dedup: pending restatement folded into pending {dup_id} "
              f"(sim {sim:.2f})", file=sys.stderr)
        return {"ok": True, "id": dup_id, "merged": True,
                "identical": sim >= _DEDUP_IDENTICAL_MIN}
    new_content = (dup_content or "") + "\n" + content
    with conn:
        conn.execute("UPDATE memories SET content=?, updated_at=? WHERE id=?", (new_content, now, dup_id))
    _upsert_embedding(conn, dup_id, new_content)
    print(f"[phylactery] dedup: pending detail merged into pending {dup_id} (sim {sim:.2f})", file=sys.stderr)
    return {"ok": True, "id": dup_id, "merged": True}


def _dedup_merge(conn, content, audience, consent_pending, now, source,
                 standalone_only: bool = False):
    """If `content` duplicates an existing memory, fold it in and return a
    create-style result; otherwise return None (caller inserts normally)."""
    # A not-yet-reviewed fact takes the aggressive, audience-agnostic queue path
    # (kept separate so the conservative confirmed-store behaviour below is
    # unchanged — the threshold that protects long-term memory from conflating
    # two real facts is never loosened).
    if consent_pending:
        return _dedup_merge_pending(conn, content, audience, now, standalone_only)

    dup = _find_duplicate(conn, content, audience, standalone_only,
                          threshold=_DEDUP_MERGE_MIN, ignore_audience=False)
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


# Content-gating (Phase 3): the legacy content `category` → a "topic:level" tag,
# mirroring content-tags.js `categoryToTag` (the Node side is the source of
# truth; kept in sync by hand like the graph-vocab duplication). Used as the
# fall-back when the extractor didn't supply an explicit tag, and by the
# backfill for pre-tag rows.
_CATEGORY_TO_TOPIC = {
    "basics": "general",
    "emotional_content": "mental-health",
    "health_info": "medical",
    "relationships": "relationships",
    "whereabouts": "location",
    "views": "general",
}
_TAG_SENSITIVE_CATEGORIES = {"emotional_content", "health_info"}


def category_to_tag(category: str | None) -> str:
    """A `"topic:level"` content tag for a legacy content category. Fail-safe:
    an unknown/None category → `general:open`."""
    topic = _CATEGORY_TO_TOPIC.get(category or "", "general")
    level = "sensitive" if category in _TAG_SENSITIVE_CATEGORIES else "open"
    return f"{topic}:{level}"


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
    content_tag: str | None = None,
    consent_pending: bool = False,
    confidence: float = 1.0,
    attribution_confidence: float | None = None,
    standalone: bool = False,
    register: str = "episodic",
    source_meta: dict | None = None,
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
                slug = _derive_slug(None, content)
        else:
            dk = date_key or _today()
            slug = None

        # Provenance. `source_meta` (when a write is attributable to someone other
        # than me — e.g. a villager acting through me on Discord) is merged in and
        # may override `via`, so a memory carries WHO caused it. This is what lets
        # the Familiar reevaluate later whether to trust a given source.
        src = {"author": source_author, "via": "memorization", "at": now}
        if source_meta:
            src.update(source_meta)
        source = json.dumps(src)

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

            # Model-facing id is a content-derived slug ("low-on-tea-k3"), not a
            # uuid4 hex — the mandatory readable-id convention (db.slug_id). The
            # id rides out in recall / the consent block / graduation, so the
            # Familiar repeats a legible, greppable id instead of ~16 tokens of
            # meaningless hex. Legacy hex ids stay valid (ids are opaque TEXT).
            # Content tag: the extractor's explicit tag, else derived from the
            # category (never left NULL on a fresh fact, so the Phase 4 gate
            # always has a value to reason about).
            tag = (content_tag or "").strip() or category_to_tag(category)
            # NULL when unset → recall treats it as fully attributed (weight 1.0),
            # so a write that omits it is never downweighted.
            attr_conf = None if attribution_confidence is None else max(0.0, min(1.0, attribution_confidence))
            insert_sql = """
                INSERT INTO memories(id,kind,register,granularity,date_key,slug,content,
                    audience,subjects_json,care_weight,category,content_tag,consent_pending,
                    confidence,attribution_confidence,source_json,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """
            rec_id = insert_with_slug_retry(
                conn, insert_sql,
                lambda cid: (cid, "narrative", register, granularity, dk, slug,
                             content, audience, subj_json, care_weight, category, tag,
                             1 if consent_pending else 0, max(0.0, min(1.0, confidence)),
                             attr_conf, source, now, now),
                label=content, kind="mem",
            )

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
    register: str | None = None,
) -> list[dict]:
    """Newest-first browse. `register` narrows to one register — e.g. 'me', the
    standing truths I hold about myself, which the chat turn reads back so what
    I've come to think actually reaches me."""
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        where = ["kind='narrative'"]
        params: list = []
        if granularity:
            where.append("granularity=?"); params.append(granularity)
        if register:
            where.append("register=?"); params.append(register)
        rows = conn.execute(
            "SELECT id,granularity,register,date_key,content,audience,content_tag,care_weight FROM memories "
            f"WHERE {' AND '.join(where)} ORDER BY date_key DESC, rowid DESC LIMIT ? OFFSET ?",
            (*params, limit, offset),
        ).fetchall()
        return [_row_to_list_item(r) for r in rows]
    finally:
        if own_conn:
            conn.close()


def list_content_gate_candidates(
    limit: int = 40,
    conn: sqlite3.Connection | None = None,
) -> list[dict]:
    """Ward-about-self memories still tagged coarse 'ward-private' — the input to
    the Familiar-curated content-gating re-tag pass (ward-disclosure build spec,
    Phase B). Selects ONLY facts with NO third-party subject (subjects_json is
    the empty list), so the pass can never touch a fact about someone else — a
    third-party fact stays on the coarse circle gate, always. Narrative rows
    only, newest first. Returns id + content + current content_tag + category so
    the Familiar can judge each with full context (and correct a coarse
    backfill-derived content_tag while it's there)."""
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT id, date_key, granularity, register, content, content_tag, category "
            "FROM memories "
            "WHERE kind='narrative' AND audience='ward-private' "
            "AND (subjects_json IS NULL OR subjects_json='' OR subjects_json='[]') "
            "ORDER BY date_key DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [
            {
                "id": r["id"],
                "date": r["date_key"],
                "granularity": r["granularity"],
                "register": r["register"],
                "content": r["content"],
                "content_tag": (r["content_tag"] if "content_tag" in r.keys() else "") or "",
                "category": (r["category"] if "category" in r.keys() else "") or "",
            }
            for r in rows
        ]
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
            "SELECT id, granularity, register, date_key, slug, content, audience, content_tag, care_weight "
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
            "content_tag": row["content_tag"] or "",
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
    content_tag: str | None = None,
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
        if content_tag is not None:
            # The ward's edit is authoritative but still normalised in code (the
            # exact-values rule): an unrecognised value is stored as-is only if
            # blank-cleared, else canonicalised to a real topic:level below via
            # the caller. Here we just persist the string the endpoint validated.
            sets.append("content_tag=?")
            params.append(content_tag if content_tag != "" else None)
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


def _unembedded_narrative(conn: sqlite3.Connection) -> list:
    """Narrative memories with content but NO vector row. Raises if the vec
    table is unavailable (caller decides how to degrade)."""
    return conn.execute("""
        SELECT m.id, m.content FROM memories m
        LEFT JOIN memory_vecs v ON v.memory_id = m.id
        WHERE m.kind='narrative' AND v.memory_id IS NULL
          AND m.content IS NOT NULL AND TRIM(m.content) != ''
        ORDER BY m.updated_at DESC
    """).fetchall()


def backfill_embeddings(conn: sqlite3.Connection | None = None, *, limit: int | None = None) -> dict:
    """Embed narrative memories that have content but no vector row — heals the
    gap left by bulk inserts that skipped embedding (notably the entity-core
    migration, which INSERT-ORs rows without a vector). Those rows are invisible
    to semantic dedup, so a new fact paraphrasing a migrated memory can't match
    it and re-queues — a real contributor to the consent-queue pile-up. Runs the
    embedder in-process; idempotent (a fully-embedded store is a no-op). Never
    raises. Returns {ok, embedded, remaining, total_gap}."""
    own = conn is None
    if own:
        conn = get_conn()
    try:
        try:
            rows = _unembedded_narrative(conn)
        except Exception as e:
            return {"ok": False, "error": f"vec table unavailable: {e}", "embedded": 0}
        total_gap = len(rows)
        if not rows:
            return {"ok": True, "embedded": 0, "remaining": 0, "total_gap": 0}
        # Confirm the embedder loads before churning through the batch.
        try:
            from phylactery.embed import embed_text
            embed_text("health probe")
        except Exception as e:
            return {"ok": False, "error": f"embedder unavailable: {e}",
                    "embedded": 0, "remaining": total_gap, "total_gap": total_gap}
        todo = rows[:limit] if limit else rows
        embedded = 0
        for r in todo:
            before = conn.total_changes
            _upsert_embedding(conn, r["id"], r["content"])
            # _upsert_embedding swallows its own errors; count only real inserts.
            if conn.total_changes > before:
                embedded += 1
        remaining = len(_unembedded_narrative(conn))
        return {"ok": True, "embedded": embedded, "remaining": remaining, "total_gap": total_gap}
    finally:
        if own:
            conn.close()


# Legacy hex/uuid id shape — memories created before the readable-id fix.
_LEGACY_ID_RE = re.compile(
    r"^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone() is not None


def ids_to_slugs(conn: sqlite3.Connection | None = None) -> dict:
    """One-shot mechanical re-key of legacy hex/uuid memory ids to readable
    content-derived slugs — mirrors graph.ids_to_slugs. Updates every reference
    (the memory_vecs embedding row, graduation_log.memory_id, and the dormant
    tracker_entries.tracker_id FK if present) and preserves each embedding by
    COPYING its bytes to the new key — so it works even when the embedder is
    unavailable (no re-embedding). Idempotent (only touches legacy-shaped ids);
    one transaction with foreign_keys off. Returns {ok, remapped, mapping}."""
    own = conn is None
    if own:
        conn = get_conn()
    try:
        taken = {r["id"] for r in conn.execute("SELECT id FROM memories")}
        mapping: dict[str, str] = {}

        def fresh(content: str) -> str:
            for suffix_len in (2, 3, 5):
                cand = slug_id((content or "")[:80], kind="mem", suffix_len=suffix_len)
                if cand not in taken:
                    taken.add(cand)
                    return cand
            cand = new_id()
            taken.add(cand)
            return cand

        has_grad = _table_exists(conn, "graduation_log")
        has_tracker = _table_exists(conn, "tracker_entries")
        has_vecs = _table_exists(conn, "memory_vecs")

        # PRAGMA foreign_keys is a no-op inside a transaction — commit any
        # in-flight implicit one first so the toggle applies.
        conn.commit()
        conn.execute("PRAGMA foreign_keys = OFF")
        try:
            with conn:
                remapped = 0
                rows = conn.execute("SELECT id, content FROM memories").fetchall()
                for r in rows:
                    if not _LEGACY_ID_RE.match(r["id"]):
                        continue
                    old = r["id"]
                    new = fresh(r["content"])
                    mapping[old] = new
                    conn.execute("UPDATE memories SET id=? WHERE id=?", (new, old))
                    if has_grad:
                        conn.execute("UPDATE graduation_log SET memory_id=? WHERE memory_id=?", (new, old))
                    if has_tracker:
                        conn.execute("UPDATE tracker_entries SET tracker_id=? WHERE tracker_id=?", (new, old))
                    # Re-key the embedding row by COPYING its bytes (vec0 can't
                    # UPDATE its PK; and copying avoids needing the embedder).
                    if has_vecs:
                        try:
                            vrow = conn.execute(
                                "SELECT embedding FROM memory_vecs WHERE memory_id=?", (old,)
                            ).fetchone()
                            conn.execute("DELETE FROM memory_vecs WHERE memory_id=?", (old,))
                            if vrow is not None:
                                conn.execute(
                                    "INSERT INTO memory_vecs(memory_id, embedding) VALUES(?,?)",
                                    (new, vrow["embedding"]),
                                )
                        except Exception:
                            pass  # vec stack unavailable → skip (dedup already degraded)
                    remapped += 1
        finally:
            conn.execute("PRAGMA foreign_keys = ON")
        return {"ok": True, "remapped": remapped, "mapping": mapping}
    finally:
        if own:
            conn.close()


def list_by_subject(villager_id: str, limit: int = 50,
                    conn: sqlite3.Connection | None = None) -> list[dict]:
    """Kept memories where the given villager is a SUBJECT — thin
    projections (id, category, brief, date), newest first.

    Backs the villager consent menu: a person may see what I hold about
    them. Matching is on the exact quoted id inside subjects_json (ids are
    slugs — no quote characters), so a substring id can't false-match.
    Consent-pending rows are excluded here; they surface separately as
    "planned" items.
    """
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT id, category, content, date_key, created_at FROM memories "
            "WHERE kind='narrative' AND consent_pending=0 AND subjects_json LIKE ? "
            "ORDER BY created_at DESC LIMIT ?",
            (f'%"{villager_id}"%', int(limit)),
        ).fetchall()
        return [{
            "id": r["id"],
            "category": r["category"],
            "brief": (r["content"] or "")[:160],
            "date": r["date_key"],
        } for r in rows]
    finally:
        if own_conn:
            conn.close()


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
