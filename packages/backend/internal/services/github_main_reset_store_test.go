package services

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// Only the unlanded stack fold is faked. SQL intent persistence, transaction
// rollback and repository serialization use the production journal and PG18.
type journalStackFixture struct{ failSettlement bool }

func (*journalStackFixture) Ready(context.Context) error { return nil }
func (*journalStackFixture) OpenForcePush(context.Context, pgx.Tx, int64, GitHubMainForcePush) error {
	return nil
}
func (*journalStackFixture) ValidateReset(_ context.Context, _ pgx.Tx, _ int64, id, old, new string) (string, error) {
	if id != "force-attention" || old != pullOld || new != pullNew {
		return "", staleMainReset()
	}
	return id, nil
}
func (*journalStackFixture) VerifyPull(context.Context, pgx.Tx, int64, string, string) error {
	return nil
}
func (f *journalStackFixture) SettleReset(ctx context.Context, tx pgx.Tx, intent GitHubMainResetIntent) error {
	if _, err := tx.Exec(ctx, `UPDATE mythical_stacks SET reason=reason || '|settled' WHERE repository_id=$1`, intent.RepositoryID); err != nil {
		return err
	}
	if f.failSettlement {
		return errors.New("crash after projection before intent retirement")
	}
	return nil
}
func (*journalStackFixture) LeaveOpen(context.Context, pgx.Tx, GitHubMainResetIntent) error {
	return nil
}

func journalDatabaseFixture(t *testing.T) (*pgxpool.Pool, int64) {
	t.Helper()
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	ctx := t.Context()
	user, err := q.CreateUser(ctx, db.CreateUserParams{Username: "journal-owner", LowerUsername: "journal-owner"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: user.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO mythical_stacks(repository_id,actor_user_id,state) VALUES($1,$2,'active')`, repo.ID, user.ID)
	require.NoError(t, err)
	_, err = q.RequestGithubMainPull(ctx, repo.ID)
	require.NoError(t, err)
	return pool, repo.ID
}

func TestMainResetJournalPersistsAcrossRestartAndSettlesAtomically(t *testing.T) {
	pool, repo := journalDatabaseFixture(t)
	ctx := t.Context()
	stack := &journalStackFixture{failSettlement: true}
	journal := &GitHubMainResetJournal{Pool: pool, Stack: stack}
	var intent GitHubMainResetIntent
	require.NoError(t, journal.WithRepository(ctx, repo, func(fence GitHubMainFence) error {
		var err error
		intent, err = fence.Prepare(ctx, "force-attention", pullOld, pullNew)
		if err != nil {
			return err
		}
		require.NoError(t, fence.VerifyLocked(ctx, intent))
		require.Error(t, fence.VerifyPull(ctx, pullOld, pullNew), "pull cannot overtake durable reset")
		return nil
	}))
	// A new journal instance reads the already committed intent. A failed stack
	// projection rolls back along with retirement, leaving boot recovery possible.
	restarted := &GitHubMainResetJournal{Pool: pool, Stack: stack}
	pending, err := restarted.Pending(ctx)
	require.NoError(t, err)
	require.Equal(t, []GitHubMainResetIntent{intent}, pending)
	require.Error(t, restarted.WithRepository(ctx, repo, func(fence GitHubMainFence) error { return fence.Settle(ctx, intent) }))
	var reason string
	require.NoError(t, pool.QueryRow(ctx, `SELECT reason FROM mythical_stacks WHERE repository_id=$1`, repo).Scan(&reason))
	require.Empty(t, reason)
	pending, err = restarted.Pending(ctx)
	require.NoError(t, err)
	require.Len(t, pending, 1)
	stack.failSettlement = false
	require.NoError(t, restarted.WithRepository(ctx, repo, func(fence GitHubMainFence) error { return fence.Settle(ctx, intent) }))
	require.NoError(t, restarted.WithRepository(ctx, repo, func(fence GitHubMainFence) error { return fence.Settle(ctx, intent) }))
	pending, err = restarted.Pending(ctx)
	require.NoError(t, err)
	require.Empty(t, pending)
	require.NoError(t, pool.QueryRow(ctx, `SELECT reason FROM mythical_stacks WHERE repository_id=$1`, repo).Scan(&reason))
	require.Equal(t, "|settled", reason)
	receipt, err := db.New(pool).GetGithubMainPull(ctx, repo)
	require.NoError(t, err)
	require.Equal(t, "synced", receipt.State)
	require.Equal(t, pullNew, receipt.SmithersHead)
	require.Equal(t, pullNew, receipt.GithubHead)
	require.True(t, receipt.LastSyncedAt.Valid)
	require.Empty(t, receipt.HealthCause)
	require.False(t, receipt.RetryAt.Valid)
	require.Greater(t, receipt.RequestedGeneration, receipt.SyncedGeneration, "reset preserves concurrent Retry admission for a new upstream observation")
	require.NoError(t, restarted.WithRepository(ctx, repo, func(fence GitHubMainFence) error {
		replay, err := fence.Prepare(ctx, "force-attention", pullOld, pullNew)
		require.NoError(t, err)
		require.True(t, replay.Settled)
		require.NoError(t, fence.VerifyPull(ctx, pullNew, pullNew), "completed receipt does not fence normal following")
		return nil
	}))
}

func TestMainResetJournalRetainsRepositoryLockAfterPrepareCommit(t *testing.T) {
	pool, repo := journalDatabaseFixture(t)
	ctx := t.Context()
	journal := &GitHubMainResetJournal{Pool: pool, Stack: &journalStackFixture{}}
	require.NoError(t, journal.WithRepository(ctx, repo, func(fence GitHubMainFence) error {
		intent, err := fence.Prepare(ctx, "force-attention", pullOld, pullNew)
		require.NoError(t, err)
		tx, err := pool.Begin(ctx)
		require.NoError(t, err)
		defer tx.Rollback(ctx)
		var acquired bool
		require.NoError(t, tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock($1)`, repo).Scan(&acquired))
		require.False(t, acquired, "merge's xact lock waits through ref transfer and settlement")
		stale := intent
		stale.ID = "obsolete"
		require.Error(t, fence.VerifyLocked(ctx, stale))
		require.NoError(t, fence.LeaveOpen(ctx, intent))
		return nil
	}))
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer tx.Rollback(ctx)
	var acquired bool
	require.NoError(t, tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock($1)`, repo).Scan(&acquired))
	require.True(t, acquired)
}

func TestMainResetJournalMissingStackRefusesBeforePersistence(t *testing.T) {
	pool, repo := journalDatabaseFixture(t)
	ctx := t.Context()
	journal := &GitHubMainResetJournal{Pool: pool}
	require.Error(t, journal.WithRepository(ctx, repo, func(GitHubMainFence) error { t.Fatal("missing provider entered reset"); return nil }))
	_, err := journal.Pending(ctx)
	require.Error(t, err)
	var pending bool
	require.NoError(t, pool.QueryRow(ctx, `SELECT reset_intent IS NOT NULL FROM github_main_pulls WHERE repository_id=$1`, repo).Scan(&pending))
	require.False(t, pending)
}
