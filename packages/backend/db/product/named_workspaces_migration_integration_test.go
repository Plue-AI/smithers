package product

import (
	"context"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestNamedWorkspaceMigrationPreservesDuplicateGuests(t *testing.T) {
	pool := reviewDatabase(t, 74)
	ctx := context.Background()
	registered, err := registeredMigrations()
	require.NoError(t, err)
	// Verify the deployed pre-branch schema: 0108 refuses conflicting branch runtimes.
	applyNamed := func() error { return applyOnce(ctx, pool, registered[:107]) }
	exec := func(sql string, args ...any) {
		t.Helper()
		_, err := pool.Exec(ctx, sql, args...)
		require.NoError(t, err)
	}
	exec(`INSERT INTO users(id,username,lower_username) VALUES(1,'named-owner','named-owner')`)
	exec(`INSERT INTO repositories(id,user_id,name,lower_name) VALUES(1,1,'named','named')`)
	const older = "00000000-0000-4000-8000-000000000001"
	const winner = "00000000-0000-4000-8000-000000000002"
	const pending = "00000000-0000-4000-8000-000000000003"
	exec(`INSERT INTO workspaces(id,repository_id,user_id,name,target_bookmark,is_fork,status,vm_id,created_at) VALUES
		($1,1,1,'issue','feature/one',true,'running','guest-older',now()-interval '1 hour'),
		($2,1,1,'issue','feature/one',true,'running','guest-winner',now()),
		($3,1,1,E'\t issue \n','feature/one',true,'starting','',now()+interval '1 hour')`, older, winner, pending)
	// Even a pre-existing name matching the migration suffix is preserved.
	exec(`INSERT INTO workspaces(repository_id,user_id,name,target_bookmark,is_fork,status,vm_id)
		VALUES(1,1,$1,'feature/one',true,'running','guest-suffix')`, "issue ["+older+"]")
	exec(`INSERT INTO workspaces(repository_id,user_id,name,target_bookmark,is_fork,status)
		VALUES(1,1,$1,'feature/one',true,'starting')`, "\u2003unicode\u00a0")
	require.NoError(t, applyNamed())
	q := db.New(pool)
	unicodeRow, err := q.GetActiveWorkspaceForIdentity(ctx, db.GetActiveWorkspaceForIdentityParams{
		RepositoryID: 1, UserID: 1, Name: "unicode", TargetBookmark: "feature/one", Kind: "container",
	})
	require.NoError(t, err)
	require.Equal(t, "unicode", unicodeRow.Name)
	for _, tc := range []struct{ id, name, vm, status string }{
		{older, "issue [" + older + "]~", "guest-older", "running"},
		{winner, "issue", "guest-winner", "running"},
		{pending, "issue [" + pending + "]", "", "starting"},
	} {
		row, err := q.GetWorkspace(ctx, tc.id)
		require.NoError(t, err)
		require.Equal(t, tc.name, row.Name)
		require.Equal(t, tc.vm, row.VmID)
		require.Equal(t, tc.status, row.Status)
		require.False(t, row.DeletedAt.Valid)
	}
	_, err = q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: 1, UserID: 1,
		Name: "issue", TargetBookmark: "feature/one", Kind: "container", IsFork: true, Status: "starting"})
	require.Error(t, err, "the migrated ready guest reserves its identity")
	require.NoError(t, applyNamed(), "recorded migration can be applied again")
}
