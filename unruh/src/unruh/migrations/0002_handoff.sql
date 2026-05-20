-- Session handoff (M6).
--
-- A handoff is the snapshot written when a session ends: what the
-- Familiar was doing ("active intent") plus unfinished business
-- ("open threads"). It surfaces at the top of the NEXT session's
-- [Temporal Context] so the Familiar picks up where it left off.
--
-- One row per session-end. get_handoff returns the most recent
-- unconsumed row; set_handoff supersedes (marks consumed) any prior
-- unconsumed rows first, so at most one handoff is ever live. The
-- consumed flag is what stops a handoff re-surfacing on every message
-- of the new session — it's flipped once the new session surfaces it.
CREATE TABLE IF NOT EXISTS handoff (
  id           TEXT PRIMARY KEY,           -- uuid4
  session_id   TEXT,                       -- client-provided source session id
  intent       TEXT,                       -- "what you were doing last"; may be NULL
  threads_json TEXT NOT NULL DEFAULT '[]', -- JSON array of open-thread strings
  consumed     INTEGER NOT NULL DEFAULT 0, -- 0 = surfaceable, 1 = done / superseded
  created_at   TEXT NOT NULL,              -- ISO-8601 UTC
  consumed_at  TEXT                        -- ISO-8601 UTC; NULL while unconsumed
);

CREATE INDEX IF NOT EXISTS idx_handoff_consumed_created ON handoff(consumed, created_at);
