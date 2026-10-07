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

type cleanupBranchStore struct {
	*cleanupLaneStore
	owner    int64
	ownerErr error
}

func (s *cleanupBranchStore) GetBranchMachineOwner(context.Context) (int64, error) {
	return s.owner, s.ownerErr
}

func TestCleanupRetainsScratchMachineWithoutLane(t *testing.T) {
	for _, kind := range []string{"vm", "container", "agent"} {
		t.Run(kind, func(t *testing.T) {
			row := db.Workspace{ID: "scratch", UserID: 42, Kind: kind, Status: "suspended"}
			q := &cleanupBranchStore{cleanupLaneStore: &cleanupLaneStore{
				mockWorkspaceQuerier: &mockWorkspaceQuerier{}, laneErr: pgx.ErrNoRows,
			}, owner: 42}
			svc := newWorkspaceServiceForTests(q)
			keep, err := svc.keepTodoWorkspace(context.Background(), row)
			require.NoError(t, err)
			require.True(t, keep)
			require.ErrorIs(t, svc.destroyWorkspace(context.Background(), row), errTodoWorkspaceRetained)
			require.ErrorIs(t, svc.deleteWorkspaceRefs(context.Background(), row), errTodoWorkspaceRetained)
		})
	}
}

func TestCleanupRetainsMachineWhenOwnerLookupFails(t *testing.T) {
	failed := errors.New("owner inventory unavailable")
	q := &cleanupBranchStore{cleanupLaneStore: &cleanupLaneStore{mockWorkspaceQuerier: &mockWorkspaceQuerier{}, laneErr: pgx.ErrNoRows}, ownerErr: failed}
	svc := newWorkspaceServiceForTests(q)
	row := db.Workspace{ID: "scratch", UserID: 42, Kind: "vm"}
	keep, err := svc.keepTodoWorkspace(context.Background(), row)
	require.True(t, keep)
	require.ErrorIs(t, err, failed)
	require.ErrorIs(t, svc.destroyWorkspace(context.Background(), row), failed)
	require.ErrorIs(t, svc.deleteWorkspaceRefs(context.Background(), row), failed)
}

// The neighboring capture lifecycle has not landed. This test-only authority
// holds its fence across removal; it cannot authorize production deletion.
type captureReclaimAuthority struct {
	ids     []string
	capture WorkspaceDiskReclaimCapture
	before  func()
	fenced  bool
	failure error
}

func (a *captureReclaimAuthority) Candidates(context.Context) ([]string, error) { return a.ids, nil }
func (a *captureReclaimAuthority) WithFinalCapture(ctx context.Context, _ db.Workspace, remove func(context.Context, WorkspaceDiskReclaimCapture) error) error {
	if a.failure != nil {
		return a.failure
	}
	a.fenced = true
	defer func() { a.fenced = false }()
	if a.before != nil {
		a.before()
	}
	return remove(ctx, a.capture)
}

type authorizedReclaimRuntime struct {
	workspaceapi.WorkspaceRuntime
	authority *captureReclaimAuthority
	reclaimed []string
	failure   error
}

func (r *authorizedReclaimRuntime) ReclaimWorkspaceDisk(_ context.Context, id string) error {
	if !r.authority.fenced {
		panic("capture fence lost")
	}
	r.reclaimed = append(r.reclaimed, id)
	return r.failure
}
func TestWorkspaceCleanerAtomicFinalCaptureReclaim(t *testing.T) {
	for _, name := range []string{"verified", "unsettled", "busy", "missing capture", "wrong workspace", "wrong candidate", "unverified ref", "resumed", "rebound", "missing head", "capture failure", "runtime failure"} {
		t.Run(name, func(t *testing.T) {
			row := db.Workspace{ID: "settled", VmID: "machine", Status: "suspended", HeadCommitID: "pinned"}
			authority := &captureReclaimAuthority{ids: []string{row.ID}, capture: WorkspaceDiskReclaimCapture{WorkspaceID: row.ID, CandidateHead: "pinned", RetainedHead: "pinned", CaptureID: "complete-notes-capture", Settled: true, Quiet: true, BindingVerified: true, CaptureComplete: true, InventoryCurrent: true}}
			switch name {
			case "unsettled":
				authority.capture.Settled = false
			case "busy":
				authority.capture.Quiet = false
			case "missing capture":
				authority.capture.CaptureID = ""
			case "wrong workspace":
				authority.capture.WorkspaceID = "other"
			case "wrong candidate":
				authority.capture.CandidateHead = "other"
			case "unverified ref":
				authority.capture.RetainedHead = "other"
			case "resumed":
				authority.before = func() { row.Status = "running" }
			case "rebound":
				authority.before = func() { row.VmID = "replacement" }
			case "missing head":
				row.HeadCommitID = ""
			case "capture failure":
				authority.failure = errors.New("capture unavailable")
			}
			runtime := &authorizedReclaimRuntime{authority: authority}
			if name == "runtime failure" {
				runtime.failure = errors.New("runtime unavailable")
			}
			q := &mockWorkspaceQuerier{getWorkspaceFn: func(context.Context, string) (db.Workspace, error) { return row, nil }}
			svc := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(runtime), WithWorkspaceDiskReclaimAuthority(authority))
			// Drive the production cleaner's complete tick, not a helper invocation.
			store := &darkCleanupStore{WorkspaceService: svc, tick: make(chan struct{}, 1)}
			cleaner := cleanup.NewWorkspaceCleaner(store, 100*time.Millisecond)
			cleaner.Start(context.Background())
			select {
			case <-store.tick:
			case <-time.After(time.Second):
				t.Fatal("cleaner did not tick")
			}
			cleaner.Stop()
			if name == "verified" || name == "runtime failure" {
				require.Equal(t, []string{row.ID}, runtime.reclaimed)
			} else {
				require.Empty(t, runtime.reclaimed)
			}
			require.False(t, authority.fenced)
		})
	}
}

func TestFinalCaptureReclaimWaitsForLifecycleAndReReads(t *testing.T) {
	row := db.Workspace{ID: "waiting", Status: "suspended", HeadCommitID: "pinned"}
	authority := &captureReclaimAuthority{ids: []string{row.ID}, before: func() { t.Error("resumed workspace reached capture") }}
	runtime := &authorizedReclaimRuntime{authority: authority}
	q := &mockWorkspaceQuerier{getWorkspaceFn: func(context.Context, string) (db.Workspace, error) { return row, nil }}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(runtime), WithWorkspaceDiskReclaimAuthority(authority))
	unlock := svc.lockRuntimeWorkspace(row.ID)
	started, done := make(chan struct{}), make(chan error, 1)
	go func() { close(started); done <- svc.CleanupStoppedAgentWorkspaceDisks(context.Background()) }()
	<-started
	row.Status = "running"
	unlock()
	require.NoError(t, <-done)
	require.Empty(t, runtime.reclaimed)
}

func TestFinalCaptureReclaimPropagatesFailures(t *testing.T) {
	failure := errors.New("capture or removal unavailable")
	for _, stage := range []string{"capture", "runtime"} {
		t.Run(stage, func(t *testing.T) {
			row := db.Workspace{ID: "settled", Status: "suspended", HeadCommitID: "pinned"}
			a := &captureReclaimAuthority{ids: []string{row.ID}, capture: WorkspaceDiskReclaimCapture{WorkspaceID: row.ID, CandidateHead: "pinned", RetainedHead: "pinned", CaptureID: "capture", Settled: true, Quiet: true, BindingVerified: true, CaptureComplete: true, InventoryCurrent: true}}
			r := &authorizedReclaimRuntime{authority: a}
			if stage == "capture" {
				a.failure = failure
			} else {
				r.failure = failure
			}
			q := &mockWorkspaceQuerier{getWorkspaceFn: func(context.Context, string) (db.Workspace, error) { return row, nil }}
			svc := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(r), WithWorkspaceDiskReclaimAuthority(a))
			require.ErrorIs(t, svc.CleanupStoppedAgentWorkspaceDisks(context.Background()), failure)
			require.False(t, a.fenced)
		})
	}
}
