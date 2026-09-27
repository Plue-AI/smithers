const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS repos (
    repo TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    quiz TEXT NOT NULL DEFAULT 'auto',
    prs_per_month INTEGER NOT NULL,
    spend_cap_usd REAL NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS api_keys (
    hash TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    repos_json TEXT NOT NULL,
    spend_cap_usd REAL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    hash TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    pr INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    spend_cap_usd REAL NOT NULL,
    spent_usd REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    api_key_hash TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS usage_events (
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    pr INTEGER NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL,
    kind TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS usage_events_repo_idx ON usage_events(repo, created_at)`,
  `CREATE TABLE IF NOT EXISTS usage_totals (
    repo TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (repo, model)
  )`,
  `CREATE TABLE IF NOT EXISTS usage_reservations (
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    session_hash TEXT,
    cost_usd REAL NOT NULL CHECK (cost_usd > 0),
    created_at INTEGER NOT NULL,
    settlement_json TEXT,
    model TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS usage_reservations_repo_idx ON usage_reservations(repo)`,
  `CREATE INDEX IF NOT EXISTS usage_reservations_session_idx ON usage_reservations(session_hash)`,
  `CREATE TABLE IF NOT EXISTS reviewed_prs (
    repo TEXT NOT NULL,
    pr INTEGER NOT NULL,
    month TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    PRIMARY KEY (repo, pr, month)
  )`,
  `CREATE INDEX IF NOT EXISTS reviewed_prs_month_idx ON reviewed_prs(repo, month)`,
  `CREATE TABLE IF NOT EXISTS walkthroughs (
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    pr INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    session_hash TEXT,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('pending', 'complete'))
  )`,
  `CREATE INDEX IF NOT EXISTS walkthroughs_repo_idx ON walkthroughs(repo, created_at)`,
  `CREATE INDEX IF NOT EXISTS walkthroughs_session_hash_idx ON walkthroughs(session_hash)`,
];


/** Immutable deploy-time migrations. Append versions; never edit applied SQL. */
export const REVIEW_MIGRATIONS = [{
  name: "0001_review_baseline.sql",
  sql: [...SCHEMA_STATEMENTS,
    "SELECT quiz FROM repos LIMIT 0",
    "SELECT spend_cap_usd FROM api_keys LIMIT 0",
    "SELECT api_key_hash FROM sessions LIMIT 0",
    "SELECT cache_creation_tokens, cache_read_tokens FROM usage_events LIMIT 0",
    "SELECT model FROM usage_reservations LIMIT 0",
    "SELECT status FROM walkthroughs LIMIT 0",
    "CREATE INDEX IF NOT EXISTS usage_events_created_idx ON usage_events(created_at)",
    "CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at)",
    "CREATE INDEX IF NOT EXISTS walkthroughs_created_idx ON walkthroughs(created_at)",
    "CREATE INDEX IF NOT EXISTS reviewed_prs_retention_idx ON reviewed_prs(month)",
    `INSERT OR IGNORE INTO usage_totals (repo, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd)
      SELECT repo, model, SUM(input_tokens), SUM(output_tokens), SUM(cache_creation_tokens), SUM(cache_read_tokens), SUM(cost_usd)
      FROM usage_events WHERE NOT EXISTS (SELECT 1 FROM usage_totals) GROUP BY repo, model`,
  ].join(";\n") + ";\n",
}, {
  name: "0002_repository_identity.sql",
  sql: `ALTER TABLE repos ADD COLUMN repository_id TEXT;
ALTER TABLE repos ADD COLUMN owner_id TEXT;
CREATE UNIQUE INDEX repos_repository_id_idx ON repos(repository_id);
CREATE UNIQUE INDEX repos_name_idx ON repos(repo COLLATE NOCASE);
`,
}, {
  name: "0003_allowed_workflow_refs.sql",
  sql: `ALTER TABLE repos ADD COLUMN allowed_workflow_refs TEXT;
`,
}] as const;
