package services

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
	"strings"
	"sync"
	"testing"
	"time"
)

// Only the unresolved VM effect is a sentinel. Durable requests, authorization,
// locks and deduplication exercise real PostgreSQL; this is not VM certification.
type terminalRequestRuntime struct {
	workspaceapi.WorkspaceRuntime
	registry *machined.Registry
	entered  chan struct{}
	release  chan struct{}
	once     sync.Once
}

func (r *terminalRequestRuntime) Capabilities() workspaceapi.WorkspaceCapabilities {
	return workspaceapi.WorkspaceCapabilities{Terminal: true}
}
func (r *terminalRequestRuntime) MachinedRegistry() *machined.Registry { return r.registry }
func (r *terminalRequestRuntime) InspectWorkspace(ctx context.Context, id string) (workspaceapi.Workspace, error) {
	r.once.Do(func() { close(r.entered) })
	select {
	case <-r.release:
		return workspaceapi.Workspace{}, errors.New("sentinel machine refused")
	case <-ctx.Done():
		return workspaceapi.Workspace{}, ctx.Err()
	}
}
func TestBranchTerminalPersistsBeforeWakeAndDeduplicates(t *testing.T) {
	pool := newProductTestPool(t)
	member, repo := setupTestUserAndRepo(t, pool)
	q := db.New(pool)
	owner, err := q.GetBranchMachineOwner(t.Context())
	require.NoError(t, err)
	branch, err := q.CreateWorkspace(t.Context(), db.CreateWorkspaceParams{RepositoryID: repo, UserID: owner, TargetBookmark: "scratch/terminal/test", Name: "terminal", Status: "running", Kind: "vm"})
	require.NoError(t, err)
	runtime := &terminalRequestRuntime{registry: &machined.Registry{}, entered: make(chan struct{}), release: make(chan struct{})}
	service := NewWorkspaceService(q, WithWorkspaceRuntime(runtime), WithWorkspaceTransactions(pool), WithBranchMachineProviders(branchMachineTestProviders()))
	service.BindBranchTerminalHost(func(context.Context, db.Workspace, int64) error { return nil })
	defer func() {
		close(runtime.release)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		require.NoError(t, service.WaitForProvisioning(ctx))
	}()
	request := uuid.NewString()
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	receipt, err := service.OpenBranchTerminal(ctx, branch.ID, repo, member, request)
	require.NoError(t, err)
	require.Equal(t, "pending", receipt.Status)
	select {
	case <-runtime.entered:
	case <-time.After(time.Second):
		t.Fatal("persisted request did not start background provision")
	}
	var count int
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type='terminal.requested' AND data->>'session'=$1`, receipt.ID).Scan(&count))
	require.Equal(t, 1, count)
	duplicate, err := service.OpenBranchTerminal(ctx, branch.ID, repo, member, request)
	require.NoError(t, err)
	require.Equal(t, receipt.ID, duplicate.ID)
	_, err = service.OpenSSHReservation(ctx, branch.ID, repo, member, request)
	require.Error(t, err, "a request cannot change transport")
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM workspace_sessions WHERE workspace_id=$1`, branch.ID).Scan(&count))
	require.Equal(t, 1, count)
	_, err = service.OpenBranchTerminal(ctx, branch.ID, repo, member, "not-a-uuid")
	require.Error(t, err)
	uppercase, err := service.OpenBranchTerminal(t.Context(), branch.ID, repo, member, strings.ToUpper(request))
	require.NoError(t, err)
	require.Equal(t, receipt.ID, uppercase.ID)
	next := uuid.NewString()
	start := make(chan struct{})
	outcomes := make(chan error, 2)
	go func() {
		<-start
		_, err := service.OpenBranchTerminal(t.Context(), branch.ID, repo, member, next)
		outcomes <- err
	}()
	go func() {
		<-start
		_, err := service.OpenSSHReservation(t.Context(), branch.ID, repo, member, next)
		outcomes <- err
	}()
	close(start)
	first, second := <-outcomes, <-outcomes
	require.NotEqual(t, first == nil, second == nil, "exactly one transport owns a request")
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM workspace_sessions WHERE workspace_id=$1`, branch.ID).Scan(&count))
	require.Equal(t, 2, count)

}

func TestRecoveredTerminalWaitsForBranchHost(t *testing.T) {
	pool := newProductTestPool(t)
	member, repo := setupTestUserAndRepo(t, pool)
	q := db.New(pool)
	branch, err := q.CreateWorkspace(t.Context(), db.CreateWorkspaceParams{RepositoryID: repo, UserID: member, TargetBookmark: "scratch/recovery/terminal", Name: "terminal", Status: "running", Kind: "vm"})
	require.NoError(t, err)
	session, err := q.CreateWorkspaceSession(t.Context(), db.CreateWorkspaceSessionParams{WorkspaceID: branch.ID, RepositoryID: repo, UserID: member, Cols: 80, Rows: 24})
	require.NoError(t, err)
	_, err = q.UpdateWorkspaceSessionSSHConnectionInfo(t.Context(), db.UpdateWorkspaceSessionSSHConnectionInfoParams{ID: session.ID, SshConnectionInfo: []byte(`{"via":"terminal"}`)})
	require.NoError(t, err)
	service := NewWorkspaceService(q, WithWorkspaceTransactions(pool))
	service.completeRecoveredSessions(t.Context(), branch.ID)
	pending, err := q.GetWorkspaceSession(t.Context(), session.ID)
	require.NoError(t, err)
	require.Equal(t, "pending", pending.Status)
	entered, release := make(chan struct{}), make(chan struct{})
	service.BindBranchTerminalHost(func(ctx context.Context, ws db.Workspace, member int64) error {
		require.Equal(t, branch.ID, ws.ID)
		close(entered)
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	done := make(chan struct{})
	go func() { defer close(done); service.completeRecoveredSessions(t.Context(), branch.ID) }()
	<-entered
	pending, err = q.GetWorkspaceSession(t.Context(), session.ID)
	require.NoError(t, err)
	require.Equal(t, "pending", pending.Status)
	close(release)
	<-done
	running, err := q.GetWorkspaceSession(t.Context(), session.ID)
	require.NoError(t, err)
	require.Equal(t, "running", running.Status)
}

func TestSessionReservationSharesWakeAuthorityAndFencesTombstone(t *testing.T) {
	pool := newProductTestPool(t)
	member, repo := setupTestUserAndRepo(t, pool)
	q := db.New(pool)
	var definition string
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT pg_get_functiondef('guard_workspace_session_live_parent_insert()'::regprocedure)`).Scan(&definition))
	require.Contains(t, definition, "FOR SHARE")
	row, err := q.CreateWorkspace(t.Context(), db.CreateWorkspaceParams{RepositoryID: repo, UserID: member, Name: "reservation", Kind: "vm", Status: "running"})
	require.NoError(t, err)
	tx, err := pool.Begin(t.Context())
	require.NoError(t, err)
	defer tx.Rollback(context.Background())
	_, err = tx.Exec(t.Context(), `SELECT id FROM workspaces WHERE id=$1 FOR SHARE`, row.ID)
	require.NoError(t, err)
	// Keep the parent lock held throughout the reservation: an incompatible
	// wake lock still times out, with room for database scheduler contention.
	bounded, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	session, err := q.CreateWorkspaceSession(bounded, db.CreateWorkspaceSessionParams{WorkspaceID: row.ID, RepositoryID: repo, UserID: member, Cols: 80, Rows: 24})
	require.NoError(t, err, "reservation must not await wake work")
	removed := make(chan error, 1)
	go func() {
		_, err := pool.Exec(t.Context(), `UPDATE workspaces SET deleted_at=now() WHERE id=$1`, row.ID)
		removed <- err
	}()
	select {
	case err := <-removed:
		t.Fatalf("tombstone crossed held parent authority: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	require.NoError(t, tx.Commit(t.Context()))
	require.NoError(t, <-removed)
	stopped, err := q.GetWorkspaceSession(t.Context(), session.ID)
	require.NoError(t, err)
	require.Equal(t, "stopped", stopped.Status)
	_, err = q.CreateWorkspaceSession(t.Context(), db.CreateWorkspaceSessionParams{WorkspaceID: row.ID, RepositoryID: repo, UserID: member, Cols: 80, Rows: 24})
	require.Error(t, err, "a tombstoned parent cannot admit another reservation")
}
