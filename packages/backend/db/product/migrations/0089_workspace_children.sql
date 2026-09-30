-- #2802: a running workspace fans out short-lived child workspaces from one
-- snapshot of its disk. A child is an ordinary workspace row (is_fork, parent
-- set) plus the receipt below. Children carry no credentials, never count
-- against the per-user workspace quota, and are reaped with their parent.
CREATE TABLE public.workspace_child_batches (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    parent_workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    profile text NOT NULL CONSTRAINT workspace_child_batches_profile_check CHECK (profile IN ('small', 'build')),
    requested integer NOT NULL CONSTRAINT workspace_child_batches_requested_check CHECK (requested BETWEEN 1 AND 128),
    -- The provider snapshot every child in the batch boots from; empty until taken.
    snapshot_id text DEFAULT '' NOT NULL,
    -- Set once every child stopped and the snapshot was deleted.
    snapshot_deleted_at timestamptz,
    expires_at timestamptz NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX workspace_child_batches_parent_idx ON public.workspace_child_batches (parent_workspace_id);

-- The receipt is written before its workspace row in the same transaction, so
-- the quota trigger can tell a child from a workspace.
CREATE TABLE public.workspace_children (
    workspace_id uuid NOT NULL PRIMARY KEY
        REFERENCES public.workspaces(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    batch_id uuid NOT NULL REFERENCES public.workspace_child_batches(id) ON DELETE CASCADE,
    user_id bigint NOT NULL,
    ordinal integer NOT NULL CONSTRAINT workspace_children_ordinal_check CHECK (ordinal >= 0 AND ordinal < 128),
    vm_id text DEFAULT '' NOT NULL,
    started_at timestamptz,
    stopped_at timestamptz,
    stop_reason text CONSTRAINT workspace_children_stop_reason_check
        CHECK (stop_reason IN ('requested', 'parent_stopped', 'expired', 'idle', 'failed', 'abandoned')),
    failure_message text,
    created_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT workspace_children_batch_ordinal_key UNIQUE (batch_id, ordinal),
    CONSTRAINT workspace_children_stop_pair CHECK ((stopped_at IS NULL) = (stop_reason IS NULL))
);

CREATE INDEX workspace_children_live_user_idx ON public.workspace_children (user_id) WHERE stopped_at IS NULL;

-- Children never consume the 100-workspace backstop.
CREATE OR REPLACE FUNCTION public.enforce_workspace_user_quota() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    active_count BIGINT;
BEGIN
    IF EXISTS (SELECT 1 FROM workspace_children WHERE workspace_id = NEW.id) THEN
        RETURN NEW;
    END IF;
    PERFORM 1 FROM users WHERE id = NEW.user_id FOR UPDATE;
    SELECT COUNT(*) INTO active_count
    FROM workspaces w
    WHERE w.user_id = NEW.user_id
      AND w.deleted_at IS NULL
      AND w.status <> 'failed'
      AND NOT EXISTS (SELECT 1 FROM workspace_children c WHERE c.workspace_id = w.id);
    IF active_count >= 100 THEN
        RAISE EXCEPTION 'user % already has the maximum of 100 active workspaces', NEW.user_id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'workspaces_user_quota';
    END IF;
    RETURN NEW;
END;
$$;
