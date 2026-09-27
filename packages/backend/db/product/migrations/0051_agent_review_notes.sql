-- An agent may comment on or request changes to a landing without a verdict
-- (the CLI's `land review` run with an agent's credential). Only a verdict
-- review carries the confidence and summary, and only an LGTM counts.
ALTER TABLE public.landing_request_reviews
    DROP CONSTRAINT landing_request_reviews_agent_fields_check,
    ADD CONSTRAINT landing_request_reviews_agent_fields_check CHECK (
        reviewer_kind::text = 'human'
        OR (verdict IS NULL AND confidence_bucket IS NULL
            AND type::text IN ('comment', 'request_changes')
            AND length(btrim(body)) > 0 AND length(btrim(commit_id::text)) > 0)
        OR (verdict IS NOT NULL AND confidence_bucket IS NOT NULL
            AND length(btrim(summary)) > 0 AND length(btrim(commit_id::text)) > 0)
    );
