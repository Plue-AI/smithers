-- The host uses the same memory_notes contract as @smthrs/agent/MemoryStore.
-- No proposal table: proposal data is immutable note provenance.
CREATE TABLE IF NOT EXISTS memory_notes (
 id text PRIMARY KEY CHECK(length(id)>0),
 namespace_kind text NOT NULL CHECK(namespace_kind IN ('flow','agent','user','global')),
 namespace_id text NOT NULL CHECK(length(namespace_id)>0),
 text text NOT NULL,
 tags_json text NOT NULL CHECK(tags_json::jsonb IS NOT NULL),
 provenance_json text NOT NULL CHECK(provenance_json::jsonb IS NOT NULL),
 status text NOT NULL DEFAULT 'accepted' CHECK(status IN ('pending','accepted','rejected')),
 created_at_ms bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_notes_namespace_order_idx ON memory_notes(namespace_kind,namespace_id,created_at_ms,id);
ALTER TABLE memory_notes ADD COLUMN IF NOT EXISTS status_at_ms bigint;
ALTER TABLE memory_notes ADD COLUMN IF NOT EXISTS accepted_todo text;
