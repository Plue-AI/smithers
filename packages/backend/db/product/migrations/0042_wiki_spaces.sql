-- Extend the existing page revision log, never a second wiki store.
ALTER TABLE wiki_pages ADD COLUMN visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private'));
ALTER TABLE wiki_pages ADD COLUMN path text NOT NULL DEFAULT '';
ALTER TABLE wiki_pages ADD COLUMN content_digest text NOT NULL DEFAULT '';
ALTER TABLE wiki_page_revisions ADD COLUMN visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private'));
ALTER TABLE wiki_page_revisions ADD COLUMN path text NOT NULL DEFAULT '';
ALTER TABLE wiki_page_revisions ADD COLUMN content_digest text NOT NULL DEFAULT '';
-- Backfill without manufacturing human edits.
ALTER TABLE wiki_pages DISABLE TRIGGER wiki_advance_revision;
ALTER TABLE wiki_pages DISABLE TRIGGER wiki_record_revision;
UPDATE wiki_pages SET path = slug || '.md', content_digest = encode(sha256(convert_to(body,'UTF8')),'hex');
UPDATE wiki_page_revisions SET path = slug || '.md', content_digest = encode(sha256(convert_to(body,'UTF8')),'hex');
ALTER TABLE wiki_pages ENABLE TRIGGER wiki_advance_revision;
ALTER TABLE wiki_pages ENABLE TRIGGER wiki_record_revision;
ALTER TABLE wiki_pages DROP CONSTRAINT wiki_pages_repository_id_slug_key;
ALTER TABLE wiki_pages ADD UNIQUE(repository_id,visibility,slug);
CREATE UNIQUE INDEX wiki_path_unique ON wiki_pages(repository_id,visibility,lower(path));
CREATE INDEX wiki_scope_revisions ON wiki_page_revisions(repository_id,visibility,page_id,revision);

CREATE FUNCTION wiki_prepare_page() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.visibility <> OLD.visibility OR NEW.repository_id <> OLD.repository_id) THEN
    RAISE EXCEPTION 'wiki scope is immutable';
  END IF;
  IF NEW.path = '' THEN NEW.path := NEW.slug || '.md'; END IF;
  NEW.content_digest := encode(sha256(convert_to(NEW.body,'UTF8')),'hex');
  RETURN NEW;
END $$;
-- Runs after revision advance; digest changes cannot manufacture an extra revision.
CREATE TRIGGER wiki_prepare_page BEFORE INSERT OR UPDATE ON wiki_pages FOR EACH ROW EXECUTE FUNCTION wiki_prepare_page();

CREATE OR REPLACE FUNCTION public.wiki_record_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    page wiki_pages%ROWTYPE;
    cursor_id BIGINT;
    is_deleted BOOLEAN := TG_OP = 'DELETE';
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.revision = OLD.revision THEN
        RETURN NULL;
    END IF;
    IF is_deleted THEN
        -- Parent/user cascades have already removed the referenced row.
        -- Ordinary page deletion retains history; repository deletion removes it.
        IF NOT EXISTS (SELECT 1 FROM repositories WHERE id = OLD.repository_id) THEN
            RETURN NULL;
        END IF;
        page := OLD;
        page.revision := OLD.revision + 1;
        page.last_update_id := NULL;
        page.last_update := NULL;
        page.author_id := COALESCE(NULLIF(current_setting('smithers.wiki_actor_id', true), '')::bigint, OLD.author_id);
    ELSE
        page := NEW;
    END IF;
    INSERT INTO wiki_page_revisions(repository_id, page_id, revision, slug, title, body, visibility, path, content_digest,
        author_id, author_username, update_id, update_bytes, deleted)
    VALUES (page.repository_id, page.id, page.revision, page.slug, page.title, page.body, page.visibility, page.path, page.content_digest,
        CASE WHEN EXISTS (SELECT 1 FROM users WHERE id = page.author_id) THEN page.author_id END, COALESCE((SELECT username FROM users WHERE id = page.author_id), ''),
        page.last_update_id, page.last_update, is_deleted)
    RETURNING id INTO cursor_id;
    -- Only small metadata goes through NOTIFY; clients fetch bounded pages of
    -- committed revisions or the latest CRDT snapshot through authorized REST.
    PERFORM pg_notify('wiki_page_' || page.id, json_build_object(
        'id', page.revision, 'page_id', page.id, 'revision', page.revision,
        'update_id', page.last_update_id, 'deleted', is_deleted)::text);
    RETURN NULL;
END $$;
