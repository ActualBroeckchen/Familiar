"""Audience gate utility for Phylactery.

Disclosure rule: record M may surface in room R iff
  permission_score(R) >= required_score(M)

'ward-private' scores MAX — only the ward themselves can see it.
A category id scores below ward-private; broader categories score lower.

For Pillar A (standalone service): all records default to 'ward-private'.
When enrich() passes audienceTag='ward-private' (the default, from thalamus),
all records are returned (the ward sees their own full memory).

Full audience-gated recall arrives in Pillar B when thalamus passes real
room tags from Discord / village sessions.
"""

from __future__ import annotations

WARD_PRIVATE = "ward-private"

# Score mapping. ward-private has the highest score (most restrictive record,
# but accessible to the ward themselves who are the room when it's private).
# Category ids get lower scores based on trust level; add as Village categories
# are defined. Unknown category ids default to 0 (no access).
_SCORES: dict[str, int] = {
    WARD_PRIVATE: 1000,
}


def permission_score(audience_tag: str) -> int:
    """Score for a ROOM — what level of records can this room surface?"""
    return _SCORES.get(audience_tag, 0)


def required_score(record_audience: str) -> int:
    """Minimum score a room must have to surface a record tagged with this audience."""
    return _SCORES.get(record_audience, 0)


def is_allowed(record_audience: str, room_tag: str) -> bool:
    """Return True if record_audience is surfaceable in room_tag."""
    return permission_score(room_tag) >= required_score(record_audience)


def audience_filter_sql(room_tag: str, col: str = "audience") -> tuple[str, list]:
    """Return (WHERE clause fragment, params) to filter records for a room.

    When room_tag is 'ward-private', no filtering is applied (ward sees all).
    For other tags, only records with audience in the allowed set are returned.
    """
    if room_tag == WARD_PRIVATE:
        return "1=1", []
    # Conservative: only records explicitly tagged for this room or ward-private.
    # Full category-ladder gating comes in Pillar B.
    return f"{col} IN (?, ?)", [room_tag, WARD_PRIVATE]
