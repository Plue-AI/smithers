-- T-STK-01: the existing item owns TODO identity; no second record or backfill service.
ALTER TABLE mythical_items
 ADD COLUMN number bigint CHECK (number > 0),
 ADD COLUMN title text,
 ADD COLUMN stack_position bigint CHECK (stack_position > 0),
 ADD COLUMN paused_at timestamptz,
 ADD COLUMN created_by bigint REFERENCES users(id),
 ADD COLUMN owner_id bigint REFERENCES users(id),
 ADD COLUMN flow_digest text,
 ADD COLUMN revisions jsonb CHECK (revisions IS NULL OR jsonb_typeof(revisions) = 'array');

WITH numbered AS (
 SELECT id, row_number() OVER (PARTITION BY repository_id ORDER BY created_at, id) AS n
 FROM mythical_items
)
UPDATE mythical_items i SET number = n.n, stack_position = n.n, title = i.issue_title
FROM numbered n WHERE i.id = n.id;
CREATE UNIQUE INDEX mythical_items_number_idx ON mythical_items(repository_id, number);

-- All existing insertion doors allocate under the same repository lock.
-- This also protects issue/chat imports which do not yet supply TODO fields.
CREATE FUNCTION mythical_item_number() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(NEW.repository_id);
 SELECT COALESCE(MAX(number), 0) + 1 INTO NEW.number
 FROM mythical_items WHERE repository_id = NEW.repository_id;
 SELECT COALESCE(MAX(stack_position), 0) + 1 INTO NEW.stack_position
 FROM mythical_items WHERE repository_id = NEW.repository_id
 AND state NOT IN ('landed', 'cancelled', 'rejected', 'declined');
 NEW.title := COALESCE(NEW.title, NEW.issue_title);
 RETURN NEW;
END
$$;
CREATE TRIGGER mythical_item_number BEFORE INSERT ON mythical_items
FOR EACH ROW EXECUTE FUNCTION mythical_item_number();

ALTER TABLE mythical_items DROP CONSTRAINT mythical_items_source_check,
 ADD CONSTRAINT mythical_items_source_check CHECK (source IN ('issue','chat','todo'));
CREATE UNIQUE INDEX mythical_items_creation_request_idx ON mythical_items
 (repository_id, (checks->>'creation_session'), (checks->>'filedRequest'))
 WHERE checks ? 'creation_session';
