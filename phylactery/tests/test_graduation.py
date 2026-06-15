"""Tests for the human-signed graduation-eligibility rule (Pillar H).

These guard the safety boundary: what may LEAVE the always-injected surface.
False positives (keeping too long) are cheap; false negatives (filing a
safety-relevant fact away) are not — so the bias is toward NOT graduating.
"""

from datetime import datetime, timedelta, timezone

from phylactery import graduation as grad


NOW = datetime(2026, 6, 15, tzinfo=timezone.utc)


def _iso(days_ago: float) -> str:
    return (NOW - timedelta(days=days_ago)).isoformat()


def _base(**over):
    """An otherwise-eligible record: old, never recalled, never re-confirmed."""
    rec = {
        "care_weight": None,
        "category": None,
        "content": "my human likes the colour teal",
        "dwell_anchor": _iso(120),
        "last_recalled_at": None,
        "last_confirmed_at": None,
    }
    rec.update(over)
    return rec


# ── The happy path: ordinary, stale detail graduates ─────────────────────────

def test_old_unrecalled_ordinary_fact_is_eligible():
    assert grad.is_graduation_eligible(_base(), NOW) is True


# ── Hard exclusions (pinned, never graduate) ─────────────────────────────────

def test_care_weight_high_never_graduates():
    assert grad.is_graduation_eligible(_base(care_weight="high"), NOW) is False
    assert grad.is_graduation_eligible(_base(care_weight="HIGH"), NOW) is False


def test_care_categories_never_graduate():
    for cat in ("health_info", "crisis", "support-map"):
        assert grad.is_graduation_eligible(_base(category=cat), NOW) is False, cat


def test_care_critical_content_never_graduates():
    for content in (
        "allergic to penicillin",
        "takes 50mg of sertraline daily",
        "crisis line is 988",
        "what helps when she spirals: a walk",
        "do not mention her father",
        "keeps an epipen in the kitchen drawer",
    ):
        assert grad.is_graduation_eligible(_base(content=content), NOW) is False, content


def test_recently_confirmed_never_graduates():
    assert grad.is_graduation_eligible(_base(last_confirmed_at=_iso(5)), NOW) is False
    # Just outside the window is fine.
    assert grad.is_graduation_eligible(_base(last_confirmed_at=_iso(40)), NOW) is True


# ── Candidate gate (must clear all of these) ─────────────────────────────────

def test_too_new_on_surface_not_eligible():
    assert grad.is_graduation_eligible(_base(dwell_anchor=_iso(5)), NOW) is False


def test_missing_dwell_anchor_not_eligible():
    assert grad.is_graduation_eligible(_base(dwell_anchor=None), NOW) is False


def test_recently_recalled_not_eligible():
    assert grad.is_graduation_eligible(_base(last_recalled_at=_iso(3)), NOW) is False
    # Recalled long ago → still eligible.
    assert grad.is_graduation_eligible(_base(last_recalled_at=_iso(90)), NOW) is True


def test_never_recalled_counts_as_eligible_by_recall():
    # last_recalled_at None means it has faded from front-of-mind.
    assert grad.is_graduation_eligible(_base(last_recalled_at=None), NOW) is True


# ── contains_care_critical matcher ───────────────────────────────────────────

def test_care_matcher_is_broad_but_not_everything():
    assert grad.contains_care_critical("medication list") is True
    assert grad.contains_care_critical("she's allergic to cats") is True
    assert grad.contains_care_critical(None) is False
    assert grad.contains_care_critical("favourite film is Arrival") is False
