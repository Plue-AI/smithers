-- #3175: a repository or organization workflow secret declares the hosts and
-- request headers it may be sent to, the binding model agent-environment
-- secrets use. A hosted NixOS CI guest receives a bound secret only through
-- its per-sandbox egress proxy, as a placeholder; an unbound secret is
-- refused there. Empty on both sides means unbound.
ALTER TABLE public.repository_secrets
    ADD COLUMN IF NOT EXISTS hosts text[] DEFAULT '{}'::text[] NOT NULL,
    ADD COLUMN IF NOT EXISTS match_headers text[] DEFAULT '{}'::text[] NOT NULL;

ALTER TABLE public.organization_secrets
    ADD COLUMN IF NOT EXISTS hosts text[] DEFAULT '{}'::text[] NOT NULL,
    ADD COLUMN IF NOT EXISTS match_headers text[] DEFAULT '{}'::text[] NOT NULL;
