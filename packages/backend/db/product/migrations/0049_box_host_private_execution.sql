-- A box's coding host holds the owner's repository landing credential, and a
-- write-share guest runs as the same user on the box, so no write share may
-- be granted while the box's host is starting or running (#2198). The
-- constraint name is the one the share grant already answers as a conflict.
CREATE OR REPLACE FUNCTION refuse_write_share_with_box_host() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.level = 'write' AND EXISTS (
        SELECT 1 FROM flow_runtime_host_bindings
         WHERE workspace_id = NEW.workspace_id
           AND catalog_key = 'coding'
           AND state IN ('starting', 'running')
    ) THEN
        RAISE EXCEPTION 'a box with a running coding host cannot be shared for writing'
            USING ERRCODE = '23514', CONSTRAINT = 'workspace_gateway_private_execution';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspace_shares_box_host_private_execution ON workspace_shares;
CREATE TRIGGER workspace_shares_box_host_private_execution
    BEFORE INSERT OR UPDATE OF level, workspace_id ON workspace_shares
    FOR EACH ROW EXECUTE FUNCTION refuse_write_share_with_box_host();
