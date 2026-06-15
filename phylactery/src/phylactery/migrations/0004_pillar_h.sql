-- Pillar H — lifecycle: recall tracking + graduation log.
--
-- Recall tracking is pure observability: search() bumps these so the
-- graduation gate (and a future, separately-signed-off retrieval-decay
-- knob) can tell front-of-mind records from never-recalled ones. It
-- never changes recall ordering on its own.

ALTER TABLE memories ADD COLUMN last_recalled_at TEXT;
ALTER TABLE memories ADD COLUMN recall_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_memories_last_recalled ON memories(last_recalled_at);

-- Identity files gain the same recall/dwell anchors so the graduation
-- audit can reason about "how long since this block was last touched".
-- last_graduation_skip records the last time the audit looked at a file
-- and chose to keep it, so a kept block isn't re-offered every tick.
ALTER TABLE identity_files ADD COLUMN last_graduated_at TEXT;

-- Graduation log — every graduation the audit performs, for observability
-- and so thalamus can surface ward-block graduations to the ward
-- (ward-consulted, non-blocking) and offer pull-back.
CREATE TABLE IF NOT EXISTS graduation_log (
  id              TEXT PRIMARY KEY,
  source_category TEXT NOT NULL,   -- 'self' | 'ward' (the always-injected block it left)
  source_filename TEXT,
  memory_id       TEXT,            -- the new me/ward register memory record
  register        TEXT NOT NULL,   -- 'me' | 'ward'
  summary         TEXT NOT NULL,   -- short description of what was filed away
  acknowledged    INTEGER NOT NULL DEFAULT 0,  -- ward has seen the mention
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_graduation_log_ack ON graduation_log(acknowledged);
