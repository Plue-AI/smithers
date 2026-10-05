package services

import (
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

// A box's coding host holds one person's repository credential only while
// that person is its sole writer: their own unshared workspace, or a branch
// machine the machine service owns that is shared with them alone (a TODO's
// lane). A second writer, or a read of someone else's box, refuses.
func TestWorkspaceSoleWriter(t *testing.T) {
	pool := newProductTestPool(t)
	actor, repo := setupTestUserAndRepo(t, pool)
	ctx := t.Context()
	q := db.New(pool)
	var ben int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES('ben-sole','ben-sole') RETURNING id`).Scan(&ben))
	svc := NewWorkspaceService(q, WithWorkspaceTransactions(pool), WithBranchMachineProviders(branchMachineTestProviders()))
	alone := func(workspaceID string, user int64) bool {
		t.Helper()
		got, err := q.WorkspaceSoleWriter(ctx, db.WorkspaceSoleWriterParams{WorkspaceID: workspaceID, UserID: user})
		require.NoError(t, err)
		return got
	}

	lane, err := svc.createWorkspaceRow(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: actor, TargetBookmark: "smithers/sole-writer", Kind: "container", Status: "starting"})
	require.NoError(t, err)
	owner, err := q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	require.Equal(t, owner, lane.UserID, "a branch machine is the machine service's")
	require.True(t, alone(lane.ID, actor), "shared with its person alone")
	require.False(t, alone(lane.ID, ben), "no share")
	require.False(t, alone(lane.ID, owner), "the machine service is no writer")

	_, err = q.UpsertWorkspaceShare(ctx, db.UpsertWorkspaceShareParams{WorkspaceID: lane.ID, OwnerUserID: owner, GranteeUserID: ben, Level: string(WorkspaceAccessRead)})
	require.NoError(t, err)
	require.True(t, alone(lane.ID, actor), "a read share is no writer")
	_, err = q.UpsertWorkspaceShare(ctx, db.UpsertWorkspaceShareParams{WorkspaceID: lane.ID, OwnerUserID: owner, GranteeUserID: ben, Level: string(WorkspaceAccessWrite)})
	require.NoError(t, err)
	require.False(t, alone(lane.ID, actor), "a second writer could read the credential")
	require.False(t, alone(lane.ID, ben))

	own, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: actor, TargetBookmark: "own/sole-writer", Kind: "container", Status: "running"})
	require.NoError(t, err)
	require.True(t, alone(own.ID, actor), "an unshared own box")
	_, err = q.UpsertWorkspaceShare(ctx, db.UpsertWorkspaceShareParams{WorkspaceID: own.ID, OwnerUserID: actor, GranteeUserID: ben, Level: string(WorkspaceAccessWrite)})
	require.NoError(t, err)
	require.False(t, alone(own.ID, actor), "an own box with a write share")
	require.False(t, alone(own.ID, ben), "a grantee of someone's own box")
}
