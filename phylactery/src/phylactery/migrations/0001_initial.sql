-- Phylactery initial schema.
--
-- All records carry audience + timestamps + caretaker metadata as native
-- fields — the outgoing filter (Pillar D) depends on this being total.
-- sqlite-vec virtual tables (memory_vecs, graph_node_vecs) require the
-- vec0 extension to be loaded on every connection; db.py handles this.

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ── Identity files (always-injected; not vector-retrieved) ────────────────────
-- Category 'user' was renamed to 'ward' at Pillar F.
-- All new records use 'ward'; migration 0003 converted existing rows.

CREATE TABLE IF NOT EXISTS identity_files (
  id           TEXT PRIMARY KEY,
  category     TEXT NOT NULL,   -- 'self' | 'ward' | 'relationship' | 'custom'
  filename     TEXT NOT NULL,
  content      TEXT NOT NULL DEFAULT '',
  prompt_label TEXT,            -- XML tag for prompt wrapping (e.g. 'my_identity')
  sort_order   INTEGER NOT NULL DEFAULT 999,
  audience     TEXT NOT NULL DEFAULT 'ward-private',
  care_weight  TEXT,            -- 'high' | 'low' | NULL
  source_json  TEXT,            -- { author, via, at, originalId? }
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE(category, filename)
);

CREATE INDEX IF NOT EXISTS idx_identity_category ON identity_files(category);

-- ── Memory records ────────────────────────────────────────────────────────────
-- Covers kind='narrative' (all tiers), 'tracker_def', 'tracker_entry'.
-- For episodic narrative: granularity + date_key are the address.
-- For significant: date_key = 'YYYY-MM-DD_slug', slug also stored separately.

CREATE TABLE IF NOT EXISTS memories (
  id                 TEXT PRIMARY KEY,
  kind               TEXT NOT NULL DEFAULT 'narrative',
  register           TEXT NOT NULL DEFAULT 'episodic', -- 'episodic' | 'me' | 'ward'
  granularity        TEXT,           -- 'daily'|'weekly'|'monthly'|'yearly'|'significant'
  date_key           TEXT,           -- YYYY-MM-DD or YYYY-MM-DD_slug
  slug               TEXT,           -- for 'significant' only
  content            TEXT NOT NULL DEFAULT '',
  audience           TEXT NOT NULL DEFAULT 'ward-private',
  subjects_json      TEXT NOT NULL DEFAULT '[]',  -- [villagerId, ...]
  care_weight        TEXT,           -- 'high' | 'low' | NULL
  confidence         REAL NOT NULL DEFAULT 1.0,
  provenance         TEXT,           -- 'told-directly'|'inferred'|'observed-pattern'
  last_confirmed_at  TEXT,
  source_json        TEXT,           -- { author, via, at, originalId? }
  known_to_json      TEXT NOT NULL DEFAULT '[]',  -- [{ who, since?, source? }]
  tracker_id         TEXT,           -- tracker_entry: FK to tracker_def id
  tracker_value_json TEXT,           -- tracker_entry: value/item/values
  observed_as        TEXT,           -- tracker_entry: 'self-report'|'familiar-observed'|'inferred'
  note               TEXT,           -- tracker_entry: freeform note
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  FOREIGN KEY(tracker_id) REFERENCES memories(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memories_granularity ON memories(granularity);
CREATE INDEX IF NOT EXISTS idx_memories_date_key    ON memories(date_key);
CREATE INDEX IF NOT EXISTS idx_memories_kind        ON memories(kind);
CREATE INDEX IF NOT EXISTS idx_memories_register    ON memories(register);
CREATE INDEX IF NOT EXISTS idx_memories_audience    ON memories(audience);

-- ── Knowledge graph ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS graph_nodes (
  id               TEXT PRIMARY KEY,
  label            TEXT NOT NULL,
  type             TEXT,           -- 'person'|'place'|'project'|'pet'|'organisation'|...
  description      TEXT,
  audience         TEXT NOT NULL DEFAULT 'ward-private',
  care_weight      TEXT,
  source_json      TEXT,
  properties_json  TEXT NOT NULL DEFAULT '{}',  -- extensible; villagerId lives here (Pillar G)
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_graph_nodes_type  ON graph_nodes(type);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_label ON graph_nodes(label);

CREATE TABLE IF NOT EXISTS graph_edges (
  id          TEXT PRIMARY KEY,
  from_id     TEXT NOT NULL,
  to_id       TEXT NOT NULL,
  type        TEXT NOT NULL,
  weight      REAL NOT NULL DEFAULT 1.0,
  audience    TEXT NOT NULL DEFAULT 'ward-private',
  source_json TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  FOREIGN KEY(from_id) REFERENCES graph_nodes(id) ON DELETE CASCADE,
  FOREIGN KEY(to_id)   REFERENCES graph_nodes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(from_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_to   ON graph_edges(to_id);

-- ── Snapshots ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS snapshots (
  id          TEXT PRIMARY KEY,
  file_path   TEXT NOT NULL,
  size_bytes  INTEGER,
  created_at  TEXT NOT NULL
);

-- ── sqlite-vec virtual tables ─────────────────────────────────────────────────
-- These require the vec0 extension loaded before any connection can use them.
-- db.py calls sqlite_vec.load(conn) before running migrations.

CREATE VIRTUAL TABLE IF NOT EXISTS memory_vecs USING vec0(
  memory_id TEXT PRIMARY KEY,
  embedding float[384]
);

CREATE VIRTUAL TABLE IF NOT EXISTS graph_node_vecs USING vec0(
  node_id TEXT PRIMARY KEY,
  embedding float[384]
);
