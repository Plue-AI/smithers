ALTER TABLE workflow_runs ADD COLUMN dismissed_by BIGINT REFERENCES users(id), ADD COLUMN dismissed_at TIMESTAMPTZ,
    ADD COLUMN background_retry_id BIGINT REFERENCES workflow_runs(id);
ALTER TABLE flow_loads ADD COLUMN dismissed_by BIGINT REFERENCES users(id), ADD COLUMN dismissed_at TIMESTAMPTZ,
    ADD COLUMN dismissed_generation BIGINT, ADD COLUMN retry_generation BIGINT;
CREATE INDEX workflow_runs_background_failed ON workflow_runs(repository_id, id) WHERE status = 'failure' AND dismissed_at IS NULL;

