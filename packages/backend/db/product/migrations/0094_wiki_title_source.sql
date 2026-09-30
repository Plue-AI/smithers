-- Older pages have no trustworthy title provenance. Preserve their stored
-- titles; equality with a filename or slug is not evidence of generation.
ALTER TABLE wiki_pages ADD COLUMN title_source text NOT NULL DEFAULT 'unknown'
    CHECK (title_source IN ('unknown', 'explicit', 'imported'));

-- Ownership is authored state: retain it in immutable revisions so replay
-- cannot turn an explicit title back into importer-owned or unknown state.
ALTER TABLE wiki_page_revisions ADD COLUMN title_source text NOT NULL DEFAULT 'unknown'
    CHECK (title_source IN ('unknown', 'explicit', 'imported'));

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
 INSERT INTO wiki_page_revisions(repository_id,page_id,revision,slug,title,title_source,body,visibility,path,content_digest,
  author_id,author_username,update_id,update_bytes,deleted,attachment,sequence,crdt_state,crdt_vector)
 VALUES(page.repository_id,page.id,page.revision,page.slug,page.title,page.title_source,page.body,page.visibility,page.path,page.content_digest,
  CASE WHEN EXISTS(SELECT 1 FROM users WHERE id=page.author_id) THEN page.author_id END,COALESCE((SELECT username FROM users WHERE id=page.author_id),''),
  page.last_update_id,page.last_update,is_deleted,page.attachment,next_sequence,page.crdt_state,page.crdt_vector)
 RETURNING id INTO cursor_id;
 PERFORM pg_notify('wiki_page_'||page.id,json_build_object('id',page.revision,'page_id',page.id,'revision',page.revision,'update_id',page.last_update_id,'deleted',is_deleted)::text);
 RETURN NULL;
END $$;
