-- A connection authorizes one GitHub repository by the immutable id GitHub
-- returned when it verified the connecting user's push permission. Names
-- change on rename; the id does not. Rows made before this migration stay
-- NULL and must be reconnected.
ALTER TABLE repo_connections
    ADD COLUMN github_repository_id BIGINT CHECK (github_repository_id > 0);
