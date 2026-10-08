-- Mutable entry facts are a projection of the committed TODO, separate from
-- the append-only, hash-verified prompt/answer journal. One card per subject.
ALTER TABLE chat_turns ADD COLUMN entry_subject jsonb;
ALTER TABLE chat_turns ADD CONSTRAINT chat_turns_entry_subject_object
 CHECK (entry_subject IS NULL OR jsonb_typeof(entry_subject) = 'object');
