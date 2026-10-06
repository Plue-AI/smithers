-- Login allocations remain reserved in detached collaborator rows after removal.
ALTER TABLE collaborators ADD COLUMN unix_login text, ADD COLUMN unix_github_id bigint;
UPDATE collaborators SET unix_github_id=github_id;
CREATE UNIQUE INDEX collaborators_unix_github_unique ON collaborators(repository_id,unix_github_id) WHERE unix_github_id IS NOT NULL;
ALTER TABLE collaborators ADD CONSTRAINT collaborators_unix_login_valid
 CHECK (unix_login IS NULL OR (unix_login ~ '^[a-z0-9_-]{1,32}$' AND unix_login NOT IN ('root','agent','machined')));
CREATE UNIQUE INDEX collaborators_unix_login_unique ON collaborators(unix_login) WHERE unix_login IS NOT NULL;
