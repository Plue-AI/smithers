package db

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestActiveWorkspaceUniquenessIncludesKind(t *testing.T) {
	if testing.Short() {
		t.Skip("db integration test; requires Postgres (set SMITHERS_TEST_DATABASE_URL)")
	}

	ctx := context.Background()
	tx, err := sharedPool.BeginTx(ctx, pgx.TxOptions{})
	require.NoError(t, err)
	t.Cleanup(func() { _ = tx.Rollback(ctx) })

	q := New(tx)
	userID := mustCreateUser(t, tx, "workspace-kind-user")
	repoID := mustCreateRepoForUser(t, tx, userID, "workspace-kind-repo")

	vm, err := q.CreateWorkspace(ctx, CreateWorkspaceParams{
		RepositoryID: repoID,
		UserID:       userID,
		Name:         "proof-vm",
		Kind:         "vm",
		Status:       "running",
	})
	require.NoError(t, err)
	desktop, err := q.CreateWorkspace(ctx, CreateWorkspaceParams{
		RepositoryID: repoID,
		UserID:       userID,
		Name:         "proof-desktop",
		Kind:         "desktop",
		Status:       "running",
	})
	require.NoError(t, err)

	assert.NotEqual(t, vm.ID, desktop.ID)
	gotVM, err := q.GetActiveWorkspaceForUserRepoKind(ctx, GetActiveWorkspaceForUserRepoKindParams{
		RepositoryID: repoID,
		UserID:       userID,
		Kind:         "vm",
	})
	require.NoError(t, err)
	assert.Equal(t, vm.ID, gotVM.ID)
	gotDesktop, err := q.GetActiveWorkspaceForUserRepoKind(ctx, GetActiveWorkspaceForUserRepoKindParams{
		RepositoryID: repoID,
		UserID:       userID,
		Kind:         "desktop",
	})
	require.NoError(t, err)
	assert.Equal(t, desktop.ID, gotDesktop.ID)

	_, err = q.CreateWorkspace(ctx, CreateWorkspaceParams{
		RepositoryID: repoID,
		UserID:       userID,
		Name:         "proof-vm",
		Kind:         "vm",
		Status:       "running",
	})
	require.Error(t, err, "the same active name, bookmark, and kind must still conflict")
}
