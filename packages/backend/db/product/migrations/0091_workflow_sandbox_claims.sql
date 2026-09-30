-- #3155: the CI run claim lease is product state. Self-hosted and Plue
-- deployments claim queued sandbox-plane runs through the same table,
-- terminal fence and queries (db/product/queries/workflow_sandbox_claims.sql).
-- Every statement is idempotent so a Plue database that created these objects
-- in its private baseline adopts them unchanged; the definitions match it.
CREATE TABLE IF NOT EXISTS public.workflow_sandbox_claims (
    workflow_run_id bigint NOT NULL,
    generation bigint DEFAULT 0 NOT NULL,
    claim_token uuid,
    claimed_at timestamptz,
    lease_expires_at timestamptz,
    CONSTRAINT workflow_sandbox_claims_pkey PRIMARY KEY (workflow_run_id),
    CONSTRAINT workflow_sandbox_claims_workflow_run_id_fkey FOREIGN KEY (workflow_run_id) REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
    CONSTRAINT workflow_sandbox_claims_active_fields_match CHECK ((((claim_token IS NULL) AND (claimed_at IS NULL) AND (lease_expires_at IS NULL)) OR ((claim_token IS NOT NULL) AND (claimed_at IS NOT NULL) AND (lease_expires_at IS NOT NULL)))),
    CONSTRAINT workflow_sandbox_claims_generation_nonnegative CHECK ((generation >= 0))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_sandbox_claims_active_token ON public.workflow_sandbox_claims USING btree (claim_token) WHERE (claim_token IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_workflow_sandbox_claims_expiry ON public.workflow_sandbox_claims USING btree (lease_expires_at, workflow_run_id) WHERE (claim_token IS NOT NULL);

-- A sandbox-plane run leaves 'running' for success or failure only through
-- the scheduler that holds its live claim: the finishing statement names the
-- claim in transaction settings. A queued run cannot jump straight to a
-- terminal scheduler outcome. Cancellation is not fenced.
CREATE OR REPLACE FUNCTION public.guard_workflow_sandbox_terminal_claim() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    active_claim workflow_sandbox_claims%ROWTYPE;
BEGIN
    IF OLD.execution_plane IS DISTINCT FROM 'sandbox'
       OR NEW.status NOT IN ('success', 'failure') THEN
        RETURN NEW;
    END IF;

    IF OLD.status = 'queued' THEN
        RETURN NULL;
    END IF;

    SELECT *
    INTO active_claim
    FROM workflow_sandbox_claims
    WHERE workflow_run_id = OLD.id
      AND claim_token IS NOT NULL;

    IF FOUND
       AND (
           current_setting('smithers.workflow_sandbox_claim_token', true)
               IS DISTINCT FROM active_claim.claim_token::text
           OR current_setting('smithers.workflow_sandbox_claim_generation', true)
               IS DISTINCT FROM active_claim.generation::text
       ) THEN
        RETURN NULL;
    END IF;

    RETURN NEW;
END;
$$;

-- Any terminal status releases the lease and advances the generation, so a
-- scheduler that lost its run can neither renew nor finish it.
CREATE OR REPLACE FUNCTION public.invalidate_workflow_sandbox_claim() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.execution_plane = 'sandbox'
       AND NEW.status IN ('success', 'failure', 'cancelled')
       AND NEW.status IS DISTINCT FROM OLD.status THEN
        UPDATE workflow_sandbox_claims
        SET generation = generation + 1,
            claim_token = NULL,
            claimed_at = NULL,
            lease_expires_at = NULL
        WHERE workflow_run_id = NEW.id
          AND claim_token IS NOT NULL;
    END IF;

    RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER trg_workflow_runs_40_sandbox_terminal_claim_guard BEFORE UPDATE OF status ON public.workflow_runs FOR EACH ROW EXECUTE FUNCTION public.guard_workflow_sandbox_terminal_claim();

CREATE OR REPLACE TRIGGER trg_workflow_runs_90_invalidate_sandbox_claim AFTER UPDATE OF status ON public.workflow_runs FOR EACH ROW EXECUTE FUNCTION public.invalidate_workflow_sandbox_claim();
