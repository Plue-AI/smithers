-- 0108 rewrote the per-person workspace backstop for branch machines and
-- dropped 0089's child exemptions. A person's child workspaces have their own
-- per-parent limit (workspace_children), so they again neither count toward
-- nor are refused by the 100-workspace backstop.
CREATE OR REPLACE FUNCTION public.enforce_workspace_user_quota() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE active_count BIGINT;
BEGIN
    -- A branch's database owner is an install service, never its first joiner.
    IF EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id
        AND lower_username = 'smithers-machines' AND user_type = 'service' AND prohibit_login) THEN
        RETURN NEW;
    END IF;
    IF EXISTS (SELECT 1 FROM workspace_children WHERE workspace_id = NEW.id) THEN
        RETURN NEW;
    END IF;
    PERFORM 1 FROM users WHERE id = NEW.user_id FOR UPDATE;
    SELECT COUNT(*) INTO active_count FROM workspaces w
    WHERE w.user_id = NEW.user_id AND w.deleted_at IS NULL AND w.status <> 'failed'
      AND NOT EXISTS (SELECT 1 FROM workspace_children c WHERE c.workspace_id = w.id);
    IF active_count >= 100 THEN
        RAISE EXCEPTION 'user % already has the maximum of 100 active workspaces', NEW.user_id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'workspaces_user_quota';
    END IF;
    RETURN NEW;
END $$;
