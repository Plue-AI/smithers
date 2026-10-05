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
	var unicodeName string
	require.NoError(t, pool.QueryRow(ctx, `SELECT name FROM workspaces WHERE repository_id = 1 AND user_id = 1 AND name = 'unicode'
		AND target_bookmark = 'feature/one' AND kind = 'container' AND deleted_at IS NULL`).Scan(&unicodeName))
	require.Equal(t, "unicode", unicodeName)
	for _, tc := range []struct{ id, name, vm, status string }{
		{older, "issue [" + older + "]~", "guest-older", "running"},
		{winner, "issue", "guest-winner", "running"},
		{pending, "issue [" + pending + "]", "", "starting"},
	} {
		var name, vm, status string
		var deleted bool
		require.NoError(t, pool.QueryRow(ctx, `SELECT name, vm_id, status, deleted_at IS NOT NULL FROM workspaces WHERE id = $1`, tc.id).Scan(&name, &vm, &status, &deleted))
		require.Equal(t, tc.name, name)
		require.Equal(t, tc.vm, vm)
		require.Equal(t, tc.status, status)
		require.False(t, deleted)
	}
	_, err = historicWorkspace(t, pool, db.CreateWorkspaceParams{RepositoryID: 1, UserID: 1,
		Name: "issue", TargetBookmark: "feature/one", Kind: "container", IsFork: true, Status: "starting"})
	require.Error(t, err, "the migrated ready guest reserves its identity")
	require.NoError(t, applyNamed(), "recorded migration can be applied again")
}
