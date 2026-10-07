-- Shared turns use the existing journal; legacy private history stays private.
-- Only new admissions set conversation_id. Legacy payload names are private
-- to each member and may already have concurrent producers (T-APP-16 Earlier).
ALTER TABLE chat_turns ADD COLUMN conversation_id text;
ALTER TABLE chat_turns DROP CONSTRAINT chat_turns_state_check;
ALTER TABLE chat_turns ADD CONSTRAINT chat_turns_state_check CHECK (state IN ('accepted','queued','running','completed','failed','cancelled','uncertain','retired'));
CREATE INDEX chat_turns_conversation_idx ON chat_turns(repository_id,conversation_id,created_at,id) WHERE conversation_id IS NOT NULL;
CREATE UNIQUE INDEX chat_turns_conversation_running_idx ON chat_turns(repository_id,conversation_id) WHERE repository_id>0 AND conversation_id IS NOT NULL AND state='running';
DROP INDEX chat_turns_recovery_idx;
CREATE INDEX chat_turns_recovery_idx ON chat_turns(state,producer_lease_expires_at,created_at) WHERE state IN ('accepted','queued','running');
ALTER TABLE collaborators ADD COLUMN view_state jsonb NOT NULL DEFAULT '{}', ADD COLUMN toasts_hidden boolean NOT NULL DEFAULT false;
ALTER TABLE collaborators ADD CONSTRAINT collaborators_view_state_object CHECK (jsonb_typeof(view_state)='object');
