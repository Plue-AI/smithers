package product

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

// planeAdoptedClaimObjects is how a Plue database created the claim lease in
// its private baseline before product migration 0091 owned it (#3155).
const planeAdoptedClaimObjects = `
CREATE TABLE public.workflow_sandbox_claims (
    workflow_run_id bigint NOT NULL,
    generation bigint DEFAULT 0 NOT NULL,
    claim_token uuid,
    claimed_at timestamptz,
    lease_expires_at timestamptz,
    CONSTRAINT workflow_sandbox_claims_active_fields_match CHECK ((((claim_token IS NULL) AND (claimed_at IS NULL) AND (lease_expires_at IS NULL)) OR ((claim_token IS NOT NULL) AND (claimed_at IS NOT NULL) AND (lease_expires_at IS NOT NULL)))),
    CONSTRAINT workflow_sandbox_claims_generation_nonnegative CHECK ((generation >= 0))
);
ALTER TABLE ONLY public.workflow_sandbox_claims
    ADD CONSTRAINT workflow_sandbox_claims_pkey PRIMARY KEY (workflow_run_id);
CREATE UNIQUE INDEX idx_workflow_sandbox_claims_active_token ON public.workflow_sandbox_claims USING btree (claim_token) WHERE (claim_token IS NOT NULL);
CREATE INDEX idx_workflow_sandbox_claims_expiry ON public.workflow_sandbox_claims USING btree (lease_expires_at, workflow_run_id) WHERE (claim_token IS NOT NULL);
ALTER TABLE ONLY public.workflow_sandbox_claims
    ADD CONSTRAINT workflow_sandbox_claims_workflow_run_id_fkey FOREIGN KEY (workflow_run_id) REFERENCES public.workflow_runs(id) ON DELETE CASCADE;
CREATE FUNCTION public.guard_workflow_sandbox_terminal_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;
CREATE FUNCTION public.invalidate_workflow_sandbox_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END; $$;
CREATE TRIGGER trg_workflow_runs_40_sandbox_terminal_claim_guard BEFORE UPDATE OF status ON public.workflow_runs FOR EACH ROW EXECUTE FUNCTION public.guard_workflow_sandbox_terminal_claim();
CREATE TRIGGER trg_workflow_runs_90_invalidate_sandbox_claim AFTER UPDATE OF status ON public.workflow_runs FOR EACH ROW EXECUTE FUNCTION public.invalidate_workflow_sandbox_claim();
`

// 0091 adopts a database that already holds the claim lease: live claims
// survive, each object exists once, and the fence behaves as the product's.
func TestWorkflowSandboxClaimsMigrationAdoptsExistingLease(t *testing.T) {
	pool := reviewDatabase(t, 90)
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		_, err := pool.Exec(ctx, sql, args...)
		require.NoError(t, err)
	}
	exec(planeAdoptedClaimObjects)
	exec(`INSERT INTO users (id, username, lower_username) VALUES (1, 'lease', 'lease')`)
	exec(`INSERT INTO repositories (id, user_id, name, lower_name) VALUES (1, 1, 'ci', 'ci')`)
	exec(`INSERT INTO workflow_definitions (id, repository_id, name, path, config) VALUES (1, 1, 'CI', '.smithers/workflows/ci.tsx', '{}')`)
	exec(`INSERT INTO workflow_runs (id, repository_id, workflow_definition_id, status, trigger_event, execution_plane) VALUES (1, 1, 1, 'running', 'push', 'sandbox')`)
	const token = "00000000-0000-4000-8000-00000000c1a1"
	exec(`INSERT INTO workflow_sandbox_claims VALUES (1, 4, $1, now(), now() + interval '2 minutes')`, token)

	require.NoError(t, Apply(ctx, pool))
	require.NoError(t, Apply(ctx, pool), "recorded migration can be applied again")

	var claims, triggers, indexes int
	require.NoError(t, pool.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM workflow_sandbox_claims WHERE claim_token = $1 AND generation = 4),
		(SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.workflow_runs'::regclass AND tgname IN
			('trg_workflow_runs_40_sandbox_terminal_claim_guard', 'trg_workflow_runs_90_invalidate_sandbox_claim')),
		(SELECT count(*) FROM pg_indexes WHERE tablename = 'workflow_sandbox_claims')`, token).Scan(&claims, &triggers, &indexes))
	require.Equal(t, 1, claims, "the live claim survives adoption")
	require.Equal(t, 2, triggers)
	require.Equal(t, 3, indexes, "primary key plus the two lease indexes, none duplicated")

	// The replaced functions are the product fence: an unmarked write is
	// ignored, the owner's marked write lands and releases the lease.
	exec(`UPDATE workflow_runs SET status = 'success' WHERE id = 1`)
	var status string
	require.NoError(t, pool.QueryRow(ctx, `SELECT status FROM workflow_runs WHERE id = 1`).Scan(&status))
	require.Equal(t, "running", status)
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `SELECT set_config('smithers.workflow_sandbox_claim_token', $1, true), set_config('smithers.workflow_sandbox_claim_generation', '4', true)`, token)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `UPDATE workflow_runs SET status = 'success' WHERE id = 1`)
	require.NoError(t, err)
	require.NoError(t, tx.Commit(ctx))
	var generation int64
	var live bool
	require.NoError(t, pool.QueryRow(ctx, `SELECT r.status, c.generation, c.claim_token IS NOT NULL
		FROM workflow_runs r JOIN workflow_sandbox_claims c ON c.workflow_run_id = r.id WHERE r.id = 1`).Scan(&status, &generation, &live))
	require.Equal(t, "success", status)
	require.Equal(t, int64(5), generation)
	require.False(t, live)
}
