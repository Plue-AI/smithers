package services

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

// Real attention, reset journal, authority, item projection and worker claims.
// Existing orchestration doubles stop at the machine launch boundary; these
// tests make no claim about microVM isolation.
func TestProductionMainResetSettlementAndRecovery(t *testing.T) {
	o, ctx := newTodoAdmission(t)
	s := o.service
	s.SetFlowLoad(true)
	s.SetBranchRebaseExecutor(&rebaseExecutionFixture{})
	q := db.New(o.pool)
	item := o.fileTodo(ctx, "reset-todo")
	_, err := q.RequestGithubMainPull(ctx, o.repoID)
	require.NoError(t, err)
	journal := &GitHubMainResetJournal{Pool: o.pool.(*pgxpool.Pool), Stack: s}
	var intent GitHubMainResetIntent
	require.NoError(t, journal.WithRepository(ctx, o.repoID, func(f GitHubMainFence) error {
		require.NoError(t, f.OpenForcePush(ctx, GitHubMainForcePush{Old: pullOld, New: pullNew}))
		require.NoError(t, f.OpenForcePush(ctx, GitHubMainForcePush{Old: pullOld, New: pullNew}))
		rows, err := s.HomeAttention(ctx, o.repoID)
		require.NoError(t, err)
		require.Len(t, rows, 1)
		require.Error(t, f.VerifyPull(ctx, pullOld, pullNew))
		claimed, err := q.ClaimMythicalStacks(ctx, 10, 60)
		require.NoError(t, err)
		require.Empty(t, claimed, "open attention freezes stack dispatch")
		intent, err = f.Prepare(ctx, rows[0].ID, pullOld, pullNew)
		require.NoError(t, err)
		require.Equal(t, o.userID, intent.ActorID)
		require.NoError(t, f.VerifyLocked(ctx, intent))
		return nil
	}))
	// Durable owner authority survives the HTTP session and recovery process.
	restarted := &GitHubMainResetJournal{Pool: o.pool.(*pgxpool.Pool), Stack: s}
	require.NoError(t, restarted.WithRepository(context.Background(), o.repoID, func(f GitHubMainFence) error { return f.Settle(context.Background(), intent) }))
	after, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	require.Equal(t, "rebase_pending", after.Reason)
	require.Equal(t, pullNew, mythicalChecksOf(after).Rebase.Onto)
	require.False(t, after.CandidateVerified)
	stack, err := q.GetMythicalStack(ctx, o.repoID)
	require.NoError(t, err)
	require.Equal(t, "bootstrapping", stack.State)
	require.Positive(t, stack.ResetGeneration)
	rows, err := readStackAttention(ctx, o.pool, o.repoID)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	attention, err := forcePushAttention(rows[0])
	require.NoError(t, err)
	require.Equal(t, o.userID, attention.SettledBy)
	require.Equal(t, stack.RequestedGeneration, attention.MainMovedGeneration)
	require.NotNil(t, attention.SettledAt)
	require.NoError(t, restarted.WithRepository(ctx, o.repoID, func(f GitHubMainFence) error { return f.Settle(ctx, intent) }))
	again, err := q.GetMythicalStack(ctx, o.repoID)
	require.NoError(t, err)
	require.Equal(t, stack, again, "recovery must enqueue once")
	same, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	require.Equal(t, after, same)
	pending, err := restarted.Pending(ctx)
	require.NoError(t, err)
	require.Empty(t, pending)
}

func TestProductionMainResetFencesAndStaleBinding(t *testing.T) {
	o, ctx := newTodoAdmission(t)
	s := o.service
	s.SetFlowLoad(true)
	s.SetBranchRebaseExecutor(&rebaseExecutionFixture{})
	q := db.New(o.pool)
	item := o.fileTodo(ctx, "fenced-todo")
	_, err := q.RequestGithubMainPull(ctx, o.repoID)
	require.NoError(t, err)
	j := &GitHubMainResetJournal{Pool: o.pool.(*pgxpool.Pool), Stack: s}
	// A crashed native operation must recover before attention freezes claims.
	_, err = o.pool.Exec(ctx, `UPDATE mythical_stacks SET pending_op='{"kind":"bootstrap"}' WHERE repository_id=$1`, o.repoID)
	require.NoError(t, err)
	err = j.WithRepository(ctx, o.repoID, func(f GitHubMainFence) error {
		return f.OpenForcePush(ctx, GitHubMainForcePush{Old: pullOld, New: pullNew})
	})
	require.Error(t, err)
	attention, err := s.HomeAttention(ctx, o.repoID)
	require.NoError(t, err)
	require.Empty(t, attention)
	_, err = o.pool.Exec(ctx, `UPDATE mythical_stacks SET pending_op=NULL WHERE repository_id=$1`, o.repoID)
	require.NoError(t, err)
	require.NoError(t, j.WithRepository(ctx, o.repoID, func(f GitHubMainFence) error {
		require.NoError(t, f.OpenForcePush(ctx, GitHubMainForcePush{Old: pullOld, New: pullNew}))
		rows, err := s.HomeAttention(ctx, o.repoID)
		require.NoError(t, err)
		id := rows[0].ID
		_, err = f.Prepare(ctx, id, pullOld, pullOld)
		require.Error(t, err)
		_, err = o.pool.Exec(ctx, `UPDATE mythical_items SET pending_op='{"kind":"merge","state":"unknown","target":"1","desired":"2222222222222222222222222222222222222222","precondition":"open"}' WHERE id=$1`, item.ID)
		require.NoError(t, err)
		_, err = f.Prepare(ctx, id, pullOld, pullNew)
		require.ErrorContains(t, err, "merge")
		_, err = o.pool.Exec(ctx, `UPDATE mythical_items SET pending_op=NULL WHERE id=$1`, item.ID)
		require.NoError(t, err)
		third := "3333333333333333333333333333333333333333"
		require.NoError(t, f.OpenForcePush(ctx, GitHubMainForcePush{Old: pullOld, New: third}))
		_, err = f.Prepare(ctx, id, pullOld, pullNew)
		require.Error(t, err)
		intent, err := f.Prepare(ctx, id, pullOld, third)
		require.NoError(t, err)
		require.NoError(t, f.LeaveOpen(ctx, intent))
		rows, err = s.HomeAttention(ctx, o.repoID)
		require.NoError(t, err)
		require.Len(t, rows, 1)
		raw, err := json.Marshal(rows[0])
		require.NoError(t, err)
		require.Contains(t, string(raw), third)
		return nil
	}))
	// Another operation cannot enter until this repository claim ends.
	entered := make(chan struct{})
	done := make(chan error, 1)
	require.NoError(t, j.WithRepository(ctx, o.repoID, func(GitHubMainFence) error {
		go func() {
			done <- j.WithRepository(ctx, o.repoID, func(GitHubMainFence) error { close(entered); return nil })
		}()
		select {
		case <-entered:
			t.Fatal("operation overtook repository fence")
		case <-time.After(50 * time.Millisecond):
		}
		blocked, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
		defer cancel()
		tx, err := o.pool.(*pgxpool.Pool).Begin(blocked)
		require.NoError(t, err)
		defer tx.Rollback(context.Background())
		require.Error(t, lockMainOperationTx(blocked, tx, o.repoID), "merge dispatch shares the reset fence")
		return nil
	}))
	require.NoError(t, <-done)
}
