-- spec §3: one install-settings store; capacity is the owner-controlled key.
CREATE TABLE install_settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    sealed BOOLEAN NOT NULL DEFAULT FALSE,
    updated_by BIGINT REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
