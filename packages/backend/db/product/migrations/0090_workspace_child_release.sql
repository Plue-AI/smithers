-- #2802 review: a child's machine stays owned until it is confirmed deleted,
-- and a batch's snapshot stays reclaimable after its parent row is gone.
ALTER TABLE public.workspace_children ADD COLUMN vm_released_at timestamptz;

-- Earlier stops deleted the machine before closing the receipt.
UPDATE public.workspace_children SET vm_released_at = stopped_at WHERE stopped_at IS NOT NULL AND vm_id <> '';

DROP INDEX public.workspace_children_live_user_idx;
CREATE INDEX workspace_children_live_user_idx ON public.workspace_children (user_id)
    WHERE stopped_at IS NULL OR (vm_id <> '' AND vm_released_at IS NULL);

ALTER TABLE public.workspace_child_batches
    ALTER COLUMN parent_workspace_id DROP NOT NULL,
    DROP CONSTRAINT workspace_child_batches_parent_workspace_id_fkey,
    ADD CONSTRAINT workspace_child_batches_parent_workspace_id_fkey
        FOREIGN KEY (parent_workspace_id) REFERENCES public.workspaces(id) ON DELETE SET NULL;
