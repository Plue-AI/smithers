-- Pending machine work survives activity pruning and install restarts. The
-- immutable snapshot itself remains pinned by its machine event receipt.
ALTER TABLE workspaces ADD COLUMN capture_pending JSONB
    CHECK (capture_pending IS NULL OR jsonb_typeof(capture_pending) = 'object');
