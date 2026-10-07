package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/cleanup"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// Test-only final-capture authority; production stays dark until the capture
// owner can hold writer/admission exclusion and verify retained objects.
type finalCaptureFixture struct {
	ids     []string
	facts   WorkspaceDiskReclaimCapture
	entered func()
	held    bool
	err     error
}

func (f *finalCaptureFixture) Candidates(context.Context) ([]string, error) { return f.ids, nil }
func (f *finalCaptureFixture) WithFinalCapture(ctx context.Context, row db.Workspace, lockRuntime func() func(), consume func(WorkspaceDiskReclaimCapture) error) error {
	if f.err != nil {
		return f.err
	}
	f.held = true
	defer func() { f.held = false }()
	if f.entered != nil {
		f.entered()
	}
	unlock := lockRuntime()
	defer unlock()
	return consume(f.facts)
}

type settledReclaimStore struct {
	*mockWorkspaceQuerier
	lane db.MythicalLane
	item db.MythicalItem
}

func (s *settledReclaimStore) GetMythicalLane(context.Context, string) (db.MythicalLane, error) {
	return s.lane, nil
}
func (s *settledReclaimStore) GetMythicalItem(context.Context, pgtype.UUID) (db.MythicalItem, error) {
	return s.item, nil
}

type settledReclaimRuntime struct {
	workspaceapi.WorkspaceRuntime
	authority *finalCaptureFixture
	calls     int
	err       error
}

func (r *settledReclaimRuntime) ReclaimWorkspaceDisk(ctx context.Context, id string) error {
	if !r.authority.held {
		panic("capture exclusion released before disk removal")
	}
	r.calls++
	return r.err
}
func TestSettledDiskReclaimRequiresCurrentCompleteAuthority(t *testing.T) {
	for _, name := range []string{"verified", "lock order", "unsettled", "busy", "unverified", "mismatch", "missing candidate", "wrong workspace", "resumed", "deleted", "head changed", "binding changed", "machine changed", "owner changed", "repository changed", "authority failure", "runtime failure", "cancelled", "reopened", "paused", "lane moved", "pending capture", "capture arrives"} {
		t.Run(name, func(t *testing.T) {
			row := db.Workspace{ID: "settled", UserID: 1, RepositoryID: 2, Status: "suspended", TargetBookmark: "todo", HeadCommitID: "pinned"}
			f := &finalCaptureFixture{ids: []string{row.ID}, facts: WorkspaceDiskReclaimCapture{WorkspaceID: row.ID, CandidateHead: "pinned", RetainedHead: "pinned", Settled: true, Quiet: true, CaptureComplete: true, BindingVerified: true, InventoryCurrent: true, CaptureID: "capture"}}
			r := &settledReclaimRuntime{authority: f}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			failure := errors.New("unavailable")
			switch name {
			case "unsettled":
				f.facts.Settled = false
			case "busy":
				f.facts.Quiet = false
			case "unverified":
				f.facts.CaptureComplete = false
			case "mismatch":
				f.facts.RetainedHead = "different"
			case "missing candidate":
				f.facts.CandidateHead = ""
			case "wrong workspace":
				f.facts.WorkspaceID = "other"
			case "resumed":
				f.entered = func() { row.Status = "running" }
			case "deleted":
				f.entered = func() { row.DeletedAt.Valid = true }
			case "head changed":
				f.entered = func() { row.HeadCommitID = "new" }
			case "pending capture":
				row.CapturePending = []byte(`{"head":"unaccepted"}`)
			case "capture arrives":
				f.entered = func() { row.CapturePending = []byte(`{"head":"unaccepted"}`) }
			case "binding changed":
				f.entered = func() { row.TargetBookmark = "other" }
			case "machine changed":
				f.entered = func() { row.VmID = "replacement" }
			case "owner changed":
				f.entered = func() { row.UserID++ }
			case "repository changed":
				f.entered = func() { row.RepositoryID++ }
			case "authority failure":
				f.err = failure
			case "runtime failure":
				r.err = failure
			case "cancelled":
				f.entered = cancel
			}
			q := &settledReclaimStore{mockWorkspaceQuerier: &mockWorkspaceQuerier{getWorkspaceFn: func(context.Context, string) (db.Workspace, error) { return row, nil }}, lane: db.MythicalLane{WorkspaceID: row.ID, RepositoryID: row.RepositoryID}, item: db.MythicalItem{WorkspaceID: row.ID, RepositoryID: row.RepositoryID, State: "cancelled", CandidateHead: "pinned"}}
			switch name {
			case "reopened":
				f.entered = func() { q.item.State = "proposed" }
			case "paused":
				f.entered = func() { q.item.PausedAt.Valid = true }
			case "lane moved":
				f.entered = func() { q.lane.WorkspaceID = "other" }
			}
			s := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(r), WithWorkspaceDiskReclaimAuthority(f))
			if name == "lock order" {
				f.entered = func() {
					registry := s.runtimeLocks
					registry.mutex.Lock()
					entry := registry.entries[row.ID]
					registry.mutex.Unlock()
					if entry != nil {
						available := entry.mutex.TryLock()
						if available {
							entry.mutex.Unlock()
						}
						require.True(t, available, "capture exclusion must precede runtime mutation locking")
					}
				}
			}
			err := s.CleanupStoppedAgentWorkspaceDisks(ctx)
			switch name {
			case "authority failure", "runtime failure":
				require.ErrorIs(t, err, failure)
			case "cancelled":
				require.ErrorIs(t, err, context.Canceled)
			default:
				require.NoError(t, err)
			}
			want := 0
			if name == "verified" || name == "lock order" || name == "runtime failure" {
				want = 1
			}
			require.Equal(t, want, r.calls)
			require.False(t, f.held)
		})
	}
}
func TestWorkspaceCleanerReclaimsSettledDiskInsideCaptureExclusion(t *testing.T) {
	pool := newProductTestPool(t)
	user, repo := setupTestUserAndRepo(t, pool)
	q := db.New(pool)
	row, err := q.CreateWorkspace(context.Background(), db.CreateWorkspaceParams{RepositoryID: repo, UserID: user, Name: "settled TODO", Kind: "agent", Status: "suspended", TargetBookmark: "todo", EnvironmentSource: defaultWorkspaceEnvironmentSource})
	require.NoError(t, err)
	_, err = pool.Exec(context.Background(), `UPDATE workspaces SET head_commit_id='pinned' WHERE id=$1`, row.ID)
	require.NoError(t, err)
	item, _, err := q.InsertMythicalChatItem(context.Background(), db.MythicalItem{RepositoryID: repo, WorkspaceID: row.ID, CandidateHead: "pinned"})
	require.NoError(t, err)
	_, _, err = q.BindMythicalLane(context.Background(), db.MythicalLane{WorkspaceID: row.ID, RepositoryID: repo, ItemID: item.ID, Name: "settled"})
	require.NoError(t, err)
	_, err = pool.Exec(context.Background(), `UPDATE mythical_items SET state='cancelled' WHERE id=$1`, item.ID)
	require.NoError(t, err)
	f := &finalCaptureFixture{ids: []string{row.ID}, facts: WorkspaceDiskReclaimCapture{WorkspaceID: row.ID, CandidateHead: "pinned", RetainedHead: "pinned", Settled: true, Quiet: true, CaptureComplete: true, BindingVerified: true, InventoryCurrent: true, CaptureID: "capture"}}
	r := &settledReclaimRuntime{authority: f}
	service := NewWorkspaceService(q, WithWorkspaceRuntime(r), WithWorkspaceDiskReclaimAuthority(f))
	// The hint and authority can both predate a durable pending snapshot.
	// Even with a matching verified candidate, that work must survive the sweep.
	f.entered = func() {
		_, err := pool.Exec(context.Background(), `UPDATE workspaces SET capture_pending='{"head":"unaccepted"}' WHERE id=$1`, row.ID)
		require.NoError(t, err)
	}
	require.NoError(t, service.CleanupStoppedAgentWorkspaceDisks(context.Background()))
	require.Zero(t, r.calls)
	retained, err := q.GetWorkspace(context.Background(), row.ID)
	require.NoError(t, err)
	require.JSONEq(t, `{"head":"unaccepted"}`, string(retained.CapturePending))
	f.entered = nil
	_, err = pool.Exec(context.Background(), `UPDATE workspaces SET capture_pending=NULL WHERE id=$1`, row.ID)
	require.NoError(t, err)
	store := &darkCleanupStore{WorkspaceService: service, tick: make(chan struct{}, 1)}
	cleaner := cleanup.NewWorkspaceCleaner(store, 50*time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cleaner.Start(ctx)
	select {
	case <-store.tick:
	case <-time.After(30 * time.Second):
		t.Fatal("cleaner never finished")
	}
	cleaner.Stop()
	require.Positive(t, r.calls)
	current, err := q.GetWorkspace(context.Background(), row.ID)
	require.NoError(t, err)
	require.False(t, current.DeletedAt.Valid, "reclaim retains durable binding for reopen")
	require.Equal(t, "pinned", current.HeadCommitID)
}

func TestSettledDiskSweepReReadsAfterLifecycleLock(t *testing.T) {
	row := db.Workspace{ID: "resumed", Status: "suspended", HeadCommitID: "pinned"}
	f := &finalCaptureFixture{ids: []string{row.ID}, facts: WorkspaceDiskReclaimCapture{WorkspaceID: row.ID, CandidateHead: "pinned", RetainedHead: "pinned", Settled: true, Quiet: true, CaptureComplete: true, BindingVerified: true, InventoryCurrent: true, CaptureID: "capture"}}
	r := &settledReclaimRuntime{authority: f}
	looked := false
	q := &settledReclaimStore{mockWorkspaceQuerier: &mockWorkspaceQuerier{getWorkspaceFn: func(context.Context, string) (db.Workspace, error) { looked = true; return row, nil }}}
	service := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(r), WithWorkspaceDiskReclaimAuthority(f))
	unlock := service.lockRuntimeWorkspace(row.ID)
	done := make(chan error, 1)
	go func() { done <- service.CleanupStoppedAgentWorkspaceDisks(context.Background()) }()
	// The lifecycle mutation owns the lock. The queued sweep must observe its
	// resulting running state even when its candidate list is stale.
	row.Status = "running"
	unlock()
	require.NoError(t, <-done)
	require.True(t, looked)
	require.Zero(t, r.calls)
}
