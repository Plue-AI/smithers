package services

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

func lostWorkerRuntimeCause() error {
	return fmt.Errorf("worker request: %w", &sandbox.StatusError{StatusCode: http.StatusServiceUnavailable,
		Code: "host_lease_lost", Message: "The workspace worker is unavailable. Use another workspace, or retry when this worker is available."})
}

func requireLostWorkerRuntimeFailure(t *testing.T, err error) {
	t.Helper()
	failure := apiErrorOf(t, err)
	require.Equal(t, http.StatusServiceUnavailable, failure.Status, "%v", err)
	require.Equal(t, pkgerrors.CodeHostLeaseLost, failure.Code)
	require.Equal(t, pkgerrors.FaultInfra, failure.Fault)
}

type snapshotLostWorkerRuntime struct {
	workspaceapi.WorkspaceRuntime
	lost     error
	fail     string
	terminal workspaceapi.Terminal
	created  int
	forked   int
	deleted  int
	stopped  int
	started  int
}

// Isolation is read on every repository readiness path (354eeaab05); the
// sandboxed runtime without a compute provider stages its own artifacts.
func (*snapshotLostWorkerRuntime) Isolation() workspaceapi.IsolationLevel {
	return workspaceapi.IsolationSandboxed
}

func (*snapshotLostWorkerRuntime) Capabilities() workspaceapi.WorkspaceCapabilities {
	return workspaceapi.WorkspaceCapabilities{PersistentFiles: true, Execution: true, FileOperations: true, ColdSnapshots: true, Terminal: true}
}

func (*snapshotLostWorkerRuntime) InspectWorkspace(_ context.Context, id string) (workspaceapi.Workspace, error) {
	return workspaceapi.Workspace{ID: id, State: workspaceapi.WorkspaceRunning}, nil
}

func (r *snapshotLostWorkerRuntime) StopWorkspace(context.Context, string) error {
	r.stopped++
	return nil
}

func (r *snapshotLostWorkerRuntime) StartWorkspace(_ context.Context, id string) (workspaceapi.Workspace, error) {
	r.started++
	return workspaceapi.Workspace{ID: id, State: workspaceapi.WorkspaceRunning}, nil
}

func (r *snapshotLostWorkerRuntime) CreateColdSnapshot(_ context.Context, source string, spec workspaceapi.ColdSnapshotSpec) (workspaceapi.ColdSnapshot, error) {
	r.created++
	if r.fail == "create" {
		return workspaceapi.ColdSnapshot{}, r.lost
	}
	return workspaceapi.ColdSnapshot{ID: spec.ID, SourceWorkspaceID: source}, nil
}

func (r *snapshotLostWorkerRuntime) ForkColdSnapshot(_ context.Context, _ string, spec workspaceapi.WorkspaceSpec) (workspaceapi.Workspace, error) {
	r.forked++
	if r.fail == "fork" {
		return workspaceapi.Workspace{}, r.lost
	}
	return workspaceapi.Workspace{ID: spec.ID, State: workspaceapi.WorkspaceRunning}, nil
}

func (r *snapshotLostWorkerRuntime) DeleteColdSnapshot(context.Context, string) error {
	r.deleted++
	if r.fail == "delete" {
		return r.lost
	}
	return nil
}

func (r *snapshotLostWorkerRuntime) ListFiles(_ context.Context, _, path string) ([]workspaceapi.FileEntry, error) {
	if path == ".git" {
		return []workspaceapi.FileEntry{{Name: "smithers-workspace-initialization.json"}}, nil
	}
	return []workspaceapi.FileEntry{{Name: ".git", IsDir: true}, {Name: ".jj", IsDir: true}}, nil
}

func (*snapshotLostWorkerRuntime) ReadFile(_ context.Context, workspaceID, _ string) ([]byte, error) {
	receipt := workspaceRepositoryReceipt{Version: workspaceRepositoryReceiptVersion, WorkspaceID: workspaceID,
		RepositoryID: 101, CloneURL: testWorkspaceGitBaseURL + "/alice/demo.git", SourceBookmark: "main",
		SourceRevision: strings.Repeat("a", 40), InitializedAt: time.Now().UTC()}
	return json.Marshal(receipt)
}

func (*snapshotLostWorkerRuntime) ExecuteCommand(_ context.Context, _ string, command workspaceapi.Command) (workspaceapi.CommandResult, error) {
	if len(command.Args) >= 4 && command.Args[0] == "git" && command.Args[1] == "remote" {
		return workspaceapi.CommandResult{Stdout: testWorkspaceGitBaseURL + "/alice/demo.git\n"}, nil
	}
	return workspaceapi.CommandResult{}, nil
}

func (r *snapshotLostWorkerRuntime) OpenWorkspaceTerminal(context.Context, string, workspaceapi.Command) (workspaceapi.Terminal, error) {
	return r.terminal, nil
}

type lostWorkerRuntimeQuerier struct {
	*mockWorkspaceQuerier
	failedCodes []string
}

func (q *lostWorkerRuntimeQuerier) GetRepoOwnerSlugAndNameByID(context.Context, int64) (db.GetRepoOwnerSlugAndNameByIDRow, error) {
	return db.GetRepoOwnerSlugAndNameByIDRow{OwnerSlug: "alice", RepoName: "demo"}, nil
}

func (q *lostWorkerRuntimeQuerier) FailProvisioningWorkspaceIfCurrent(_ context.Context, arg db.FailProvisioningWorkspaceIfCurrentParams) (db.Workspace, error) {
	q.failedCodes = append(q.failedCodes, arg.FailureCode)
	return sampleDBWorkspace(arg.ID), nil
}

func TestRuntimeRestoreLostWorkerIsInfra(t *testing.T) {
	runtime := &snapshotLostWorkerRuntime{lost: lostWorkerRuntimeCause(), fail: "fork"}
	row := sampleDBWorkspace("ws-restore")
	row.Status = "starting"
	const snapshotID = "cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa"
	snapshot := sampleDBWorkspaceSnapshot(snapshotID, "ws-source", "checkpoint", "provider-snap")
	q := &lostWorkerRuntimeQuerier{mockWorkspaceQuerier: &mockWorkspaceQuerier{
		getWorkspaceSnapshotByRepoFn: func(context.Context, db.GetWorkspaceSnapshotByRepoParams) (db.WorkspaceSnapshot, error) {
			return snapshot, nil
		},
		createWorkspaceFn: func(context.Context, db.CreateWorkspaceParams) (db.Workspace, error) { return row, nil },
	}}
	service := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(runtime))
	_, err := service.CreateWorkspace(context.Background(), CreateWorkspaceInput{
		RepositoryID: 101, UserID: 1, RepoOwner: "alice", RepoName: "demo", Name: "restored", SnapshotID: snapshotID,
	})
	requireLostWorkerRuntimeFailure(t, err)
	require.Equal(t, 1, runtime.forked)
	require.Equal(t, []string{string(pkgerrors.CodeHostLeaseLost)}, q.failedCodes)
}

// No legacy runtime caller can reach the removed stop/snapshot/resume path,
// even if the provider would fail during snapshot creation or disk cloning.
func TestRuntimeForkRefusesBeforeSnapshotOrMutation(t *testing.T) {
	for _, phase := range []string{"create", "fork"} {
		t.Run(phase, func(t *testing.T) {
			source := sampleDBWorkspace("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
			q := &lostWorkerRuntimeQuerier{mockWorkspaceQuerier: &mockWorkspaceQuerier{
				getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) { return source, nil },
				getWorkspaceFn:       func(context.Context, string) (db.Workspace, error) { return source, nil },
				createWorkspaceFn: func(context.Context, db.CreateWorkspaceParams) (db.Workspace, error) {
					t.Fatal("refused fork created a workspace")
					return db.Workspace{}, nil
				},
			}}
			runtime := &snapshotLostWorkerRuntime{lost: lostWorkerRuntimeCause(), fail: phase}
			service := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(runtime))
			_, err := service.ForkWorkspace(context.Background(), ForkWorkspaceInput{RepositoryID: 101, UserID: 1, WorkspaceID: source.ID, Name: "branch"})
			var typed *pkgerrors.APIError
			require.ErrorAs(t, err, &typed)
			require.Equal(t, pkgerrors.CodeServiceUnavailable, typed.Code)
			require.Empty(t, q.failedCodes)
			require.Zero(t, runtime.created+runtime.forked+runtime.deleted)
		})
	}
}

func TestRuntimeCreateSnapshotLostWorkerIsInfra(t *testing.T) {
	row := sampleDBWorkspace("ws-snapshot")
	persisted := 0
	q := &lostWorkerRuntimeQuerier{mockWorkspaceQuerier: &mockWorkspaceQuerier{
		getWorkspaceFn: func(context.Context, string) (db.Workspace, error) { return row, nil },
		suspendRunningWorkspaceFn: func(context.Context, string) (db.Workspace, error) {
			suspended := row
			suspended.Status = "suspended"
			return suspended, nil
		},
		createWorkspaceSnapshotFn: func(context.Context, db.CreateWorkspaceSnapshotParams) (db.WorkspaceSnapshot, error) {
			persisted++
			return db.WorkspaceSnapshot{}, nil
		},
	}}
	runtime := &snapshotLostWorkerRuntime{lost: lostWorkerRuntimeCause(), fail: "create"}
	service := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(runtime))
	_, err := service.CreateWorkspaceSnapshot(context.Background(), CreateWorkspaceSnapshotInput{RepositoryID: 101, UserID: 1, WorkspaceID: row.ID, Name: "checkpoint"})
	requireLostWorkerRuntimeFailure(t, err)
	require.Equal(t, 1, runtime.created)
	require.Zero(t, persisted)
}

func TestRuntimeDeleteSnapshotLostWorkerRetainsRow(t *testing.T) {
	snapshot := sampleDBWorkspaceSnapshot("snap-delete", "ws-delete", "checkpoint", "provider-snap")
	deletedRows := 0
	q := &mockWorkspaceQuerier{
		getWorkspaceSnapshotByRepoFn: func(context.Context, db.GetWorkspaceSnapshotByRepoParams) (db.WorkspaceSnapshot, error) {
			return snapshot, nil
		},
		deleteWorkspaceSnapshotFn: func(context.Context, string) error { deletedRows++; return nil },
	}
	runtime := &snapshotLostWorkerRuntime{lost: lostWorkerRuntimeCause(), fail: "delete"}
	service := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(runtime))
	err := service.DeleteWorkspaceSnapshot(context.Background(), snapshot.ID, 101, 1)
	requireLostWorkerRuntimeFailure(t, err)
	require.Equal(t, 1, runtime.deleted)
	require.Zero(t, deletedRows)
}

type lostWorkerTerminal struct {
	err    error
	closed bool
}

func (*lostWorkerTerminal) Read([]byte) (int, error)                       { return 0, nil }
func (*lostWorkerTerminal) Write(p []byte) (int, error)                    { return len(p), nil }
func (t *lostWorkerTerminal) Close() error                                 { t.closed = true; return nil }
func (t *lostWorkerTerminal) Resize(context.Context, uint16, uint16) error { return t.err }

func TestRuntimeTerminalResizeLostWorkerClosesTerminal(t *testing.T) {
	row := sampleDBWorkspace("ws-terminal")
	q := &lostWorkerRuntimeQuerier{mockWorkspaceQuerier: &mockWorkspaceQuerier{
		getWorkspaceSessionByRepoFn: func(context.Context, db.GetWorkspaceSessionByRepoParams) (db.WorkspaceSession, error) {
			return db.WorkspaceSession{ID: "session-terminal", WorkspaceID: row.ID, RepositoryID: 101, UserID: 1, Status: "running"}, nil
		},
		getWorkspaceFn: func(context.Context, string) (db.Workspace, error) { return row, nil },
	}}
	terminal := &lostWorkerTerminal{err: lostWorkerRuntimeCause()}
	runtime := &snapshotLostWorkerRuntime{terminal: terminal}
	service := newWorkspaceServiceForTests(q, WithWorkspaceRuntime(runtime))
	_, err := service.OpenWorkspaceTerminal(context.Background(), "session-terminal", 101, 1, 80, 24)
	requireLostWorkerRuntimeFailure(t, err)
	require.True(t, terminal.closed)
}
