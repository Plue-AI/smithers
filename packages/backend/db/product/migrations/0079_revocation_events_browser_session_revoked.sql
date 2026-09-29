-- Logging out or deleting a browser session must end the live deliveries that
-- session authorized. token_hash carries the SHA-256 of the session key.
ALTER TABLE ONLY public.revocation_events
    DROP CONSTRAINT IF EXISTS revocation_events_kind_check;

ALTER TABLE ONLY public.revocation_events
    ADD CONSTRAINT revocation_events_kind_check CHECK ((kind = ANY (ARRAY['token_revoked'::text, 'token_scopes_narrowed'::text, 'user_disabled'::text, 'user_enabled'::text, 'collaborator_removed'::text, 'workspace_share_removed'::text, 'agent_session_cancelled'::text, 'org_member_removed'::text, 'gateway_revoked'::text, 'ssh_key_revoked'::text, 'browser_session_revoked'::text])));
