-- T-MCH-04: deployed identities must migrate without deleting runtime data.
LOCK TABLE public.workspaces, public.agent_sessions, public.workspace_shares IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.users IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.workspaces WHERE deleted_at IS NULL
        GROUP BY repository_id, target_bookmark HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION 'conflicting branch machine bindings; resolve without deleting disks';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.workspaces w JOIN public.agent_sessions a ON a.id = w.agent_session_id
        WHERE a.workspace_id IS NOT NULL AND a.workspace_id <> w.id
    ) THEN
        RAISE EXCEPTION 'conflicting agent session workspace binding';
    END IF;
    IF EXISTS (SELECT 1 FROM public.users WHERE lower_username = 'smithers-machines'
        AND (user_type <> 'service' OR NOT prohibit_login OR deleted_at IS NOT NULL)) THEN
        RAISE EXCEPTION 'branch machine service identity is occupied';
    END IF;
END $$;

INSERT INTO public.users (id, username, lower_username, display_name, user_type, prohibit_login)
SELECT GREATEST(nextval('public.users_id_seq'), COALESCE(MAX(id), 0) + 1),
    'smithers-machines', 'smithers-machines', 'Smithers', 'service', true FROM public.users
ON CONFLICT (lower_username) DO NOTHING;
SELECT setval('public.users_id_seq', GREATEST((SELECT last_value FROM public.users_id_seq), (SELECT MAX(id) FROM public.users)));

UPDATE public.agent_sessions a SET workspace_id = w.id
FROM public.workspaces w WHERE w.agent_session_id = a.id;
UPDATE public.workspaces SET agent_session_id = NULL;
DROP INDEX public.uq_workspaces_agent_session;

UPDATE public.workspace_shares SET owner_user_id =
    (SELECT id FROM public.users WHERE lower_username = 'smithers-machines');
UPDATE public.workspaces SET user_id =
    (SELECT id FROM public.users WHERE lower_username = 'smithers-machines');
-- Member erasure must not remove a snapshot backing a shared machine's disk.
UPDATE public.workspace_snapshots SET user_id =
    (SELECT id FROM public.users WHERE lower_username = 'smithers-machines');

DROP INDEX public.uq_workspaces_active;
CREATE UNIQUE INDEX uq_workspaces_active
ON public.workspaces (repository_id, kind, target_bookmark, name)
WHERE parent_workspace_id IS NULL
  AND source_snapshot_id IS NULL
  AND agent_session_id IS NULL
  AND source_commit = ''
  AND deleted_at IS NULL
  AND status IN ('pending', 'starting', 'running', 'suspended');

CREATE OR REPLACE FUNCTION public.enforce_workspace_user_quota() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE active_count BIGINT;
BEGIN
    -- A branch's database owner is an install service, never its first joiner.
    IF EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id
        AND lower_username = 'smithers-machines' AND user_type = 'service' AND prohibit_login) THEN
        RETURN NEW;
    END IF;
    PERFORM 1 FROM users WHERE id = NEW.user_id FOR UPDATE;
    SELECT COUNT(*) INTO active_count FROM workspaces
    WHERE user_id = NEW.user_id AND deleted_at IS NULL AND status <> 'failed';
    IF active_count >= 100 THEN
        RAISE EXCEPTION 'user % already has the maximum of 100 active workspaces', NEW.user_id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'workspaces_user_quota';
    END IF;
    RETURN NEW;
END $$;
