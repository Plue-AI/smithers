-- One ordered event history per wiki, extending the existing revision log.
CREATE TABLE wiki_spaces (
 repository_id bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
 visibility text NOT NULL CHECK (visibility IN ('public','private')),
 head bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(repository_id,visibility)
);
ALTER TABLE wiki_pages ADD COLUMN attachment jsonb CHECK (attachment IS NULL OR jsonb_typeof(attachment)='object');
ALTER TABLE wiki_page_revisions ADD COLUMN attachment jsonb;
ALTER TABLE wiki_page_revisions ADD COLUMN sequence bigint NOT NULL DEFAULT 0;
ALTER TABLE wiki_page_revisions ADD COLUMN crdt_state bytea;
ALTER TABLE wiki_page_revisions ADD COLUMN crdt_vector bytea;
-- Causal state is a rebuildable projection; retain the latest seed at upgrade.
UPDATE wiki_page_revisions r SET crdt_state=p.crdt_state,crdt_vector=p.crdt_vector
FROM wiki_pages p WHERE p.id=r.page_id AND p.revision=r.revision;
WITH ordered AS (
 SELECT id,row_number() OVER (PARTITION BY repository_id,visibility ORDER BY id) AS seq FROM wiki_page_revisions
) UPDATE wiki_page_revisions r SET sequence=o.seq FROM ordered o WHERE o.id=r.id;
INSERT INTO wiki_spaces(repository_id,visibility,head)
 SELECT repository_id,visibility,max(sequence) FROM wiki_page_revisions GROUP BY repository_id,visibility;
CREATE UNIQUE INDEX wiki_event_sequence ON wiki_page_revisions(repository_id,visibility,sequence);

CREATE OR REPLACE FUNCTION wiki_prepare_page() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.visibility<>OLD.visibility OR NEW.repository_id<>OLD.repository_id OR (NEW.attachment IS NULL)<>(OLD.attachment IS NULL)) THEN
  RAISE EXCEPTION 'wiki scope and content kind are immutable';
 END IF;
 IF NEW.path='' THEN NEW.path:=NEW.slug||'.md'; END IF;
 IF NEW.attachment IS NULL THEN
  NEW.content_digest:=encode(sha256(convert_to(NEW.body,'UTF8')),'hex');
 ELSE
  IF NEW.body<>'' OR NEW.crdt_state IS NOT NULL OR (NEW.attachment->>'digest') !~ '^[a-f0-9]{64}$' OR NEW.attachment->>'digest' IS NULL THEN
   RAISE EXCEPTION 'invalid wiki attachment';
  END IF;
  NEW.content_digest:=NEW.attachment->>'digest';
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION wiki_record_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
 page wiki_pages%ROWTYPE;
 cursor_id bigint;
 next_sequence bigint;
 is_deleted boolean:=TG_OP='DELETE';
BEGIN
 IF current_setting('smithers.wiki_replay',true)='on' THEN RETURN NULL; END IF;
 IF TG_OP='UPDATE' AND NEW.revision=OLD.revision THEN RETURN NULL; END IF;
 IF is_deleted THEN
  IF NOT EXISTS(SELECT 1 FROM repositories WHERE id=OLD.repository_id) THEN RETURN NULL; END IF;
  page:=OLD;page.revision:=OLD.revision+1;page.last_update_id:=NULL;page.last_update:=NULL;
  page.author_id:=COALESCE(NULLIF(current_setting('smithers.wiki_actor_id',true),'')::bigint,OLD.author_id);
 ELSE page:=NEW;
 END IF;
 -- The row lock is held until commit: no earlier sequence can commit later.
 INSERT INTO wiki_spaces(repository_id,visibility,head) VALUES(page.repository_id,page.visibility,1)
 ON CONFLICT(repository_id,visibility) DO UPDATE SET head=wiki_spaces.head+1
 RETURNING head INTO next_sequence;
 INSERT INTO wiki_page_revisions(repository_id,page_id,revision,slug,title,body,visibility,path,content_digest,
  author_id,author_username,update_id,update_bytes,deleted,attachment,sequence,crdt_state,crdt_vector)
 VALUES(page.repository_id,page.id,page.revision,page.slug,page.title,page.body,page.visibility,page.path,page.content_digest,
  CASE WHEN EXISTS(SELECT 1 FROM users WHERE id=page.author_id) THEN page.author_id END,COALESCE((SELECT username FROM users WHERE id=page.author_id),''),
  page.last_update_id,page.last_update,is_deleted,page.attachment,next_sequence,page.crdt_state,page.crdt_vector)
 RETURNING id INTO cursor_id;
 PERFORM pg_notify('wiki_page_'||page.id,json_build_object('id',page.revision,'page_id',page.id,'revision',page.revision,'update_id',page.last_update_id,'deleted',is_deleted)::text);
 RETURN NULL;
END $$;

-- Causal seed metadata, like history_commit_id, is a projection receipt. It is
-- retained on the matching edit so rebuilding cannot invalidate offline editors.
CREATE FUNCTION wiki_record_seed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.crdt_state IS NULL AND NEW.crdt_state IS NOT NULL AND NEW.revision=OLD.revision THEN
  UPDATE wiki_page_revisions SET crdt_state=NEW.crdt_state,crdt_vector=NEW.crdt_vector
  WHERE page_id=NEW.id AND revision=NEW.revision;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER wiki_record_seed AFTER UPDATE ON wiki_pages FOR EACH ROW EXECUTE FUNCTION wiki_record_seed();

-- Event contents are append-only. Projection receipts can advance without
-- rewriting the authored page event. Parent deletion still owns retention.
CREATE FUNCTION wiki_immutable_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'history_commit_id'-'crdt_state'-'crdt_vector'-'author_id') IS DISTINCT FROM
    (to_jsonb(OLD)-'history_commit_id'-'crdt_state'-'crdt_vector'-'author_id') THEN
  RAISE EXCEPTION 'wiki revisions are immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER wiki_immutable_revision BEFORE UPDATE ON wiki_page_revisions FOR EACH ROW EXECUTE FUNCTION wiki_immutable_revision();
