package db

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

func recoveryRun(t *testing.T, q *Queries, repo, user int64, running bool) int64 {
	t.Helper()
	ctx := context.Background()
	run, err := q.CreateGithubMirrorSyncRun(ctx, CreateGithubMirrorSyncRunParams{
		RepositoryID: repo, RequestedBy: pgtype.Int8{Int64: user, Valid: true},
	})
	require.NoError(t, err)
	if running {
		rows, err := q.MarkGithubMirrorSyncRunRunning(ctx, run.ID)
		require.NoError(t, err)
		require.Equal(t, int64(1), rows)
	}
	return run.ID
}

func recoveryAge(t *testing.T, db DBTX, run int64, age string) {
	t.Helper()
	_, err := db.Exec(context.Background(), `UPDATE github_mirror_sync_runs
		SET created_at = NOW() - $2::interval, updated_at = NOW()
		WHERE id = $1`, run, age)
	require.NoError(t, err)
}

func recoveryUpsert(t *testing.T, q *Queries, arg UpsertGithubMirrorSyncRefResultParams, wantRows int64) {
	t.Helper()
	rows, err := q.UpsertGithubMirrorSyncRefResult(context.Background(), arg)
	require.NoError(t, err)
	require.Equal(t, wantRows, rows)
}

func TestGitMirrorRecoveryFixedDeadlineAndFencing(t *testing.T) {
	ctx := context.Background()
	q, tx := newQueries(t)
	user := mustCreateUser(t, tx, uniqueTestUsername(t))
	repo := mustCreateRepo(t, tx, user, uniqueTestRepoName(t))
	run := recoveryRun(t, q, repo, user, false)

	// At the exact worker deadline a queued launch cannot start, but remains
	// recoverable only at its separate finalization deadline.
	recoveryAge(t, tx, run, "10 minutes")
	rows, err := q.MarkGithubMirrorSyncRunRunning(ctx, run)
	require.NoError(t, err)
	require.Zero(t, rows)
	rows, err = q.ExpireGithubMirrorSyncRuns(ctx, repo)
	require.NoError(t, err)
	require.Zero(t, rows)
	var state string
	require.NoError(t, tx.QueryRow(ctx, `SELECT state FROM github_mirror_sync_runs WHERE id=$1`, run).Scan(&state))
	require.Equal(t, "queued", state)

	// updated_at is fresh, but admission is tied to created_at. Neither a
	// late finisher nor a late writer can publish anything before the sweep.
	recoveryAge(t, tx, run, "11 minutes")
	rows, err = q.MarkGithubMirrorSyncRunRunning(ctx, run)
	require.NoError(t, err)
	require.Zero(t, rows)
	require.NoError(t, q.FinishGithubMirrorSyncRun(ctx, FinishGithubMirrorSyncRunParams{ID: run, State: "failed"}))
	rows, err = q.FinishSuccessfulGithubMirrorSyncRun(ctx, FinishSuccessfulGithubMirrorSyncRunParams{
		ID: run, VerifiedRefs: []byte(`{"refs/heads/main":"stale"}`),
	})
	require.NoError(t, err)
	require.Zero(t, rows)
	require.NoError(t, tx.QueryRow(ctx, `SELECT state FROM github_mirror_sync_runs WHERE id=$1`, run).Scan(&state))
	require.Equal(t, "queued", state)

	rows, err = q.ExpireGithubMirrorSyncRuns(ctx, repo)
	require.NoError(t, err)
	require.Equal(t, int64(1), rows)
	require.NoError(t, tx.QueryRow(ctx, `SELECT state FROM github_mirror_sync_runs WHERE id=$1`, run).Scan(&state))
	require.Equal(t, "failed", state)
	rows, err = q.ExpireGithubMirrorSyncRuns(ctx, repo)
	require.NoError(t, err)
	require.Zero(t, rows)

	running := recoveryRun(t, q, repo, user, true)
	recoveryAge(t, tx, running, "11 minutes")
	recoveryUpsert(t, q, UpsertGithubMirrorSyncRefResultParams{
		RunID: running, Name: "refs/heads/late", ToRevision: "stale", Status: "pending",
	}, 0)
	refs, err := q.ListGithubMirrorSyncRefResults(ctx, running)
	require.NoError(t, err)
	require.Empty(t, refs)
	require.NoError(t, q.FinishGithubMirrorSyncRun(ctx, FinishGithubMirrorSyncRunParams{ID: running, State: "failed"}))
	rows, err = q.FinishSuccessfulGithubMirrorSyncRun(ctx, FinishSuccessfulGithubMirrorSyncRunParams{
		ID: running, VerifiedRefs: []byte(`{"refs/heads/main":"stale"}`),
	})
	require.NoError(t, err)
	require.Zero(t, rows)
	require.NoError(t, tx.QueryRow(ctx, `SELECT state FROM github_mirror_sync_runs WHERE id=$1`, running).Scan(&state))
	require.Equal(t, "running", state)
}

func TestGitMirrorRecoveryPreservesReceiptsAndVerifiedHead(t *testing.T) {
	ctx := context.Background()
	q, tx := newQueries(t)
	user := mustCreateUser(t, tx, uniqueTestUsername(t))
	repo := mustCreateRepo(t, tx, user, uniqueTestRepoName(t))
	_, err := tx.Exec(ctx, `UPDATE repositories SET mirror_status='synced',
		last_mirror_github_head='verified-head', last_mirror_at=NOW()-INTERVAL '1 day' WHERE id=$1`, repo)
	require.NoError(t, err)
	run := recoveryRun(t, q, repo, user, true)
	for _, receipt := range []struct{ name, status string }{
		{"refs/heads/main", "succeeded"},
		{"refs/heads/pending", "pending"},
		{"refs/heads/failed", "failed"},
	} {
		recoveryUpsert(t, q, UpsertGithubMirrorSyncRefResultParams{
			RunID: run, Name: receipt.name, ToRevision: "new", Status: receipt.status,
			Error: map[bool]string{true: "push rejected"}[receipt.status == "failed"],
		}, 1)
	}
	recoveryAge(t, tx, run, "12 minutes")
	rows, err := q.ExpireGithubMirrorSyncRuns(ctx, repo)
	require.NoError(t, err)
	require.Equal(t, int64(1), rows)
	refs, err := q.ListGithubMirrorSyncRefResults(ctx, run)
	require.NoError(t, err)
	require.Len(t, refs, 3)
	for _, ref := range refs {
		switch ref.Name {
		case "refs/heads/main":
			require.Equal(t, "succeeded", ref.Status)
		case "refs/heads/pending":
			require.Equal(t, "failed", ref.Status)
			require.Contains(t, ref.Error, "interrupted")
		case "refs/heads/failed":
			require.Equal(t, "failed", ref.Status)
			require.Equal(t, "push rejected", ref.Error)
		default:
			t.Fatalf("unexpected receipt %q", ref.Name)
		}
	}
	var health, head, lastError string
	var behind, failed int
	var verifiedAt pgtype.Timestamptz
	require.NoError(t, tx.QueryRow(ctx, `SELECT mirror_status, mirror_behind_refs,
		mirror_failed_refs, last_mirror_error, last_mirror_github_head, last_mirror_at
		FROM repositories WHERE id=$1`, repo).Scan(&health, &behind, &failed, &lastError, &head, &verifiedAt))
	require.Equal(t, "failed", health)
	require.Equal(t, 2, behind)
	require.Equal(t, 2, failed)
	require.Contains(t, lastError, "interrupted")
	require.Equal(t, "verified-head", head)
	require.True(t, verifiedAt.Valid)

	// An old worker returning after recovery cannot insert or overwrite a ref.
	recoveryUpsert(t, q, UpsertGithubMirrorSyncRefResultParams{
		RunID: run, Name: "refs/heads/late", ToRevision: "late", Status: "succeeded",
	}, 0)
	recoveryUpsert(t, q, UpsertGithubMirrorSyncRefResultParams{
		RunID: run, Name: "refs/heads/pending", ToRevision: "late", Status: "succeeded",
	}, 0)
	refs, err = q.ListGithubMirrorSyncRefResults(ctx, run)
	require.NoError(t, err)
	require.Len(t, refs, 3)
	for _, ref := range refs {
		if ref.Name == "refs/heads/pending" {
			require.Equal(t, "failed", ref.Status)
			require.Equal(t, "new", ref.ToRevision)
		}
	}
}

func TestGitMirrorRecoveryDoesNotReplaceNewerRepositoryHealth(t *testing.T) {
	ctx := context.Background()
	q, tx := newQueries(t)
	user := mustCreateUser(t, tx, uniqueTestUsername(t))
	repo := mustCreateRepo(t, tx, user, uniqueTestRepoName(t))
	run := recoveryRun(t, q, repo, user, true)
	recoveryUpsert(t, q, UpsertGithubMirrorSyncRefResultParams{
		RunID: run, Name: "refs/heads/main", ToRevision: "abandoned", Status: "pending",
	}, 1)
	recoveryAge(t, tx, run, "12 minutes")
	_, err := tx.Exec(ctx, `UPDATE repositories SET mirror_status='synced',
		mirror_behind_refs=0, mirror_failed_refs=0, last_mirror_error=NULL,
		last_mirror_github_head='newer-head', last_mirror_at=NOW() WHERE id=$1`, repo)
	require.NoError(t, err)

	rows, err := q.ExpireGithubMirrorSyncRuns(ctx, repo)
	require.NoError(t, err)
	require.Zero(t, rows, "recovery must not overwrite a newer successful sync")
	var state, health, head string
	var behind, failed int
	var lastError pgtype.Text
	require.NoError(t, tx.QueryRow(ctx, `SELECT state FROM github_mirror_sync_runs WHERE id=$1`, run).Scan(&state))
	require.Equal(t, "failed", state, "the abandoned run still needs a terminal receipt")
	refs, err := q.ListGithubMirrorSyncRefResults(ctx, run)
	require.NoError(t, err)
	require.Len(t, refs, 1)
	require.Equal(t, "failed", refs[0].Status)
	require.Contains(t, refs[0].Error, "interrupted")
	require.NoError(t, tx.QueryRow(ctx, `SELECT mirror_status, mirror_behind_refs,
		mirror_failed_refs, last_mirror_error, last_mirror_github_head
		FROM repositories WHERE id=$1`, repo).Scan(&health, &behind, &failed, &lastError, &head))
	require.Equal(t, "synced", health)
	require.Zero(t, behind)
	require.Zero(t, failed)
	require.False(t, lastError.Valid)
	require.Equal(t, "newer-head", head)
}

func TestGitMirrorRecoveryFailedFinisherPreservesNewerHealth(t *testing.T) {
	ctx := context.Background()
	q, tx := newQueries(t)
	user := mustCreateUser(t, tx, uniqueTestUsername(t))
	repo := mustCreateRepo(t, tx, user, uniqueTestRepoName(t))
	run := recoveryRun(t, q, repo, user, true)
	recoveryUpsert(t, q, UpsertGithubMirrorSyncRefResultParams{
		RunID: run, Name: "refs/heads/main", ToRevision: "rejected", Status: "failed", Error: "push rejected",
	}, 1)
	// The run is still within its finalization window, but repository health
	// was verified after it began.
	recoveryAge(t, tx, run, "1 minute")
	_, err := tx.Exec(ctx, `UPDATE repositories SET mirror_status='synced',
		mirror_behind_refs=0, mirror_failed_refs=0, last_mirror_error=NULL,
		last_mirror_github_head='newer-head', last_mirror_at=NOW() WHERE id=$1`, repo)
	require.NoError(t, err)
	require.NoError(t, q.FinishGithubMirrorSyncRun(ctx, FinishGithubMirrorSyncRunParams{ID: run, State: "failed"}))

	var state, health, head string
	var behind, failed int
	var lastError pgtype.Text
	require.NoError(t, tx.QueryRow(ctx, `SELECT state FROM github_mirror_sync_runs WHERE id=$1`, run).Scan(&state))
	require.Equal(t, "failed", state)
	require.NoError(t, tx.QueryRow(ctx, `SELECT mirror_status, mirror_behind_refs,
		mirror_failed_refs, last_mirror_error, last_mirror_github_head
		FROM repositories WHERE id=$1`, repo).Scan(&health, &behind, &failed, &lastError, &head))
	require.Equal(t, "synced", health)
	require.Zero(t, behind)
	require.Zero(t, failed)
	require.False(t, lastError.Valid)
	require.Equal(t, "newer-head", head)
}

func TestGitMirrorRecoveryEmptyRevisionConstraint(t *testing.T) {
	ctx := context.Background()
	q, tx := newQueries(t)
	user := mustCreateUser(t, tx, uniqueTestUsername(t))
	repo := mustCreateRepo(t, tx, user, uniqueTestRepoName(t))
	run := recoveryRun(t, q, repo, user, true)
	queryErr := mustExpectQueryError(t, tx, func(spQ *Queries) error {
		_, err := spQ.UpsertGithubMirrorSyncRefResult(ctx, UpsertGithubMirrorSyncRefResultParams{
			RunID: run, Name: "refs/heads/empty", Status: "pending",
		})
		return err
	})
	require.Error(t, queryErr)
	refs, err := q.ListGithubMirrorSyncRefResults(ctx, run)
	require.NoError(t, err)
	require.Empty(t, refs)
	recoveryUpsert(t, q, UpsertGithubMirrorSyncRefResultParams{
		RunID: run, Name: "refs/heads/valid", ToRevision: "new", Status: "pending",
	}, 1)
}

func recoveryCommittedFixture(t *testing.T) (*pgxpool.Pool, *Queries, int64, int64) {
	t.Helper()
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := New(pool)
	user := mustCreateUser(t, pool, uniqueTestUsername(t))
	repo := mustCreateRepo(t, pool, user, uniqueTestRepoName(t))
	return pool, q, user, repo
}

func TestGitMirrorRecoveryGlobalConcurrentSweep(t *testing.T) {
	ctx := context.Background()
	pool, q, user, repo1 := recoveryCommittedFixture(t)
	repo2 := mustCreateRepo(t, pool, user, uniqueTestRepoName(t))
	run1 := recoveryRun(t, q, repo1, user, true)
	run2 := recoveryRun(t, q, repo2, user, false)
	recoveryAge(t, pool, run1, "12 minutes")
	recoveryAge(t, pool, run2, "12 minutes")
	start := make(chan struct{})
	results := make(chan int64, 2)
	errs := make(chan error, 2)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			n, err := q.ExpireGithubMirrorSyncRuns(ctx, 0)
			results <- n
			errs <- err
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	close(errs)
	for err := range errs {
		require.NoError(t, err)
	}
	var total int64
	for n := range results {
		total += n
	}
	require.Equal(t, int64(2), total, "replicas must not both take over one run")
	for _, id := range []int64{run1, run2} {
		var state string
		require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM github_mirror_sync_runs WHERE id=$1`, id).Scan(&state))
		require.Equal(t, "failed", state)
	}
	n, err := q.ExpireGithubMirrorSyncRuns(ctx, 0)
	require.NoError(t, err)
	require.Zero(t, n)
}

func TestGitMirrorRecoverySerializesLateRefWriter(t *testing.T) {
	ctx := context.Background()
	pool, q, user, repo := recoveryCommittedFixture(t)
	run := recoveryRun(t, q, repo, user, true)

	// Hold the run lock while a stale worker attempts to insert a ref. The
	// writer must wait, then see the failed state after recovery commits.
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	var lockedID int64
	require.NoError(t, tx.QueryRow(ctx, `SELECT id FROM github_mirror_sync_runs WHERE id=$1 FOR UPDATE`, run).Scan(&lockedID))
	require.Equal(t, run, lockedID)
	writerConn, err := pool.Acquire(ctx)
	require.NoError(t, err)
	t.Cleanup(writerConn.Release)
	writerPID := writerConn.Conn().PgConn().PID()
	type writeResult struct {
		rows int64
		err  error
	}
	writerDone := make(chan writeResult, 1)
	go func() {
		rows, err := New(writerConn).UpsertGithubMirrorSyncRefResult(ctx, UpsertGithubMirrorSyncRefResultParams{
			RunID: run, Name: "refs/heads/late", ToRevision: "stale", Status: "pending",
		})
		writerDone <- writeResult{rows, err}
	}()
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		var waitType string
		require.NoError(t, pool.QueryRow(ctx, `SELECT COALESCE(wait_event_type, '')
			FROM pg_stat_activity WHERE pid=$1`, writerPID).Scan(&waitType))
		if waitType == "Lock" {
			break
		}
		select {
		case result := <-writerDone:
			t.Fatalf("stale writer bypassed the run lock: rows=%d err=%v", result.rows, result.err)
		case <-deadline.C:
			t.Fatal("stale writer never waited on the run lock")
		case <-ticker.C:
		}
	}
	recoveryAge(t, tx, run, "12 minutes")
	n, err := New(tx).ExpireGithubMirrorSyncRuns(ctx, repo)
	require.NoError(t, err)
	require.Equal(t, int64(1), n)
	require.NoError(t, tx.Commit(ctx))
	select {
	case result := <-writerDone:
		require.NoError(t, result.err)
		require.Zero(t, result.rows)
	case <-time.After(5 * time.Second):
		t.Fatal("stale writer did not unblock after recovery committed")
	}
	refs, err := q.ListGithubMirrorSyncRefResults(ctx, run)
	require.NoError(t, err)
	require.Empty(t, refs)

	newRun := recoveryRun(t, q, repo, user, true)
	recoveryUpsert(t, q, UpsertGithubMirrorSyncRefResultParams{
		RunID: newRun, Name: "refs/heads/main", ToRevision: "fresh", Status: "succeeded",
	}, 1)
	refs, err = q.ListGithubMirrorSyncRefResults(ctx, newRun)
	require.NoError(t, err)
	require.Len(t, refs, 1)
	require.Equal(t, "fresh", refs[0].ToRevision)
}
