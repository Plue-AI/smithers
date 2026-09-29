package db

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestNamedWorkspacesHaveIndependentActiveIdentity(t *testing.T) {
	if testing.Short() {
		t.Skip("requires PostgreSQL")
	}
	ctx := context.Background()
	tx, err := sharedPool.Begin(ctx)
	require.NoError(t, err)
	t.Cleanup(func() { _ = tx.Rollback(ctx) })
	q := New(tx)
	user := mustCreateUser(t, tx, "named-owner")
	repo := mustCreateRepoForUser(t, tx, user, "named-repo")
	create := func(name, bookmark, kind, status string) (Workspace, error) {
		return q.CreateWorkspace(ctx, CreateWorkspaceParams{
			RepositoryID: repo, UserID: user, Name: name, TargetBookmark: bookmark, Kind: kind, Status: status,
		})
	}
	one, err := create("issue-one", "main", "vm", "running")
	require.NoError(t, err)
	two, err := create("issue-two", "main", "vm", "running")
	require.NoError(t, err, "a second name must have an independent workspace")
	require.NotEqual(t, one.ID, two.ID)
	_, err = create("issue-one", "feature/one", "vm", "running")
	require.NoError(t, err)
	_, err = create("issue-one", "main", "desktop", "running")
	require.NoError(t, err)
	_, err = create("pending", "main", "vm", "starting")
	require.NoError(t, err)
	_, err = tx.Exec(ctx, "SAVEPOINT duplicate")
	require.NoError(t, err)
	_, err = create("pending", "main", "vm", "starting")
	require.Error(t, err, "pending workspace identity must already prevent duplicate creation")
	_, err = tx.Exec(ctx, "ROLLBACK TO SAVEPOINT duplicate")
	require.NoError(t, err)
	_, err = tx.Exec(ctx, "SAVEPOINT active_duplicate")
	require.NoError(t, err)
	_, err = create("issue-one", "main", "vm", "running")
	require.Error(t, err)
	_, err = tx.Exec(ctx, "ROLLBACK TO SAVEPOINT active_duplicate")
	require.NoError(t, err)
	_, err = q.SoftDeleteWorkspace(ctx, one.ID)
	require.NoError(t, err)
	_, err = create("issue-one", "main", "vm", "running")
	require.NoError(t, err, "deleted names can be used again")
}
