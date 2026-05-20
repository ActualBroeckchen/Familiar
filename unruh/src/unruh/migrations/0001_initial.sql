-- Initial Unruh schema.
--
-- Two-layer graph: schedule (events / tasks / phases / states with
-- temporal-causal edges) lands in M3; interest (standing values /
-- live interests / curiosities with engagement edges) lands in M4.
-- Both layers share these tables, distinguished by `nodes.layer`,
-- so M4 doesn't need a schema migration — it just starts inserting
-- with layer='interest' and populating the M4-specific columns
-- (weight, last_touched) that are declared NULL here.

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id           TEXT PRIMARY KEY,                    -- uuid4
  layer        TEXT NOT NULL,                       -- 'schedule' (M3) | 'interest' (M4)
  type         TEXT NOT NULL,                       -- per-layer enum (see below)
  label        TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',          -- arbitrary per-type extras
  -- Schedule-layer time fields. NULL on interest-layer nodes.
  -- All timestamps are ISO-8601 UTC; rendering layer converts to local TZ.
  when_ts      TEXT,                                -- event/task start, phase start
  end_ts       TEXT,                                -- task deadline, phase end, event duration
  resolution   TEXT,                                -- 'done' | 'cancelled' | 'carried_forward' | NULL=open
  -- Interest-layer fields (M4). Declared now to avoid an M4 migration.
  weight       REAL,                                -- accumulated engagement weight
  last_touched TEXT,                                -- ISO-8601 UTC; for on-read decay
  -- Audit
  created_at   TEXT NOT NULL,                       -- ISO-8601 UTC
  updated_at   TEXT NOT NULL                        -- ISO-8601 UTC
);

CREATE INDEX IF NOT EXISTS idx_nodes_layer_type  ON nodes(layer, type);
CREATE INDEX IF NOT EXISTS idx_nodes_when_ts     ON nodes(when_ts);
CREATE INDEX IF NOT EXISTS idx_nodes_end_ts      ON nodes(end_ts);
CREATE INDEX IF NOT EXISTS idx_nodes_resolution  ON nodes(resolution);

-- Schedule node types: 'event' | 'task' | 'phase' | 'state'
-- Interest node types (M4): 'standing_value' | 'active_pursuit'
--                           | 'live_interest' | 'curiosity' | 'bookmark'

CREATE TABLE IF NOT EXISTS edges (
  id           TEXT PRIMARY KEY,                    -- uuid4
  src_id       TEXT NOT NULL,
  dst_id       TEXT NOT NULL,
  kind         TEXT NOT NULL,                       -- see below
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  FOREIGN KEY(src_id) REFERENCES nodes(id) ON DELETE CASCADE,
  FOREIGN KEY(dst_id) REFERENCES nodes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_edges_src  ON edges(src_id);
CREATE INDEX IF NOT EXISTS idx_edges_dst  ON edges(dst_id);
CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);

-- Schedule edge kinds: 'causes' | 'requires' | 'depends_on' | 'blocks'
--                     | 'during' | 'carries_forward'
-- Interest edge kinds (M4): 'engaged_with' | 'derived_from' | 'related_to'
--                          | 'bookmarked'
