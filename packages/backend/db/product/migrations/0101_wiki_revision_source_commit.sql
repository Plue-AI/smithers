-- Commit provenance of a revision imported from a git checkout: the commit
-- whose tree held exactly the imported bytes at the document path. Empty means
-- unknown: not a checkout, uncommitted bytes, or not a sync import.
ALTER TABLE wiki_page_revisions ADD COLUMN source_commit text NOT NULL DEFAULT ''
    CHECK (source_commit = '' OR source_commit ~ '^([0-9a-f]{40}|[0-9a-f]{64})$');

-- Like history_commit_id, provenance is a receipt recorded after the authored
-- event. It is written at most once; every other revision field stays fixed.
CREATE OR REPLACE FUNCTION wiki_immutable_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'history_commit_id'-'crdt_state'-'crdt_vector'-'author_id'-'source_commit') IS DISTINCT FROM
    (to_jsonb(OLD)-'history_commit_id'-'crdt_state'-'crdt_vector'-'author_id'-'source_commit')
    OR (NEW.source_commit<>OLD.source_commit AND OLD.source_commit<>'') THEN
  RAISE EXCEPTION 'wiki revisions are immutable';
 END IF;
 RETURN NEW;
END $$;
