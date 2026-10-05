package services

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// One live branch (M-17, stage 2 item 9): every creation path on one branch
// returns its one machine, whatever kind or name it asks for, and the
// database refuses a second active row that bypasses the service.
func TestOneLiveBranchEveryCreationPathJoinsIt(t *testing.T) {
	pool := newProductTestPool(t)
	owner, repo := setupTestUserAndRepo(t, pool)
	installBranchOwner(t, pool, owner)
	ctx := context.Background()
	svc := installLaneService(t, pool, owner)
	q := db.New(pool)

	first, err := svc.createBookmarkWorkspace(ctx, repo, owner, "editor", "main", workspaceCreateMetadata{kind: "container"}, false)
	require.NoError(t, err)
	for _, tc := range []struct {
		name, kind string
		fork       bool
	}{
		{"terminal", "vm", false},
		{"", "container", true},
		{"coding agent", "agent", false},
	} {
		row, err := svc.createBookmarkWorkspace(ctx, repo, owner, tc.name, "main", workspaceCreateMetadata{kind: tc.kind}, tc.fork)
		require.NoError(t, err)
		require.Equal(t, first.ID, row.ID, "%q/%s joins the branch's machine", tc.name, tc.kind)
	}

	// A child is a copy of its parent's machine on the parent's branch; the
	// branch's machine is still the parent.
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	txq := db.New(tx)
	batch, err := txq.CreateWorkspaceChildBatch(ctx, db.CreateWorkspaceChildBatchParams{
		ParentWorkspaceID: pgUUIDFromString(first.ID), UserID: first.UserID, Profile: "small", Requested: 2, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	require.NoError(t, txq.ReserveWorkspaceChildren(ctx, batch.ID))
	children, err := txq.CreateWorkspaceChildRows(ctx, batch.ID)
	require.NoError(t, err)
	require.NoError(t, tx.Commit(ctx))
	require.Len(t, children, 2, "children on the parent's branch are admitted")
	for _, child := range children {
		require.Equal(t, "main", child.TargetBookmark)
	}
	again, err := svc.createBookmarkWorkspace(ctx, repo, owner, "late joiner", "main", workspaceCreateMetadata{kind: "container"}, false)
	require.NoError(t, err)
	require.Equal(t, first.ID, again.ID, "a newer child never answers for the branch")

	// The database is the backstop for any path that skips the branch lock.
	for _, arg := range []db.CreateWorkspaceParams{
		{Name: "other name", Kind: "container"},
		{Name: "editor", Kind: "vm"},
		{Name: "pushed", Kind: "container", SourceCommit: "0123456789abcdef0123456789abcdef01234567"},
		{Name: "agent", Kind: "agent", AgentSessionID: pgtype.UUID{}},
	} {
		arg.RepositoryID, arg.UserID, arg.TargetBookmark, arg.Status = repo, owner, "main", "starting"
		arg.EnvironmentSource = defaultWorkspaceEnvironmentSource
		_, err := q.CreateWorkspace(ctx, arg)
		require.Error(t, err, "%+v", arg)
		require.True(t, isWorkspaceActiveUniqueViolation(err), "%v", err)
	}
	// A retained machine (stopped or failed) is history, not a second live one.
	_, err = q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: owner, Name: "retained", Kind: "container",
		TargetBookmark: "main", Status: "failed", EnvironmentSource: defaultWorkspaceEnvironmentSource})
	require.NoError(t, err)

	// Stack lanes share the stack's bookmark and are told apart by lane name.
	lane := func(name string) error {
		_, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: owner, Name: name, Kind: "container",
			TargetBookmark: MythicalBookmark, Status: "starting", EnvironmentSource: defaultWorkspaceEnvironmentSource})
		return err
	}
	require.NoError(t, lane("TODO 1 attempt 1 g1"))
	require.NoError(t, lane("TODO 2 attempt 1 g1"))
	err = lane("TODO 1 attempt 1 g1")
	require.True(t, isWorkspaceActiveUniqueViolation(err), "%v", err)

	var live int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE repository_id=$1 AND target_bookmark='main'
        AND deleted_at IS NULL AND status IN ('pending','starting','running','suspended') AND parent_workspace_id IS NULL`, repo).Scan(&live))
	require.Equal(t, 1, live)
}

// Concurrent first joins of one branch, by different kinds and names, make
// one machine.
func TestOneLiveBranchConcurrentJoinsMakeOneMachine(t *testing.T) {
	pool := newProductTestPool(t)
	owner, repo := setupTestUserAndRepo(t, pool)
	installBranchOwner(t, pool, owner)
	ctx := context.Background()
	svc := installLaneService(t, pool, owner)
	const joiners = 8
	ids := make([]string, joiners)
	errs := make([]error, joiners)
	var wg sync.WaitGroup
	for i := range joiners {
		wg.Add(1)
		go func() {
			defer wg.Done()
			kind := []string{"container", "vm", "agent"}[i%3]
			row, err := svc.createBookmarkWorkspace(ctx, repo, owner, "joiner "+string(rune('a'+i)), "scratch/owner/race", workspaceCreateMetadata{kind: kind}, i%2 == 0)
			ids[i], errs[i] = row.ID, err
		}()
	}
	wg.Wait()
	for i := range joiners {
		require.NoError(t, errs[i])
		require.Equal(t, ids[0], ids[i])
	}
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE repository_id=$1 AND target_bookmark='scratch/owner/race' AND deleted_at IS NULL`, repo).Scan(&count))
	require.Equal(t, 1, count)
}
