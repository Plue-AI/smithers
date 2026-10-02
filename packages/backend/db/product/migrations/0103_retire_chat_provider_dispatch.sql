-- MVP provider retirement (#3389): retain comment history and old receipt rows,
-- but native comment changes no longer dispatch to Slack/Telegram mappings.
CREATE OR REPLACE FUNCTION record_issue_message_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c issue_comments%ROWTYPE; verb text;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.body,NEW.persona) IS NOT DISTINCT FROM (OLD.body,OLD.persona) THEN RETURN NEW; END IF;
 IF TG_OP='DELETE' THEN c:=OLD; verb:='comment.deleted';
 ELSIF TG_OP='INSERT' THEN c:=NEW; verb:='comment.created';
 ELSE c:=NEW; verb:='comment.edited'; END IF;
 IF NOT EXISTS(SELECT 1 FROM issues WHERE id=c.issue_id) THEN RETURN COALESCE(NEW,OLD); END IF;
 INSERT INTO issue_events(issue_id,actor_id,event_type,payload)
 VALUES(c.issue_id,c.user_id,verb,jsonb_build_object('comment',to_jsonb(c),'origin',COALESCE(current_setting('smithers.issue_origin',true),'')));
 RETURN COALESCE(NEW,OLD);
END $$;
