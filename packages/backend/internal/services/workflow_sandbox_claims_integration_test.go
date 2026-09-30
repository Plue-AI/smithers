package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/runtimeports"
)

// #3155: the claim lease is product SQL, so a self-hosted database claims,
// renews, loses, and fences sandbox-plane runs exactly as Plue's did.
func TestProductWorkflowSandboxSchedulerClaimLifecyclePostgres(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	store := NewProductWorkflowSandboxScheduler(db.New(pool))
	repoID, defID := sandboxClaimFixture(t, pool)

	first := sandboxClaimRun(t, pool, repoID, defID, "sandbox", "queued", "push")
	second := sandboxClaimRun(t, pool, repoID, defID, "sandbox", "queued", "workflow_dispatch")
	agent := sandboxClaimRun(t, pool, repoID, defID, "agent", "queued", "push")
	flow := sandboxClaimRun(t, pool, repoID, defID, "flow", "queued", "push")

	// Oldest first, bounded by the limit, and only the sandbox plane.
	claimed, err := store.ClaimQueuedWorkflowRuns(ctx, 1)
	require.NoError(t, err)
	require.Len(t, claimed, 1)
	claim := claimed[0]
	assert.Equal(t, first, claim.ID)
	assert.Equal(t, repoID, claim.RepositoryID)
	assert.Equal(t, defID, claim.WorkflowDefinitionID)
	assert.Equal(t, "push", claim.TriggerEvent, "the claim carries the trigger that gates main-only secrets")
	assert.Equal(t, "refs/heads/main", claim.TriggerRef)
	assert.True(t, claim.ClaimToken.Valid)
	assert.Equal(t, int64(1), claim.ClaimGeneration)
	assert.WithinDuration(t, time.Now().Add(2*time.Minute), claim.ClaimLeaseExpiresAt.Time, 30*time.Second)
	assert.Equal(t, "running", sandboxClaimStatus(t, pool, first))

	rest, err := store.ClaimQueuedWorkflowRuns(ctx, 10)
	require.NoError(t, err)
	require.Len(t, rest, 1, "a live lease is not reclaimed and other planes are never claimed")
	assert.Equal(t, second, rest[0].ID)
	assert.Equal(t, "workflow_dispatch", rest[0].TriggerEvent)
	assert.Equal(t, "queued", sandboxClaimStatus(t, pool, agent))
	assert.Equal(t, "queued", sandboxClaimStatus(t, pool, flow))

	token := UUIDString(claim.ClaimToken)
	renew := func(token string, generation int64) (time.Time, error) {
		expires, err := store.RenewWorkflowSandboxClaim(ctx, runtimeports.RenewWorkflowSandboxClaimParams{ID: first, ClaimToken: token, ClaimGeneration: generation})
		return expires.Time, err
	}

	// Renewal extends only the live claim.
	_, err = pool.Exec(ctx, `UPDATE workflow_sandbox_claims SET lease_expires_at = NOW() + INTERVAL '5 seconds' WHERE workflow_run_id = $1`, first)
	require.NoError(t, err)
	expires, err := renew(token, 1)
	require.NoError(t, err)
	assert.WithinDuration(t, time.Now().Add(2*time.Minute), expires, 30*time.Second)
	_, err = renew(token, 2)
	assert.ErrorIs(t, err, pgx.ErrNoRows, "a wrong generation cannot renew")
	_, err = renew(UUIDString(rest[0].ClaimToken), 1)
	assert.ErrorIs(t, err, pgx.ErrNoRows, "another run's token cannot renew this run")

	// A plain status write cannot finish a claimed run: only the owner can.
	_, err = pool.Exec(ctx, `UPDATE workflow_runs SET status = 'success' WHERE id = $1`, first)
	require.NoError(t, err)
	assert.Equal(t, "running", sandboxClaimStatus(t, pool, first))

	// Lease loss: an expired lease is reclaimed under a new token and generation.
	_, err = pool.Exec(ctx, `UPDATE workflow_sandbox_claims SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE workflow_run_id = $1`, first)
	require.NoError(t, err)
	reclaimed, err := store.ClaimQueuedWorkflowRuns(ctx, 10)
	require.NoError(t, err)
	require.Len(t, reclaimed, 1)
	assert.Equal(t, first, reclaimed[0].ID)
	assert.Equal(t, int64(2), reclaimed[0].ClaimGeneration)
	assert.NotEqual(t, token, UUIDString(reclaimed[0].ClaimToken))

	// The previous owner can neither renew nor finish.
	_, err = renew(token, 1)
	assert.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = store.MarkWorkflowRunFailure(ctx, runtimeports.MarkWorkflowRunFailureParams{ID: first, ClaimToken: token, ClaimGeneration: 1})
	assert.ErrorIs(t, err, pgx.ErrNoRows)
	assert.Equal(t, "running", sandboxClaimStatus(t, pool, first))

	// The current owner finishes; the lease is released and the generation moves on.
	run, err := store.MarkWorkflowRunSuccess(ctx, runtimeports.MarkWorkflowRunSuccessParams{
		ID: first, ClaimToken: UUIDString(reclaimed[0].ClaimToken), ClaimGeneration: 2,
	})
	require.NoError(t, err)
	assert.Equal(t, first, run.ID)
	assert.Equal(t, "success", run.Status)
	assert.True(t, run.CompletedAt.Valid)
	var generation int64
	var live bool
	require.NoError(t, pool.QueryRow(ctx, `SELECT generation, claim_token IS NOT NULL FROM workflow_sandbox_claims WHERE workflow_run_id = $1`, first).Scan(&generation, &live))
	assert.Equal(t, int64(3), generation)
	assert.False(t, live)
	_, err = store.MarkWorkflowRunSuccess(ctx, runtimeports.MarkWorkflowRunSuccessParams{
		ID: first, ClaimToken: UUIDString(reclaimed[0].ClaimToken), ClaimGeneration: 2,
	})
	assert.ErrorIs(t, err, pgx.ErrNoRows, "a finished run is not finished twice")

	// Cancellation is not fenced, and it revokes the running claim.
	require.NoError(t, db.New(pool).CancelWorkflowRun(ctx, second))
	assert.Equal(t, "cancelled", sandboxClaimStatus(t, pool, second))
	_, err = store.RenewWorkflowSandboxClaim(ctx, runtimeports.RenewWorkflowSandboxClaimParams{ID: second, ClaimToken: UUIDString(rest[0].ClaimToken), ClaimGeneration: 1})
	assert.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = store.MarkWorkflowRunFailure(ctx, runtimeports.MarkWorkflowRunFailureParams{ID: second, ClaimToken: UUIDString(rest[0].ClaimToken), ClaimGeneration: 1})
	assert.ErrorIs(t, err, pgx.ErrNoRows)
	assert.Equal(t, "cancelled", sandboxClaimStatus(t, pool, second))
}

// A queued run cannot jump to a scheduler outcome, and a running row that
// predates the lease is recovered only after three hours.
func TestProductWorkflowSandboxSchedulerFencesUnleasedRunsPostgres(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	store := NewProductWorkflowSandboxScheduler(db.New(pool))
	repoID, defID := sandboxClaimFixture(t, pool)

	queued := sandboxClaimRun(t, pool, repoID, defID, "sandbox", "queued", "push")
	_, err := pool.Exec(ctx, `UPDATE workflow_runs SET status = 'failure' WHERE id = $1`, queued)
	require.NoError(t, err)
	assert.Equal(t, "queued", sandboxClaimStatus(t, pool, queued))
	_, err = pool.Exec(ctx, `UPDATE workflow_runs SET status = 'cancelled' WHERE id = $1`, queued)
	require.NoError(t, err)

	fresh := sandboxClaimRun(t, pool, repoID, defID, "sandbox", "running", "push")
	stale := sandboxClaimRun(t, pool, repoID, defID, "sandbox", "running", "push")
	_, err = pool.Exec(ctx, `UPDATE workflow_runs SET updated_at = NOW() - INTERVAL '3 hours 1 minute' WHERE id = $1`, stale)
	require.NoError(t, err)
	claimed, err := store.ClaimQueuedWorkflowRuns(ctx, 10)
	require.NoError(t, err)
	require.Len(t, claimed, 1)
	assert.Equal(t, stale, claimed[0].ID)
	assert.Equal(t, int64(1), claimed[0].ClaimGeneration)
	assert.Equal(t, "running", sandboxClaimStatus(t, pool, fresh))

	// An unleased running run is still finishable (no claim to check), which
	// lets the pre-lease scheduler generation drain.
	_, err = pool.Exec(ctx, `UPDATE workflow_runs SET status = 'failure' WHERE id = $1`, fresh)
	require.NoError(t, err)
	assert.Equal(t, "failure", sandboxClaimStatus(t, pool, fresh))

	// A malformed claim token is refused, not treated as a match.
	_, err = store.MarkWorkflowRunSuccess(ctx, runtimeports.MarkWorkflowRunSuccessParams{ID: stale, ClaimToken: "not-a-uuid", ClaimGeneration: 1})
	require.Error(t, err)
	assert.False(t, errors.Is(err, pgx.ErrNoRows))
	assert.Equal(t, "running", sandboxClaimStatus(t, pool, stale))
}

// Claims are exclusive under concurrency: every queued run goes to exactly
// one of several schedulers polling at once.
func TestProductWorkflowSandboxSchedulerConcurrentClaimsPostgres(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	store := NewProductWorkflowSandboxScheduler(db.New(pool))
	repoID, defID := sandboxClaimFixture(t, pool)
	const runs = 12
	for range runs {
		sandboxClaimRun(t, pool, repoID, defID, "sandbox", "queued", "push")
	}
	results := make(chan []runtimeports.ClaimQueuedWorkflowRunsRow, 4)
	errs := make(chan error, 4)
	for range 4 {
		go func() {
			rows, err := store.ClaimQueuedWorkflowRuns(ctx, 5)
			results <- rows
			errs <- err
		}()
	}
	seen := map[int64]bool{}
	for range 4 {
		require.NoError(t, <-errs)
		for _, row := range <-results {
			assert.False(t, seen[row.ID], "run %d claimed twice", row.ID)
			seen[row.ID] = true
		}
	}
	assert.LessOrEqual(t, len(seen), runs)
	rest, err := store.ClaimQueuedWorkflowRuns(ctx, runs)
	require.NoError(t, err)
	assert.Len(t, rest, runs-len(seen), "runs skipped under lock contention stay claimable")
}

func sandboxClaimFixture(t *testing.T, pool *pgxpool.Pool) (int64, int64) {
	t.Helper()
	ctx := context.Background()
	var userID, repoID, defID int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users (username, lower_username) VALUES ('claims', 'claims') RETURNING id`).Scan(&userID))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories (user_id, name, lower_name, description, is_public, default_bookmark)
		VALUES ($1, 'ci', 'ci', '', FALSE, 'main') RETURNING id`, userID).Scan(&repoID))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workflow_definitions (repository_id, name, path, config)
		VALUES ($1, 'CI', '.smithers/workflows/ci.tsx', '{}') RETURNING id`, repoID).Scan(&defID))
	return repoID, defID
}

func sandboxClaimRun(t *testing.T, pool *pgxpool.Pool, repoID, defID int64, plane, status, event string) int64 {
	t.Helper()
	var id int64
	require.NoError(t, pool.QueryRow(context.Background(), `INSERT INTO workflow_runs
		(repository_id, workflow_definition_id, status, trigger_event, trigger_ref, trigger_commit_sha, execution_plane)
		VALUES ($1, $2, $3, $4, 'refs/heads/main', $5, $6) RETURNING id`,
		repoID, defID, status, event, "ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12", plane).Scan(&id))
	return id
}

func sandboxClaimStatus(t *testing.T, pool *pgxpool.Pool, runID int64) string {
	t.Helper()
	var status string
	require.NoError(t, pool.QueryRow(context.Background(), `SELECT status FROM workflow_runs WHERE id = $1`, runID).Scan(&status))
	return status
}
