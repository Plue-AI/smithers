-- #2158: a registration report shared across accounts. Only the backend writes
-- it, from a completed registration run it read on the registrant's box for a
-- repository GitHub serves anonymously, so a private repository never has a
-- row. A report is keyed by the source repository and the commit it analysed;
-- the first observation of a commit stays.
CREATE TABLE public.repository_registration_reports (
    host text NOT NULL DEFAULT 'github.com' CHECK (host = lower(host) AND btrim(host) <> ''),
    owner text NOT NULL CHECK (owner = lower(owner) AND btrim(owner) <> ''),
    name text NOT NULL CHECK (name = lower(name) AND btrim(name) <> ''),
    commit_sha text NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
    report jsonb NOT NULL CHECK (jsonb_typeof(report) = 'object'),
    recorded_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (host, owner, name, commit_sha)
);
