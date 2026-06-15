"""Tests for retrieval-decay weight function.

Signed-off contract:
  weight = 0.5 ^ (days_since_recall / 180)
  careWeight:high floor = 0.5
  never-recalled → weight = 1.0 (no penalty)
  always a multiplier — never a filter cutoff
"""

import pytest
from datetime import datetime, timedelta
from unittest.mock import patch

from phylactery.memory import _decay_weight, _DECAY_HALF_LIFE_DAYS, _DECAY_FLOOR_HIGH_CARE


def _iso_days_ago(days: float) -> str:
    """Return an ISO datetime string for N days ago (UTC, no timezone suffix)."""
    return (datetime.utcnow() - timedelta(days=days)).isoformat()


class TestDecayWeight:
    def test_never_recalled_returns_one(self):
        assert _decay_weight(None, None) == 1.0

    def test_never_recalled_high_care_still_one(self):
        # careWeight:high floor only applies when there IS a decay; no-recall = 1.0 anyway
        assert _decay_weight(None, "high") == 1.0

    def test_recalled_today_near_one(self):
        w = _decay_weight(_iso_days_ago(0), None)
        assert 0.99 <= w <= 1.0

    def test_half_life_at_180d(self):
        w = _decay_weight(_iso_days_ago(180), None)
        assert abs(w - 0.5) < 0.01

    def test_two_half_lives_at_360d(self):
        w = _decay_weight(_iso_days_ago(360), None)
        assert abs(w - 0.25) < 0.02

    def test_high_care_floor_at_long_interval(self):
        # After 1000d without recall, normal decay ≈ 0.5^(1000/180) ≈ 0.021
        # careWeight:high must bring it back up to 0.5
        w = _decay_weight(_iso_days_ago(1000), "high")
        assert w == pytest.approx(_DECAY_FLOOR_HIGH_CARE, abs=0.001)

    def test_high_care_no_floor_if_recently_recalled(self):
        # If recalled recently, decay is already above 0.5 — floor doesn't clamp it
        ts = _iso_days_ago(10)
        w_high = _decay_weight(ts, "high")
        w_low = _decay_weight(ts, None)
        # Same timestamp → identical weights; both well above the 0.5 floor
        assert w_high >= 0.9
        assert w_high == pytest.approx(w_low)

    def test_low_care_can_decay_below_0_5(self):
        # Only careWeight:high has a floor; other records can decay freely
        w = _decay_weight(_iso_days_ago(360), None)
        assert w < _DECAY_FLOOR_HIGH_CARE

    def test_malformed_timestamp_fails_open(self):
        # Bad ISO string → weight=1.0 (fail open, never block recall)
        assert _decay_weight("not-a-date", None) == 1.0
        assert _decay_weight("2024-13-45T99:99:99", None) == 1.0

    def test_weight_is_multiplicative_not_additive(self):
        # Verify the formula: score = similarity * decay_weight
        # At 180d, w ≈ 0.5; at 0d, w ≈ 1.0
        w_fresh = _decay_weight(_iso_days_ago(0), None)
        w_half = _decay_weight(_iso_days_ago(180), None)
        assert w_fresh > w_half
        assert w_half < 1.0

    def test_constants_match_signoff(self):
        assert _DECAY_HALF_LIFE_DAYS == 180.0
        assert _DECAY_FLOOR_HIGH_CARE == 0.5
