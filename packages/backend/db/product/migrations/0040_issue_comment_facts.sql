-- Comment facts share the repository journal. Audience survives row deletion.
ALTER TABLE issue_state_facts ADD COLUMN audience_user_id bigint;
ALTER TABLE issue_state_facts DROP CONSTRAINT issue_state_facts_entity_type_check;
ALTER TABLE issue_state_facts ADD CONSTRAINT issue_state_facts_entity_type_check
 CHECK (entity_type IN ('issue','issue_label','issue_assignee','issue_comment'));
CREATE FUNCTION record_issue_comment_fact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c issue_comments%ROWTYPE; i issues%ROWTYPE; position bigint;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.body,NEW.persona) IS NOT DISTINCT FROM (OLD.body,OLD.persona) THEN RETURN NEW; END IF;
 c:=CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
 SELECT * INTO i FROM issues WHERE id=c.issue_id;
 IF NOT FOUND THEN RETURN COALESCE(NEW,OLD); END IF;
 UPDATE issue_state_journals SET head=head+1 WHERE repository_id=i.repository_id RETURNING head INTO STRICT position;
 INSERT INTO issue_state_facts(repository_id,sequence,entity_type,operation,issue_id,entity_key,post_image,audience_user_id)
 VALUES(i.repository_id,position,'issue_comment',CASE TG_OP WHEN 'INSERT' THEN 'created' WHEN 'UPDATE' THEN 'updated' ELSE 'deleted' END,
 i.id,c.id::text,CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(c) END,CASE WHEN i.kind='chat' THEN i.author_id END);
 PERFORM pg_notify('issue_state_facts_'||i.repository_id::text,position::text);
 RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER trg_issue_comment_fact AFTER INSERT OR UPDATE OR DELETE ON issue_comments FOR EACH ROW EXECUTE FUNCTION record_issue_comment_fact();
