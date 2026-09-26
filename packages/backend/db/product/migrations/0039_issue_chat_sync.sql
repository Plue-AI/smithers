-- Chat is an owner-private issue; messages remain issue_comments.
ALTER TABLE issues ADD COLUMN kind text NOT NULL DEFAULT 'issue' CHECK (kind IN ('issue','chat'));
ALTER TABLE issue_comments ADD COLUMN persona jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(persona)='object');
ALTER TABLE issue_comments ADD COLUMN idempotency_key text NOT NULL DEFAULT '';
CREATE UNIQUE INDEX issue_comments_request_key ON issue_comments(issue_id,user_id,idempotency_key) WHERE idempotency_key<>'';

ALTER TABLE issues ADD COLUMN idempotency_key text NOT NULL DEFAULT '';
CREATE UNIQUE INDEX issues_request_key ON issues(repository_id,author_id,idempotency_key) WHERE idempotency_key<>'';
CREATE TABLE issue_comment_keys (
 issue_id bigint NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
 user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 key text NOT NULL,
 comment_id bigint NOT NULL,
 request_hash bytea NOT NULL,
 PRIMARY KEY(issue_id,user_id,key)
);
CREATE FUNCTION remember_issue_comment_key() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.idempotency_key<>'' AND NEW.user_id IS NOT NULL THEN
 INSERT INTO issue_comment_keys(issue_id,user_id,key,comment_id,request_hash)
 VALUES(NEW.issue_id,NEW.user_id,NEW.idempotency_key,NEW.id,digest(jsonb_build_array(NEW.body,NEW.persona)::text,'sha256'));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER trg_issue_comment_key AFTER INSERT ON issue_comments FOR EACH ROW EXECUTE FUNCTION remember_issue_comment_key();

-- Private issue content never enters repository-wide automation or projections.
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
      'comment',to_jsonb(comment_row)||jsonb_build_object('user',actor),
      'sender',actor,'repository',jsonb_build_object('id',issue_row.repository_id)));
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.admit_native_repository_job_issue() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  action_name TEXT;
BEGIN
  IF NEW.kind='chat' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND (NEW.title,NEW.body,NEW.state) IS NOT DISTINCT FROM (OLD.title,OLD.body,OLD.state) THEN
    RETURN NEW;
  END IF;
  action_name := CASE WHEN TG_OP='INSERT' THEN 'opened'
    WHEN NEW.state<>OLD.state THEN CASE WHEN NEW.state='open' THEN 'reopened' ELSE 'closed' END
    ELSE 'edited' END;
  INSERT INTO repository_job_events
    (repository_id,delivery_key,source,event_type,event_action,issue_number,payload)
  VALUES (NEW.repository_id,'native:'||gen_random_uuid()::text,'smithers-cloud','issues',action_name,NEW.number,
    jsonb_build_object('action',action_name,'issue',repository_job_native_issue_payload(NEW),
      'repository',jsonb_build_object('id',NEW.repository_id)));
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.admit_native_repository_job_label() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  issue_row issues%ROWTYPE;
  issue_key BIGINT;
  action_name TEXT;
BEGIN
  IF TG_OP='DELETE' THEN issue_key:=OLD.issue_id; action_name:='unlabeled';
  ELSE issue_key:=NEW.issue_id; action_name:='labeled'; END IF;
  SELECT * INTO issue_row FROM issues WHERE id=issue_key;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF issue_row.kind='chat' THEN RETURN NULL; END IF;
  INSERT INTO repository_job_events
    (repository_id,delivery_key,source,event_type,event_action,issue_number,payload)
  VALUES (issue_row.repository_id,'native:'||gen_random_uuid()::text,'smithers-cloud','issues',action_name,issue_row.number,
    jsonb_build_object('action',action_name,'issue',repository_job_native_issue_payload(issue_row),
      'repository',jsonb_build_object('id',issue_row.repository_id)));
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.record_issue_state_fact() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE repo BIGINT; parent_issue BIGINT; position BIGINT; entity TEXT; identity TEXT; image JSONB;
BEGIN
    IF TG_OP = 'UPDATE' AND to_jsonb(NEW) = to_jsonb(OLD) THEN RETURN NEW; END IF;
    image := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
    IF TG_TABLE_NAME = 'issues' THEN
        repo := (image ->> 'repository_id')::BIGINT;
        parent_issue := (image ->> 'id')::BIGINT;
        entity := 'issue'; identity := parent_issue::TEXT;
        image := image - 'search_vector';
        IF TG_OP = 'UPDATE' AND image = to_jsonb(OLD) - 'search_vector' THEN RETURN NEW; END IF;
    ELSE
        parent_issue := (image ->> 'issue_id')::BIGINT;
        SELECT repository_id INTO repo FROM issues WHERE id = parent_issue;
        IF TG_TABLE_NAME = 'issue_labels' THEN
            entity := 'issue_label'; identity := parent_issue::TEXT || ':' || (image ->> 'label_id');
        ELSE
            entity := 'issue_assignee'; identity := image ->> 'id';
        END IF;
    END IF;
    IF (TG_TABLE_NAME='issues' AND image->>'kind'='chat') OR EXISTS (SELECT 1 FROM issues WHERE id=parent_issue AND kind='chat') THEN
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END IF;
    -- An issue delete fact removes all its memberships during projection.
    -- Cascading child deletion sees no issue; repository deletion purges its
    -- complete private history instead of appending an orphan tombstone.
    IF repo IS NULL OR NOT EXISTS (SELECT 1 FROM repositories WHERE id = repo) THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END IF;
    UPDATE issue_state_journals SET head = head + 1 WHERE repository_id = repo RETURNING head INTO STRICT position;
    INSERT INTO issue_state_facts(repository_id, sequence, entity_type, operation, issue_id, entity_key, post_image)
    VALUES(repo, position, entity, CASE TG_OP WHEN 'INSERT' THEN 'created' WHEN 'UPDATE' THEN 'updated' ELSE 'deleted' END,
        parent_issue, identity, CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE image END);
    PERFORM pg_notify('issue_state_facts_' || repo::TEXT, position::TEXT);
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.maintain_repo_issue_counts() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='DELETE' THEN
   IF OLD.kind='chat' THEN RETURN OLD; END IF;
 ELSIF NEW.kind='chat' THEN RETURN NEW; END IF;
    IF TG_OP = 'INSERT' THEN
        UPDATE repositories
        SET num_issues = num_issues + 1,
            num_closed_issues = num_closed_issues
                + CASE WHEN NEW.state <> 'open' THEN 1 ELSE 0 END,
            updated_at = NOW()
        WHERE id = NEW.repository_id;
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' THEN
        UPDATE repositories
        SET num_closed_issues = GREATEST(
                num_closed_issues
                + CASE WHEN NEW.state <> 'open' THEN 1 ELSE 0 END
                - CASE WHEN OLD.state <> 'open' THEN 1 ELSE 0 END,
                0),
            updated_at = NOW()
        WHERE id = NEW.repository_id;
        RETURN NEW;
    END IF;
    UPDATE repositories
    SET num_issues = GREATEST(num_issues - 1, 0),
        num_closed_issues = GREATEST(num_closed_issues
            - CASE WHEN OLD.state <> 'open' THEN 1 ELSE 0 END, 0),
        updated_at = NOW()
    WHERE id = OLD.repository_id;
    RETURN OLD;
END;
$$;

-- Connections hold only routing policy. Secrets remain in the credential broker.
CREATE TABLE issue_sync_channels (
 owner_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 repository_id bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
 provider text NOT NULL CHECK(provider IN ('slack','telegram')),
 connection_id text NOT NULL,
 scope_id text NOT NULL,
 conversation_id text NOT NULL,
 external_user_id text NOT NULL DEFAULT '',
 thread_id text NOT NULL DEFAULT '',
 PRIMARY KEY (owner_id,provider,connection_id,scope_id,conversation_id,thread_id)
);
CREATE TABLE issue_sync_threads (
 issue_id bigint PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
 owner_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 provider text NOT NULL CHECK(provider IN ('slack','telegram')),
 connection_id text NOT NULL,
 scope_id text NOT NULL,
 conversation_id text NOT NULL,
 thread_id text NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX issue_sync_thread_identity ON issue_sync_threads(owner_id,provider,connection_id,scope_id,conversation_id,thread_id) WHERE thread_id<>'';
CREATE TABLE issue_external_messages (
 issue_id bigint NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
 comment_id bigint,
 message_id text NOT NULL,
 provider_version numeric NOT NULL DEFAULT 0,
 deleted boolean NOT NULL DEFAULT false,
 PRIMARY KEY (issue_id,message_id),
 UNIQUE (issue_id,comment_id)
);
CREATE TABLE issue_sync_receipts (
 owner_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 delivery_key text NOT NULL,
 issue_id bigint REFERENCES issues(id) ON DELETE CASCADE,
 PRIMARY KEY(owner_id,delivery_key)
);
CREATE TABLE issue_sync_deliveries (
 id bigserial PRIMARY KEY,
 issue_id bigint NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
 event_id bigint NOT NULL UNIQUE REFERENCES issue_events(id) ON DELETE CASCADE,
 reconcile_key text NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','dispatching','sent','outcome_unknown','failed','unsupported')),
 claim_token text NOT NULL DEFAULT '',
 message_id text NOT NULL DEFAULT '',
 error text NOT NULL DEFAULT '',
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION record_issue_message_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c issue_comments%ROWTYPE; event_key bigint; verb text;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.body,NEW.persona) IS NOT DISTINCT FROM (OLD.body,OLD.persona) THEN RETURN NEW; END IF;
 IF TG_OP='DELETE' THEN c:=OLD; verb:='comment.deleted';
 ELSIF TG_OP='INSERT' THEN c:=NEW; verb:='comment.created';
 ELSE c:=NEW; verb:='comment.edited'; END IF;
 IF NOT EXISTS(SELECT 1 FROM issues WHERE id=c.issue_id) THEN RETURN COALESCE(NEW,OLD); END IF;
 INSERT INTO issue_events(issue_id,actor_id,event_type,payload)
 VALUES(c.issue_id,c.user_id,verb,jsonb_build_object('comment',to_jsonb(c),'origin',COALESCE(current_setting('smithers.issue_origin',true),''))) RETURNING id INTO event_key;
 IF COALESCE(current_setting('smithers.issue_origin',true),'') = '' AND EXISTS(SELECT 1 FROM issue_sync_threads WHERE issue_id=c.issue_id) THEN
  INSERT INTO issue_sync_deliveries(issue_id,event_id) VALUES(c.issue_id,event_key);
 END IF;
 RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER trg_issue_message_event AFTER INSERT OR UPDATE OR DELETE ON issue_comments FOR EACH ROW EXECUTE FUNCTION record_issue_message_event();

-- External reaction attribution points at the existing reactions table.
CREATE TABLE issue_external_reactions (
 id bigserial PRIMARY KEY,
 reaction_id bigint UNIQUE REFERENCES reactions(id) ON DELETE SET NULL,
 issue_id bigint NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
 comment_id bigint NOT NULL REFERENCES issue_comments(id) ON DELETE CASCADE,
 actor text NOT NULL,
 name text NOT NULL,
 version numeric NOT NULL DEFAULT 0,
 UNIQUE(issue_id,comment_id,actor,name)
);
