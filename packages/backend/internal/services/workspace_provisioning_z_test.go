package services

import (
	"bytes"
	"context"
	stderrors "errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"text/template"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

type workspaceZRegistrarQuerier struct {
	*mockWorkspaceQuerier
	registerFn func(context.Context, db.RegisterWorkspaceVMParams) (db.Workspace, error)
}

func (q *workspaceZRegistrarQuerier) RegisterWorkspaceVM(ctx context.Context, arg db.RegisterWorkspaceVMParams) (db.Workspace, error) {
	if q.registerFn != nil {
		return q.registerFn(ctx, arg)
	}
	ws := sampleDBWorkspace(arg.ID)
	ws.VmID = arg.VmID
	ws.Status = arg.Status
	return ws, nil
}

type workspaceZFailGzip struct {
	writeErr error
	closeErr error
}

func (g workspaceZFailGzip) Write(p []byte) (int, error) {
	if g.writeErr != nil {
		return 0, g.writeErr
	}
	return len(p), nil
}

func (g workspaceZFailGzip) Close() error {
	return g.closeErr
}

type workspaceZNoExecSandbox struct {
	createVMFn        func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error)
	forkVMFn          func(context.Context, string, sandbox.ForkRequest) (sandbox.CreateResult, error)
	deleteVMFn        func(context.Context, string) error
	getVMFn           func(context.Context, string) (sandbox.Sandbox, error)
	startVMFn         func(context.Context, string, sandbox.StartRequest) (sandbox.StartResult, error)
	snapshotVMFn      func(context.Context, string, sandbox.SnapshotRequest) (sandbox.SnapshotResult, error)
	deleteSnapshotFn  func(context.Context, string) error
	createIdentityFn  func(context.Context) (sandbox.Identity, error)
	grantPermissionFn func(context.Context, string, string, sandbox.GrantAccessRequest) (sandbox.AccessGrant, error)
	createTokenFn     func(context.Context, string) (sandbox.CreatedToken, error)
}

func (s *workspaceZNoExecSandbox) CreateSandbox(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error) {
	if s.createVMFn != nil {
		return s.createVMFn(ctx, req)
	}
	return sandbox.CreateResult{ID: "vm-no-exec"}, nil
}

func (s *workspaceZNoExecSandbox) ForkSandbox(ctx context.Context, sourceVMID string, req sandbox.ForkRequest) (sandbox.CreateResult, error) {
	if s.forkVMFn != nil {
		return s.forkVMFn(ctx, sourceVMID, req)
	}
	return sandbox.CreateResult{ID: "vm-fork-no-exec"}, nil
}

func (s *workspaceZNoExecSandbox) CreateService(context.Context, string, sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
	return sandbox.CreateServiceResult{Success: true}, nil
}

func (s *workspaceZNoExecSandbox) InspectSandbox(ctx context.Context, vmID string) (sandbox.Sandbox, error) {
	if s.getVMFn != nil {
		return s.getVMFn(ctx, vmID)
	}
	return sandbox.Sandbox{ID: vmID, State: sandbox.StateRunning}, nil
}

func (s *workspaceZNoExecSandbox) DeleteSandbox(ctx context.Context, vmID string) error {
	if s.deleteVMFn != nil {
		return s.deleteVMFn(ctx, vmID)
	}
	return nil
}

func (s *workspaceZNoExecSandbox) StartSandbox(ctx context.Context, vmID string, req sandbox.StartRequest) (sandbox.StartResult, error) {
	if s.startVMFn != nil {
		return s.startVMFn(ctx, vmID, req)
	}
	return sandbox.StartResult{ID: vmID}, nil
}

func (s *workspaceZNoExecSandbox) SuspendSandbox(context.Context, string) (sandbox.SuspendResult, error) {
	return sandbox.SuspendResult{}, nil
}

func (s *workspaceZNoExecSandbox) SnapshotSandbox(ctx context.Context, vmID string, req sandbox.SnapshotRequest) (sandbox.SnapshotResult, error) {
	if s.snapshotVMFn != nil {
		return s.snapshotVMFn(ctx, vmID, req)
	}
	return sandbox.SnapshotResult{SnapshotID: "fs-snap", SourceSandboxID: vmID}, nil
}

func (s *workspaceZNoExecSandbox) DeleteSnapshot(ctx context.Context, snapshotID string) error {
	if s.deleteSnapshotFn != nil {
		return s.deleteSnapshotFn(ctx, snapshotID)
	}
	return nil
}

func (s *workspaceZNoExecSandbox) CreateIdentity(ctx context.Context) (sandbox.Identity, error) {
	if s.createIdentityFn != nil {
		return s.createIdentityFn(ctx)
	}
	return sandbox.Identity{ID: "identity"}, nil
}

func (s *workspaceZNoExecSandbox) GrantAccess(ctx context.Context, identityID, vmID string, req sandbox.GrantAccessRequest) (sandbox.AccessGrant, error) {
	if s.grantPermissionFn != nil {
		return s.grantPermissionFn(ctx, identityID, vmID, req)
	}
	return sandbox.AccessGrant{ID: "perm"}, nil
}

func (s *workspaceZNoExecSandbox) CreateIdentityToken(ctx context.Context, identityID string) (sandbox.CreatedToken, error) {
	if s.createTokenFn != nil {
		return s.createTokenFn(ctx, identityID)
	}
	return sandbox.CreatedToken{ID: "token", Token: "plain"}, nil
}

func workspaceZRunningQuery(workspace db.Workspace) *mockWorkspaceQuerier {
	return &mockWorkspaceQuerier{
		getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) {
			return workspace, nil
		},
		getWorkspaceSnapshotByRepoFn: func(_ context.Context, arg db.GetWorkspaceSnapshotByRepoParams) (db.WorkspaceSnapshot, error) {
			return sampleDBWorkspaceSnapshot(arg.ID, workspace.ID, "snap", "fs-snap"), nil
		},
		updateWorkspaceExecutionInfoFn: func(_ context.Context, arg db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
			ws := workspace
			ws.ID = arg.ID
			ws.VmID = arg.VmID
			ws.Status = arg.Status
			return ws, nil
		},
	}
}

func TestWorkspaceProvisioning_Z_BootstrapAndCLIErrorBranches(t *testing.T) {
	oldTemplate := bootstrapTmpl
	bootstrapTmpl = template.Must(template.New("bad").Parse(`{{template "missing" .}}`))
	require.Panics(t, func() { _ = buildWorkspaceClaudeBootstrapScript() })
	bootstrapTmpl = oldTemplate

	cliPath := filepath.Join(t.TempDir(), "smithers")
	require.NoError(t, os.WriteFile(cliPath, []byte("payload"), 0o755))
	t.Setenv(workspaceCodingHostBinaryEnv, cliPath)
	oldGzip := newWorkspaceGzipWriter
	defer func() { newWorkspaceGzipWriter = oldGzip }()

	newWorkspaceGzipWriter = func(io.Writer) workspaceGzipWriteCloser {
		return workspaceZFailGzip{writeErr: stderrors.New("write failed")}
	}
	assert.False(t, addWorkspaceCodingHost(map[string]sandbox.SandboxFile{}))

	newWorkspaceGzipWriter = func(io.Writer) workspaceGzipWriteCloser {
		return workspaceZFailGzip{closeErr: stderrors.New("close failed")}
	}
	assert.False(t, addWorkspaceCodingHost(map[string]sandbox.SandboxFile{}))

	// A 5xx is a tier fault, never a snapshot fault, however snapshot-flavored
	// the prose is.
	assert.False(t, goldenSnapshotCreateErrorIsSnapshotSpecific(&sandbox.StatusError{StatusCode: 500, Message: "snapshot missing"}, "snap-1"))
	// No snapshot in the request means nothing can implicate one.
	assert.False(t, goldenSnapshotCreateErrorIsSnapshotSpecific(&sandbox.StatusError{StatusCode: 404, Message: "image missing"}, ""))
	assert.True(t, goldenSnapshotCreateErrorIsSnapshotSpecific(&sandbox.StatusError{StatusCode: 400, ErrorCode: "snapshot_invalid"}, "snap-1"))

	var compressed bytes.Buffer
	newWorkspaceGzipWriter = oldGzip
	require.True(t, addWorkspaceCodingHost(map[string]sandbox.SandboxFile{"/tmp/probe": {Content: compressed.String()}}))
}

func TestWorkspaceProvisioning_Z_CreateAsyncForkAndSnapshotBranches(t *testing.T) {
	ctx := context.Background()
	workspace := sampleDBWorkspace("ws-z")
	workspace.UserID = 1
	workspace.RepositoryID = 101

	quotaQ := &mockWorkspaceQuerier{countActiveWorkspacesByUserFn: func(context.Context, int64) (int64, error) {
		return MaxActiveWorkspacesPerUser, nil
	}}
	_, err := newWorkspaceServiceForTests(quotaQ, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{})).
		CreateWorkspace(ctx, CreateWorkspaceInput{RepositoryID: 101, UserID: 1, SnapshotID: "snap"})
	assert.Equal(t, http.StatusTooManyRequests, apiStatus(t, err))

	q := workspaceZRunningQuery(workspace)
	q.createWorkspaceFn = func(context.Context, db.CreateWorkspaceParams) (db.Workspace, error) { return workspace, nil }
	_, err = newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-snap-error"}, stderrors.New("create failed")
		},
	})).CreateWorkspace(ctx, CreateWorkspaceInput{RepositoryID: 101, UserID: 1, SnapshotID: "snap"})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	q = &mockWorkspaceQuerier{countWorkspacesByRepoFn: func(context.Context, db.CountWorkspacesByRepoParams) (int64, error) {
		return 0, stderrors.New("count failed")
	}}
	_, err = newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{})).
		CreateWorkspaceAsync(ctx, CreateWorkspaceInput{RepositoryID: 101, UserID: 1})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	_, err = newWorkspaceServiceForTests(quotaQ, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{})).
		CreateWorkspaceAsync(ctx, CreateWorkspaceInput{RepositoryID: 101, UserID: 1, SnapshotID: "snap"})
	assert.Equal(t, http.StatusTooManyRequests, apiStatus(t, err))

	q = &mockWorkspaceQuerier{getWorkspaceSnapshotByRepoFn: func(context.Context, db.GetWorkspaceSnapshotByRepoParams) (db.WorkspaceSnapshot, error) {
		return db.WorkspaceSnapshot{}, pgx.ErrNoRows
	}}
	_, err = newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{})).
		CreateWorkspaceAsync(ctx, CreateWorkspaceInput{RepositoryID: 101, UserID: 1, SnapshotID: "snap"})
	assert.Equal(t, http.StatusNotFound, apiStatus(t, err))

	q = &mockWorkspaceQuerier{
		getWorkspaceSnapshotByRepoFn: func(context.Context, db.GetWorkspaceSnapshotByRepoParams) (db.WorkspaceSnapshot, error) {
			return sampleDBWorkspaceSnapshot("snap", workspace.ID, "snap", "fs-snap"), nil
		},
		createWorkspaceFn: func(context.Context, db.CreateWorkspaceParams) (db.Workspace, error) {
			return db.Workspace{}, stderrors.New("insert failed")
		},
	}
	_, err = newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{})).
		CreateWorkspaceAsync(ctx, CreateWorkspaceInput{RepositoryID: 101, UserID: 1, SnapshotID: "snap"})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	done := make(chan struct{})
	q = workspaceZRunningQuery(workspace)
	q.createWorkspaceFn = func(context.Context, db.CreateWorkspaceParams) (db.Workspace, error) { return workspace, nil }
	q.updateWorkspaceExecutionInfoFn = func(context.Context, db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
		defer close(done)
		running := workspace
		running.Status = "running"
		running.VmID = "vm-snap-async"
		return running, nil
	}
	resp, err := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-snap-async"}, nil
		},
	})).CreateWorkspaceAsync(ctx, CreateWorkspaceInput{RepositoryID: 101, UserID: 1, SnapshotID: "snap"})
	require.NoError(t, err)
	assert.Equal(t, workspace.ID, resp.ID)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for async snapshot provisioning")
	}

	_, err = NewWorkspaceService(nil).ForkWorkspace(ctx, ForkWorkspaceInput{})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
	_, err = newWorkspaceServiceForTests(&mockWorkspaceQuerier{}).ForkWorkspace(ctx, ForkWorkspaceInput{})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
	_, err = newWorkspaceServiceForTests(quotaQ, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{})).
		ForkWorkspace(ctx, ForkWorkspaceInput{RepositoryID: 101, UserID: 1, WorkspaceID: workspace.ID})
	assert.Equal(t, http.StatusTooManyRequests, apiStatus(t, err))

	q = &mockWorkspaceQuerier{getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) {
		return db.Workspace{}, pgx.ErrNoRows
	}}
	_, err = newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{})).
		ForkWorkspace(ctx, ForkWorkspaceInput{RepositoryID: 101, UserID: 1, WorkspaceID: "missing"})
	assert.Equal(t, http.StatusNotFound, apiStatus(t, err))

	_, err = newWorkspaceServiceForTests(workspaceZRunningQuery(workspace), WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{}, stderrors.New("get failed")
		},
	})).ForkWorkspace(ctx, ForkWorkspaceInput{RepositoryID: 101, UserID: 1, WorkspaceID: workspace.ID})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	q = workspaceZRunningQuery(workspace)
	q.createWorkspaceFn = func(context.Context, db.CreateWorkspaceParams) (db.Workspace, error) {
		return db.Workspace{}, stderrors.New("insert failed")
	}
	_, err = newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{})).
		ForkWorkspace(ctx, ForkWorkspaceInput{RepositoryID: 101, UserID: 1, WorkspaceID: workspace.ID})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	// A failed fork must NOT fail the request. Forking is an optimization, not
	// the session's whole job (see workspaceForkTimeout): forkWorkspaceVM reaps
	// the partial child and binds a freshly provisioned sandbox to the fork
	// workspace instead. This assertion previously demanded a 500 and had gone
	// stale against that deliberate fallback, reddening the package.
	q = workspaceZRunningQuery(workspace)
	q.createWorkspaceFn = func(context.Context, db.CreateWorkspaceParams) (db.Workspace, error) {
		return sampleDBWorkspace("ws-fork-created"), nil
	}
	deletedForkVMs := make(chan string, 1)
	forked, err := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		forkVMFn: func(context.Context, string, sandbox.ForkRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-fork-fail"}, stderrors.New("fork failed")
		},
		createVMFn: func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-fork-fallback"}, nil
		},
		deleteVMFn: func(_ context.Context, vmID string) error {
			select {
			case deletedForkVMs <- vmID:
			default:
			}
			return nil
		},
	})).ForkWorkspace(ctx, ForkWorkspaceInput{RepositoryID: 101, UserID: 1, WorkspaceID: workspace.ID})
	require.NoError(t, err, "a failed fork must fall back to a fresh sandbox, not fail the session")
	assert.Equal(t, "vm-fork-fallback", forked.VMID, "the fork workspace must be bound to the fallback VM")
	select {
	case orphan := <-deletedForkVMs:
		assert.Equal(t, "vm-fork-fail", orphan, "the ambiguous partial fork child must be reaped")
	default:
		t.Fatal("the partial fork child was never reaped")
	}
}

func TestWorkspaceProvisioning_Z_SnapshotAndDeleteBranches(t *testing.T) {
	ctx := context.Background()
	workspace := sampleDBWorkspace("ws-snap-source")

	_, err := NewWorkspaceService(nil).CreateWorkspaceSnapshot(ctx, CreateWorkspaceSnapshotInput{})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
	_, err = newWorkspaceServiceForTests(&mockWorkspaceQuerier{}).CreateWorkspaceSnapshot(ctx, CreateWorkspaceSnapshotInput{})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	q := &mockWorkspaceQuerier{getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) {
		return db.Workspace{}, pgx.ErrNoRows
	}}
	_, err = newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{})).
		CreateWorkspaceSnapshot(ctx, CreateWorkspaceSnapshotInput{WorkspaceID: "missing", RepositoryID: 101, UserID: 1})
	assert.Equal(t, http.StatusNotFound, apiStatus(t, err))

	noVM := workspace
	noVM.VmID = ""
	q = workspaceZRunningQuery(noVM)
	_, err = newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{})).
		CreateWorkspaceSnapshot(ctx, CreateWorkspaceSnapshotInput{WorkspaceID: noVM.ID, RepositoryID: 101, UserID: 1})
	assert.Equal(t, http.StatusConflict, apiStatus(t, err))

	q = workspaceZRunningQuery(workspace)
	_, err = newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		snapshotVMFn: func(context.Context, string, sandbox.SnapshotRequest) (sandbox.SnapshotResult, error) {
			return sandbox.SnapshotResult{}, stderrors.New("snapshot failed")
		},
	})).CreateWorkspaceSnapshot(ctx, CreateWorkspaceSnapshotInput{WorkspaceID: workspace.ID, RepositoryID: 101, UserID: 1})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	deleted := ""
	q = workspaceZRunningQuery(workspace)
	_, err = newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		snapshotVMFn: func(context.Context, string, sandbox.SnapshotRequest) (sandbox.SnapshotResult, error) {
			return sandbox.SnapshotResult{SnapshotID: "fs-bad-name"}, nil
		},
		deleteSnapshotFn: func(context.Context, string) error {
			deleted = "fs-bad-name"
			return nil
		},
	})).CreateWorkspaceSnapshot(ctx, CreateWorkspaceSnapshotInput{WorkspaceID: workspace.ID, RepositoryID: 101, UserID: 1, Name: "bad\x00name"})
	assert.Equal(t, http.StatusUnprocessableEntity, apiStatus(t, err))
	assert.Empty(t, deleted, "validation happens before DB persist cleanup path")

	q = workspaceZRunningQuery(workspace)
	q.createWorkspaceSnapshotFn = func(context.Context, db.CreateWorkspaceSnapshotParams) (db.WorkspaceSnapshot, error) {
		return db.WorkspaceSnapshot{}, stderrors.New("persist failed")
	}
	_, err = newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		snapshotVMFn: func(context.Context, string, sandbox.SnapshotRequest) (sandbox.SnapshotResult, error) {
			return sandbox.SnapshotResult{SnapshotID: "fs-cleanup"}, nil
		},
		deleteSnapshotFn: func(context.Context, string) error {
			deleted = "fs-cleanup"
			return nil
		},
	})).CreateWorkspaceSnapshot(ctx, CreateWorkspaceSnapshotInput{WorkspaceID: workspace.ID, RepositoryID: 101, UserID: 1, Name: "ok"})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
	assert.Equal(t, "fs-cleanup", deleted)

	_, err = NewWorkspaceService(nil).GetWorkspaceSnapshot(ctx, "snap", 101, 1)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	q = &mockWorkspaceQuerier{getWorkspaceSnapshotByRepoFn: func(context.Context, db.GetWorkspaceSnapshotByRepoParams) (db.WorkspaceSnapshot, error) {
		return db.WorkspaceSnapshot{}, pgx.ErrNoRows
	}}
	err = newWorkspaceServiceForTests(q).DeleteWorkspaceSnapshot(ctx, "missing", 101, 1)
	assert.Equal(t, http.StatusNotFound, apiStatus(t, err))

	q = &mockWorkspaceQuerier{
		getWorkspaceSnapshotByRepoFn: func(_ context.Context, arg db.GetWorkspaceSnapshotByRepoParams) (db.WorkspaceSnapshot, error) {
			return sampleDBWorkspaceSnapshot(arg.ID, workspace.ID, "snap", "fs-gone"), nil
		},
		deleteWorkspaceSnapshotFn: func(context.Context, string) error { return stderrors.New("delete row failed") },
	}
	err = newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		deleteSnapshotFn: func(context.Context, string) error {
			return &sandbox.StatusError{StatusCode: 404, Message: "not found"}
		},
	})).DeleteWorkspaceSnapshot(ctx, "snap", 101, 1)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
}

func TestWorkspaceProvisioning_Z_FindCreateAndRegistrationBranches(t *testing.T) {
	ctx := context.Background()

	q := &mockWorkspaceQuerier{countWorkspacesByRepoFn: func(context.Context, db.CountWorkspacesByRepoParams) (int64, error) {
		return 0, stderrors.New("count failed")
	}}
	_, err := newWorkspaceServiceForTests(q).findOrCreatePrimaryWorkspace(ctx, 101, 1, "primary", "main", workspaceCreateMetadata{})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	stale := sampleDBWorkspace("ws-stale-primary")
	stale.Status = "starting"
	stale.VmID = ""
	stale.UpdatedAt = time.Now().Add(-workspaceStaleAfter - time.Second)
	q = &mockWorkspaceQuerier{
		countWorkspacesByRepoFn: func(context.Context, db.CountWorkspacesByRepoParams) (int64, error) { return 1, nil },
		listWorkspacesByRepoFn: func(context.Context, db.ListWorkspacesByRepoParams) ([]db.Workspace, error) {
			return []db.Workspace{stale}, nil
		},
		getActiveWorkspaceForIdentityFn: func(context.Context, db.GetActiveWorkspaceForIdentityParams) (db.Workspace, error) {
			return stale, nil
		},
		updateWorkspaceStatusFn: func(context.Context, db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
			return db.Workspace{}, stderrors.New("fail stale")
		},
	}
	_, err = newWorkspaceServiceForTests(q).findOrCreatePrimaryWorkspace(ctx, 101, 1, "primary", "main", workspaceCreateMetadata{})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	existing := sampleDBWorkspace("ws-existing")
	existing.TargetBookmark = "main"
	q = &mockWorkspaceQuerier{
		countWorkspacesByRepoFn: func(context.Context, db.CountWorkspacesByRepoParams) (int64, error) { return 0, nil },
		getActiveWorkspaceForIdentityFn: func(context.Context, db.GetActiveWorkspaceForIdentityParams) (db.Workspace, error) {
			return existing, nil
		},
		updateWorkspaceTargetBookmarkFn: func(context.Context, db.UpdateWorkspaceTargetBookmarkParams) (db.Workspace, error) {
			return db.Workspace{}, stderrors.New("target failed")
		},
	}
	_, err = newWorkspaceServiceForTests(q).ensureWorkspaceTargetBookmark(ctx, existing, "feature")
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	stale.Name = "replacement"
	q = &mockWorkspaceQuerier{
		countWorkspacesByRepoFn: func(context.Context, db.CountWorkspacesByRepoParams) (int64, error) { return 0, nil },
		getActiveWorkspaceForIdentityFn: func(context.Context, db.GetActiveWorkspaceForIdentityParams) (db.Workspace, error) {
			return stale, nil
		},
		updateWorkspaceStatusFn: func(_ context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
			failed := stale
			failed.Status = arg.Status
			return failed, nil
		},
		createWorkspaceFn: func(_ context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
			created := sampleDBWorkspace("ws-replacement")
			created.Name = arg.Name
			created.TargetBookmark = arg.TargetBookmark
			created.VmID = ""
			created.Status = arg.Status
			return created, nil
		},
	}
	replaced, err := newWorkspaceServiceForTests(q).findOrCreatePrimaryWorkspace(ctx, 101, 1, "replacement", "main", workspaceCreateMetadata{})
	require.NoError(t, err)
	assert.Equal(t, "ws-replacement", replaced.ID)

	q = &mockWorkspaceQuerier{
		countWorkspacesByRepoFn: func(context.Context, db.CountWorkspacesByRepoParams) (int64, error) { return 0, nil },
		getActiveWorkspaceForIdentityFn: func(context.Context, db.GetActiveWorkspaceForIdentityParams) (db.Workspace, error) {
			return stale, nil
		},
		updateWorkspaceStatusFn: func(context.Context, db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
			return db.Workspace{}, stderrors.New("fail active stale")
		},
	}
	_, err = newWorkspaceServiceForTests(q).findOrCreatePrimaryWorkspace(ctx, 101, 1, "replacement", "main", workspaceCreateMetadata{})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	_, err = newWorkspaceServiceForTests(&mockWorkspaceQuerier{countWorkspacesByRepoFn: func(context.Context, db.CountWorkspacesByRepoParams) (int64, error) {
		return 0, stderrors.New("count failed")
	}}).findOrCreateDerivedWorkspaceForBookmark(ctx, 101, 1, "branch", "feature", workspaceCreateMetadata{})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	_, err = newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		countWorkspacesByRepoFn: func(context.Context, db.CountWorkspacesByRepoParams) (int64, error) { return 0, nil },
		listWorkspacesByRepoFn: func(context.Context, db.ListWorkspacesByRepoParams) ([]db.Workspace, error) {
			return nil, stderrors.New("list failed")
		},
	}).findOrCreateDerivedWorkspaceForBookmark(ctx, 101, 1, "branch", "feature", workspaceCreateMetadata{})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	staleFork := stale
	staleFork.ID = "ws-stale-fork"
	staleFork.IsFork = true
	staleFork.TargetBookmark = "feature"
	staleFork.Name = "branch"
	q = &mockWorkspaceQuerier{
		countWorkspacesByRepoFn: func(context.Context, db.CountWorkspacesByRepoParams) (int64, error) { return 1, nil },
		listWorkspacesByRepoFn: func(context.Context, db.ListWorkspacesByRepoParams) ([]db.Workspace, error) {
			return []db.Workspace{staleFork}, nil
		},
		updateWorkspaceStatusFn: func(context.Context, db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
			return db.Workspace{}, stderrors.New("fail stale fork")
		},
	}
	_, err = newWorkspaceServiceForTests(q).findOrCreateDerivedWorkspaceForBookmark(ctx, 101, 1, "branch", "feature", workspaceCreateMetadata{})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	q = &mockWorkspaceQuerier{
		countWorkspacesByRepoFn: func(context.Context, db.CountWorkspacesByRepoParams) (int64, error) { return 0, nil },
		listWorkspacesByRepoFn: func(context.Context, db.ListWorkspacesByRepoParams) ([]db.Workspace, error) {
			return []db.Workspace{staleFork}, nil
		},
		updateWorkspaceStatusFn: func(_ context.Context, arg db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
			failed := staleFork
			failed.Status = arg.Status
			return failed, nil
		},
		createWorkspaceFn: func(_ context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
			created := sampleDBWorkspace("ws-derived-replacement")
			created.IsFork = arg.IsFork
			created.TargetBookmark = arg.TargetBookmark
			created.VmID = ""
			created.Status = arg.Status
			return created, nil
		},
	}
	derived, err := newWorkspaceServiceForTests(q).findOrCreateDerivedWorkspaceForBookmark(ctx, 101, 1, "branch", "feature", workspaceCreateMetadata{})
	require.NoError(t, err)
	assert.Equal(t, "ws-derived-replacement", derived.ID)

	_, err = newWorkspaceServiceForTests(&mockWorkspaceQuerier{countActiveWorkspacesByUserFn: func(context.Context, int64) (int64, error) {
		return MaxActiveWorkspacesPerUser, nil
	}}).createDerivedWorkspaceForBookmark(ctx, 101, 1, "branch", "feature", workspaceCreateMetadata{})
	assert.Equal(t, http.StatusTooManyRequests, apiStatus(t, err))

	err = newWorkspaceServiceForTests(&mockWorkspaceQuerier{countWorkspacesByRepoFn: func(context.Context, db.CountWorkspacesByRepoParams) (int64, error) {
		return 0, stderrors.New("count failed")
	}}).failStalePendingWorkspacesForRepoUser(ctx, 101, 1)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	registrarSuccess := &workspaceZRegistrarQuerier{mockWorkspaceQuerier: &mockWorkspaceQuerier{}}
	updated, won, err := newWorkspaceServiceForTests(registrarSuccess).registerNewWorkspaceVM(ctx, sampleDBWorkspace("ws-reg"), "vm-reg", "running")
	require.NoError(t, err)
	assert.False(t, won)
	assert.Equal(t, "vm-reg", updated.VmID)

	registrarErr := &workspaceZRegistrarQuerier{mockWorkspaceQuerier: &mockWorkspaceQuerier{}, registerFn: func(context.Context, db.RegisterWorkspaceVMParams) (db.Workspace, error) {
		return db.Workspace{}, stderrors.New("register failed")
	}}
	_, won, err = newWorkspaceServiceForTests(registrarErr).registerNewWorkspaceVM(ctx, sampleDBWorkspace("ws-reg"), "vm-reg", "running")
	require.Error(t, err)
	assert.False(t, won)

	registrarErr.registerFn = func(context.Context, db.RegisterWorkspaceVMParams) (db.Workspace, error) {
		return db.Workspace{}, pgx.ErrNoRows
	}
	registrarErr.mockWorkspaceQuerier.getWorkspaceFn = func(context.Context, string) (db.Workspace, error) {
		return db.Workspace{}, stderrors.New("load winner failed")
	}
	_, won, err = newWorkspaceServiceForTests(registrarErr, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{})).
		registerNewWorkspaceVM(ctx, sampleDBWorkspace("ws-reg"), "vm-reg", "running")
	require.Error(t, err)
	assert.True(t, won)

	registrarErr.mockWorkspaceQuerier.getWorkspaceFn = func(context.Context, string) (db.Workspace, error) {
		ws := sampleDBWorkspace("ws-reg")
		ws.VmID = "vm-winner"
		return ws, nil
	}
	updated, won, err = newWorkspaceServiceForTests(registrarErr, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{})).
		registerNewWorkspaceVM(ctx, sampleDBWorkspace("ws-reg"), "vm-reg", "running")
	require.NoError(t, err)
	assert.True(t, won)
	assert.Equal(t, "vm-winner", updated.VmID)

	registrarErr.mockWorkspaceQuerier.getWorkspaceFn = func(context.Context, string) (db.Workspace, error) {
		ws := sampleDBWorkspace("ws-reg")
		ws.VmID = ""
		return ws, nil
	}
	_, won, err = newWorkspaceServiceForTests(registrarErr, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{})).
		registerNewWorkspaceVM(ctx, sampleDBWorkspace("ws-reg"), "vm-reg", "running")
	require.Error(t, err)
	assert.True(t, won)

	newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		deleteVMFn: func(context.Context, string) error { return stderrors.New("delete failed") },
	})).deleteOrphanedWorkspaceVM(ctx, "vm-delete-fails")
	NewWorkspaceService(nil).markWorkspaceProvisionFailed(ctx, sampleDBWorkspace("ws-no-q"), stderrors.New("cause"))
}

func TestWorkspaceProvisioning_Z_CreateWorkspaceVMBranches(t *testing.T) {
	ctx := context.Background()
	workspace := sampleDBWorkspace("ws-create-z")
	workspace.VmID = ""

	q := &mockWorkspaceQuerier{createAccessTokenFn: func(context.Context, db.CreateAccessTokenParams) (db.AccessToken, error) {
		return db.AccessToken{}, stderrors.New("token failed")
	}}
	_, err := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{})).
		createWorkspaceVM(ctx, workspace, CreateWorkspaceSessionInput{UserID: 1, RepoOwner: "acme", RepoName: "repo"})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	q = &mockWorkspaceQuerier{}
	_, err = NewWorkspaceService(q, WithWorkspaceGitBaseURL("://bad"), WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{})).
		createWorkspaceVM(ctx, workspace, CreateWorkspaceSessionInput{UserID: 1, RepoOwner: "acme", RepoName: "repo"})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	metrics := &workspaceProvisioningCovMetrics{}
	q = &mockWorkspaceQuerier{updateWorkspaceStatusFn: func(context.Context, db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
		return sampleDBWorkspace("ws-create-z"), nil
	}}
	_, err = newWorkspaceServiceForTests(q, WithWorkspaceSandboxMetrics(metrics), WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-create-error"}, stderrors.New("create failed")
		},
	})).createWorkspaceVM(ctx, workspace, CreateWorkspaceSessionInput{UserID: 1})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
	assert.Contains(t, metrics.createStatuses, "workspace:error")

	registrarWinner := &workspaceZRegistrarQuerier{
		mockWorkspaceQuerier: &mockWorkspaceQuerier{getWorkspaceFn: func(context.Context, string) (db.Workspace, error) {
			winner := sampleDBWorkspace("ws-create-z")
			winner.VmID = "vm-winner"
			return winner, nil
		}},
		registerFn: func(context.Context, db.RegisterWorkspaceVMParams) (db.Workspace, error) {
			return db.Workspace{}, pgx.ErrNoRows
		},
	}
	got, err := newWorkspaceServiceForTests(registrarWinner, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{ID: "vm-lost"}, nil
		},
	})).createWorkspaceVM(ctx, workspace, CreateWorkspaceSessionInput{UserID: 1})
	require.NoError(t, err)
	assert.Equal(t, "vm-winner", got.VmID)

	for _, tc := range []struct {
		name string
		err  error
	}{
		{name: "active conflict", err: &pgconn.PgError{Code: "23505", ConstraintName: "uq_workspaces_active"}},
		{name: "generic", err: stderrors.New("final store failed")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			q := &mockWorkspaceQuerier{
				updateWorkspaceExecutionInfoFn: func(context.Context, db.UpdateWorkspaceExecutionInfoParams) (db.Workspace, error) {
					calls++
					if calls == 1 {
						starting := workspace
						starting.VmID = "vm-final"
						starting.Status = "starting"
						return starting, nil
					}
					return db.Workspace{}, tc.err
				},
				updateWorkspaceStatusFn: func(context.Context, db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
					failed := workspace
					failed.Status = "failed"
					return failed, nil
				},
				getActiveWorkspaceForIdentityFn: func(context.Context, db.GetActiveWorkspaceForIdentityParams) (db.Workspace, error) {
					winner := workspace
					winner.ID = "ws-winner"
					winner.VmID = "vm-winner"
					return winner, nil
				},
			}
			got, err := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
				createVMFn: func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
					return sandbox.CreateResult{ID: "vm-final"}, nil
				},
			})).createWorkspaceVM(ctx, workspace, CreateWorkspaceSessionInput{UserID: 1})
			if tc.name == "active conflict" {
				require.NoError(t, err)
				assert.Equal(t, "ws-winner", got.ID)
			} else {
				assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
			}
		})
	}

	done := make(chan struct{})
	q = &mockWorkspaceQuerier{}
	svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
			defer close(done)
			return sandbox.Sandbox{}, stderrors.New("get failed")
		},
	}))
	pending := workspace
	pending.VmID = "vm-existing"
	pending.Status = "starting"
	svc.provisionWorkspaceAsync(ctx, pending, CreateWorkspaceSessionInput{})
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for async provision error")
	}

	done = make(chan struct{})
	svc = newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		createVMFn: func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
			defer close(done)
			return sandbox.CreateResult{ID: "vm-snap-error"}, stderrors.New("create failed")
		},
	}))
	svc.provisionSnapshotWorkspaceAsync(ctx, workspace, sampleDBWorkspaceSnapshot("snap", workspace.ID, "snap", "fs-snap"))
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for async snapshot error")
	}
}

func TestWorkspaceProvisioning_Z_ForkFastPathAndCloneBranches(t *testing.T) {
	ctx := context.Background()
	workspace := sampleDBWorkspace("ws-derived")
	workspace.IsFork = true
	workspace.VmID = ""
	workspace.TargetBookmark = "feature"

	svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{}))
	got, ok := svc.tryForkDerivedFromPrimary(ctx, sampleDBWorkspace("ws-primary"), CreateWorkspaceSessionInput{SourceBookmark: "feature", RepoOwner: "acme", RepoName: "repo"})
	assert.False(t, ok)
	assert.Equal(t, "ws-primary", got.ID)
	_, ok = svc.tryForkDerivedFromPrimary(ctx, workspace, CreateWorkspaceSessionInput{SourceBookmark: " ", RepoOwner: "acme", RepoName: "repo"})
	assert.False(t, ok)

	q := &mockWorkspaceQuerier{getActiveWorkspaceForUserRepoFn: func(context.Context, db.GetActiveWorkspaceForUserRepoParams) (db.Workspace, error) {
		return db.Workspace{}, pgx.ErrNoRows
	}}
	_, ok = newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{})).
		tryForkDerivedFromPrimary(ctx, workspace, CreateWorkspaceSessionInput{SourceBookmark: "feature", RepoOwner: "acme", RepoName: "repo"})
	assert.False(t, ok)

	source := sampleDBWorkspace("ws-source")
	source.VmID = "vm-source"
	q = &mockWorkspaceQuerier{getActiveWorkspaceForUserRepoFn: func(context.Context, db.GetActiveWorkspaceForUserRepoParams) (db.Workspace, error) {
		return source, nil
	}}
	_, ok = newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		getVMFn: func(context.Context, string) (sandbox.Sandbox, error) {
			return sandbox.Sandbox{}, stderrors.New("resume source failed")
		},
	})).tryForkDerivedFromPrimary(ctx, workspace, CreateWorkspaceSessionInput{SourceBookmark: "feature", RepoOwner: "acme", RepoName: "repo"})
	assert.False(t, ok)

	_, ok = newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		forkVMFn: func(context.Context, string, sandbox.ForkRequest) (sandbox.CreateResult, error) {
			return sandbox.CreateResult{}, stderrors.New("fork failed")
		},
	})).tryForkDerivedFromPrimary(ctx, workspace, CreateWorkspaceSessionInput{SourceBookmark: "feature", RepoOwner: "acme", RepoName: "repo"})
	assert.False(t, ok)

	registrarWinner := &workspaceZRegistrarQuerier{
		mockWorkspaceQuerier: &mockWorkspaceQuerier{
			getActiveWorkspaceForUserRepoFn: func(context.Context, db.GetActiveWorkspaceForUserRepoParams) (db.Workspace, error) {
				return source, nil
			},
			getWorkspaceFn: func(context.Context, string) (db.Workspace, error) {
				winner := workspace
				winner.VmID = "vm-winner"
				return winner, nil
			},
		},
		registerFn: func(context.Context, db.RegisterWorkspaceVMParams) (db.Workspace, error) {
			return db.Workspace{}, pgx.ErrNoRows
		},
	}
	got, ok = newWorkspaceServiceForTests(registrarWinner, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{})).
		tryForkDerivedFromPrimary(ctx, workspace, CreateWorkspaceSessionInput{UserID: 1, SourceBookmark: "feature", RepoOwner: "acme", RepoName: "repo"})
	assert.True(t, ok)
	assert.Equal(t, "vm-winner", got.VmID)

	metrics := &workspaceProvisioningCovMetrics{}
	registrarSuccess := &workspaceZRegistrarQuerier{
		mockWorkspaceQuerier: &mockWorkspaceQuerier{
			getActiveWorkspaceForUserRepoFn: func(context.Context, db.GetActiveWorkspaceForUserRepoParams) (db.Workspace, error) {
				return source, nil
			},
		},
	}
	got, ok = newWorkspaceServiceForTests(registrarSuccess, WithWorkspaceSandboxMetrics(metrics), WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{})).
		tryForkDerivedFromPrimary(ctx, workspace, CreateWorkspaceSessionInput{UserID: 1, SourceBookmark: "feature", RepoOwner: "acme", RepoName: "repo"})
	assert.True(t, ok)
	assert.Equal(t, "vm-fork-123", got.VmID)
	assert.Contains(t, metrics.createStatuses, "workspace:success")
	assert.Contains(t, metrics.activeDeltas, float64(1))

	noExec := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(&workspaceZNoExecSandbox{}))
	err := noExec.switchForkedWorkspaceBookmark(ctx, "vm", CreateWorkspaceSessionInput{UserID: 1, SourceBookmark: "feature"})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
	err = noExec.cloneWorkspaceRepository(ctx, "vm", "https://example.test/repo.git", "tok", "", 0, workspaceCloneSource{})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	err = newWorkspaceServiceForTests(&mockWorkspaceQuerier{createAccessTokenFn: func(context.Context, db.CreateAccessTokenParams) (db.AccessToken, error) {
		return db.AccessToken{}, stderrors.New("token failed")
	}}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{})).
		switchForkedWorkspaceBookmark(ctx, "vm", CreateWorkspaceSessionInput{UserID: 1, SourceBookmark: "feature"})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	err = newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		execAwaitFn: func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
			return sandbox.ExecResult{}, stderrors.New("exec failed")
		},
	})).switchForkedWorkspaceBookmark(ctx, "vm", CreateWorkspaceSessionInput{UserID: 1, SourceBookmark: "feature"})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	err = newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		execAwaitFn: func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
			code := int32(9)
			return sandbox.ExecResult{StatusCode: &code, Stderr: strings.Repeat("x", 1200)}, nil
		},
	})).switchForkedWorkspaceBookmark(ctx, "vm", CreateWorkspaceSessionInput{UserID: 1, SourceBookmark: "feature"})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	err = newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		execAwaitFn: func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
			return sandbox.ExecResult{}, stderrors.New("exec failed")
		},
	})).cloneWorkspaceRepository(ctx, "vm", "https://example.test/repo.git", "tok", "", 0, workspaceCloneSource{})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	err = newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		execAwaitFn: func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
			code := int32(2)
			return sandbox.ExecResult{StatusCode: &code, Stdout: "stdout only"}, nil
		},
	})).cloneWorkspaceRepository(ctx, "vm", "https://example.test/repo.git", "tok", "", 0, workspaceCloneSource{})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	err = newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		execAwaitFn: func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
			code := int32(2)
			return sandbox.ExecResult{StatusCode: &code, Stderr: "stderr detail", Stdout: "stdout detail"}, nil
		},
	})).cloneWorkspaceRepository(ctx, "vm", "https://example.test/repo.git", "tok", "", 0, workspaceCloneSource{})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
	assert.Contains(t, err.Error(), "stderr detail\nstdout detail")

	err = newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
		execAwaitFn: func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
			code := int32(2)
			return sandbox.ExecResult{StatusCode: &code}, nil
		},
	})).cloneWorkspaceRepository(ctx, "vm", "https://example.test/repo.git", "tok", "", 0, workspaceCloneSource{})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
}

func TestWorkspaceProvisioning_Z_SnapshotForkEmptyMetricsAndErrors(t *testing.T) {
	ctx := context.Background()
	workspace := sampleDBWorkspace("ws-vm-z")
	workspace.VmID = ""

	for _, tc := range []struct {
		name string
		call func(*WorkspaceService) (db.Workspace, error)
	}{
		{name: "snapshot", call: func(s *WorkspaceService) (db.Workspace, error) {
			return s.createWorkspaceVMFromSnapshot(ctx, workspace, sampleDBWorkspaceSnapshot("snap", workspace.ID, "snap", "fs-snap"))
		}},
		{name: "fork", call: func(s *WorkspaceService) (db.Workspace, error) {
			source := sampleDBWorkspace("ws-source")
			source.VmID = "vm-source"
			return s.forkWorkspaceVM(ctx, workspace, source)
		}},
		{name: "empty source", call: func(s *WorkspaceService) (db.Workspace, error) {
			return s.provisionForkVMOnEmptySource(ctx, workspace)
		}},
	} {
		t.Run(tc.name+" create error metrics", func(t *testing.T) {
			metrics := &workspaceProvisioningCovMetrics{}
			q := &mockWorkspaceQuerier{updateWorkspaceStatusFn: func(context.Context, db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
				failed := workspace
				failed.Status = "failed"
				return failed, nil
			}}
			svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxMetrics(metrics), WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{
				createVMFn: func(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
					return sandbox.CreateResult{ID: "vm-create-failed"}, stderrors.New("create failed")
				},
				forkVMFn: func(context.Context, string, sandbox.ForkRequest) (sandbox.CreateResult, error) {
					return sandbox.CreateResult{ID: "vm-fork-failed"}, stderrors.New("fork failed")
				},
			}))
			_, err := tc.call(svc)
			assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
			assert.Contains(t, metrics.createStatuses, "workspace:error")
		})

		t.Run(tc.name+" register conflict winner", func(t *testing.T) {
			q := &workspaceZRegistrarQuerier{
				mockWorkspaceQuerier: &mockWorkspaceQuerier{
					updateWorkspaceStatusFn: func(context.Context, db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
						failed := workspace
						failed.Status = "failed"
						return failed, nil
					},
					getActiveWorkspaceForIdentityFn: func(context.Context, db.GetActiveWorkspaceForIdentityParams) (db.Workspace, error) {
						winner := workspace
						winner.ID = "ws-winner"
						winner.VmID = "vm-winner"
						return winner, nil
					},
				},
				registerFn: func(context.Context, db.RegisterWorkspaceVMParams) (db.Workspace, error) {
					return db.Workspace{}, &pgconn.PgError{Code: "23505", ConstraintName: "uq_workspaces_active"}
				},
			}
			got, err := tc.call(newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{})))
			require.NoError(t, err)
			assert.Equal(t, "ws-winner", got.ID)
		})

		t.Run(tc.name+" register won elsewhere", func(t *testing.T) {
			q := &workspaceZRegistrarQuerier{
				mockWorkspaceQuerier: &mockWorkspaceQuerier{
					getWorkspaceFn: func(context.Context, string) (db.Workspace, error) {
						winner := workspace
						winner.VmID = "vm-winner"
						return winner, nil
					},
				},
				registerFn: func(context.Context, db.RegisterWorkspaceVMParams) (db.Workspace, error) {
					return db.Workspace{}, pgx.ErrNoRows
				},
			}
			got, err := tc.call(newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{})))
			require.NoError(t, err)
			assert.Equal(t, "vm-winner", got.VmID)
		})

		t.Run(tc.name+" register generic error", func(t *testing.T) {
			q := &workspaceZRegistrarQuerier{
				mockWorkspaceQuerier: &mockWorkspaceQuerier{updateWorkspaceStatusFn: func(context.Context, db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
					failed := workspace
					failed.Status = "failed"
					return failed, nil
				}},
				registerFn: func(context.Context, db.RegisterWorkspaceVMParams) (db.Workspace, error) {
					return db.Workspace{}, stderrors.New("register failed")
				},
			}
			_, err := tc.call(newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{})))
			assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
		})

		t.Run(tc.name+" success metrics", func(t *testing.T) {
			metrics := &workspaceProvisioningCovMetrics{}
			q := &workspaceZRegistrarQuerier{mockWorkspaceQuerier: &mockWorkspaceQuerier{}}
			got, err := tc.call(newWorkspaceServiceForTests(q, WithWorkspaceSandboxMetrics(metrics), WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{})))
			require.NoError(t, err)
			assert.Equal(t, "running", got.Status)
			assert.Contains(t, metrics.activeDeltas, float64(1))
		})
	}

	q := &workspaceZRegistrarQuerier{
		mockWorkspaceQuerier: &mockWorkspaceQuerier{updateWorkspaceStatusFn: func(context.Context, db.UpdateWorkspaceStatusParams) (db.Workspace, error) {
			failed := workspace
			failed.Status = "failed"
			return failed, nil
		}},
		registerFn: func(context.Context, db.RegisterWorkspaceVMParams) (db.Workspace, error) {
			return db.Workspace{}, stderrors.New("register failed")
		},
	}
	_, err := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(&mockWorkspaceSandboxVMClient{})).
		provisionForkVMOnEmptySource(ctx, workspace)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
}
