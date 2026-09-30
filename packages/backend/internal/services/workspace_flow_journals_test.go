package services

import (
	"context"
	"errors"
	"net/url"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/testkit/testdb"
)

// Deleting a workspace drops its flow journal; the cleaner's sweep drops the
// journal of a workspace whose row a repository deletion cascaded away and
// keeps a live workspace's journal and every name outside the scheme. Real
// PostgreSQL holds the rows and the journals; only the VM is a test double.
func TestWorkspaceFlowJournalsFollowTheWorkspace(t *testing.T) {
	pool := newProductTestPool(t)
	user, repo := setupTestUserAndRepo(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	queries := db.New(pool)
	journals, err := flowhost.NewPostgresJournals(ctx, pool, testdb.ServerURL(), []byte("smithers flow journal test key 32"))
	require.NoError(t, err)
	svc := NewWorkspaceService(queries, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))
	svc.SetFlowJournals(journals)
	create := func(name string, repository int64) db.Workspace {
		t.Helper()
		row, err := queries.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repository, UserID: user, Name: name,
			TargetBookmark: "main", Kind: "container", EnvironmentSource: defaultWorkspaceEnvironmentSource, Status: "running"})
		require.NoError(t, err)
		_, err = journals.Provision(ctx, row.ID)
		require.NoError(t, err)
		name, err = flowhost.JournalDatabaseName(row.ID)
		require.NoError(t, err)
		t.Cleanup(func() { _ = journals.Drop(context.Background(), row.ID) })
		return row
	}
	exists := func(workspaceID string) bool {
		t.Helper()
		name, err := flowhost.JournalDatabaseName(workspaceID)
		require.NoError(t, err)
		var role, database bool
		require.NoError(t, pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1),
			EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)`, name).Scan(&role, &database))
		require.Equal(t, role, database, "a journal's role and database go together")
		return role
	}
	live := create("live", repo)
	deleted := create("deleted", repo)

	require.NoError(t, svc.DeleteWorkspace(ctx, deleted.ID, repo, user))
	assert.False(t, exists(deleted.ID), "deleting the workspace drops its journal")
	assert.True(t, exists(live.ID))

	// A repository or account deletion cascades the row away without the
	// workspace delete path; the sweep finds the journal left behind.
	cascaded := create("cascaded", repo)
	_, err = pool.Exec(ctx, `DELETE FROM workspaces WHERE id = $1`, cascaded.ID)
	require.NoError(t, err)
	// A tombstoned workspace whose drop failed at delete time is swept too.
	tombstoned := create("tombstoned", repo)
	_, err = queries.SoftDeleteWorkspace(ctx, tombstoned.ID)
	require.NoError(t, err)
	// A role named outside the scheme, tagged as this backend's, is never
	// dropped.
	var database string
	require.NoError(t, pool.QueryRow(ctx, `SELECT current_database()`).Scan(&database))
	decoy := "smithers_flows_keep_" + uuid.NewString()[:8]
	_, err = pool.Exec(ctx, "CREATE ROLE "+decoy)
	require.NoError(t, err)
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), "DROP ROLE IF EXISTS "+decoy) })
	_, err = pool.Exec(ctx, "COMMENT ON ROLE "+decoy+" IS 'smithers flow journal of database "+database+"'")
	require.NoError(t, err)

	require.NoError(t, svc.CleanupOrphanFlowJournals(ctx))
	assert.False(t, exists(cascaded.ID))
	assert.False(t, exists(tombstoned.ID))
	assert.True(t, exists(live.ID), "a live workspace keeps its journal")
	var decoyKept bool
	require.NoError(t, pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)`, decoy).Scan(&decoyKept))
	assert.True(t, decoyKept)
	require.NoError(t, svc.CleanupOrphanFlowJournals(ctx), "a second sweep finds nothing")
	listed, err := journals.Workspaces(ctx)
	require.NoError(t, err)
	assert.Equal(t, []string{live.ID}, listed)

	// Stopping keeps the journal: only deletion ends it.
	_, err = svc.StopWorkspace(ctx, live.ID, repo, user)
	require.NoError(t, err)
	assert.True(t, exists(live.ID))
	require.NoError(t, svc.CleanupOrphanFlowJournals(ctx))
	assert.True(t, exists(live.ID))
	_ = url.URL{}
}

type fakeFlowJournals struct {
	listed  []string
	listErr error
	dropErr map[string]error
	dropped []string
}

func (f *fakeFlowJournals) Drop(_ context.Context, workspaceID string) error {
	f.dropped = append(f.dropped, workspaceID)
	return f.dropErr[workspaceID]
}

func (f *fakeFlowJournals) Workspaces(context.Context) ([]string, error) { return f.listed, f.listErr }

func (f *fakeFlowJournals) Fence(context.Context, string) (bool, error) { return false, nil }

type flowJournalQuerier struct {
	WorkspaceQuerier
	rows map[string]error
}

func (q flowJournalQuerier) GetWorkspace(_ context.Context, id string) (db.Workspace, error) {
	if err, ok := q.rows[id]; ok {
		return db.Workspace{ID: id}, err
	}
	return db.Workspace{}, pgx.ErrNoRows
}

func TestCleanupOrphanFlowJournalsReportsEveryFailureAndKeepsGoing(t *testing.T) {
	ctx := context.Background()
	// Without PostgreSQL journals there is nothing to sweep.
	require.NoError(t, NewWorkspaceService(flowJournalQuerier{}).CleanupOrphanFlowJournals(ctx))
	unstored := &WorkspaceService{}
	unstored.SetFlowJournals(&fakeFlowJournals{listErr: errors.New("must not list")})
	require.NoError(t, unstored.CleanupOrphanFlowJournals(ctx))

	listing := &fakeFlowJournals{listErr: errors.New("server gone")}
	svc := NewWorkspaceService(flowJournalQuerier{})
	svc.SetFlowJournals(listing)
	require.ErrorContains(t, svc.CleanupOrphanFlowJournals(ctx), "list flow journals: server gone")

	journals := &fakeFlowJournals{
		listed:  []string{"live", "unreadable", "orphan-a", "undroppable", "orphan-b"},
		dropErr: map[string]error{"undroppable": errors.New("in use")},
	}
	svc = NewWorkspaceService(flowJournalQuerier{rows: map[string]error{"live": nil, "unreadable": errors.New("db down")}})
	svc.SetFlowJournals(journals)
	err := svc.CleanupOrphanFlowJournals(ctx)
	require.ErrorContains(t, err, "load flow journal workspace unreadable: db down")
	require.ErrorContains(t, err, "drop flow journal of workspace undroppable: in use")
	assert.Equal(t, []string{"orphan-a", "undroppable", "orphan-b"}, journals.dropped, "a failure never stops the sweep, and live or unreadable rows are kept")

	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	journals.dropped = nil
	require.ErrorIs(t, svc.CleanupOrphanFlowJournals(cancelled), context.Canceled)
	assert.Empty(t, journals.dropped)
}

func TestDropFlowJournalFailureDoesNotFailTheDelete(t *testing.T) {
	journals := &fakeFlowJournals{dropErr: map[string]error{"ws": errors.New("server gone")}}
	svc := NewWorkspaceService(flowJournalQuerier{})
	svc.dropFlowJournal(context.Background(), "ws") // no journals: nothing happens
	svc.SetFlowJournals(journals)
	svc.dropFlowJournal(context.Background(), "ws")
	assert.Equal(t, []string{"ws"}, journals.dropped)
}
