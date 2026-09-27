-- Who last wrote a native issue's title and who last wrote its body. An
-- issue's text is its maintainer author's own only while both writers are the
-- author or another maintainer person. A write names its person with
-- set_config('smithers.issue_text_editor', <user id>, true) in its
-- transaction; a run credential, an import, or any path that names no one
-- leaves no writer, so its text is never a maintainer's own. Issues written
-- before this migration have no recorded writers.
ALTER TABLE issues
    ADD COLUMN title_editor_id bigint REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN body_editor_id bigint REFERENCES users(id) ON DELETE SET NULL;

CREATE FUNCTION public.record_issue_text_editor() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  editor bigint := NULLIF(current_setting('smithers.issue_text_editor', true), '')::bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.title_editor_id := editor;
    NEW.body_editor_id := editor;
    RETURN NEW;
  END IF;
  NEW.title_editor_id := CASE WHEN NEW.title IS DISTINCT FROM OLD.title THEN editor ELSE OLD.title_editor_id END;
  NEW.body_editor_id := CASE WHEN NEW.body IS DISTINCT FROM OLD.body THEN editor ELSE OLD.body_editor_id END;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_issues_text_editor BEFORE INSERT OR UPDATE ON public.issues
    FOR EACH ROW EXECUTE FUNCTION public.record_issue_text_editor();

-- Whether a person is the author or another maintainer of the repository.
CREATE FUNCTION public.repository_job_native_text_writer(repo_id bigint, author_id bigint, writer_id bigint) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT writer_id IS NOT NULL AND (writer_id = author_id
    OR COALESCE(repository_job_native_association(repo_id, writer_id), 'NONE') IN ('OWNER','MEMBER','COLLABORATOR'))
$$;

CREATE OR REPLACE FUNCTION public.repository_job_native_issue_payload(issue_row public.issues) RETURNS jsonb
    LANGUAGE sql STABLE
    AS $$
  SELECT to_jsonb(issue_row) - 'search_vector' - 'title_editor_id' - 'body_editor_id' || jsonb_build_object(
    'user', jsonb_build_object('id',u.id,'login',u.username),
    'author_association', COALESCE(repository_job_native_association(issue_row.repository_id,u.id),'NONE'),
    'smithers_text_by_maintainer',
      repository_job_native_text_writer(issue_row.repository_id, issue_row.author_id, issue_row.title_editor_id)
      AND repository_job_native_text_writer(issue_row.repository_id, issue_row.author_id, issue_row.body_editor_id),
    'labels', COALESCE((SELECT jsonb_agg(jsonb_build_object('name',l.name))
      FROM issue_labels il JOIN labels l ON l.id=il.label_id
      WHERE il.issue_id=issue_row.id), '[]'::jsonb))
  FROM users u WHERE u.id=issue_row.author_id
$$;
