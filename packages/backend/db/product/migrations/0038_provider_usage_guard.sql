-- Successful provider responses carry subscription utilization independently
-- of rate-limit refusals. Direct work remains admissible at every utilization.
ALTER TABLE provider_connections
  ADD COLUMN used_percent double precision CHECK (used_percent >= 0 AND used_percent <= 100),
  ADD COLUMN usage_observed_at timestamptz;
