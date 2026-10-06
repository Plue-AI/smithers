-- T-AGT-02: adapter state shares the authoritative machine receipt transaction.
-- Bookkeeping records produce no conversation entry but still advance state.
ALTER TABLE machine_event_receipts ADD COLUMN transcript_checkpoint JSONB;
CREATE INDEX machine_transcript_checkpoint_idx ON machine_event_receipts
  (workspace_id, (transcript_checkpoint->>'source'), (transcript_checkpoint->>'generation'))
  WHERE transcript_checkpoint IS NOT NULL;
