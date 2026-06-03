-- Bookmark surfacing tracking (M8).
--
-- Adds idle-mode surfacing metadata to the nodes table so Unruh can
-- decide when to re-surface a bookmark (resurface_after_hours),
-- remember the last time it was shown (last_surfaced_at), record
-- whether the user engaged with it (last_surfacing_outcome), and
-- track consecutive ignores to apply an adaptive decay when a bookmark
-- is repeatedly skipped (consecutive_ignores).
--
-- These columns are only meaningful on type='bookmark' interest-layer
-- nodes. NULL on all other rows is intentional — no per-type table
-- split needed at this scale.
--
-- resurface_after_hours adaptive rules (applied in interest.py):
--   outcome='engaged' → interval *= 1.5, capped at 168h (1 week)
--   outcome='ignored' → interval *= 0.75, floored at 4h
--   3+ consecutive ignores → apply a small weight-decay bump on the
--     parent topic so the interest layer can deprioritise it naturally.

ALTER TABLE nodes ADD COLUMN last_surfaced_at      TEXT;
ALTER TABLE nodes ADD COLUMN last_surfacing_outcome TEXT;          -- 'engaged' | 'ignored' | NULL=never surfaced
ALTER TABLE nodes ADD COLUMN resurface_after_hours  REAL NOT NULL DEFAULT 24.0;
ALTER TABLE nodes ADD COLUMN consecutive_ignores    INTEGER NOT NULL DEFAULT 0;

-- Fast lookup for the due-bookmark query in idle mode:
--   WHERE type='bookmark' AND (last_surfaced_at IS NULL OR due expression)
CREATE INDEX IF NOT EXISTS idx_nodes_bookmark_surfacing
  ON nodes(type, last_surfaced_at) WHERE layer = 'interest';
