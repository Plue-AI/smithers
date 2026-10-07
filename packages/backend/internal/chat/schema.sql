CREATE TABLE chat_turns (
  id text PRIMARY KEY,
  repository_id bigint NOT NULL DEFAULT 0,
  user_id bigint NOT NULL,
  run_id text NOT NULL,
  leg_id text NOT NULL,
  request_payload jsonb,
  request_hash text NOT NULL,
  owner_hash text,
  access_hash text NOT NULL,
  writer_hash text,
  acceptance jsonb,
  acceptance_hash text,
  accepted_at_ms bigint,
  head_batch bigint NOT NULL DEFAULT 0 CHECK (head_batch >= 0),
  head_position bigint NOT NULL DEFAULT 0 CHECK (head_position >= 0),
  cursor_hash text,
  head_hash text,
  output_bytes bigint NOT NULL DEFAULT 0 CHECK (output_bytes >= 0),
  terminal boolean NOT NULL DEFAULT false,
  state text NOT NULL CHECK (state IN ('accepted','running','completed','failed','cancelled','uncertain','retired')),
  producer_generation bigint NOT NULL DEFAULT 0 CHECK (producer_generation >= 0),
  producer_token_hash text,
  producer_lease_expires_at timestamptz,
  producer_started_at timestamptz,
  cancel_requested_at timestamptz,
  retirement jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, run_id, leg_id)
);

CREATE INDEX chat_turns_recovery_idx
  ON chat_turns(state, producer_lease_expires_at, created_at)
  WHERE state IN ('accepted','running');
CREATE INDEX chat_turns_run_idx
  ON chat_turns(user_id, run_id, created_at);

CREATE TABLE chat_turn_batches (
  turn_id text NOT NULL REFERENCES chat_turns(id) ON DELETE CASCADE,
  batch_number bigint NOT NULL CHECK (batch_number > 0),
  from_position bigint NOT NULL CHECK (from_position > 0),
  previous_hash text NOT NULL,
  frames jsonb NOT NULL,
  hash text NOT NULL,
  canonical_bytes integer NOT NULL CHECK (canonical_bytes > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (turn_id, batch_number)
);

CREATE TABLE chat_turn_erasures (
  run_id text NOT NULL,
  leg_id text NOT NULL,
  access_hash text NOT NULL,
  retired_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, leg_id)
);

-- Key erasure tombstones by the proof that wrote them.
--
-- Admission is unique per (user_id, run_id, leg_id), so one public turn
-- identity can be admitted by several accounts, each under its own replay
-- token. A tombstone keyed by identity alone let the first proof reserve the
-- identity: another account's valid proof was refused, and a proof written
-- before admission blocked every other account's admission of that identity.
-- A tombstone now fences only the proof that wrote it.
ALTER TABLE chat_turn_erasures DROP CONSTRAINT chat_turn_erasures_pkey;
ALTER TABLE chat_turn_erasures ADD PRIMARY KEY (run_id, leg_id, access_hash);

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
