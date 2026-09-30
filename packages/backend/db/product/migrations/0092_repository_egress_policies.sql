-- #2653: a repository's owner-set egress allowlist. A non-empty list is sent
-- as EgressProxyPolicy.AllowDomains when a sandbox of the repository is
-- created or resumed and replaces the running proxies' list on write; an
-- empty list leaves the list to the provider's deployment default.
CREATE TABLE IF NOT EXISTS public.repository_egress_policies (
    repository_id bigint PRIMARY KEY REFERENCES public.repositories(id) ON DELETE CASCADE,
    allow_domains text[] NOT NULL DEFAULT '{}',
    updated_by bigint REFERENCES public.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
