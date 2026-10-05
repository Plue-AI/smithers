-- An install's owner-paid model calls (modelproxy.OwnerMeter): the owner pays
-- the provider with the install's own key, so the row has no Smithers credit
-- account or reservation. paid_by names who paid. The repository's daily
-- token budget counts every row alike (MythicalRepositoryTokensSince).
ALTER TABLE model_usage
    ALTER COLUMN credit_account_id DROP NOT NULL,
    ALTER COLUMN reservation_id DROP NOT NULL,
    ADD COLUMN paid_by text NOT NULL DEFAULT 'credit',
    ADD CONSTRAINT model_usage_paid_by_check CHECK (
        (paid_by = 'credit' AND credit_account_id IS NOT NULL AND reservation_id IS NOT NULL)
        OR (paid_by = 'owner' AND credit_account_id IS NULL AND reservation_id IS NULL));
