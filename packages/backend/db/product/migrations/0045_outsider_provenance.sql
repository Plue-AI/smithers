-- Who may start credentialed work from issue text, and what outsider-started
-- work may change.

-- A native issue or comment carries its author's association with the
-- repository in GitHub's terms, so one trust rule applies to both sources.
CREATE FUNCTION public.repository_job_native_association(repo_id bigint, author_id bigint) RETURNS text
    LANGUAGE sql STABLE
    AS $$
  SELECT CASE
    WHEN r.user_id = author_id OR EXISTS (SELECT 1 FROM org_members m
      WHERE m.organization_id = r.org_id AND m.user_id = author_id AND m.role = 'owner') THEN 'OWNER'
    WHEN EXISTS (SELECT 1 FROM org_members m WHERE m.organization_id = r.org_id AND m.user_id = author_id) THEN 'MEMBER'
    WHEN EXISTS (SELECT 1 FROM collaborators c
      WHERE c.repository_id = r.id AND c.user_id = author_id AND c.permission IN ('write','admin'))
      OR EXISTS (SELECT 1 FROM team_repos tr JOIN teams t ON t.id = tr.team_id JOIN team_members tm ON tm.team_id = t.id
        WHERE tr.repository_id = r.id AND tm.user_id = author_id AND t.permission IN ('write','admin')) THEN 'COLLABORATOR'
    ELSE 'NONE' END
  FROM repositories r WHERE r.id = repo_id
$$;

CREATE OR REPLACE FUNCTION public.repository_job_native_issue_payload(issue_row public.issues) RETURNS jsonb
    LANGUAGE sql STABLE
    AS $$
  SELECT to_jsonb(issue_row) - 'search_vector' || jsonb_build_object(
    'user', jsonb_build_object('id',u.id,'login',u.username),
    'author_association', COALESCE(repository_job_native_association(issue_row.repository_id,u.id),'NONE'),
    'labels', COALESCE((SELECT jsonb_agg(jsonb_build_object('name',l.name))
      FROM issue_labels il JOIN labels l ON l.id=il.label_id
      WHERE il.issue_id=issue_row.id), '[]'::jsonb))
  FROM users u WHERE u.id=issue_row.author_id
$$;

CREATE OR REPLACE FUNCTION public.admit_native_repository_job_comment() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  issue_row issues%ROWTYPE;
  comment_row issue_comments%ROWTYPE;
  action_name TEXT;
  actor JSONB;
BEGIN
  IF TG_OP='UPDATE' AND NEW.body IS NOT DISTINCT FROM OLD.body THEN RETURN NEW; END IF;
  IF TG_OP='DELETE' THEN comment_row:=OLD; action_name:='deleted';
  ELSIF TG_OP='INSERT' THEN comment_row:=NEW; action_name:='created';
  ELSE comment_row:=NEW; action_name:='edited'; END IF;
  SELECT * INTO issue_row FROM issues WHERE id=comment_row.issue_id;
  IF NOT FOUND OR comment_row.type<>'comment' THEN RETURN NULL; END IF;
  SELECT jsonb_build_object('id',id,'login',username) INTO actor FROM users WHERE id=comment_row.user_id;
  IF issue_row.kind='chat' THEN RETURN NULL; END IF;
  INSERT INTO repository_job_events
    (repository_id,delivery_key,source,event_type,event_action,issue_number,payload)
  VALUES (issue_row.repository_id,'native:'||gen_random_uuid()::text,'smithers-cloud','issue_comment',action_name,issue_row.number,
    jsonb_build_object('action',action_name,'issue',repository_job_native_issue_payload(issue_row),
      'comment',to_jsonb(comment_row)||jsonb_build_object('user',actor,
        'author_association',repository_job_native_association(issue_row.repository_id,comment_row.user_id)),
      'sender',actor,'repository',jsonb_build_object('id',issue_row.repository_id)));
  RETURN NULL;
END $$;

-- Who applied a native label, so a label event names its sender as a GitHub
-- label event does.
ALTER TABLE issue_labels ADD COLUMN added_by bigint REFERENCES users(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION public.admit_native_repository_job_label() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  issue_row issues%ROWTYPE;
  label_row issue_labels%ROWTYPE;
  action_name TEXT;
  label_name TEXT;
  actor JSONB;
BEGIN
  IF TG_OP='DELETE' THEN label_row:=OLD; action_name:='unlabeled';
  ELSE label_row:=NEW; action_name:='labeled'; END IF;
  SELECT * INTO issue_row FROM issues WHERE id=label_row.issue_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF issue_row.kind='chat' THEN RETURN NULL; END IF;
  SELECT name INTO label_name FROM labels WHERE id=label_row.label_id;
  SELECT jsonb_build_object('id',id,'login',username,'type','User') INTO actor FROM users WHERE id=label_row.added_by;
  INSERT INTO repository_job_events
    (repository_id,delivery_key,source,event_type,event_action,issue_number,payload)
  VALUES (issue_row.repository_id,'native:'||gen_random_uuid()::text,'smithers-cloud','issues',action_name,issue_row.number,
    jsonb_build_object('action',action_name,'issue',repository_job_native_issue_payload(issue_row),
      'label',jsonb_build_object('name',label_name),'sender',actor,
      'repository',jsonb_build_object('id',issue_row.repository_id)));
  RETURN NULL;
END $$;

-- An item whose issue text an outsider wrote, approved by a maintainer's label.
ALTER TABLE mythical_items ADD COLUMN outsider boolean NOT NULL DEFAULT false;

-- A workspace that ran work started from an outsider's text; the mark is
-- permanent. A landing a marked workspace opened never changes a protected
-- path.
CREATE TABLE outsider_workspaces (
    workspace_id text PRIMARY KEY,
    repository_id bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now()
);
-- The workspace whose landing credential opened a landing.
CREATE TABLE landing_source_workspaces (
    landing_request_id bigint PRIMARY KEY REFERENCES landing_requests(id) ON DELETE CASCADE,
    workspace_id text NOT NULL
);
-- Workspace landing credentials minted before they named their workspace are
-- revoked; the next workspace start mints a replacement.
DELETE FROM access_tokens WHERE name LIKE 'workspace-gateway-landing-%' AND scopes NOT LIKE '%landing-workspace:%';
