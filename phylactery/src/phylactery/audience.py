"""Audience gate utilities for Phylactery.

The trust model lives JS-side (`audience.js`): it computes the SET of audience
tags a room is cleared to see (`visibleAudiences()`) and passes it in. Phylactery
just turns that set into a SQL filter — no scoring is duplicated here.

- `audience_in_sql(audiences)` — the recall gate (Pillar E), the current path.
- `audience_filter_sql(room_tag)` — the older single-tag filter, kept ONLY for the
  dedup path in memory.py (`_find_near_duplicate`).

All records default to 'ward-private'; a ward-private room (audiences=None) sees
everything.
"""

from __future__ import annotations

WARD_PRIVATE = "ward-private"


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


def audience_in_sql(audiences, col: str = "audience") -> tuple[str, list]:
    """Recall gate (Pillar E). `audiences` is the SET of audience tags the room
    is cleared to see — computed JS-side by `visibleAudiences()` and passed in.

    - None  → no filter ('1=1'): a ward-private room sees everything.
    - []    → nothing ('0=1'): a room cleared for nothing surfaces nothing.
    - list  → `col IN (?,?,…)`.

    Note this does NOT auto-include 'ward-private': the JS ladder already excludes
    it for non-ward rooms, which is the whole point (the old audience_filter_sql
    leaked ward-private into every room — that bug is fixed by routing recall
    through here instead).
    """
    if audiences is None:
        return "1=1", []
    if not audiences:
        return "0=1", []
    placeholders = ",".join("?" * len(audiences))
    return f"{col} IN ({placeholders})", list(audiences)
