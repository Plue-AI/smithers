-- #2939: the guest size a workspace requested at creation. NULL keeps the
-- operator's size for the workspace kind. Every provision of the workspace
-- (create, recovery, fork) boots at the persisted size.
ALTER TABLE public.workspaces
    ADD COLUMN vcpu_count integer CONSTRAINT workspaces_vcpu_count_check CHECK (vcpu_count > 0),
    ADD COLUMN memory_mb integer CONSTRAINT workspaces_memory_mb_check CHECK (memory_mb > 0),
    ADD COLUMN disk_mb integer CONSTRAINT workspaces_disk_mb_check CHECK (disk_mb > 0);
