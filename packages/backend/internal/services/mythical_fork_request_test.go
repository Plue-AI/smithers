package services

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/stretchr/testify/require"
)

// Real PostgreSQL and git transfer, with the production workspace adapter.
// The fixture refuses actual VM execution; no machine qualification is implied.
func TestForkRequestReplaysAfterMainMoves(t *testing.T) {
	f := newMythicalServiceFixture(t)
	pool := f.pool.(*pgxpool.Pool)
	installBranchOwner(t, pool, f.userID)
	f.commit("First revision", "retry.ts", "export const retry = 2;\n")
	head := f.publish()
	ws := installLaneService(t, pool, f.userID)
	f.service.lanes = NewWorkspaceMythicalLanes(ws)
	person, err := db.New(pool).GetUserByID(t.Context(), f.userID)
	require.NoError(t, err)
	ctx := middleware.ContextWithAuthInfo(t.Context(), &middleware.AuthInfo{User: &person, SessionHash: "fork-person-session"})
	input := BranchForkInput{From: "main", Name: "request-retry", Request: "same-fork"}
	first, err := f.service.ForkBranch(ctx, f.repoID, f.userID, input)
	require.NoError(t, err)
	require.Equal(t, head, first.Head)
	f.commit("Main moved", "retry.ts", "export const retry = 99;\n")
	require.NotEqual(t, head, f.publish())
	var wg sync.WaitGroup
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got, err := f.service.ForkBranch(ctx, f.repoID, f.userID, input)
			if err != nil {
				t.Error(err)
				return
			}
			if got.Machine.ID != first.Machine.ID || got.Head != head {
				t.Error("retry changed the fork")
			}
		}()
	}
	wg.Wait()
	input.Name = "another-fork"
	_, err = f.service.ForkBranch(ctx, f.repoID, f.userID, input)
	var refused *BranchError
	require.ErrorAs(t, err, &refused)
	require.Equal(t, 409, refused.Status)
	var branches, activity, receipts int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE repository_id=$1`, f.repoID).Scan(&branches))
	require.Equal(t, 1, branches)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='branch.forked'`).Scan(&activity))
	require.Equal(t, 1, activity)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='branch.fork.completed'`).Scan(&receipts))
	require.Equal(t, 1, receipts)
	require.Equal(t, head, f.hostRef("refs/heads/"+first.Name))
	_, err = f.service.ForkBranch(context.Background(), f.repoID, f.userID, BranchForkInput{From: "main", Request: "same-fork"})
	require.Error(t, err, fmt.Sprint("receipt requires the original person's authority"))
}

// Fail after the workspace and published ref exist, before completion commits.
// This models a process interruption using real workspace and Git boundaries.
type interruptedScratchFork struct {
	mythicalLanes
	forks     mythicalScratchForks
	interrupt bool
}

func (f *interruptedScratchFork) ForkScratch(ctx context.Context, input ScratchFork) (BranchMachineResponse, error) {
	branch, err := f.forks.ForkScratch(ctx, input)
	if err == nil && f.interrupt {
		f.interrupt = false
		return BranchMachineResponse{}, errors.New("interrupted after workspace creation")
	}
	return branch, err
}
func TestInterruptedForkRetainsOriginalRevision(t *testing.T) {
	f := newMythicalServiceFixture(t)
	pool := f.pool.(*pgxpool.Pool)
	installBranchOwner(t, pool, f.userID)
	f.commit("First revision", "retry.ts", "export const retry = 2;\n")
	head := f.publish()
	ws := installLaneService(t, pool, f.userID)
	lanes := NewWorkspaceMythicalLanes(ws)
	f.service.lanes = &interruptedScratchFork{mythicalLanes: lanes, forks: lanes, interrupt: true}
	person, err := db.New(pool).GetUserByID(t.Context(), f.userID)
	require.NoError(t, err)
	ctx := middleware.ContextWithAuthInfo(t.Context(), &middleware.AuthInfo{User: &person, SessionHash: "interrupted-fork-session"})
	input := BranchForkInput{From: "main", Name: "interrupted-retry", Request: "interrupted-fork"}
	_, err = f.service.ForkBranch(ctx, f.repoID, f.userID, input)
	require.EqualError(t, err, "interrupted after workspace creation")
	var original string
	require.NoError(t, pool.QueryRow(ctx, `SELECT id::text FROM workspaces WHERE repository_id=$1`, f.repoID).Scan(&original))
	f.commit("Main moved", "retry.ts", "export const retry = 99;\n")
	require.NotEqual(t, head, f.publish())
	changed := input
	changed.From = "T2"
	_, err = f.service.ForkBranch(ctx, f.repoID, f.userID, changed)
	var refused *BranchError
	require.ErrorAs(t, err, &refused)
	require.Equal(t, 409, refused.Status)
	// A workspace found by name must still be the intended fork.
	require.NoError(t, ws.WaitForProvisioning(ctx))
	_, err = pool.Exec(ctx, `UPDATE workspaces SET source_commit=$2 WHERE id=$1`, original, strings.Repeat("f", 40))
	require.NoError(t, err)
	_, err = f.service.ForkBranch(ctx, f.repoID, f.userID, input)
	require.ErrorContains(t, err, "different machine source")
	_, err = pool.Exec(ctx, `UPDATE workspaces SET source_commit=$2 WHERE id=$1`, original, head)
	require.NoError(t, err)
	recovered, err := f.service.ForkBranch(ctx, f.repoID, f.userID, input)
	require.NoError(t, err)
	require.Equal(t, "failed", recovered.State, "replay reports the retained machine honestly without re-provisioning it")
	require.Equal(t, original, recovered.Machine.ID)
	require.Equal(t, head, recovered.Head)
	require.Equal(t, head, recovered.ForkedFrom.Commit)
	require.Equal(t, head, f.hostRef("refs/heads/"+recovered.Name))
	for _, event := range []string{"branch.fork.intended", "branch.forked", "branch.fork.completed"} {
		var count int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type=$1`, event).Scan(&count))
		require.Equal(t, 1, count, event)
	}
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE repository_id=$1`, f.repoID).Scan(&count))
	require.Equal(t, 1, count)
}
