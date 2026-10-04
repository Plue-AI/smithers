package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/cleanup"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// Any runtime call while safety authority is unavailable is a regression.
type diskReclaimRuntime struct {
	workspaceapi.WorkspaceRuntime
	reclaimed []string
}

func (*diskReclaimRuntime) ReclaimWorkspaceDisk(context.Context, string) error {
	panic("cleanup without branch safety authority")
}

func TestCleanupStoppedAgentWorkspaceDisksUnavailableContracts(t *testing.T) {
	for _, name := range []string{"settlement", "branch identity", "final capture", "session inventory"} {
		t.Run(name, func(t *testing.T) {
			// The current store exposes none of these contracts. Neither store reads
			// nor runtime calls may turn missing facts into permission to remove.
			q := &mockWorkspaceQuerier{getWorkspaceFn: func(context.Context, string) (db.Workspace, error) {
				t.Fatal("age-only workspace lookup")
				return db.Workspace{}, nil
			}}
			svc := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(&diskReclaimRuntime{}))
			require.NoError(t, svc.CleanupStoppedAgentWorkspaceDisks(context.Background()))
		})
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	require.ErrorIs(t, (&WorkspaceService{}).CleanupStoppedAgentWorkspaceDisks(ctx), context.Canceled)
}

// Other cleaner steps are isolated because this check concerns the disk
// reclaim boundary; the reclaim method itself is the real WorkspaceService.
type darkCleanupStore struct {
	*WorkspaceService
	tick chan struct{}
}

func (*darkCleanupStore) CleanupIdleSessions(context.Context) error           { return nil }
func (*darkCleanupStore) CleanupStalePendingWorkspaces(context.Context) error { return nil }
func (*darkCleanupStore) CleanupIdleWorkspaces(context.Context) error         { return nil }
func (*darkCleanupStore) CleanupOverQuotaWorkspaces(context.Context) error    { return nil }
func (*darkCleanupStore) CleanupAbandonedWorkspaces(context.Context) error    { return nil }
func (*darkCleanupStore) ReapWorkspaceChildren(context.Context) error         { return nil }
func (s *darkCleanupStore) CleanupOrphanFlowJournals(context.Context) error {
	select {
	case s.tick <- struct{}{}:
	default:
	}
	return nil
}
func TestWorkspaceCleanerRetainsDisksWithoutSafetyContracts(t *testing.T) {
	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceRuntime(&diskReclaimRuntime{}))
	store := &darkCleanupStore{WorkspaceService: svc, tick: make(chan struct{}, 1)}
	cleaner := cleanup.NewWorkspaceCleaner(store, time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cleaner.Start(ctx)
	defer cleaner.Stop()
	select {
	case <-store.tick:
	case <-time.After(time.Second):
		t.Fatal("cleaner never completed a tick")
	}
}

type cleanupLaneStore struct {
	*mockWorkspaceQuerier
	laneErr error
}

func (s *cleanupLaneStore) GetMythicalLane(context.Context, string) (db.MythicalLane, error) {
	return db.MythicalLane{}, s.laneErr
}
func TestCleanupRetainsAgentWithoutLaneBinding(t *testing.T) {
	for _, tc := range []struct {
		name, kind string
		laneErr    error
		keep       bool
	}{
		{"unbound agent", "agent", pgx.ErrNoRows, true},
		{"bound agent", "agent", nil, true},
		{"bound legacy workspace", "vm", nil, true},
		{"legacy nonbranch consumer", "vm", pgx.ErrNoRows, false},
		{"binding failure", "agent", errors.New("database unavailable"), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc := newWorkspaceServiceForTests(&cleanupLaneStore{mockWorkspaceQuerier: &mockWorkspaceQuerier{}, laneErr: tc.laneErr})
			row := db.Workspace{ID: "ws-cleanup", Kind: tc.kind}
			keep, err := svc.keepTodoWorkspace(context.Background(), row)
			require.Equal(t, tc.keep, keep)
			if tc.laneErr != nil && !errors.Is(tc.laneErr, pgx.ErrNoRows) {
				require.ErrorIs(t, err, tc.laneErr)
			} else {
				require.NoError(t, err)
			}
			if tc.keep && err == nil {
				require.ErrorIs(t, svc.destroyWorkspace(context.Background(), row), errTodoWorkspaceRetained)
				require.ErrorIs(t, svc.deleteWorkspaceRefs(context.Background(), row), errTodoWorkspaceRetained)
			}
		})
	}
}
