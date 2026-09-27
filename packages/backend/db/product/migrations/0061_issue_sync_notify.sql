-- Delivery wakeups share the existing issue stream. Facts remain authoritative
-- for issue state; this owner-scoped hint only asks a connector to drain its
-- already-persisted receipts. PostgreSQL publishes it after commit.
CREATE FUNCTION notify_issue_sync_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE repo bigint; recipient bigint;
BEGIN
 IF NEW.issue_id IS NULL OR NEW.state <> 'pending' THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.state=NEW.state THEN RETURN NEW; END IF;
 SELECT i.repository_id,t.owner_id INTO repo,recipient
 FROM issues i JOIN issue_sync_threads t ON t.issue_id=i.id WHERE i.id=NEW.issue_id;
 IF repo IS NOT NULL THEN
  PERFORM pg_notify('issue_state_facts_'||repo::text,'sync:'||recipient::text);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER trg_issue_sync_delivery_notify AFTER INSERT OR UPDATE OF state ON issue_sync_deliveries
 FOR EACH ROW EXECUTE FUNCTION notify_issue_sync_delivery();
