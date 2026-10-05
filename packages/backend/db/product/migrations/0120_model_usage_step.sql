-- Native flow step correlation is descriptive, never an authorization scope.
ALTER TABLE model_usage ADD COLUMN execution_id text, ADD COLUMN step_id text;
CREATE INDEX model_usage_execution_step ON model_usage(workspace_id, execution_id, step_id) WHERE execution_id IS NOT NULL;
