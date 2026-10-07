-- Assign a durable order at shared publication, never while a prompt is queued.
ALTER TABLE chat_turns ADD COLUMN entry_seq bigint NOT NULL DEFAULT 0 CHECK(entry_seq >= 0);
WITH published AS (
 SELECT id, row_number() OVER (PARTITION BY repository_id,conversation_id ORDER BY created_at,id) AS seq
 FROM chat_turns WHERE producer_generation>0 AND conversation_id IS NOT NULL
)
UPDATE chat_turns t SET entry_seq=p.seq FROM published p WHERE p.id=t.id;
CREATE FUNCTION chat_entry_sequence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.entry_seq=0 AND NEW.producer_generation>0 AND NEW.conversation_id IS NOT NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('chat-entry:' || NEW.repository_id || ':' || NEW.conversation_id,0));
  SELECT coalesce(max(entry_seq),0)+1 INTO NEW.entry_seq FROM chat_turns
   WHERE repository_id=NEW.repository_id AND conversation_id=NEW.conversation_id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER chat_entry_sequence BEFORE INSERT OR UPDATE ON chat_turns
 FOR EACH ROW EXECUTE FUNCTION chat_entry_sequence();
