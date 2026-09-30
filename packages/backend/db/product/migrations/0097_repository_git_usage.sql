-- Git object bytes on the repository host count toward the owner's storage
-- quota (smithersai/plue#593). The API records the size repo-host measures
-- after each push, stamped with when it was measured; a repository without a
-- row has not been measured.
CREATE TABLE public.repository_git_usage (
    repository_id bigint PRIMARY KEY REFERENCES public.repositories(id) ON DELETE CASCADE,
    git_bytes bigint NOT NULL CHECK (git_bytes >= 0),
    measured_at timestamptz NOT NULL
);
