package db

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Ticket 0105: DB-level validation for the sandbox-quota semantics.
// These tests go through a real Postgres (SMITHERS_TEST_DATABASE_URL) so reviewers
// know the count query isn't a mock, the partial index really matches,
// and soft-delete actually drops rows out of the count.

func TestCountActiveWorkspacesByUser_ReflectsSoftDelete(t *testing.T) {
	if testing.Short() {
		t.Skip("db integration test; requires Postgres (set SMITHERS_TEST_DATABASE_URL)")
	}

	ctx := context.Background()
	tx, err := sharedPool.BeginTx(ctx, pgx.TxOptions{})
	require.NoError(t, err)
	t.Cleanup(func() { _ = tx.Rollback(ctx) })

	q := New(tx)

	userID := mustCreateUser(t, tx, "quota-user")
	repoID := mustCreateRepoForUser(t, tx, userID, "quota-repo")

	// Insert 3 workspaces.
	for i := 0; i < 3; i++ {
		_, err := q.CreateWorkspace(ctx, CreateWorkspaceParams{
			RepositoryID: repoID,
			UserID:       userID,
			Name:         fmt.Sprintf("ws-%d", i),
			IsFork:       i > 0,
			Status:       "starting",
		})
		require.NoError(t, err)
	}

	count, err := q.CountActiveWorkspacesByUser(ctx, userID)
	require.NoError(t, err)
	assert.Equal(t, int64(3), count)

	// Tombstone one, verify the count drops.
	list, err := q.ListWorkspacesByRepo(ctx, ListWorkspacesByRepoParams{
		RepositoryID: repoID, UserID: userID, PageSize: 10, PageOffset: 0,
	})
	require.NoError(t, err)
	require.Len(t, list, 3)

	_, err = q.SoftDeleteWorkspace(ctx, list[0].ID)
	require.NoError(t, err)

	count, err = q.CountActiveWorkspacesByUser(ctx, userID)
	require.NoError(t, err)
	assert.Equal(t, int64(2), count, "soft-delete must drop the count")

	// Tombstoned row must be invisible to passive reads.
	listed, err := q.ListWorkspacesByRepo(ctx, ListWorkspacesByRepoParams{
		RepositoryID: repoID, UserID: userID, PageSize: 10, PageOffset: 0,
	})
	require.NoError(t, err)
	assert.Len(t, listed, 2, "tombstoned workspace must drop out of ListWorkspacesByRepo")

	// GetWorkspace on the tombstoned row returns no rows.
	_, err = q.GetWorkspace(ctx, list[0].ID)
	assert.ErrorIs(t, err, pgx.ErrNoRows, "GetWorkspace must hide tombstones")

	// GetWorkspaceIncludingDeleted still finds it — needed for reconciliation.
	recovered, err := q.GetWorkspaceIncludingDeleted(ctx, list[0].ID)
	require.NoError(t, err)
	assert.True(t, recovered.DeletedAt.Valid, "deleted_at must be populated post-soft-delete")
	assert.Equal(t, "stopped", recovered.Status, "SoftDeleteWorkspace forces status=stopped")
}

// Smoke test: a user can create MaxActiveWorkspacesPerUser rows and the
// count query returns exactly that. Uses forks to sidestep the
// one-active-primary-per-user+repo unique constraint.
func TestCountActiveWorkspacesByUser_HandlesHundredRows(t *testing.T) {
	if testing.Short() {
		t.Skip("db integration test; requires Postgres (set SMITHERS_TEST_DATABASE_URL)")
	}

	ctx := context.Background()
	tx, err := sharedPool.BeginTx(ctx, pgx.TxOptions{})
	require.NoError(t, err)
	t.Cleanup(func() { _ = tx.Rollback(ctx) })

	q := New(tx)
	userID := mustCreateUser(t, tx, "quota-user-100")
	repoID := mustCreateRepoForUser(t, tx, userID, "quota-repo-100")

	const target = 100
	for i := 0; i < target; i++ {
		_, err := q.CreateWorkspace(ctx, CreateWorkspaceParams{
			RepositoryID: repoID,
			UserID:       userID,
			Name:         fmt.Sprintf("bulk-%d", i),
			IsFork:       true,
			Status:       "starting",
		})
		require.NoError(t, err)
	}

	count, err := q.CountActiveWorkspacesByUser(ctx, userID)
	require.NoError(t, err)
	assert.Equal(t, int64(target), count)
}

func TestCountActiveWorkspacesByUser_QueryPlanUsesActiveIndex(t *testing.T) {
	if testing.Short() {
		t.Skip("db integration test; requires Postgres (set SMITHERS_TEST_DATABASE_URL)")
	}

	ctx := context.Background()
	tx, err := sharedPool.BeginTx(ctx, pgx.TxOptions{})
	require.NoError(t, err)
	t.Cleanup(func() { _ = tx.Rollback(ctx) })

	q := New(tx)
	userID := mustCreateUser(t, tx, "quota-plan-user")
	repoID := mustCreateRepoForUser(t, tx, userID, "quota-plan-repo")

	// Keep rows live (deleted_at NULL) so the planner can use the same
	// partial index backing CountActiveWorkspacesByUser.
	for i := 0; i < 100; i++ {
		_, err := q.CreateWorkspace(ctx, CreateWorkspaceParams{
			RepositoryID: repoID,
			UserID:       userID,
			Name:         fmt.Sprintf("plan-row-%d", i),
			IsFork:       true,
			Status:       "running",
		})
		require.NoError(t, err)
	}

	// Guard against planner picking a tiny-table seq scan in tests; we want to
	// assert the quota query can be served by idx_workspaces_user_active.
	_, err = tx.Exec(ctx, `SET LOCAL enable_seqscan = off`)
	require.NoError(t, err)

	rows, err := tx.Query(
		ctx,
		`EXPLAIN (COSTS FALSE) SELECT COUNT(*) FROM workspaces WHERE user_id = $1 AND deleted_at IS NULL`,
		userID,
	)
	require.NoError(t, err)
	defer rows.Close()

	var planLines []string
	for rows.Next() {
		var line string
		require.NoError(t, rows.Scan(&line))
		planLines = append(planLines, line)
	}
	require.NoError(t, rows.Err())
	require.NotEmpty(t, planLines)

	plan := strings.Join(planLines, "\n")
	assert.Contains(t, plan, "Index", "quota count should use an index-backed plan")
	assert.True(t,
		strings.Contains(plan, "idx_workspaces_user_active") || strings.Contains(plan, "idx_workspaces_user_recency"),
		"quota count should use a partial user/deleted_at workspace index; plan:\n%s", plan)
	assert.NotContains(t, plan, "Seq Scan on workspaces", "quota count should not full-scan workspaces")
}

// mustCreateRepoForUser inserts a minimal repository row owned by userID.
// Only the columns the workspace FK actually needs. If the schema grows
// new NOT NULL columns without defaults, this helper will start failing.
func mustCreateRepoForUser(t *testing.T, tx DBTX, userID int64, name string) int64 {
	t.Helper()
	var id int64
	err := tx.QueryRow(
		context.Background(),
		`INSERT INTO repositories (user_id, name, lower_name) VALUES ($1, $2, $3)
		 RETURNING id`,
		userID, name, strings.ToLower(name),
	).Scan(&id)
	require.NoError(t, err)
	return id
}
