CREATE TABLE fast_model_installs (
    install_id uuid PRIMARY KEY,
    owner_id bigint NOT NULL REFERENCES users(id),
    credential_hash bytea NOT NULL CHECK (octet_length(credential_hash) = 32),
    revoked boolean NOT NULL DEFAULT false
);
CREATE TABLE fast_model_counts (
    id uuid PRIMARY KEY,
    install_id uuid NOT NULL REFERENCES fast_model_installs(install_id),
    tokens bigint NOT NULL CHECK (tokens >= 0),
    created_at timestamptz NOT NULL,
    settled boolean NOT NULL DEFAULT false
);
CREATE INDEX fast_model_counts_day ON fast_model_counts(install_id, created_at);
