package services

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	sandbox "github.com/smithersai/smithers/packages/backend/sandbox"
)

type workspaceProvisioningCovMetrics struct {
	createStatuses           []string
	activeDeltas             []float64
	suspendSeconds           []float64
	sessionProvisionStatuses []string
}

func (m *workspaceProvisioningCovMetrics) ObserveSandboxVMCreate(vmType, status string, seconds float64) {
	m.createStatuses = append(m.createStatuses, vmType+":"+status)
}

func (m *workspaceProvisioningCovMetrics) AddSandboxActiveVMs(vmType string, delta float64) {
	m.activeDeltas = append(m.activeDeltas, delta)
}

func (m *workspaceProvisioningCovMetrics) ObserveSandboxVMSuspend(seconds float64) {
	m.suspendSeconds = append(m.suspendSeconds, seconds)
}

func (m *workspaceProvisioningCovMetrics) ObserveWorkspaceSessionProvision(status string, seconds float64) {
	m.sessionProvisionStatuses = append(m.sessionProvisionStatuses, status)
}

func TestWorkspaceProvisioning_Cov_CLIStagingBakeRequestAndCommands(t *testing.T) {
	t.Setenv(workspaceCodingHostBinaryEnv, filepath.Join(t.TempDir(), "missing-smithers"))
	files := map[string]sandbox.SandboxFile{}
	assert.False(t, addWorkspaceCodingHost(files))
	assert.NotContains(t, files, workspaceCodingHostB64Path)

	emptyCLI := filepath.Join(t.TempDir(), "empty-smithers")
	require.NoError(t, os.WriteFile(emptyCLI, nil, 0o755))
	t.Setenv(workspaceCodingHostBinaryEnv, emptyCLI)
	assert.False(t, addWorkspaceCodingHost(files))

	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{})
	req := svc.GoldenBakeVMRequest()
	assert.Empty(t, req.SnapshotID)
	assert.Contains(t, req.Packages, "git")
	require.NotNil(t, req.WaitForReady)
	assert.True(t, *req.WaitForReady)
	require.Contains(t, req.Files, workspaceClaudeScriptPath)

	assert.Equal(t, "''", shellQuote(""))
	assert.Equal(t, "'plain'", shellQuote("plain"))
	assert.Equal(t, "'can'\\''t'", shellQuote("can't"))

	switchCommand := buildForkBookmarkSwitchCommand(" token with space ", "feature/one")
	assert.Contains(t, switchCommand, "export GIT_CONFIG_VALUE_0='Authorization: Bearer token with space'")
	assert.Contains(t, switchCommand, shellQuote("feature/one@origin"))
	assert.NotContains(t, switchCommand, "git clone")
	// The credential must never ride git argv (visible in /proc/<pid>/cmdline).
	assert.NotContains(t, switchCommand, "-c http.extraHeader=")

	cloneCommand := buildWorkspaceCloneCommand("https://example.test/acme/repo.git", "tok", "", 0, workspaceCloneSource{})
	assert.Contains(t, cloneCommand, "export GIT_CONFIG_KEY_0=http.extraHeader")
	assert.Contains(t, cloneCommand, "git clone --depth 200 --branch 'main' -- ")
	assert.NotContains(t, cloneCommand, "-c http.extraHeader=")
	assert.Contains(t, cloneCommand, "jj git init --colocate")
	assert.Contains(t, cloneCommand, "jj -R '/home/developer/workspace' new 'main'")
}

func TestWorkspaceProvisioning_Cov_SnapshotListAndDeleteBranches(t *testing.T) {
	ctx := context.Background()

	svc := newWorkspaceServiceForTests(nil)
	_, _, err := svc.ListWorkspaceSnapshots(ctx, 101, 1, 1, 30)
	requireAPIErrorStatus(t, err, http.StatusInternalServerError)
	err = svc.DeleteWorkspaceSnapshot(ctx, "snap", 101, 1)
	requireAPIErrorStatus(t, err, http.StatusInternalServerError)

	q := &mockWorkspaceQuerier{
		listWorkspaceSnapshotsByRepoFn: func(ctx context.Context, arg db.ListWorkspaceSnapshotsByRepoParams) ([]db.WorkspaceSnapshot, error) {
			assert.Equal(t, int32(30), arg.PageSize)
			assert.Equal(t, int32(0), arg.PageOffset)
			return []db.WorkspaceSnapshot{sampleDBWorkspaceSnapshot("snap-1", "ws-1", "one", "fs-1")}, nil
		},
		countWorkspaceSnapshotsByRepoFn: func(ctx context.Context, arg db.CountWorkspaceSnapshotsByRepoParams) (int64, error) {
			return 1, nil
		},
	}
	svc = newWorkspaceServiceForTests(q)
	snapshots, total, err := svc.ListWorkspaceSnapshots(ctx, 101, 1, 0, 200)
	require.NoError(t, err)
	require.Len(t, snapshots, 1)
	assert.Equal(t, int64(1), total)

	q.listWorkspaceSnapshotsByRepoFn = func(ctx context.Context, arg db.ListWorkspaceSnapshotsByRepoParams) ([]db.WorkspaceSnapshot, error) {
		return nil, errors.New("list failed")
	}
	_, _, err = svc.ListWorkspaceSnapshots(ctx, 101, 1, 1, 30)
	requireAPIErrorStatus(t, err, http.StatusInternalServerError)

	q.listWorkspaceSnapshotsByRepoFn = func(ctx context.Context, arg db.ListWorkspaceSnapshotsByRepoParams) ([]db.WorkspaceSnapshot, error) {
		return []db.WorkspaceSnapshot{}, nil
	}
	q.countWorkspaceSnapshotsByRepoFn = func(ctx context.Context, arg db.CountWorkspaceSnapshotsByRepoParams) (int64, error) {
		return 0, errors.New("count failed")
	}
	_, _, err = svc.ListWorkspaceSnapshots(ctx, 101, 1, 1, 30)
	requireAPIErrorStatus(t, err, http.StatusInternalServerError)

	deleteCalled := false
	q = &mockWorkspaceQuerier{
		getWorkspaceSnapshotByRepoFn: func(ctx context.Context, arg db.GetWorkspaceSnapshotByRepoParams) (db.WorkspaceSnapshot, error) {
			return sampleDBWorkspaceSnapshot(arg.ID, "ws-source", "snapshot", "fs-snap-500"), nil
		},
		deleteWorkspaceSnapshotFn: func(ctx context.Context, id string) error {
			deleteCalled = true
			return nil
		},
	}
	svc = newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		deleteSnapshotFn: func(ctx context.Context, snapshotID string) error {
			return &sandbox.StatusError{StatusCode: 500, Message: "delete failed"}
		},
	}))
	err = svc.DeleteWorkspaceSnapshot(ctx, "snap-500", 101, 1)
	requireAPIErrorStatus(t, err, http.StatusInternalServerError)
	assert.False(t, deleteCalled)

	q.getWorkspaceSnapshotByRepoFn = func(ctx context.Context, arg db.GetWorkspaceSnapshotByRepoParams) (db.WorkspaceSnapshot, error) {
		snap := sampleDBWorkspaceSnapshot(arg.ID, "ws-source", "snapshot", "")
		snap.SnapshotID = ""
		return snap, nil
	}
	err = svc.DeleteWorkspaceSnapshot(ctx, "snap-local-only", 101, 1)
	require.NoError(t, err)
	assert.True(t, deleteCalled)
}

func TestWorkspaceProvisioning_Cov_FindCreateQuotaAndStaleBranches(t *testing.T) {
	ctx := context.Background()

	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		countActiveWorkspacesByUserFn: func(ctx context.Context, userID int64) (int64, error) {
			return 0, errors.New("count active failed")
		},
	})
	err := svc.enforceWorkspaceQuota(ctx, 1)
	requireAPIErrorStatus(t, err, http.StatusInternalServerError)

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		countActiveWorkspacesByUserFn: func(ctx context.Context, userID int64) (int64, error) {
			return MaxActiveWorkspacesPerUser, nil
		},
	})
	err = svc.enforceWorkspaceQuota(ctx, 1)
	requireAPIErrorStatus(t, err, http.StatusTooManyRequests)

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getActiveWorkspaceForIdentityFn: func(ctx context.Context, arg db.GetActiveWorkspaceForIdentityParams) (db.Workspace, error) {
			ws := sampleDBWorkspace("ws-active")
			ws.TargetBookmark = "feature/new"
			return ws, nil
		},
		updateWorkspaceTargetBookmarkFn: func(ctx context.Context, arg db.UpdateWorkspaceTargetBookmarkParams) (db.Workspace, error) {
			assert.Equal(t, "feature/new", arg.TargetBookmark)
			ws := sampleDBWorkspace(arg.ID)
			ws.TargetBookmark = arg.TargetBookmark
			return ws, nil
		},
	})
	ws, err := svc.findOrCreatePrimaryWorkspace(ctx, 101, 1, "primary", "feature/new", workspaceCreateMetadata{})
	require.NoError(t, err)
	assert.Equal(t, "feature/new", ws.TargetBookmark)

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getActiveWorkspaceForIdentityFn: func(ctx context.Context, arg db.GetActiveWorkspaceForIdentityParams) (db.Workspace, error) {
			return db.Workspace{}, errors.New("load active failed")
		},
	})
	_, err = svc.findOrCreatePrimaryWorkspace(ctx, 101, 1, "primary", "main", workspaceCreateMetadata{})
	requireAPIErrorStatus(t, err, http.StatusInternalServerError)

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		countActiveWorkspacesByUserFn: func(ctx context.Context, userID int64) (int64, error) {
			return 0, nil
		},
		createWorkspaceFn: func(ctx context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
			return db.Workspace{}, errors.New("create failed")
		},
	})
	_, err = svc.createPrimaryWorkspace(ctx, 101, 1, "primary", "main", workspaceCreateMetadata{})
	requireAPIErrorStatus(t, err, http.StatusInternalServerError)
	_, err = svc.createDerivedWorkspaceForBookmark(ctx, 101, 1, "branch", "feature", workspaceCreateMetadata{})
	requireAPIErrorStatus(t, err, http.StatusInternalServerError)

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		updateWorkspaceTargetBookmarkFn: func(ctx context.Context, arg db.UpdateWorkspaceTargetBookmarkParams) (db.Workspace, error) {
			return db.Workspace{}, errors.New("update target failed")
		},
	})
	ws = sampleDBWorkspace("ws-target")
	ws.TargetBookmark = "main"
	_, err = svc.ensureWorkspaceTargetBookmark(ctx, ws, "feature")
	requireAPIErrorStatus(t, err, http.StatusInternalServerError)
	got, err := svc.ensureWorkspaceTargetBookmark(ctx, ws, "main")
	require.NoError(t, err)
	assert.Equal(t, ws.ID, got.ID)

	now := time.Now()
	stale := sampleDBWorkspace("ws-stale")
	stale.Status = "starting"
	stale.VmID = ""
	stale.UpdatedAt = now.Add(-workspaceStaleAfter - time.Second)
	assert.True(t, svc.shouldReplaceZombieWorkspace(stale, now))
	stale.VmID = "vm-present"
	assert.False(t, svc.shouldReplaceZombieWorkspace(stale, now))
	stale.VmID = ""
	stale.Status = "running"
	assert.False(t, svc.shouldReplaceZombieWorkspace(stale, now))
	stale.Status = "pending"
	stale.UpdatedAt = time.Time{}
	stale.CreatedAt = time.Time{}
	assert.False(t, svc.shouldReplaceZombieWorkspace(stale, now))

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		countWorkspacesByRepoFn: func(ctx context.Context, arg db.CountWorkspacesByRepoParams) (int64, error) {
			return 0, nil
		},
	})
	require.NoError(t, svc.failStalePendingWorkspacesForRepoUser(ctx, 101, 1))

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		countWorkspacesByRepoFn: func(ctx context.Context, arg db.CountWorkspacesByRepoParams) (int64, error) {
			return 1, nil
		},
		listWorkspacesByRepoFn: func(ctx context.Context, arg db.ListWorkspacesByRepoParams) ([]db.Workspace, error) {
			return nil, errors.New("list failed")
		},
	})
	err = svc.failStalePendingWorkspacesForRepoUser(ctx, 101, 1)
	requireAPIErrorStatus(t, err, http.StatusInternalServerError)

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		updateWorkspaceStatusFn: func(ctx context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
			return db.Workspace{}, errors.New("status failed")
		},
	})
	_, err = svc.failWorkspace(ctx, sampleDBWorkspace("ws-fail"), errors.New("workspace provisioning timed out"))
	requireAPIErrorStatus(t, err, http.StatusInternalServerError)
}

func TestWorkspaceProvisioning_Cov_CreateWorkspaceAndAsyncBranches(t *testing.T) {
	ctx := context.Background()

	_, err := NewWorkspaceService(nil, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{})).CreateWorkspace(ctx, CreateWorkspaceInput{})
	requireAPIErrorStatus(t, err, http.StatusInternalServerError)
	_, err = newWorkspaceServiceForTests(&mockWorkspaceQuerier{}).CreateWorkspace(ctx, CreateWorkspaceInput{})
	requireAPIErrorStatus(t, err, http.StatusInternalServerError)
	_, err = NewWorkspaceService(nil, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{})).CreateWorkspaceAsync(ctx, CreateWorkspaceInput{})
	requireAPIErrorStatus(t, err, http.StatusInternalServerError)
	_, err = newWorkspaceServiceForTests(&mockWorkspaceQuerier{}).CreateWorkspaceAsync(ctx, CreateWorkspaceInput{})
	requireAPIErrorStatus(t, err, http.StatusInternalServerError)

	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getWorkspaceSnapshotByRepoFn: func(ctx context.Context, arg db.GetWorkspaceSnapshotByRepoParams) (db.WorkspaceSnapshot, error) {
			return sampleDBWorkspaceSnapshot(arg.ID, "ws-source", "snap", "fs-snap"), nil
		},
		createWorkspaceFn: func(ctx context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
			return db.Workspace{}, errors.New("insert failed")
		},
	}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))
	_, err = svc.CreateWorkspace(ctx, CreateWorkspaceInput{RepositoryID: 101, UserID: 1, SnapshotID: "snap-id"})
	requireAPIErrorStatus(t, err, http.StatusInternalServerError)

	createVMCalled := false
	running := sampleDBWorkspace("ws-running")
	running.Status = "running"
	running.VmID = "vm-running"
	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		getActiveWorkspaceForUserRepoFn: func(ctx context.Context, arg db.GetActiveWorkspaceForUserRepoParams) (db.Workspace, error) {
			return running, nil
		},
	}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			createVMCalled = true
			return sandbox.CreateResult{}, nil
		},
	}))
	resp, err := svc.CreateWorkspaceAsync(ctx, CreateWorkspaceInput{RepositoryID: 101, UserID: 1, Name: "running"})
	require.NoError(t, err)
	assert.Equal(t, "running", resp.Status)
	assert.False(t, createVMCalled)

	done := make(chan struct{})
	q := &mockWorkspaceQuerier{
		updateWorkspaceExecutionInfoFn: func(ctx context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
			defer close(done)
			ws := sampleDBWorkspace(arg.ID)
			ws.VmID = arg.VmID
			ws.Status = arg.Status
			return ws, nil
		},
	}
	svc = newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			assert.Equal(t, "fs-snap", req.SnapshotID)
			return sandbox.CreateResult{ID: "vm-snap"}, nil
		},
	}))
	svc.provisionSnapshotWorkspaceAsync(ctx, sampleDBWorkspace("ws-snap"), sampleDBWorkspaceSnapshot("snap", "ws-snap", "snap", "fs-snap"))
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for snapshot async provisioning")
	}

	var statuses []string
	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		updateWorkspaceStatusFn: func(ctx context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
			statuses = append(statuses, arg.Status)
			ws := sampleDBWorkspace(arg.ID)
			ws.Status = arg.Status
			return ws, nil
		},
	})
	func() {
		defer svc.recoverAsyncProvision(ctx, sampleDBWorkspace("ws-panic"), "cover")
		panic("boom")
	}()
	assert.Equal(t, []string{"failed"}, statuses)
}

func TestWorkspaceProvisioning_Cov_VMProvisioningBranches(t *testing.T) {
	ctx := context.Background()

	q := &mockWorkspaceQuerier{
		updateWorkspaceExecutionInfoFn: func(ctx context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
			ws := sampleDBWorkspace(arg.ID)
			ws.VmID = arg.VmID
			ws.Status = arg.Status
			return ws, nil
		},
	}
	metrics := &workspaceProvisioningCovMetrics{}
	svc := newWorkspaceServiceForTests(q,
		WithWorkspaceSandboxMetrics(metrics),
		WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
			createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
				return sandbox.CreateResult{ID: "vm-no-clone"}, nil
			},
			execAwaitFn: func(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
				t.Fatal("no clone command should run without repo owner/name")
				return sandbox.ExecResult{}, nil
			},
		}))
	ws, err := svc.createWorkspaceVM(ctx, sampleDBWorkspace("ws-no-clone"), CreateWorkspaceSessionInput{UserID: 1})
	require.NoError(t, err)
	assert.Equal(t, "vm-no-clone", ws.VmID)
	assert.Contains(t, metrics.createStatuses, "workspace:success")
	assert.Contains(t, metrics.activeDeltas, float64(1))

	var deleted []string
	var failed []string
	q = &mockWorkspaceQuerier{
		updateWorkspaceExecutionInfoFn: func(ctx context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
			return db.Workspace{}, errors.New("store failed")
		},
		updateWorkspaceStatusFn: func(ctx context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
			failed = append(failed, arg.Status)
			ws := sampleDBWorkspace(arg.ID)
			ws.Status = arg.Status
			return ws, nil
		},
	}
	svc = newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-leaked"}, nil
		},
		deleteVMFn: func(ctx context.Context, vmID string) error {
			deleted = append(deleted, vmID)
			return nil
		},
	}))
	_, err = svc.createWorkspaceVM(ctx, sampleDBWorkspace("ws-store-fail"), CreateWorkspaceSessionInput{UserID: 1})
	requireAPIErrorStatus(t, err, http.StatusInternalServerError)
	assert.Equal(t, []string{"vm-leaked"}, deleted)
	assert.Equal(t, []string{"failed"}, failed)

	err = svc.cloneWorkspaceRepository(ctx, "vm-1", "https://example.test/repo.git", " ", "", 0, workspaceCloneSource{})
	requireAPIErrorStatus(t, err, http.StatusInternalServerError)

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		execAwaitFn: func(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
			code := int32(127)
			return sandbox.ExecResult{StatusCode: &code, Stderr: strings.Repeat("x", 1100)}, nil
		},
	}))
	err = svc.cloneWorkspaceRepository(ctx, "vm-1", "https://example.test/repo.git", "tok", "", 0, workspaceCloneSource{})
	requireAPIErrorStatus(t, err, http.StatusInternalServerError)
	assert.Contains(t, err.Error(), "status 127")
	assert.LessOrEqual(t, len(err.Error()), 1100)

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		createAccessTokenFn: func(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
			return db.AccessToken{ID: 9}, nil
		},
		deleteAccessTokenFn: func(ctx context.Context, arg db.DeleteAccessTokenParams) error {
			return nil
		},
	}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		execAwaitFn: func(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
			code := int32(2)
			return sandbox.ExecResult{StatusCode: &code, Stdout: "stdout detail", Stderr: "stderr detail"}, nil
		},
	}))
	err = svc.switchForkedWorkspaceBookmark(ctx, "vm-fork", CreateWorkspaceSessionInput{UserID: 1, SourceBookmark: "feature"})
	requireAPIErrorStatus(t, err, http.StatusInternalServerError)
	assert.Contains(t, err.Error(), "stderr detail")
	assert.Contains(t, err.Error(), "stdout detail")
}

func TestWorkspaceProvisioning_Cov_ForkSnapshotAndActivationConflictBranches(t *testing.T) {
	ctx := context.Background()

	var touched []string
	q := &mockWorkspaceQuerier{
		updateWorkspaceExecutionInfoFn: func(ctx context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
			ws := sampleDBWorkspace(arg.ID)
			ws.VmID = arg.VmID
			ws.Status = arg.Status
			return ws, nil
		},
		touchWorkspaceActivityFn: func(ctx context.Context, id string) error {
			touched = append(touched, id)
			return nil
		},
	}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-empty-source"}, nil
		},
	}))
	fork := sampleDBWorkspace("ws-fork-empty")
	got, err := svc.forkWorkspaceVM(ctx, fork, db.Workspace{})
	require.NoError(t, err)
	assert.Equal(t, "vm-empty-source", got.VmID)
	assert.Equal(t, []string{fork.ID}, touched)

	var deleted []string
	var failed []string
	q = &mockWorkspaceQuerier{
		updateWorkspaceExecutionInfoFn: func(ctx context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
			return db.Workspace{}, &pgconn.PgError{Code: "23505", ConstraintName: "uq_workspaces_active"}
		},
		updateWorkspaceStatusFn: func(ctx context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
			failed = append(failed, arg.Status)
			ws := sampleDBWorkspace(arg.ID)
			ws.Status = arg.Status
			return ws, nil
		},
		getActiveWorkspaceForIdentityFn: func(ctx context.Context, arg db.GetActiveWorkspaceForIdentityParams) (db.Workspace, error) {
			return db.Workspace{}, errors.New("winner missing")
		},
	}
	svc = newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-snapshot"}, nil
		},
		deleteVMFn: func(ctx context.Context, vmID string) error {
			deleted = append(deleted, vmID)
			return nil
		},
	}))
	_, err = svc.createWorkspaceVMFromSnapshot(ctx, sampleDBWorkspace("ws-snapshot"), sampleDBWorkspaceSnapshot("snap", "ws-snapshot", "snap", "fs-snap"))
	requireAPIErrorStatus(t, err, http.StatusInternalServerError)
	assert.Equal(t, []string{"vm-snapshot"}, deleted)
	assert.Equal(t, []string{"failed"}, failed)

	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		updateWorkspaceStatusFn: func(ctx context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
			return db.Workspace{}, errors.New("fail failed")
		},
	})
	_, err = svc.reuseWinningWorkspaceAfterActivationConflict(ctx, sampleDBWorkspace("ws-conflict"))
	requireAPIErrorStatus(t, err, http.StatusInternalServerError)

	assert.False(t, isWorkspaceActiveUniqueViolation(nil))
	assert.False(t, isWorkspaceActiveUniqueViolation(&pgconn.PgError{Code: "23505", ConstraintName: "other"}))
	assert.True(t, isWorkspaceActiveUniqueViolation(errors.New(`duplicate key value violates unique constraint "uq_workspaces_active"`)))
	assert.True(t, isWorkspaceActiveUniqueViolation(errors.New("duplicate key on workspaces table")))

	assert.False(t, canProvisionWorkspace(CreateWorkspaceSessionInput{}))
	assert.True(t, canProvisionWorkspace(CreateWorkspaceSessionInput{UserID: 1, RepoOwner: "acme", RepoName: "repo"}))

	svc.deleteOrphanedWorkspaceVM(ctx, "")
	svc.markWorkspaceProvisionFailed(ctx, sampleDBWorkspace("ws-no-store"), errors.New("ignored"))
}
