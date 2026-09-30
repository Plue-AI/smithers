-- #1968: a workspace created from the caller's pushed ref checks out that
-- commit, pinned under refs/smithers/workspaces/<id>/sources/<commit>.
-- Empty means the workspace starts from its bookmark.
ALTER TABLE public.workspaces
    ADD COLUMN source_commit text DEFAULT '' NOT NULL
    CONSTRAINT workspaces_source_commit_check CHECK (source_commit = '' OR source_commit ~ '^[0-9a-f]{40}$');

-- Like forks and snapshot restores, a pushed-ref workspace is an independent
-- resource and reserves no named identity.
DROP INDEX public.uq_workspaces_active;
CREATE UNIQUE INDEX uq_workspaces_active
ON public.workspaces (repository_id, user_id, kind, target_bookmark, name)
WHERE parent_workspace_id IS NULL
  AND source_snapshot_id IS NULL
  AND agent_session_id IS NULL
  AND source_commit = ''
  AND deleted_at IS NULL
  AND status IN ('pending', 'starting', 'running', 'suspended');
