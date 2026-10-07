-- M-42 (T-MCH-16): a repository secret may also reach every branch machine as
-- a file at a declared path: `~/…` in each home, or under
-- /run/smithers/files/. The service validates the path; empty means no file.
-- Two secrets never declare one path.
ALTER TABLE public.repository_secrets
    ADD COLUMN path text DEFAULT '' NOT NULL
        CONSTRAINT repository_secrets_path_length CHECK (char_length(path) <= 512);

CREATE UNIQUE INDEX repository_secrets_repo_path
    ON public.repository_secrets (repository_id, path)
    WHERE path <> '';
