-- Imported GitHub keys are reconciled independently of manually added keys.
ALTER TABLE ssh_keys ADD COLUMN source text NOT NULL DEFAULT 'manual'
 CHECK (source IN ('manual','github'));
CREATE UNIQUE INDEX ssh_keys_user_fingerprint_unique ON ssh_keys(user_id,fingerprint);
-- Preserve global uniqueness: one key must never authenticate as two people.
DROP TABLE pair_prompt_queue, pair_session_draft, pair_session_invites,
 pair_session_links, pair_session_members, pair_share_links, pair_state,
 share_listing_event_cooldowns, share_listings, pair_sessions;
