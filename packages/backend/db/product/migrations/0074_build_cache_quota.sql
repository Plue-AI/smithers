-- Maintain quota accounting transactionally, including deletes and repairs.
-- Block old API writers until backfill and both triggers commit together.
LOCK TABLE build_cache_entries, build_cache_artifacts IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE build_cache_repository_usage (
    repository_id bigint PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
    size_bytes bigint NOT NULL CHECK (size_bytes >= 0)
);
INSERT INTO build_cache_repository_usage (repository_id, size_bytes)
SELECT repository_id, SUM(size_bytes)::bigint FROM (
    SELECT repository_id, GREATEST(1024::bigint, octet_length(body)::bigint + octet_length(result_canonical)::bigint) AS size_bytes
    FROM build_cache_entries
    UNION ALL
    SELECT repository_id, GREATEST(1024::bigint, size_bytes) FROM build_cache_artifacts
) existing GROUP BY repository_id;

CREATE FUNCTION account_build_cache_bytes() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    old_bytes bigint := 0;
    new_bytes bigint := 0;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        IF TG_TABLE_NAME = 'build_cache_entries' THEN
            old_bytes := GREATEST(1024::bigint, octet_length(OLD.body)::bigint + octet_length(OLD.result_canonical)::bigint);
        ELSE
            old_bytes := GREATEST(1024::bigint, OLD.size_bytes);
        END IF;
        -- During repository cascade deletion the usage row may already be gone.
        UPDATE build_cache_repository_usage SET size_bytes = size_bytes - old_bytes
        WHERE repository_id = OLD.repository_id;
    END IF;
    IF TG_OP <> 'DELETE' THEN
        IF TG_TABLE_NAME = 'build_cache_entries' THEN
            new_bytes := GREATEST(1024::bigint, octet_length(NEW.body)::bigint + octet_length(NEW.result_canonical)::bigint);
        ELSE
            new_bytes := GREATEST(1024::bigint, NEW.size_bytes);
        END IF;
        INSERT INTO build_cache_repository_usage(repository_id, size_bytes)
        VALUES (NEW.repository_id, new_bytes)
        ON CONFLICT (repository_id) DO UPDATE
        SET size_bytes = build_cache_repository_usage.size_bytes + EXCLUDED.size_bytes;
    END IF;
    RETURN NULL;
END;
$$;
CREATE TRIGGER account_build_cache_entries
AFTER INSERT OR DELETE OR UPDATE OF repository_id, body, result_canonical ON build_cache_entries
FOR EACH ROW EXECUTE FUNCTION account_build_cache_bytes();
CREATE TRIGGER account_build_cache_artifacts
AFTER INSERT OR DELETE OR UPDATE OF repository_id, size_bytes ON build_cache_artifacts
FOR EACH ROW EXECUTE FUNCTION account_build_cache_bytes();

CREATE INDEX idx_build_cache_entries_created ON build_cache_entries(created_at, repository_id);
CREATE INDEX idx_build_cache_artifacts_created ON build_cache_artifacts(created_at, repository_id);
CREATE INDEX idx_build_cache_entries_repo_created ON build_cache_entries(repository_id, created_at);
CREATE INDEX idx_build_cache_artifacts_repo_created ON build_cache_artifacts(repository_id, created_at);
