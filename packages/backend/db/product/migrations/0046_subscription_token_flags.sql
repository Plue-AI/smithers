-- #2206: secrets saved before the hosted subscription-token refusal, and the
-- workspaces and snapshots built while one was stored. The one-time scan
-- (services.ScanStoredSubscriptionTokens) sets these; a secret write clears
-- its flag, and a workspace or snapshot flag is cleared only by deleting it.
ALTER TABLE repository_secrets ADD COLUMN subscription_token_flagged_at timestamptz;
ALTER TABLE organization_secrets ADD COLUMN subscription_token_flagged_at timestamptz;
ALTER TABLE repository_agent_environment_secrets ADD COLUMN subscription_token_flagged_at timestamptz;
ALTER TABLE workspaces ADD COLUMN rebuild_required_at timestamptz;
ALTER TABLE workspace_snapshots ADD COLUMN rebuild_required_at timestamptz;

-- The scan's completion receipt: counts only, never a name or value.
CREATE TABLE stored_subscription_token_scan (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    completed_at timestamptz NOT NULL DEFAULT now(),
    counts jsonb NOT NULL
);
