-- One maintainer rule for native text. A maintainer is a person who may
-- write the repository, exactly canWriteRepo (repo_permissions.go; a test
-- holds the two equal): its owner, an owner of its organization, or a
-- collaborator or a member of one of its organization's teams with write or
-- admin permission. Membership of the organization alone is not. Text is a
-- maintainer's own when its author and each part's last writer are
-- maintainers; a label approves outsider text only when a maintainer applied
-- it. Native event payloads no longer name a GitHub-style author association:
-- the stamps are the decision.
CREATE FUNCTION public.repository_native_maintainer(repo_id bigint, person_id bigint) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT person_id IS NOT NULL AND EXISTS (SELECT 1 FROM repositories r WHERE r.id = repo_id AND (
    r.user_id = person_id
    OR EXISTS (SELECT 1 FROM org_members m WHERE m.organization_id = r.org_id AND m.user_id = person_id AND m.role = 'owner')
    OR EXISTS (SELECT 1 FROM collaborators c WHERE c.repository_id = r.id AND c.user_id = person_id AND c.permission IN ('write','admin'))
    OR EXISTS (SELECT 1 FROM team_repos tr JOIN teams t ON t.id = tr.team_id JOIN team_members tm ON tm.team_id = t.id
      JOIN org_members om ON om.organization_id = t.organization_id AND om.user_id = tm.user_id
      WHERE tr.repository_id = r.id AND t.organization_id = r.org_id AND tm.user_id = person_id
        AND t.permission IN ('write','admin'))))
$$;

CREATE OR REPLACE FUNCTION public.repository_job_native_text_writer(repo_id bigint, author_id bigint, writer_id bigint) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT repository_native_maintainer(repo_id, author_id) AND repository_native_maintainer(repo_id, writer_id)
$$;

CREATE OR REPLACE FUNCTION public.repository_job_native_issue_payload(issue_row public.issues) RETURNS jsonb
    LANGUAGE sql STABLE
    AS $$
  SELECT to_jsonb(issue_row) - 'search_vector' - 'title_editor_id' - 'body_editor_id' || jsonb_build_object(
    'user', jsonb_build_object('id',u.id,'login',u.username,'type','User'),
    'smithers_text_by_maintainer',
      repository_job_native_text_writer(issue_row.repository_id, issue_row.author_id, issue_row.title_editor_id)
      AND repository_job_native_text_writer(issue_row.repository_id, issue_row.author_id, issue_row.body_editor_id),
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
  SELECT jsonb_build_object('id',id,'login',username,'type','User') INTO actor FROM users WHERE id=comment_row.user_id;
  IF issue_row.kind='chat' THEN RETURN NULL; END IF;
  INSERT INTO repository_job_events
    (repository_id,delivery_key,source,event_type,event_action,issue_number,payload)
  VALUES (issue_row.repository_id,'native:'||gen_random_uuid()::text,'smithers-cloud','issue_comment',action_name,issue_row.number,
    jsonb_build_object('action',action_name,'issue',repository_job_native_issue_payload(issue_row),
      'comment',to_jsonb(comment_row) - 'body_editor_id' || jsonb_build_object('user',actor,
        'smithers_text_by_maintainer', action_name <> 'deleted'
          AND repository_job_native_text_writer(issue_row.repository_id, comment_row.user_id, comment_row.body_editor_id)),
      'sender',actor,'repository',jsonb_build_object('id',issue_row.repository_id)));
  RETURN NULL;
END $$;

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
      'label',jsonb_build_object('name',label_name,'smithers_applied_by_maintainer',
        action_name = 'labeled' AND repository_native_maintainer(issue_row.repository_id, label_row.added_by)),
      'sender',actor,'repository',jsonb_build_object('id',issue_row.repository_id)));
  RETURN NULL;
END $$;

DROP FUNCTION public.repository_job_native_association(bigint, bigint);
