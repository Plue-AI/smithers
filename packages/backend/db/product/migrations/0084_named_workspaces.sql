-- Bookmark-created workspaces reserve one identity as soon as their row exists.
-- Explicit forks, snapshots, and agent sessions are independent resources.
DROP INDEX public.uq_workspaces_active;

-- Match Go strings.TrimSpace, including tabs and Unicode whitespace.
WITH normalized AS (
    SELECT id, btrim(name, E' \t\n\r\f\013' ||
        U&'\0085\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000') AS name
    FROM public.workspaces
    WHERE parent_workspace_id IS NULL AND source_snapshot_id IS NULL
      AND agent_session_id IS NULL
)
UPDATE public.workspaces SET name = normalized.name
FROM normalized WHERE workspaces.id = normalized.id AND workspaces.name <> normalized.name;

-- Older versions allowed concurrent pending rows and multiple derived rows.
-- Preserve every existing workspace and VM, retaining the ready/newest row's
-- original name and assigning other duplicates a stable distinct name.
DO $$
DECLARE
    duplicate RECORD;
    new_name TEXT;
BEGIN
    FOR duplicate IN
        SELECT * FROM (
            SELECT id, repository_id, user_id, kind, target_bookmark, name,
                   ROW_NUMBER() OVER (
                       PARTITION BY repository_id, user_id, kind, target_bookmark, name
                       ORDER BY CASE WHEN status IN ('running', 'suspended') THEN 0 ELSE 1 END,
                                created_at DESC, id DESC
                   ) AS position
            FROM public.workspaces
            WHERE parent_workspace_id IS NULL
              AND source_snapshot_id IS NULL
              AND agent_session_id IS NULL
              AND deleted_at IS NULL
              AND status IN ('pending', 'starting', 'running', 'suspended')
        ) candidates WHERE position > 1
    LOOP
        new_name := duplicate.name || ' [' || duplicate.id::text || ']';
        WHILE EXISTS (
            SELECT 1 FROM public.workspaces
            WHERE repository_id = duplicate.repository_id AND user_id = duplicate.user_id
              AND kind = duplicate.kind AND target_bookmark = duplicate.target_bookmark
              AND name = new_name AND parent_workspace_id IS NULL
              AND source_snapshot_id IS NULL AND agent_session_id IS NULL
              AND deleted_at IS NULL AND status IN ('pending', 'starting', 'running', 'suspended')
        ) LOOP
            new_name := new_name || '~';
        END LOOP;
        UPDATE public.workspaces SET name = new_name WHERE id = duplicate.id;
    END LOOP;
END;
$$;

CREATE UNIQUE INDEX uq_workspaces_active
ON public.workspaces (repository_id, user_id, kind, target_bookmark, name)
WHERE parent_workspace_id IS NULL
  AND source_snapshot_id IS NULL
  AND agent_session_id IS NULL
  AND deleted_at IS NULL
  AND status IN ('pending', 'starting', 'running', 'suspended');
