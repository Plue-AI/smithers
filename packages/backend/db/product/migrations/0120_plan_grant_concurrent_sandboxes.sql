-- An operator comp may replace its owner's concurrent-sandbox limit for the
-- life of the grant without changing the plan catalog or its price. NULL keeps
-- the granted plan's own limit. The value is part of the immutable receipt.
ALTER TABLE billing_plan_grants
 ADD COLUMN concurrent_sandboxes bigint CHECK (concurrent_sandboxes > 0);
