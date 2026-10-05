-- T-APP-04 candidate: assign the next migration number and register it only
-- at landing. This file is not part of the installed migration lineage yet.
ALTER TABLE approvals
    ALTER COLUMN session_id DROP NOT NULL,
    ADD COLUMN member_id bigint REFERENCES users(id) ON DELETE CASCADE,
    -- Keep the issuer identity after token deletion; deletion revokes authority,
    -- but must not erase the immutable request's identity or its receipt.
    ADD COLUMN credential_id bigint,
    ADD COLUMN command text,
    ADD COLUMN subject jsonb,
    ADD COLUMN revision text,
    ADD COLUMN generation bigint,
    ADD COLUMN reviewed_head_sha text,
    ADD COLUMN request_key text,
    ADD CONSTRAINT approvals_confirmation_binding CHECK (
        (member_id IS NULL AND session_id IS NOT NULL AND credential_id IS NULL
         AND command IS NULL AND subject IS NULL AND revision IS NULL
         AND generation IS NULL AND reviewed_head_sha IS NULL AND request_key IS NULL)
        OR
        (member_id IS NOT NULL AND session_id IS NULL AND credential_id > 0
         AND credential_id IS NOT NULL AND command IS NOT NULL
         AND length(command) BETWEEN 1 AND 128
         AND subject IS NOT NULL AND jsonb_typeof(subject) = 'object'
         AND subject->>'kind' IN ('todo', 'branch', 'flow', 'agent', 'wiki')
         AND jsonb_typeof(subject->'kind') = 'string'
         AND jsonb_typeof(subject->'ref') = 'string'
         AND length(subject->>'ref') BETWEEN 1 AND 2048
         AND subject ? 'kind' AND subject ? 'ref'
         AND revision IS NOT NULL AND length(revision) BETWEEN 1 AND 2048
         AND request_key IS NOT NULL AND length(request_key) BETWEEN 1 AND 256
         AND expires_at IS NOT NULL AND expires_at > created_at
         AND expires_at <= created_at + INTERVAL '24 hours'
         AND ((kind = 'one_click' AND generation IS NULL AND reviewed_head_sha IS NULL)
              OR (kind = 'review_merge' AND subject->>'kind' = 'todo'
                  AND generation IS NOT NULL AND generation >= 0
                  AND reviewed_head_sha IS NOT NULL
                  AND reviewed_head_sha ~ '^[0-9a-f]{40}$'
                  AND reviewed_head_sha <> repeat('0',40)))
         AND (state NOT IN ('approved','rejected') OR
              (decided_by IS NOT NULL AND decided_by = member_id)))
    );

CREATE UNIQUE INDEX approvals_confirmation_request
    ON approvals(repository_id, credential_id, request_key) WHERE member_id IS NOT NULL;
CREATE INDEX approvals_member_created
    ON approvals(repository_id, member_id, created_at DESC, id DESC) WHERE member_id IS NOT NULL;

CREATE FUNCTION preserve_confirmation_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.member_id IS NOT NULL AND OLD.state <> 'pending' AND
       ROW(NEW.state, NEW.decided_at, NEW.decided_by)
       IS DISTINCT FROM ROW(OLD.state, OLD.decided_at, OLD.decided_by) THEN
        RAISE EXCEPTION 'confirmation decision is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.member_id IS NOT NULL AND
       ROW(NEW.id, NEW.repository_id, NEW.session_id, NEW.member_id, NEW.credential_id,
           NEW.command, NEW.subject, NEW.revision, NEW.generation, NEW.reviewed_head_sha,
           NEW.request_key, NEW.kind, NEW.payload, NEW.title, NEW.description,
           NEW.created_at, NEW.expires_at)
       IS DISTINCT FROM
       ROW(OLD.id, OLD.repository_id, OLD.session_id, OLD.member_id, OLD.credential_id,
           OLD.command, OLD.subject, OLD.revision, OLD.generation, OLD.reviewed_head_sha,
           OLD.request_key, OLD.kind, OLD.payload, OLD.title, OLD.description,
           OLD.created_at, OLD.expires_at) THEN
        RAISE EXCEPTION 'confirmation binding is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER approvals_preserve_confirmation_binding BEFORE UPDATE ON approvals
    FOR EACH ROW EXECUTE FUNCTION preserve_confirmation_binding();

-- Erase member-owned confirmations before the legacy decided_by SET NULL
-- action runs. Otherwise that action tries to mutate an immutable decision
-- before member_id's CASCADE can remove the row. Legacy approvals retain
-- their existing SET NULL behavior.
CREATE FUNCTION delete_member_confirmations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM approvals WHERE member_id = OLD.id;
    RETURN OLD;
END;
$$;
CREATE TRIGGER users_delete_member_confirmations BEFORE DELETE ON users
    FOR EACH ROW EXECUTE FUNCTION delete_member_confirmations();
