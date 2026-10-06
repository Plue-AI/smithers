-- Ref health belongs to the completed main-pull receipt, including after restart.
ALTER TABLE github_main_pulls
 ADD COLUMN health_cause text NOT NULL DEFAULT '',
 ADD COLUMN retry_at timestamptz;
