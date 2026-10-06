package services

import (
	"context"
	"fmt"
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
