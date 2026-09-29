package db

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestFailedPrimaryRetainedButExcludedFromActiveQueries(t *testing.T) {
	if testing.Short() {
		t.Skip("db integration test; requires Postgres (set SMITHERS_TEST_DATABASE_URL)")
	}
	ctx := context.Background()
	tx, err := sharedPool.BeginTx(ctx, pgx.TxOptions{})
	require.NoError(t, err)
	t.Cleanup(func() { _ = tx.Rollback(ctx) })
	q := New(tx)
	userID := mustCreateUser(t, tx, "dead-primary-user")
	repoID := mustCreateRepoForUser(t, tx, userID, "dead-primary-repo")
	old, err := q.CreateWorkspace(ctx, CreateWorkspaceParams{
		RepositoryID: repoID, UserID: userID, Name: "old", Kind: "container", Status: "starting",
	})
	require.NoError(t, err)
	old, err = q.UpdateWorkspaceExecutionInfo(ctx, UpdateWorkspaceExecutionInfoParams{
		ID: old.ID, VmID: "vm-old", Status: "running",
	})
	require.NoError(t, err)
	snapshot, err := q.CreateWorkspaceSnapshot(ctx, CreateWorkspaceSnapshotParams{
		RepositoryID: repoID, UserID: userID, WorkspaceID: old.ID, Name: "recovery", SnapshotID: "provider-snapshot-old",
	})
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `UPDATE workspaces SET source_snapshot_id = $2 WHERE id = $1`, old.ID, snapshot.ID)
	require.NoError(t, err)
	old, err = q.GetWorkspace(ctx, old.ID)
	require.NoError(t, err)
	expectedSnapshotID := old.SourceSnapshotID
	require.True(t, expectedSnapshotID.Valid)
	old, err = q.FailWorkspaceIfUnchanged(ctx, FailWorkspaceIfUnchangedParams{
		ID: old.ID, ExpectedStatus: old.Status, ExpectedVmID: old.VmID,
		ExpectedUpdatedAt: old.UpdatedAt, FailureCode: "workspace_vm_missing", FailureMessage: "VM missing",
	})
	require.NoError(t, err)
	assert.Equal(t, "failed", old.Status)
	assert.Equal(t, "vm-old", old.VmID)
	retained, err := q.GetWorkspace(ctx, old.ID)
	require.NoError(t, err)
	assert.Equal(t, old.ID, retained.ID)
	assert.Equal(t, "failed", retained.Status)
	assert.Equal(t, "vm-old", retained.VmID)
	assert.Equal(t, expectedSnapshotID, retained.SourceSnapshotID)
	assert.False(t, retained.DeletedAt.Valid)
	assert.Equal(t, "workspace_vm_missing", retained.FailureCode.String)

	_, err = q.GetActiveWorkspaceForUserRepo(ctx, GetActiveWorkspaceForUserRepoParams{RepositoryID: repoID, UserID: userID})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.GetActiveWorkspaceForUserRepoKind(ctx, GetActiveWorkspaceForUserRepoKindParams{RepositoryID: repoID, UserID: userID, Kind: "container"})
	require.ErrorIs(t, err, pgx.ErrNoRows)

	fresh, err := q.CreateWorkspace(ctx, CreateWorkspaceParams{
		RepositoryID: repoID, UserID: userID, Name: "replacement", Kind: "container", Status: "starting",
	})
	require.NoError(t, err)
	fresh, err = q.UpdateWorkspaceExecutionInfo(ctx, UpdateWorkspaceExecutionInfoParams{ID: fresh.ID, VmID: "vm-new", Status: "running"})
	require.NoError(t, err)
	byUser, err := q.GetActiveWorkspaceForUserRepo(ctx, GetActiveWorkspaceForUserRepoParams{RepositoryID: repoID, UserID: userID})
	require.NoError(t, err)
	byKind, err := q.GetActiveWorkspaceForUserRepoKind(ctx, GetActiveWorkspaceForUserRepoKindParams{RepositoryID: repoID, UserID: userID, Kind: "container"})
	require.NoError(t, err)
	assert.Equal(t, fresh.ID, byUser.ID)
	assert.Equal(t, fresh.ID, byKind.ID)
	activeCount, err := q.CountActiveWorkspacesByUser(ctx, userID)
	require.NoError(t, err)
	assert.Equal(t, int64(1), activeCount)
	stillRetained, err := q.GetWorkspace(ctx, old.ID)
	require.NoError(t, err)
	assert.Equal(t, "failed", stillRetained.Status)
	assert.Equal(t, expectedSnapshotID, stillRetained.SourceSnapshotID)
	recovery, err := q.GetWorkspaceSnapshotByRepo(ctx, GetWorkspaceSnapshotByRepoParams{ID: snapshot.ID, RepositoryID: repoID})
	require.NoError(t, err)
	assert.Equal(t, "provider-snapshot-old", recovery.SnapshotID)
}
