package product

import (
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/require"
	"slices"
	"testing"
)

func TestWorkspaceCapturePendingMigration(t *testing.T) {
	pool := newProductTestPool(t)
	migrations, err := registeredMigrations()
	require.NoError(t, err)
	cut := slices.IndexFunc(migrations, func(m migration) bool { return m.version == 138 })
	require.Positive(t, cut)
	require.NoError(t, applyOnce(t.Context(), pool, migrations[:cut]))
	repo := reviewRepo(t, pool)
	var branch string
	require.NoError(t, pool.QueryRow(t.Context(), `INSERT INTO workspaces(repository_id,user_id,name,head_commit_id) SELECT $1,id,'retained','retained-head' FROM users WHERE username='smithers-machines' RETURNING id`, repo).Scan(&branch))
	require.NoError(t, Apply(t.Context(), pool))
	require.NoError(t, Apply(t.Context(), pool))
	var head string
	var pending []byte
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT head_commit_id,capture_pending FROM workspaces WHERE id=$1`, branch).Scan(&head, &pending))
	require.Equal(t, "retained-head", head)
	require.Nil(t, pending)
	for _, invalid := range []string{`[]`, `true`, `"head"`, `null`} {
		_, err = pool.Exec(t.Context(), `UPDATE workspaces SET capture_pending=$2 WHERE id=$1`, branch, invalid)
		var constraint *pgconn.PgError
		require.ErrorAs(t, err, &constraint)
		require.Equal(t, "23514", constraint.Code)
	}
	_, err = pool.Exec(t.Context(), `UPDATE workspaces SET capture_pending='{"stale":true,"head":"retained"}' WHERE id=$1`, branch)
	require.NoError(t, err)
	require.NoError(t, Apply(t.Context(), pool))
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT capture_pending FROM workspaces WHERE id=$1`, branch).Scan(&pending))
	require.JSONEq(t, `{"stale":true,"head":"retained"}`, string(pending))
}
