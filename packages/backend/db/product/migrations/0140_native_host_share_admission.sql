-- Native branch hosts have an admitted agent-UID spawn receipt. Keep the
-- single-identity private-box restriction for every other workspace.
CREATE OR REPLACE FUNCTION refuse_write_share_with_box_host() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.level='write' AND EXISTS (
  SELECT 1 FROM flow_runtime_host_bindings h WHERE h.workspace_id=NEW.workspace_id
   AND h.catalog_key='coding' AND h.state IN ('starting','running')
 ) AND NOT EXISTS (
  SELECT 1 FROM workspaces w JOIN users machine ON machine.id=w.user_id
   JOIN collaborators c ON c.repository_id=w.repository_id AND c.user_id=NEW.grantee_user_id
   JOIN users member ON member.id=c.user_id
   JOIN flow_runtime_host_bindings h ON h.workspace_id=w.id AND h.catalog_key='coding' AND h.state IN ('starting','running')
   JOIN product_job_events e ON e.principal_id='branch:'||w.id::text AND e.event_type='branch.session_opened'
  WHERE w.id=NEW.workspace_id AND w.kind='vm' AND w.status='running' AND w.deleted_at IS NULL
   AND machine.lower_username='smithers-machines' AND machine.user_type='service' AND machine.prohibit_login
   AND machine.deleted_at IS NULL AND c.suspended_at IS NULL AND c.permission IN ('write','admin')
   AND c.unix_uid>=20000 AND c.unix_login<>'' AND member.is_active AND member.deleted_at IS NULL AND NOT member.prohibit_login
   AND e.data->>'via'='agent:'||h.id::text AND (e.data->>'uid')::bigint=19999
   AND (e.data->>'owner_generation')::bigint=h.owner_generation
 ) THEN
  RAISE EXCEPTION 'a private coding host cannot be shared for writing'
   USING ERRCODE='23514', CONSTRAINT='workspace_gateway_private_execution';
 END IF;
 RETURN NEW;
END;
$$;

-- Reservations read the parent while wake work holds its authority SHARE lock.
-- SHARE still fences parent deletion/tombstoning through the insert commit,
-- without unnecessarily serializing readers or awaiting VM/network work.
CREATE OR REPLACE FUNCTION guard_workspace_session_live_parent_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM workspaces
 WHERE id=NEW.workspace_id AND repository_id=NEW.repository_id AND deleted_at IS NULL
 FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN NEW;
END;
$$;
