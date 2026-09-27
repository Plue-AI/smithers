-- A webhook or refresh reads a subscription from Stripe, then writes it. Each
-- snapshot records the database time just before its read, and an upsert
-- only replaces a snapshot read no later than its own, so a slow writer
-- cannot overwrite a newer snapshot a concurrent webhook committed.
ALTER TABLE billing_subscriptions ADD COLUMN snapshot_observed_at timestamptz;
