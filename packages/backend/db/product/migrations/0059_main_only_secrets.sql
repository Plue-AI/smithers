-- A main-only repository secret, like a GitHub environment limited to the
-- default branch, reaches only a run whose trigger is a person's push to the
-- default bookmark, or a scheduled or a person's dispatched run on it (the
-- trusted triggers that save workflow caches). Agent, outsider, pull request
-- and branch runs never receive it.
ALTER TABLE public.repository_secrets
    ADD COLUMN main_only boolean DEFAULT false NOT NULL;
