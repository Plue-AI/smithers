package services

import (
	"context"
	"errors"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// diskReclaimRuntime records the workspaces whose disk the product reclaims.
type diskReclaimRuntime struct {
	workspaceapi.WorkspaceRuntime
	mu        sync.Mutex
	reclaimed []string
	operation []workspaceapi.Operation
	fail      map[string]error
}

func (r *diskReclaimRuntime) ReclaimWorkspaceDisk(ctx context.Context, id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.fail[id]; err != nil {
		return err
	}
	operation, _ := workspaceapi.OperationFromContext(ctx)
	r.operation = append(r.operation, operation)
	r.reclaimed = append(r.reclaimed, id)
	return nil
}

// Only agent workspaces suspended past the bound give their disk back; human
// workspaces, recent stops, running and deleted workspaces keep theirs.
// Real PostgreSQL selects the rows.
func TestCleanupStoppedAgentWorkspaceDisksReclaimsOnlyLongStoppedAgents(t *testing.T) {
	pool := newProductTestPool(t)
	user, repo := setupTestUserAndRepo(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	queries := db.New(pool)
	create := func(name, kind, status string, stoppedAgo time.Duration, deleted bool) string {
		t.Helper()
		row, err := queries.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo, UserID: user, Name: name,
			TargetBookmark: "main", Kind: kind, EnvironmentSource: defaultWorkspaceEnvironmentSource, Status: status})
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `UPDATE workspaces SET suspended_at = CASE WHEN status = 'suspended' THEN NOW() - make_interval(secs => $2) END,
			deleted_at = CASE WHEN $3 THEN NOW() END WHERE id = $1`, row.ID, stoppedAgo.Seconds(), deleted)
		require.NoError(t, err)
		return row.ID
	}
	oldest := create("agent-oldest", "agent", "suspended", 72*time.Hour, false)
	old := create("agent-old", "agent", "suspended", 25*time.Hour, false)
	create("agent-recent", "agent", "suspended", time.Hour, false)
	create("human-old", "vm", "suspended", 72*time.Hour, false)
	create("agent-running", "agent", "running", 0, false)
	create("agent-deleted", "agent", "suspended", 72*time.Hour, true)

	runtime := &diskReclaimRuntime{}
	svc := NewWorkspaceService(queries, WithWorkspaceRuntime(runtime))
	require.NoError(t, svc.CleanupStoppedAgentWorkspaceDisks(ctx))
	require.Equal(t, []string{oldest, old}, runtime.reclaimed, "oldest stop first")
	require.Equal(t, workspaceapi.Operation{TenantID: strconv.FormatInt(user, 10), PrincipalID: strconv.FormatInt(user, 10),
		OperationID: runtime.operation[0].OperationID}, runtime.operation[0])
	require.Contains(t, runtime.operation[0].OperationID, ":reclaim-disk")

	// A shorter bound reaches the recent stop too.
	runtime.reclaimed = nil
	svc = NewWorkspaceService(queries, WithWorkspaceRuntime(runtime), WithWorkspaceAgentDiskReclaimAfter(30*time.Minute))
	require.NoError(t, svc.CleanupStoppedAgentWorkspaceDisks(ctx))
	require.Len(t, runtime.reclaimed, 3)

	// One failure is reported without stopping the sweep.
	runtime.reclaimed = nil
	runtime.fail = map[string]error{oldest: errors.New("msb remove failed")}
	svc = NewWorkspaceService(queries, WithWorkspaceRuntime(runtime))
	err := svc.CleanupStoppedAgentWorkspaceDisks(ctx)
	require.ErrorContains(t, err, "reclaim agent workspace "+oldest+" disk: msb remove failed")
	require.Equal(t, []string{old}, runtime.reclaimed)

	// A runtime the product removed since does not fail the sweep.
	runtime.reclaimed = nil
	runtime.fail = map[string]error{oldest: workspaceapi.ErrWorkspaceNotFound}
	require.NoError(t, svc.CleanupStoppedAgentWorkspaceDisks(ctx))
	require.Equal(t, []string{old}, runtime.reclaimed)
}

// The row is re-read inside the runtime lock: a resume or delete between the
// list and the reclaim wins.
func TestReclaimAgentWorkspaceDiskSkipsARowThatChanged(t *testing.T) {
	for name, row := range map[string]db.Workspace{
		"resumed": {ID: "ws-1", Kind: "agent", Status: "running"},
		"human":   {ID: "ws-1", Kind: "vm", Status: "suspended"},
		"deleted": func() db.Workspace {
			row := db.Workspace{ID: "ws-1", Kind: "agent", Status: "suspended"}
			row.DeletedAt.Valid = true
			return row
		}(),
	} {
		t.Run(name, func(t *testing.T) {
			runtime := &diskReclaimRuntime{}
			q := &mockWorkspaceQuerier{getWorkspaceFn: func(context.Context, string) (db.Workspace, error) { return row, nil }}
			svc := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(runtime))
			require.NoError(t, svc.reclaimAgentWorkspaceDisk(context.Background(), runtime, "ws-1"))
			require.Empty(t, runtime.reclaimed)
		})
	}
}

func TestCleanupStoppedAgentWorkspaceDisksNeedsAReclaimingRuntime(t *testing.T) {
	listed := false
	q := &stoppedAgentListQuerier{mockWorkspaceQuerier: &mockWorkspaceQuerier{}, list: func() ([]string, error) { listed = true; return nil, nil }}
	require.NoError(t, newWorkspaceServiceForTests(q).CleanupStoppedAgentWorkspaceDisks(context.Background()))
	require.NoError(t, newWorkspaceServiceForTests(q, WithWorkspaceRuntime(&snapshotLostWorkerRuntime{})).CleanupStoppedAgentWorkspaceDisks(context.Background()))
	require.False(t, listed, "a runtime that cannot reclaim is never asked")

	q.list = func() ([]string, error) { return nil, errors.New("database down") }
	err := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(&diskReclaimRuntime{})).CleanupStoppedAgentWorkspaceDisks(context.Background())
	require.EqualError(t, err, "list stopped agent workspaces: database down")
}

type stoppedAgentListQuerier struct {
	*mockWorkspaceQuerier
	list func() ([]string, error)
}

func (q *stoppedAgentListQuerier) ListStoppedAgentWorkspaceIDs(context.Context, time.Duration) ([]string, error) {
	return q.list()
}
