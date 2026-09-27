-- Who last wrote a native comment's body. A comment's text is a maintainer's
-- own only while its author is a maintainer and the author or another
-- maintainer person last wrote its body. The writer is named in the
-- transaction the same way as an issue's (smithers.issue_text_editor); a run
-- credential, an import or the issue-sync intake names no one, so their
-- comments are never a maintainer's. An update that leaves the text alone
-- keeps its writer, except that deleting the writer's account clears it.
ALTER TABLE issue_comments ADD COLUMN body_editor_id bigint REFERENCES users(id) ON DELETE SET NULL;

CREATE FUNCTION public.record_issue_comment_editor() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.body IS DISTINCT FROM OLD.body THEN
    NEW.body_editor_id := NULLIF(current_setting('smithers.issue_text_editor', true), '')::bigint;
  ELSIF NEW.body_editor_id IS NOT NULL THEN
    NEW.body_editor_id := OLD.body_editor_id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_issue_comments_text_editor BEFORE INSERT OR UPDATE ON public.issue_comments
    FOR EACH ROW EXECUTE FUNCTION public.record_issue_comment_editor();

-- The same for an issue's writers (0054): ON DELETE SET NULL clears them.
CREATE OR REPLACE FUNCTION public.record_issue_text_editor() RETURNS trigger
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
  NEW.title_editor_id := CASE WHEN NEW.title IS DISTINCT FROM OLD.title THEN editor
    WHEN NEW.title_editor_id IS NULL THEN NULL ELSE OLD.title_editor_id END;
  NEW.body_editor_id := CASE WHEN NEW.body IS DISTINCT FROM OLD.body THEN editor
    WHEN NEW.body_editor_id IS NULL THEN NULL ELSE OLD.body_editor_id END;
  RETURN NEW;
END $$;

-- A deleted comment carries no text to act on.
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
      'comment',to_jsonb(comment_row) - 'body_editor_id' || jsonb_build_object('user',actor,
        'author_association',repository_job_native_association(issue_row.repository_id,comment_row.user_id),
        'smithers_text_by_maintainer', action_name <> 'deleted'
          AND repository_job_native_text_writer(issue_row.repository_id, comment_row.user_id, comment_row.body_editor_id)),
      'sender',actor,'repository',jsonb_build_object('id',issue_row.repository_id)));
  RETURN NULL;
END $$;
