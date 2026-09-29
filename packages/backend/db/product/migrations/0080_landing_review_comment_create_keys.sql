ALTER TABLE public.landing_request_reviews
    ADD COLUMN create_key text,
    ADD COLUMN create_input_hash text,
    ADD COLUMN create_effects_phase integer NOT NULL DEFAULT 0,
    ADD COLUMN create_effects_token text,
    ADD COLUMN create_effects_until timestamptz,
    ADD CONSTRAINT landing_review_create_key_pair CHECK ((create_key IS NULL) = (create_input_hash IS NULL)),
    ADD CONSTRAINT landing_review_create_lease_pair CHECK ((create_effects_token IS NULL) = (create_effects_until IS NULL));

CREATE UNIQUE INDEX landing_review_create_key_unique
    ON public.landing_request_reviews (landing_request_id, reviewer_id, create_key)
    WHERE create_key IS NOT NULL;

ALTER TABLE public.landing_request_comments
    ADD COLUMN create_key text,
    ADD COLUMN create_input_hash text,
    ADD COLUMN create_effects_phase integer NOT NULL DEFAULT 0,
    ADD COLUMN create_effects_token text,
    ADD COLUMN create_effects_until timestamptz,
    ADD CONSTRAINT landing_comment_create_key_pair CHECK ((create_key IS NULL) = (create_input_hash IS NULL)),
    ADD CONSTRAINT landing_comment_create_lease_pair CHECK ((create_effects_token IS NULL) = (create_effects_until IS NULL));

CREATE UNIQUE INDEX landing_comment_create_key_unique
    ON public.landing_request_comments (landing_request_id, user_id, create_key)
    WHERE create_key IS NOT NULL;
