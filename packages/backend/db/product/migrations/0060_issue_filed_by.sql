-- Who filed a native issue, and which agent source wrote its current text.
-- An agent files issues under a person's account without that person
-- writing them: an agent run's credential ("run"), the Linear import
-- ("linear") and a repository job's unwitnessed live trial ("trial"). Such
-- an issue never starts credentialed work on its own: its text is never a
-- maintainer's, and only a maintainer person's trigger label, or an
-- owner-committed agentIssueSources rule naming its source on the default
-- bookmark, approves it. A write names its agent source with
-- set_config('smithers.issue_text_source', <source>, true) beside
-- smithers.issue_text_editor. An issue filed before this migration is
-- "unknown": its last writers (0054) do not say who filed it.
ALTER TABLE public.issues
    ADD COLUMN filed_by text DEFAULT 'unknown' NOT NULL
        CONSTRAINT issues_filed_by_check CHECK (filed_by IN ('account', 'run', 'linear', 'trial', 'unknown')),
    ADD COLUMN text_source text
        CONSTRAINT issues_text_source_check CHECK (text_source IN ('run', 'linear', 'trial'));

-- filed_by is set once, at insert: "account" when the write names the
-- account that wrote it (a person's, or an agent account's own), else its
-- agent source, else unknown. text_source is the agent source that wrote the
-- whole current text: kept only while every later title or body write names
-- no person and the same source.
CREATE OR REPLACE FUNCTION public.record_issue_text_editor() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  editor bigint := NULLIF(current_setting('smithers.issue_text_editor', true), '')::bigint;
  source text := NULLIF(current_setting('smithers.issue_text_source', true), '');
BEGIN
  IF source IS NOT NULL AND source NOT IN ('run', 'linear', 'trial') THEN
    RAISE EXCEPTION 'unknown issue text source %', source USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.title_editor_id := editor;
    NEW.body_editor_id := editor;
    NEW.filed_by := CASE WHEN editor IS NOT NULL THEN 'account' ELSE COALESCE(source, 'unknown') END;
    NEW.text_source := CASE WHEN editor IS NULL THEN source END;
    RETURN NEW;
  END IF;
  NEW.title_editor_id := CASE WHEN NEW.title IS DISTINCT FROM OLD.title THEN editor
    WHEN NEW.title_editor_id IS NULL THEN NULL ELSE OLD.title_editor_id END;
  NEW.body_editor_id := CASE WHEN NEW.body IS DISTINCT FROM OLD.body THEN editor
    WHEN NEW.body_editor_id IS NULL THEN NULL ELSE OLD.body_editor_id END;
  NEW.filed_by := OLD.filed_by;
  NEW.text_source := CASE
    WHEN NEW.title IS NOT DISTINCT FROM OLD.title AND NEW.body IS NOT DISTINCT FROM OLD.body THEN OLD.text_source
    WHEN editor IS NULL AND source IS NOT DISTINCT FROM OLD.text_source THEN OLD.text_source
  END;
  RETURN NEW;
END $$;

-- A maintainer is a person: an agent account (bot or service) that may write
-- the repository is not one.
CREATE OR REPLACE FUNCTION public.repository_native_maintainer(repo_id bigint, person_id bigint) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT person_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM users u WHERE u.id = person_id AND u.user_type = 'user')
    AND EXISTS (SELECT 1 FROM repositories r WHERE r.id = repo_id AND (
    r.user_id = person_id
    OR EXISTS (SELECT 1 FROM org_members m WHERE m.organization_id = r.org_id AND m.user_id = person_id AND m.role = 'owner')
    OR EXISTS (SELECT 1 FROM collaborators c WHERE c.repository_id = r.id AND c.user_id = person_id AND c.permission IN ('write','admin'))
    OR EXISTS (SELECT 1 FROM team_repos tr JOIN teams t ON t.id = tr.team_id JOIN team_members tm ON tm.team_id = t.id
      JOIN org_members om ON om.organization_id = t.organization_id AND om.user_id = tm.user_id
      WHERE tr.repository_id = r.id AND t.organization_id = r.org_id AND tm.user_id = person_id
        AND t.permission IN ('write','admin'))))
$$;

-- The native event's issue stamps: its text is a maintainer's only when an
-- account filed it and maintainer persons wrote its title and body; an agent
-- source's text names that source.
CREATE OR REPLACE FUNCTION public.repository_job_native_issue_payload(issue_row public.issues) RETURNS jsonb
    LANGUAGE sql STABLE
    AS $$
  SELECT to_jsonb(issue_row) - 'search_vector' - 'title_editor_id' - 'body_editor_id' - 'text_source' || jsonb_build_object(
    'user', jsonb_build_object('id',u.id,'login',u.username,'type','User'),
    'smithers_text_by_maintainer', issue_row.filed_by = 'account'
      AND repository_job_native_text_writer(issue_row.repository_id, issue_row.author_id, issue_row.title_editor_id)
      AND repository_job_native_text_writer(issue_row.repository_id, issue_row.author_id, issue_row.body_editor_id),
    'smithers_text_source', issue_row.text_source,
    'labels', COALESCE((SELECT jsonb_agg(jsonb_build_object('name',l.name))
      FROM issue_labels il JOIN labels l ON l.id=il.label_id
      WHERE il.issue_id=issue_row.id), '[]'::jsonb))
  FROM users u WHERE u.id=issue_row.author_id
$$;

-- A person's own press of Trial (the person-only setup trial route): the
-- one setup request whose trial issue CreateTrial files as that person's.
-- Requests from before this migration were not checked for a person.
ALTER TABLE public.repository_setup_requests
    ADD COLUMN person_trial_press boolean DEFAULT false NOT NULL;
