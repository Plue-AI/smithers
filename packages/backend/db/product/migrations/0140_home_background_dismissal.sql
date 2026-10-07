ALTER TABLE workflow_runs ADD COLUMN dismissed_by BIGINT REFERENCES users(id), ADD COLUMN dismissed_at TIMESTAMPTZ;
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_dismissal_pair CHECK ((dismissed_by IS NULL) = (dismissed_at IS NULL));
