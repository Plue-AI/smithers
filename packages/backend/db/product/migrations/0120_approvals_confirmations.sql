-- A person confirmation (spec §5.4) is an approvals row that a delegated
-- credential's command creates for its member: it has no agent session, it
-- names the member who must press it, the credential that asked and that
-- request's Idempotency-Key. A repeat of the request finds its row through
-- (credential_id, request_key); the member's list reads by member_id.
ALTER TABLE approvals
    ALTER COLUMN session_id DROP NOT NULL,
    ADD COLUMN member_id bigint REFERENCES users(id) ON DELETE CASCADE,
    ADD COLUMN credential_id bigint,
    ADD COLUMN request_key text,
    ADD CONSTRAINT approvals_requester_check CHECK (session_id IS NOT NULL OR member_id IS NOT NULL),
    ADD CONSTRAINT approvals_request_check CHECK ((credential_id IS NULL) = (request_key IS NULL));
CREATE UNIQUE INDEX approvals_credential_request ON approvals (credential_id, request_key) WHERE request_key IS NOT NULL;
CREATE INDEX approvals_member_state_created ON approvals (member_id, state, created_at DESC) WHERE member_id IS NOT NULL;
