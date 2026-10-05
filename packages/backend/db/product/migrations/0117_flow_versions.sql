-- Flow versions (engineering spec §3, §11.3; T-FLW-03). A version of an
-- overridable flow is one workflow_definitions row: the flow's name, the main
-- commit flow-load read it at, its digest, and whether it loaded. The row
-- the stack service marks is_active is Active; a failed version never is.
-- Rows without a digest are the legacy .smithers/workflows definitions,
-- which keep their one row per path.
ALTER TABLE workflow_definitions
    ADD COLUMN source_commit text,
    ADD COLUMN digest text,
    ADD COLUMN status text,
    ADD COLUMN load_error text NOT NULL DEFAULT '';
ALTER TABLE workflow_definitions ADD CONSTRAINT workflow_definitions_version_check CHECK (
    (digest IS NULL AND source_commit IS NULL AND status IS NULL AND load_error = '')
    OR (digest ~ '^[0-9a-f]{64}$' AND source_commit ~ '^[0-9a-f]{40}$' AND status IN ('loaded', 'failed')
        AND (status = 'loaded' OR NOT is_active)));
ALTER TABLE workflow_definitions DROP CONSTRAINT workflow_definitions_repository_id_path_key;
CREATE UNIQUE INDEX workflow_definitions_repository_id_path_key ON workflow_definitions (repository_id, path)
    WHERE digest IS NULL;
-- A digest that already has a row writes nothing (§11.3.1).
CREATE UNIQUE INDEX workflow_definitions_version_key ON workflow_definitions (repository_id, name, digest)
    WHERE digest IS NOT NULL;
CREATE UNIQUE INDEX workflow_definitions_active_version ON workflow_definitions (repository_id, name)
    WHERE digest IS NOT NULL AND is_active;

-- One flow-load per repository at a time (§11.3.1). After every fold the
-- stack worker loads main's newest commit not yet loaded (commit_id) on a
-- short-lived workspace; loaded_commit is the newest commit whose load
-- finished and versions is what that load measured, one entry per flow.
-- generation qualifies every launch: a projection of an older generation
-- changes nothing. syncing names the flows whose files changed between
-- loaded_commit and commit_id, which the Flow card shows as merged and not
-- yet active. tree is the flow files (path to blob) at loaded_commit, and
-- commit_tree at commit_id.
CREATE TABLE flow_loads (
    repository_id bigint PRIMARY KEY REFERENCES mythical_stacks(repository_id) ON DELETE CASCADE,
    -- Optimistic concurrency between the stack worker and run projections.
    version bigint NOT NULL DEFAULT 0,
    generation bigint NOT NULL DEFAULT 0,
    state varchar(16) NOT NULL DEFAULT 'idle' CHECK (state IN ('idle', 'running')),
    commit_id text NOT NULL DEFAULT '',
    loaded_commit text NOT NULL DEFAULT '',
    versions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(versions) = 'array'),
    tree jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(tree) = 'object'),
    commit_tree jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(commit_tree) = 'object'),
    syncing jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(syncing) = 'array'),
    workspace_id text NOT NULL DEFAULT '',
    run_id text NOT NULL DEFAULT '',
    -- The run's terminal outcome, recorded by the projection: '' while it
    -- runs, else succeeded or failed[: reason]. result is its output.
    outcome text NOT NULL DEFAULT '',
    result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
    attempt integer NOT NULL DEFAULT 0,
    started_at timestamptz,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    error text NOT NULL DEFAULT '',
    updated_at timestamptz NOT NULL DEFAULT now()
);
