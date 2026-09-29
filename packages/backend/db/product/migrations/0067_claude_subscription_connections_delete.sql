-- #2777: Anthropic's terms forbid storing Claude.ai credentials. A claude
-- provider connection is now only an Anthropic API key, so delete every stored
-- Claude setup token and OAuth pair (their grants and workspace usage records
-- cascade; a device login keeps its row with no connection) and refuse any
-- other claude kind from now on. Codex rows keep every kind they had.
-- The lock keeps an older binary from inserting one between the DELETE and
-- the new constraint; taking it whole up front avoids a lock upgrade.
-- A Claude token stored under another label is removed by the startup scan
-- (services.ScanStoredSubscriptionTokens), which decrypts every row.
LOCK TABLE provider_connections IN ACCESS EXCLUSIVE MODE;

DELETE FROM provider_connections WHERE provider = 'claude' AND kind <> 'api_key';

ALTER TABLE provider_connections DROP CONSTRAINT provider_connections_kind_check;
ALTER TABLE provider_connections ADD CONSTRAINT provider_connections_kind_check
    CHECK (kind IN ('setup_token', 'oauth', 'api_key') AND (provider <> 'claude' OR kind = 'api_key'));
