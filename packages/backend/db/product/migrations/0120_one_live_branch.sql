-- M-17, stage 2 item 9: one live branch. A repository's branch has one
-- active workspace, whoever asked for it and whatever kind or name it was
-- given: members and the coding agent share it (createBranchMachineRow joins
-- it under the branch lock). A forked, snapshot-restored, pushed-ref or agent
-- workspace is that branch's machine too, so none is excluded any more.
-- Two exceptions keep their own rows:
--   * a stack lane: every lane works from the stack's bookmark, and its lane
--     name is its branch identity (installLaneBinding, mythical_lanes);
--   * a child (workspace_children): a disposable copy of its parent's
--     machine on its parent's branch. Only children and scratch forks have a
--     parent, and a scratch fork's branch is new, created under the lock.
LOCK TABLE public.workspaces IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.workspaces
        WHERE parent_workspace_id IS NULL AND deleted_at IS NULL
          AND status IN ('pending', 'starting', 'running', 'suspended')
        GROUP BY repository_id, target_bookmark,
            CASE WHEN target_bookmark = 'mythical' THEN name ELSE '' END
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION 'two active workspaces serve one branch; stop one without deleting its disk';
    END IF;
END $$;

DROP INDEX public.uq_workspaces_active;
CREATE UNIQUE INDEX uq_workspaces_active
ON public.workspaces (repository_id, target_bookmark,
    (CASE WHEN target_bookmark = 'mythical' THEN name ELSE '' END))
WHERE parent_workspace_id IS NULL
  AND deleted_at IS NULL
  AND status IN ('pending', 'starting', 'running', 'suspended');
