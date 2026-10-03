-- T-FLW-03, spec §3 and §11.3: retain flow versions in the existing table.
-- NULL identity belongs to retained, hidden maintainer workflow machinery.
ALTER TABLE workflow_definitions
    ADD COLUMN source_commit TEXT,
    ADD COLUMN digest TEXT,
    ADD COLUMN status TEXT,
    ADD COLUMN load_error TEXT,
    ADD CONSTRAINT workflow_definition_version CHECK (
        (digest IS NULL AND source_commit IS NULL AND status IS NULL AND load_error IS NULL)
        OR (digest IS NOT NULL AND source_commit IS NOT NULL AND status IS NOT NULL AND digest ~ '^[a-f0-9]{64}$' AND source_commit ~ '^[a-f0-9]{40,64}$'
            AND status IN ('loaded', 'failed')
            AND ((status = 'loaded' AND load_error IS NULL)
              OR (status = 'failed' AND load_error IS NOT NULL AND length(load_error) > 0 AND NOT is_active)))
    );
ALTER TABLE workflow_definitions DROP CONSTRAINT workflow_definitions_repository_id_path_key;
CREATE UNIQUE INDEX workflow_definitions_legacy_path ON workflow_definitions(repository_id, path) WHERE digest IS NULL;
CREATE UNIQUE INDEX workflow_definitions_version ON workflow_definitions(repository_id, name, digest) WHERE digest IS NOT NULL;
CREATE UNIQUE INDEX workflow_definitions_active_version ON workflow_definitions(repository_id, name) WHERE digest IS NOT NULL AND is_active;
