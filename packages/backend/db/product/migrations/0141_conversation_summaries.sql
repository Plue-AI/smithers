ALTER TABLE chat_turns ADD COLUMN summary text;
ALTER TABLE chat_turns ADD COLUMN summary_rev bigint NOT NULL DEFAULT 0;
ALTER TABLE chat_turns ADD COLUMN summary_pending_since timestamptz;
