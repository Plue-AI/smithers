-- A receipt belongs to the merged item, never to another TODO state.
ALTER TABLE mythical_items ADD COLUMN lessons integer CHECK (lessons >= 0);
ALTER TABLE mythical_items ADD COLUMN learning_receipt jsonb
 CHECK (learning_receipt IS NULL OR jsonb_typeof(learning_receipt)='object');
-- Preserve the ordinary person author while recording machine attribution.
ALTER TABLE wiki_page_revisions ADD COLUMN learning_author jsonb
 CHECK (learning_author IS NULL OR jsonb_typeof(learning_author)='object');
CREATE FUNCTION wiki_learning_author() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.learning_author:=NULLIF(current_setting('smithers.learning_author',true),'')::jsonb;
 RETURN NEW;
END $$;
CREATE TRIGGER wiki_learning_author BEFORE INSERT ON wiki_page_revisions
 FOR EACH ROW EXECUTE FUNCTION wiki_learning_author();
