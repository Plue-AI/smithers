package services

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// These are unit gate assertions, not C-MCH-03's production HTTP receipts.
// Nil stores/providers intentionally make any attempted side effect panic.
func TestBranchSleepUnavailableProvidersUnit(t *testing.T) {
	for _, automatic := range []bool{false, true} {
		t.Run(map[bool]string{false: "explicit", true: "automatic"}[automatic], func(t *testing.T) {
			svc := NewWorkspaceService(nil)
			ws := db.Workspace{ID: "branch", Status: "running", VmID: "retained"}
			var err error
			if automatic {
				err = svc.suspendWorkspaceIfSessionless(context.Background(), ws)
			} else {
				err = svc.suspendWorkspace(context.Background(), ws)
			}
			var api *pkgerrors.APIError
			require.ErrorAs(t, err, &api)
			require.Equal(t, pkgerrors.CodeServiceUnavailable, api.Code)
			require.Equal(t, pkgerrors.FaultInfra, api.Fault)
			require.Equal(t, 503, api.Status)
			require.Equal(t, "running", ws.Status)
		})
	}
}

func TestBranchWakeUnavailableAdmissionUnit(t *testing.T) {
	svc := NewWorkspaceService(nil)
	for _, status := range []string{"running", "suspended", "stopped"} {
		err := svc.authorizeWorkspaceResume(context.Background(), db.Workspace{Status: status})
		var api *pkgerrors.APIError
		require.ErrorAs(t, err, &api)
		require.Equal(t, pkgerrors.FaultInfra, api.Fault)
		require.Equal(t, 503, api.Status)
	}
}

// Snapshot storage is unavailable: authorized readers fail closed before any
// VM lookup/start/exec; revoked readers retain the permission refusal.
func TestBranchSnapshotReadsUnavailableBindingUnit(t *testing.T) {
	for _, actor := range []int64{1, 2, 3, 4} {
		q := &mockWorkspaceQuerier{
			getWorkspaceByRepoFn: func(_ context.Context, arg db.GetWorkspaceByRepoParams) (db.Workspace, error) {
				row := sampleDBWorkspace(arg.ID)
				row.Status = "suspended"
				return row, nil
			},
			getWorkspaceShareFn: func(_ context.Context, arg db.GetWorkspaceShareParams) (db.WorkspaceShare, error) {
				switch arg.GranteeUserID {
				case 2:
					return db.WorkspaceShare{Level: "write"}, nil
				case 3:
					return db.WorkspaceShare{Level: "read"}, nil
				default:
					return db.WorkspaceShare{}, pgx.ErrNoRows
				}
			},
		}
		svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
			getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
				t.Fatal("read consulted VM")
				return sandbox.Sandbox{}, nil
			},
			startVMFn: func(context.Context, string, sandbox.StartRequest) (sandbox.StartResult, error) {
				t.Fatal("read started VM")
				return sandbox.StartResult{}, nil
			},
			execAwaitFn: func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
				t.Fatal("read executed guest code")
				return sandbox.ExecResult{}, nil
			},
		}))
		_, listErr := svc.ListWorkspaceFiles(context.Background(), "ws-1", 101, actor, "")
		_, readErr := svc.ReadWorkspaceFile(context.Background(), "ws-1", 101, actor, "src/backoff.ts")
		for _, err := range []error{listErr, readErr} {
			var api *pkgerrors.APIError
			require.ErrorAs(t, err, &api)
			if actor == 4 {
				require.Equal(t, 403, api.Status)
			} else {
				require.Equal(t, 503, api.Status)
				require.Equal(t, pkgerrors.FaultInfra, api.Fault)
			}
		}
	}
}

func TestWorkspaceService_CleanupStalePendingWorkspaces_FailsZombies(t *testing.T) {
	t.Parallel()

	var updated []string
	q := &mockWorkspaceQuerier{
		listStalePendingWorkspacesFn: func(ctx context.Context, staleAfterSecs int32) ([]db.Workspace, error) {
			require.Equal(t, int32(workspaceStaleAfter/time.Second), staleAfterSecs)
			first := sampleDBWorkspace("ws-stale-1")
			first.Status = "pending"
			first.VmID = ""
			second := sampleDBWorkspace("ws-stale-2")
			second.Status = "starting"
			second.VmID = ""
			return []db.Workspace{first, second}, nil
		},
		updateWorkspaceStatusFn: func(ctx context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
			updated = append(updated, arg.ID+":"+arg.Status)
			workspace := sampleDBWorkspace(arg.ID)
			workspace.Status = arg.Status
			workspace.VmID = ""
			return workspace, nil
		},
	}

	svc := newWorkspaceServiceForTests(q)
	require.NoError(t, svc.CleanupStalePendingWorkspaces(context.Background()))
	assert.Equal(t, []string{"ws-stale-1:failed", "ws-stale-2:failed"}, updated)
}

// A workspace whose Microsandbox VM was reclaimed out-of-band must still be
// deletable: a 404 from DeleteSandbox is the desired terminal state, so destroy must
// proceed to soft-delete rather than 500 and leave the row holding its
// concurrent-sandbox quota slot forever ("delete one to continue" must hold).
func TestWorkspaceService_DestroyWorkspace_ToleratesAlreadyGoneVM(t *testing.T) {
	t.Parallel()

	softDeleted := false
	q := &mockWorkspaceQuerier{
		getWorkspaceFn: func(_ context.Context, id string) (db.Workspace, error) {
			ws := sampleDBWorkspace(id)
			ws.VmID = "vm-gone"
			ws.Status = "running"
			return ws, nil
		},
		softDeleteWorkspaceFn: func(_ context.Context, id string) (db.Workspace, error) {
			softDeleted = true
			return sampleDBWorkspace(id), nil
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		deleteVMFn: func(_ context.Context, _ string) error {
			return &sandbox.StatusError{StatusCode: 404, Message: "no such vm"}
		},
	}))

	require.NoError(t, svc.DestroyWorkspace(context.Background(), "ws-1"),
		"a 404 (VM already gone) must not block soft-delete")
	assert.True(t, softDeleted, "workspace must be soft-deleted so its quota slot is freed")
}

// A genuine (non-404) VM delete failure must still fail the destroy and leave
// the row intact, so we never orphan a live VM by soft-deleting its workspace.
func TestWorkspaceService_DestroyWorkspace_PropagatesRealVMDeleteError(t *testing.T) {
	t.Parallel()

	softDeleted := false
	q := &mockWorkspaceQuerier{
		getWorkspaceFn: func(_ context.Context, id string) (db.Workspace, error) {
			ws := sampleDBWorkspace(id)
			ws.VmID = "vm-live"
			ws.Status = "running"
			return ws, nil
		},
		softDeleteWorkspaceFn: func(_ context.Context, id string) (db.Workspace, error) {
			softDeleted = true
			return sampleDBWorkspace(id), nil
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		deleteVMFn: func(_ context.Context, _ string) error {
			return &sandbox.StatusError{StatusCode: 500, Message: "internal"}
		},
	}))

	require.Error(t, svc.DestroyWorkspace(context.Background(), "ws-1"),
		"a non-404 delete error must fail the destroy")
	assert.False(t, softDeleted, "workspace must not be soft-deleted when VM delete genuinely fails")
}
