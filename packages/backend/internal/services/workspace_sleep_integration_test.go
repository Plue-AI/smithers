package services

import (
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
	"testing"
)

// Supplements the composed suspend/terminal tests with the atomic eligibility
// fence used by last-session release. An active or newly pending session wins.
func TestBranchReleaseWaitsForSessions(t *testing.T) {
	pool := newProductTestPool(t)
	person, repo := setupTestUserAndRepo(t, pool)
	ctx := t.Context()
	q := db.New(pool)
	row, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: person, Kind: "container", Status: "running", TargetBookmark: "main"})
	require.NoError(t, err)
	var session string
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspace_sessions(workspace_id,repository_id,user_id,kind,status) VALUES($1,$2,$3,'terminal','pending') RETURNING id`, row.ID, repo, person).Scan(&session))
	svc := NewWorkspaceService(q, WithWorkspaceTransactions(pool))
	for _, state := range []string{"pending", "starting", "running"} {
		_, err := pool.Exec(ctx, `UPDATE workspace_sessions SET status=$2 WHERE id=$1`, session, state)
		require.NoError(t, err)
		require.ErrorIs(t, svc.transitionBranchMachine(ctx, row, "running", "releasing", "", true), pgx.ErrNoRows)
		actual, err := q.GetWorkspace(ctx, row.ID)
		require.NoError(t, err)
		require.Equal(t, "running", actual.Status)
	}
	_, err = pool.Exec(ctx, `UPDATE workspace_sessions SET status='stopped' WHERE id=$1`, session)
	require.NoError(t, err)
	require.NoError(t, svc.transitionBranchMachine(ctx, row, "running", "releasing", "", true))
	actual, err := q.GetWorkspace(ctx, row.ID)
	require.NoError(t, err)
	require.Equal(t, "releasing", actual.Status)
	require.NoError(t, svc.transitionBranchMachine(ctx, row, "releasing", "suspended", ""))
	actual, err = q.GetWorkspace(ctx, row.ID)
	require.NoError(t, err)
	require.True(t, actual.SuspendedAt.Valid)
}
