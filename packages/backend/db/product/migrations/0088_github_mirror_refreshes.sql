-- A GitHub mirror is cloned from GitHub at most once per refresh cooldown,
-- whichever user, job or replica imports it (#2970). refreshed_at is the last
-- successful clone; claim_token/claim_expires_at lease a refresh in flight.
CREATE TABLE public.github_mirror_refreshes (
    repository_id bigint PRIMARY KEY REFERENCES public.repositories(id) ON DELETE CASCADE,
    refreshed_at timestamptz,
    claim_token character varying(64),
    claim_expires_at timestamptz,
    CONSTRAINT ck_github_mirror_refreshes_claim CHECK (
        ((claim_token IS NULL) AND (claim_expires_at IS NULL))
        OR (((claim_token)::text ~ '^[0-9a-f]{64}$'::text) AND (claim_expires_at IS NOT NULL)))
);
