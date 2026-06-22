"""Identity layer — always-injected (not vector-retrieved).

Files are stored as rows in identity_files, returned wholesale by
identity_get_all() in the same JSON shape entity-core used so
thalamus.js needs no changes until Pillar B.

The canonical ordering mirrors entity-core's context.ts ordering,
preserved here so the prompt assembly in thalamus.js stays unchanged.
"""

from __future__ import annotations

import re
import sqlite3
from typing import Any

from phylactery.db import get_conn, new_id, now_iso
from phylactery.snapshot import auto_snapshot

# Canonical file orderings (mirrors entity-core's context.ts + CLAUDE.md).
# 'user' was renamed to 'ward' at Pillar F — rename complete.
SELF_ORDER = [
    "base_instructions.md",
    "my_identity.md", "my_persona.md", "my_personhood.md",
    "my_wants.md", "my_mechanics.md",
]
WARD_ORDER = [
    "user_identity.md", "user_life.md", "user_beliefs.md",
    "user_preferences.md", "user_patterns.md", "user_notes.md",
]
RELATIONSHIP_ORDER = [
    "relationship_dynamics.md", "relationship_history.md", "relationship_notes.md",
]

_ORDER_MAP: dict[str, list[str]] = {
    "self": SELF_ORDER,
    "ward": WARD_ORDER,
    "relationship": RELATIONSHIP_ORDER,
}

VALID_CATEGORIES = {"self", "ward", "relationship", "custom"}


def _sort_key(filename: str, order: list[str]) -> tuple[int, str]:
    try:
        return (order.index(filename), filename)
    except ValueError:
        return (len(order), filename)


def _derive_prompt_label(filename: str) -> str:
    return re.sub(r"\.md$", "", filename).replace("-", "_").replace(" ", "_")


def get_all(conn: sqlite3.Connection | None = None, audience: str = "ward-private") -> dict[str, Any]:
    """Return all identity files in entity-core's response shape:
      { self: [{filename, content, promptLabel}], user: [...], ... }
    """
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT category, filename, content, prompt_label FROM identity_files ORDER BY sort_order, filename"
        ).fetchall()

        buckets: dict[str, list[dict]] = {"self": [], "ward": [], "relationship": [], "custom": []}
        for r in rows:
            cat = r["category"]
            if cat not in buckets:
                buckets[cat] = []
            buckets[cat].append({
                "filename": r["filename"],
                "content": r["content"] or "",
                "promptLabel": r["prompt_label"] or _derive_prompt_label(r["filename"]),
            })

        # Enforce canonical ordering within each category.
        for cat, order in _ORDER_MAP.items():
            buckets[cat].sort(key=lambda f: _sort_key(f["filename"], order))

        return buckets
    finally:
        if own_conn:
            conn.close()


def append_file(
    category: str,
    filename: str,
    content: str,
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    if category not in VALID_CATEGORIES:
        return {"ok": False, "error": f"invalid category: {category!r}"}
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        now = now_iso()
        row = conn.execute(
            "SELECT id, content FROM identity_files WHERE category=? AND filename=?",
            (category, filename),
        ).fetchone()
        if row:
            new_content = (row["content"] or "") + "\n" + content
            with conn:
                conn.execute(
                    "UPDATE identity_files SET content=?, updated_at=? WHERE id=?",
                    (new_content, now, row["id"]),
                )
        else:
            order = _ORDER_MAP.get(category, [])
            sort_order = _sort_key(filename, order)[0]
            with conn:
                conn.execute(
                    "INSERT INTO identity_files(id,category,filename,content,prompt_label,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                    (new_id(), category, filename, content, _derive_prompt_label(filename), sort_order, now, now),
                )
        return {"ok": True}
    finally:
        if own_conn:
            conn.close()


def _rewrite_section(content: str, section: str, new_body: str) -> str:
    """Replace the body of a markdown section heading."""
    pattern = re.compile(
        r"(^#+\s+" + re.escape(section) + r"\s*$)(.*?)(?=^#+|\Z)",
        re.MULTILINE | re.DOTALL,
    )
    replacement = r"\g<1>\n" + new_body.strip() + "\n\n"
    result, n = pattern.subn(replacement, content)
    if n == 0:
        # Section not found — append it.
        result = content.rstrip() + f"\n\n## {section}\n\n{new_body.strip()}\n"
    return result


def rewrite_section(
    category: str,
    filename: str,
    section: str,
    new_body: str,
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    if category not in VALID_CATEGORIES:
        return {"ok": False, "error": f"invalid category: {category!r}"}
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    try:
        auto_snapshot(conn)
        now = now_iso()
        row = conn.execute(
            "SELECT id, content FROM identity_files WHERE category=? AND filename=?",
            (category, filename),
        ).fetchone()
        if row:
            new_content = _rewrite_section(row["content"] or "", section, new_body)
            with conn:
                conn.execute(
                    "UPDATE identity_files SET content=?, updated_at=? WHERE id=?",
                    (new_content, now, row["id"]),
                )
        else:
            order = _ORDER_MAP.get(category, [])
            sort_order = _sort_key(filename, order)[0]
            new_content = f"## {section}\n\n{new_body.strip()}\n"
            with conn:
                conn.execute(
                    "INSERT INTO identity_files(id,category,filename,content,prompt_label,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                    (new_id(), category, filename, new_content, _derive_prompt_label(filename), sort_order, now, now),
                )
        return {"ok": True}
    finally:
        if own_conn:
            conn.close()
