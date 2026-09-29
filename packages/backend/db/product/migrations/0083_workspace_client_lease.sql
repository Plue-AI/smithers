-- #2457: an optional lease the creating client renews. A workspace whose
-- lease lapsed is suspended, then deleted after the configured age; a
-- workspace without a lease is never touched by that reaper.
ALTER TABLE public.workspaces
    ADD COLUMN client_lease_secs integer CONSTRAINT workspaces_client_lease_secs_check CHECK (client_lease_secs > 0),
    ADD COLUMN client_lease_expires_at timestamptz,
    ADD CONSTRAINT workspaces_client_lease_pair CHECK ((client_lease_secs IS NULL) = (client_lease_expires_at IS NULL));

CREATE INDEX workspaces_client_lease_expires_idx ON public.workspaces (client_lease_expires_at)
    WHERE client_lease_expires_at IS NOT NULL AND deleted_at IS NULL;
