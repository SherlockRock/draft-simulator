-- Match collector schema. Idempotent — the collector runs this at every boot
-- (migrate.mjs), so schema deploy is automatic. Independent of the app DB:
-- plain SQL, no Sequelize.

CREATE TABLE IF NOT EXISTS summoners (
  puuid            TEXT PRIMARY KEY,
  region           TEXT NOT NULL,
  tier             TEXT NOT NULL,      -- CHALLENGER..DIAMOND
  division         TEXT NOT NULL,      -- I..IV
  league_points    INT,
  rank_updated_at  TIMESTAMPTZ NOT NULL,
  matches_fetched_at TIMESTAMPTZ,
  fetch_errored    BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_summoners_poll
  ON summoners (region, matches_fetched_at NULLS FIRST, rank_updated_at);

CREATE TABLE IF NOT EXISTS matches (
  match_id       TEXT PRIMARY KEY,     -- e.g. NA1_5293107648 (globally unique)
  region         TEXT NOT NULL,
  seed_tier      TEXT NOT NULL,        -- rank of the summoner whose history surfaced this match
  seed_division  TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','fetched','skipped','failed')),
  queue_id       INT,
  game_version   TEXT,
  patch_major    INT,
  patch_minor    INT,
  game_duration  INT,                  -- seconds
  game_start     TIMESTAMPTZ,
  teams          JSONB,                -- compact extracted record (extractor.mjs)
  extractor_version INT,
  error_detail   TEXT,                 -- why failed/skipped
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  exported_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_matches_pending ON matches (region, status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_matches_export  ON matches (status, exported_at) WHERE status = 'fetched';
CREATE INDEX IF NOT EXISTS idx_matches_patch   ON matches (patch_major, patch_minor);
