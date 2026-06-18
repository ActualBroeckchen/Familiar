-- Pillar C: per-fact memorization fields on the memories table.
-- category:        which remember-taxonomy bucket this fact falls into
--                  (basics | emotional_content | health_info | relationships | whereabouts).
-- consent_pending: 1 = ward has not yet consented to permanent storage (ask path).
--                  Familiar will surface these at the next chat turn and either
--                  confirm (memory_confirm_consent) or drop (memory_drop_pending).

ALTER TABLE memories ADD COLUMN category        TEXT;
ALTER TABLE memories ADD COLUMN consent_pending INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_memories_category        ON memories(category);
CREATE INDEX IF NOT EXISTS idx_memories_consent_pending ON memories(consent_pending);
