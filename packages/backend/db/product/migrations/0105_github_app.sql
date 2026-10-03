-- Each self-hosted install owns exactly one GitHub App. The singleton key
-- makes concurrent manifest conversions unable to replace its credentials.
CREATE TABLE github_app (
    id BIGINT PRIMARY KEY CHECK (id > 0),
    singleton BOOLEAN NOT NULL DEFAULT TRUE UNIQUE CHECK (singleton),
    slug TEXT NOT NULL CHECK (slug <> ''),
    owner_login TEXT NOT NULL CHECK (owner_login <> ''),
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('user', 'org')),
    client_id TEXT NOT NULL CHECK (client_id <> ''),
    pem_sealed TEXT NOT NULL CHECK (pem_sealed <> ''),
    webhook_secret_sealed TEXT NOT NULL CHECK (webhook_secret_sealed <> ''),
    client_secret_sealed TEXT NOT NULL CHECK (client_secret_sealed <> ''),
    installation_id BIGINT CHECK (installation_id > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Bind every conversion attempt to the repository selected before setup.
CREATE TABLE github_app_manifest_states (
    digest TEXT PRIMARY KEY CHECK (length(digest) = 64),
    setup_session_digest TEXT NOT NULL CHECK (length(setup_session_digest) = 64),
    owner_login TEXT NOT NULL CHECK (owner_login <> ''),
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('user', 'org')),
    repository_name TEXT NOT NULL CHECK (repository_name <> ''),
    origin TEXT NOT NULL CHECK (origin <> ''),
    callback_urls JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(callback_urls) = 'array'),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ
);
