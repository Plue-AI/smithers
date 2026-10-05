package services

import (
	"context"
	"errors"
	"io/fs"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// errAuthoritySideEffect ends a mutation at its first runtime side effect: a
// call that returns it was authorized to start the owner's machine.
var errAuthoritySideEffect = errors.New("workspace mutation reached the runtime")

// authorityRuntime records every side effect a caller can cause on the
// owner's workspace. Starting, creating, snapshotting, forking and publishing
// all stop at errAuthoritySideEffect; reads succeed only while it runs.
type authorityRuntime struct {
	workspaceapi.WorkspaceRuntime
	loopback bool

	mu      sync.Mutex
	state   workspaceapi.WorkspaceState
	effects []string

	// park, when set, holds the first side effect until release closes.
	park    bool
	once    sync.Once
	entered chan struct{}
	release chan struct{}
}

func newAuthorityRuntime(state workspaceapi.WorkspaceState) *authorityRuntime {
	return &authorityRuntime{state: state, entered: make(chan struct{}), release: make(chan struct{})}
}

func (r *authorityRuntime) effect(name string) error {
	r.mu.Lock()
	r.effects = append(r.effects, name)
	park := r.park
	r.mu.Unlock()
	if park {
		r.once.Do(func() {
			close(r.entered)
			<-r.release
		})
	}
	return errAuthoritySideEffect
}

func (r *authorityRuntime) sideEffects() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.effects...)
}

func (r *authorityRuntime) Capabilities() workspaceapi.WorkspaceCapabilities {
	return workspaceapi.WorkspaceCapabilities{PersistentFiles: true, Execution: true, ManagedServices: true, Terminal: true,
		LoopbackPreview: r.loopback, FileOperations: true, ColdSnapshots: true}
}

// Isolation answers for the microVM runtime this fixture stands in for
// (its rows carry vm_id). The embedded WorkspaceRuntime is nil, so a method a
// mutation reaches and this fixture omits would dereference nil and abort the
// whole package.
func (*authorityRuntime) Isolation() workspaceapi.IsolationLevel {
	return workspaceapi.IsolationSandboxed
}

func (r *authorityRuntime) InspectWorkspace(_ context.Context, id string) (workspaceapi.Workspace, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return workspaceapi.Workspace{ID: id, State: r.state}, nil
}

func (r *authorityRuntime) CreateWorkspace(context.Context, workspaceapi.WorkspaceSpec) (workspaceapi.Workspace, error) {
	return workspaceapi.Workspace{}, r.effect("create")
}

func (r *authorityRuntime) StartWorkspace(context.Context, string) (workspaceapi.Workspace, error) {
	return workspaceapi.Workspace{}, r.effect("start")
}

func (r *authorityRuntime) CreateColdSnapshot(context.Context, string, workspaceapi.ColdSnapshotSpec) (workspaceapi.ColdSnapshot, error) {
	return workspaceapi.ColdSnapshot{}, r.effect("snapshot")
}

func (r *authorityRuntime) ForkColdSnapshot(context.Context, string, workspaceapi.WorkspaceSpec) (workspaceapi.Workspace, error) {
	return workspaceapi.Workspace{}, r.effect("fork")
}

func (*authorityRuntime) DeleteColdSnapshot(context.Context, string) error { return nil }

func (r *authorityRuntime) PublishWorkspacePreview(context.Context, string, workspaceapi.RoutedPreviewSpec) (workspaceapi.RoutedPreview, error) {
	return workspaceapi.RoutedPreview{}, r.effect("publish")
}

func (*authorityRuntime) RevokeWorkspacePreview(context.Context, string, string) error { return nil }

func (*authorityRuntime) PreviewTarget(context.Context, string, uint16) (workspaceapi.PreviewTarget, error) {
	return workspaceapi.PreviewTarget{URL: "http://127.0.0.1:3000"}, nil
}

func (*authorityRuntime) ListFiles(context.Context, string, string) ([]workspaceapi.FileEntry, error) {
	return []workspaceapi.FileEntry{{Name: "README.md", Mode: fs.FileMode(0o644), Size: 3}}, nil
}

func (*authorityRuntime) ReadFile(context.Context, string, string) ([]byte, error) {
	return []byte("hi\n"), nil
}

func (*authorityRuntime) ListServices(context.Context, string) ([]workspaceapi.ServiceObservation, error) {
	return nil, nil
}

func (r *authorityRuntime) ManageService(context.Context, string, string, string) (workspaceapi.ServiceObservation, error) {
	return workspaceapi.ServiceObservation{}, r.effect("manage-service")
}

type authorityFixture struct {
	pool          *pgxpool.Pool
	store         *db.Queries
	repoID        int64
	owner         int64
	writer        int64
	reader        int64
	revoked       int64
	workspaceID   string
	sessionID     string
	runtime       *authorityRuntime
	service       *WorkspaceService
	sandboxClient *mockWorkspaceSandboxVMClient
}

// newAuthorityFixture seeds one owner's workspace shared with a write
// grantee, a read grantee, and a grantee whose write share was revoked.
func newAuthorityFixture(t *testing.T, status string, state workspaceapi.WorkspaceState, loopback bool) *authorityFixture {
	t.Helper()
	ctx := context.Background()
	pool := getAgentTestPool(t)
	fx := &authorityFixture{pool: pool, store: db.New(pool)}
	fx.owner = fixtureUser(t, pool, "authority-owner")
	fx.writer = fixtureUser(t, pool, "authority-writer")
	fx.reader = fixtureUser(t, pool, "authority-reader")
	fx.revoked = fixtureUser(t, pool, "authority-revoked")
	fx.repoID = fixtureRepo(t, pool, fx.owner)
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspaces (repository_id, user_id, name, kind, status, vm_id)
		VALUES ($1, $2, $3, 'container', $4, 'vm-authority') RETURNING id`,
		fx.repoID, fx.owner, "authority-"+uuid.NewString()[:8], status).Scan(&fx.workspaceID))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspace_sessions (workspace_id, repository_id, user_id, status)
		VALUES ($1, $2, $3, 'running') RETURNING id`, fx.workspaceID, fx.repoID, fx.owner).Scan(&fx.sessionID))
	for grantee, level := range map[int64]string{fx.writer: "write", fx.reader: "read", fx.revoked: "write"} {
		_, err := fx.store.UpsertWorkspaceShare(ctx, db.UpsertWorkspaceShareParams{
			WorkspaceID: fx.workspaceID, OwnerUserID: fx.owner, GranteeUserID: grantee, Level: level,
		})
		require.NoError(t, err)
	}
	require.NoError(t, fx.store.DeleteWorkspaceShare(ctx, db.DeleteWorkspaceShareParams{WorkspaceID: fx.workspaceID, GranteeUserID: fx.revoked}))
	fx.runtime = newAuthorityRuntime(state)
	fx.runtime.loopback = loopback
	fx.sandboxClient = &mockWorkspaceSandboxVMClient{}
	fx.service = fx.newService(fx.runtime)
	return fx
}

func (fx *authorityFixture) newService(runtime workspaceapi.WorkspaceRuntime) *WorkspaceService {
	return NewWorkspaceService(fx.store, WithWorkspaceRuntime(runtime), WithWorkspaceTransactions(fx.pool),
		WithWorkspaceSandboxClient(fx.sandboxClient), WithWorkspaceGitBaseURL(testWorkspaceGitBaseURL))
}

type workspaceMutationCase struct {
	name string
	// readRoute marks a read-level route that starts a stopped workspace for a
	// writer: a reader is told it is stopped instead of refused.
	readRoute bool
	call      func(ctx context.Context, fx *authorityFixture, svc *WorkspaceService, userID int64) error
}

// workspaceMutationCases is every workspace mutation a share grantee can
// reach: each creates, starts or resumes the owner's machine, runs in it,
// publishes its ingress, snapshots it, or forks it.
var workspaceMutationCases = []workspaceMutationCase{
	{name: "resume", call: func(ctx context.Context, fx *authorityFixture, svc *WorkspaceService, userID int64) error {
		_, err := svc.ResumeWorkspace(ctx, fx.workspaceID, fx.repoID, userID)
		return err
	}},
	{name: "exec command", call: func(ctx context.Context, fx *authorityFixture, svc *WorkspaceService, userID int64) error {
		_, err := svc.executeWorkspaceCommand(ctx, fx.workspaceID, fx.repoID, userID,
			WorkspaceCommandInput{OperationID: uuid.NewString(), Args: []string{"/usr/bin/true"}})
		return err
	}},
	{name: "launch service", call: func(ctx context.Context, fx *authorityFixture, svc *WorkspaceService, userID int64) error {
		_, err := svc.LaunchWorkspaceService(ctx, fx.workspaceID, fx.repoID, userID,
			WorkspaceServiceLaunchInput{OperationID: uuid.NewString(), Name: "web", Args: []string{"/usr/bin/true"}, Port: 3000})
		return err
	}},
	{name: "manage service", call: func(ctx context.Context, fx *authorityFixture, svc *WorkspaceService, userID int64) error {
		_, err := svc.ManageWorkspaceService(ctx, fx.workspaceID, fx.repoID, userID, "web", "restart")
		return err
	}},
	{name: "write file", call: func(ctx context.Context, fx *authorityFixture, svc *WorkspaceService, userID int64) error {
		_, err := svc.WriteWorkspaceFile(ctx, fx.workspaceID, fx.repoID, userID, "notes.txt", "hi")
		return err
	}},
	{name: "open terminal", call: func(ctx context.Context, fx *authorityFixture, svc *WorkspaceService, userID int64) error {
		_, err := svc.OpenWorkspaceTerminal(ctx, fx.sessionID, fx.repoID, userID, 80, 24)
		return err
	}},
	{name: "ssh connection", call: func(ctx context.Context, fx *authorityFixture, svc *WorkspaceService, userID int64) error {
		_, err := svc.GetWorkspaceSSHConnectionInfo(ctx, fx.workspaceID, fx.repoID, userID)
		return err
	}},
	{name: "apply coding", call: func(ctx context.Context, fx *authorityFixture, svc *WorkspaceService, userID int64) error {
		_, err := svc.ApplyCodingOperation(ctx, fx.workspaceID, fx.repoID, userID, codingFixture())
		return err
	}},
	{name: "undo operation", call: func(ctx context.Context, fx *authorityFixture, svc *WorkspaceService, userID int64) error {
		_, err := svc.UndoOperation(ctx, fx.workspaceID, fx.repoID, userID, strings.Repeat("a", 128))
		return err
	}},
	{name: "preview undo", call: func(ctx context.Context, fx *authorityFixture, svc *WorkspaceService, userID int64) error {
		_, err := svc.PreviewOperationUndo(ctx, fx.workspaceID, fx.repoID, userID, strings.Repeat("a", 128), nil)
		return err
	}},
	{name: "publish preview", call: func(ctx context.Context, fx *authorityFixture, svc *WorkspaceService, userID int64) error {
		_, err := svc.ResolveWorkspacePreview(ctx, fx.workspaceID, fx.repoID, userID, 3000, "")
		return err
	}},
	{name: "snapshot", call: func(ctx context.Context, fx *authorityFixture, svc *WorkspaceService, userID int64) error {
		_, err := svc.CreateWorkspaceSnapshot(ctx, CreateWorkspaceSnapshotInput{
			WorkspaceID: fx.workspaceID, RepositoryID: fx.repoID, UserID: userID, Name: "authority snapshot"})
		return err
	}},
	{name: "fork", call: func(ctx context.Context, fx *authorityFixture, svc *WorkspaceService, userID int64) error {
		_, err := svc.ForkWorkspace(ctx, ForkWorkspaceInput{
			WorkspaceID: fx.workspaceID, RepositoryID: fx.repoID, UserID: userID, Name: "authority fork"})
		return err
	}},
	{name: "list files", readRoute: true, call: func(ctx context.Context, fx *authorityFixture, svc *WorkspaceService, userID int64) error {
		_, err := svc.ListWorkspaceFiles(ctx, fx.workspaceID, fx.repoID, userID, "")
		return err
	}},
	{name: "read file", readRoute: true, call: func(ctx context.Context, fx *authorityFixture, svc *WorkspaceService, userID int64) error {
		_, err := svc.ReadWorkspaceFile(ctx, fx.workspaceID, fx.repoID, userID, "README.md")
		return err
	}},
	{name: "list services", readRoute: true, call: func(ctx context.Context, fx *authorityFixture, svc *WorkspaceService, userID int64) error {
		_, err := svc.ListWorkspaceServices(ctx, fx.workspaceID, fx.repoID, userID)
		return err
	}},
	{name: "read coding revisions", readRoute: true, call: func(ctx context.Context, fx *authorityFixture, svc *WorkspaceService, userID int64) error {
		_, err := svc.ReadCodingRevisions(ctx, fx.workspaceID, fx.repoID, userID, nil)
		return err
	}},
}

// TestWorkspaceMutationsRequireWriteAuthority runs every mutation against the
// owner's stopped workspace as the owner, a write grantee, a read grantee and
// a revoked grantee. Authorized requests fail closed while capture/admission
// providers are absent; revoked or read-only mutations remain forbidden.
func TestWorkspaceMutationsRequireWriteAuthority(t *testing.T) {
	for _, tc := range workspaceMutationCases {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			fx := newAuthorityFixture(t, "suspended", workspaceapi.WorkspaceStopped, false)
			for _, actor := range []struct {
				name    string
				userID  int64
				allowed bool
			}{
				{"owner", fx.owner, true},
				{"write grantee", fx.writer, true},
				{"read grantee", fx.reader, false},
				{"revoked grantee", fx.revoked, false},
			} {
				before := len(fx.runtime.sideEffects())
				err := tc.call(ctx, fx, fx.service, actor.userID)
				effects := fx.runtime.sideEffects()[before:]
				require.Error(t, err, actor.name)
				require.Empty(t, effects, "%s must not reach the runtime", actor.name)
				if actor.allowed || (tc.readRoute && actor.name == "read grantee") {
					require.Equal(t, 503, httpStatus(err), "capture/admission providers stay dark: %v", err)
				} else {
					require.Equal(t, 403, httpStatus(err), "%s: %v", actor.name, err)
				}
			}
			var status string
			require.NoError(t, fx.pool.QueryRow(ctx, `SELECT status FROM workspaces WHERE id = $1`, fx.workspaceID).Scan(&status))
			require.Equal(t, "suspended", status)
		})
	}
}

func shareRevocationWaiting(ctx context.Context, pool *pgxpool.Pool) bool {
	var waiting bool
	err := pool.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM pg_stat_activity
		WHERE datname = current_database() AND wait_event_type = 'Lock'
		  AND (query ILIKE '%DELETE FROM workspace_shares%' OR query ILIKE '%INSERT INTO workspace_shares%')
	)`).Scan(&waiting)
	return err == nil && waiting
}

// TestWorkspaceMutationsHoldAuthorityAcrossTheirSideEffect parks each mutation
// by a write grantee inside its runtime side effect, then revokes or demotes
// the grant. The change waits for the authorized mutation; afterwards the same
// mutation is refused without reaching the runtime.
func TestWorkspaceMutationsHoldAuthorityAcrossTheirSideEffect(t *testing.T) {
	for _, tc := range workspaceMutationCases {
		if tc.readRoute || tc.name == "resume" {
			continue // Reads no longer hold mutation authority or start stopped runtimes.
		}
		for _, change := range []string{"revoke", "demote"} {
			t.Run(tc.name+"/"+change, func(t *testing.T) {
				ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
				defer cancel()
				fx := newAuthorityFixture(t, "running", workspaceapi.WorkspaceRunning, false)
				fx.runtime.park = true
				released := false
				defer func() {
					if !released {
						close(fx.runtime.release)
					}
				}()
				mutation := make(chan error, 1)
				go func() { mutation <- tc.call(ctx, fx, fx.service, fx.writer) }()
				select {
				case <-fx.runtime.entered:
				case err := <-mutation:
					t.Fatalf("mutation never reached the runtime: %v", err)
				case <-ctx.Done():
					t.Fatal("mutation never reached the runtime")
				}

				changed := make(chan error, 1)
				go func() {
					if change == "revoke" {
						changed <- fx.store.DeleteWorkspaceShare(ctx, db.DeleteWorkspaceShareParams{WorkspaceID: fx.workspaceID, GranteeUserID: fx.writer})
						return
					}
					_, err := fx.store.UpsertWorkspaceShare(ctx, db.UpsertWorkspaceShareParams{
						WorkspaceID: fx.workspaceID, OwnerUserID: fx.owner, GranteeUserID: fx.writer, Level: "read"})
					changed <- err
				}()
				require.Eventually(t, func() bool { return shareRevocationWaiting(ctx, fx.pool) },
					5*time.Second, 10*time.Millisecond, "the %s must wait for the authorized mutation", change)
				select {
				case err := <-changed:
					t.Fatalf("%s completed while an authorized mutation was running (err=%v)", change, err)
				default:
				}

				close(fx.runtime.release)
				released = true
				require.ErrorContains(t, <-mutation, errAuthoritySideEffect.Error())
				require.NoError(t, <-changed)

				fx.runtime.mu.Lock()
				fx.runtime.park = false
				fx.runtime.mu.Unlock()
				before := len(fx.runtime.sideEffects())
				err := tc.call(ctx, fx, fx.service, fx.writer)
				require.Empty(t, fx.runtime.sideEffects()[before:], "a mutation after the %s must not reach the runtime", change)
				require.Equal(t, 403, httpStatus(err), "%v", err)
			})
		}
	}
}

// TestWorkspaceReaderSeesRunningWorkspaceWithoutMutating: a reader reads a
// running workspace and reaches its loopback preview, but never publishes a
// routed preview.
func TestWorkspaceReaderSeesRunningWorkspaceWithoutMutating(t *testing.T) {
	ctx := context.Background()
	t.Run("loopback preview", func(t *testing.T) {
		fx := newAuthorityFixture(t, "running", workspaceapi.WorkspaceRunning, true)
		access, err := fx.service.ResolveWorkspacePreview(ctx, fx.workspaceID, fx.repoID, fx.reader, 3000, "")
		require.NoError(t, err)
		require.True(t, access.Proxy)
		files, err := fx.service.ListWorkspaceFiles(ctx, fx.workspaceID, fx.repoID, fx.reader, "")
		require.NoError(t, err)
		require.Len(t, files, 1)
		content, err := fx.service.ReadWorkspaceFile(ctx, fx.workspaceID, fx.repoID, fx.reader, "README.md")
		require.NoError(t, err)
		require.Equal(t, "README.md", content.Path)
		_, err = fx.service.ListWorkspaceServices(ctx, fx.workspaceID, fx.repoID, fx.reader)
		require.NoError(t, err)
		require.Empty(t, fx.runtime.sideEffects())
	})
	t.Run("routed preview", func(t *testing.T) {
		fx := newAuthorityFixture(t, "running", workspaceapi.WorkspaceRunning, false)
		_, err := fx.service.ResolveWorkspacePreview(ctx, fx.workspaceID, fx.repoID, fx.reader, 3000, "")
		require.Equal(t, 403, httpStatus(err), "%v", err)
		require.Empty(t, fx.runtime.sideEffects())
	})
	t.Run("runtime stopped under a running row", func(t *testing.T) {
		fx := newAuthorityFixture(t, "running", workspaceapi.WorkspaceStopped, true)
		_, err := fx.service.ListWorkspaceFiles(ctx, fx.workspaceID, fx.repoID, fx.reader, "")
		require.Equal(t, 409, httpStatus(err), "%v", err)
		_, err = fx.service.ResolveWorkspacePreview(ctx, fx.workspaceID, fx.repoID, fx.reader, 3000, "")
		require.Equal(t, 409, httpStatus(err), "%v", err)
		require.Empty(t, fx.runtime.sideEffects())
	})
}

// TestSandboxWorkspaceReaderNeverResumesOrPublishes covers the sandbox
// provider: a reader neither resumes the VM nor publishes ingress, while a
// write grantee does both.
func TestSandboxWorkspaceReaderNeverResumesOrPublishes(t *testing.T) {
	ctx := context.Background()
	fx := newAuthorityFixture(t, "suspended", workspaceapi.WorkspaceStopped, false)
	var mu sync.Mutex
	var starts, publishes int
	fx.sandboxClient.getVMFn = func(_ context.Context, id string) (sandbox.Sandbox, error) {
		return sandbox.Sandbox{ID: id, State: sandbox.StateStopped}, nil
	}
	fx.sandboxClient.startVMFn = func(context.Context, string, sandbox.StartRequest) (sandbox.StartResult, error) {
		mu.Lock()
		defer mu.Unlock()
		starts++
		return sandbox.StartResult{}, errAuthoritySideEffect
	}
	fx.sandboxClient.publishIngressFn = func(context.Context, string, sandbox.PublishIngressRequest) (sandbox.IngressRoute, error) {
		mu.Lock()
		defer mu.Unlock()
		publishes++
		return sandbox.IngressRoute{}, errAuthoritySideEffect
	}
	svc := NewWorkspaceService(fx.store, WithWorkspaceTransactions(fx.pool), WithWorkspaceSandboxClient(fx.sandboxClient),
		WithWorkspaceGitBaseURL(testWorkspaceGitBaseURL))

	for _, reader := range []int64{fx.reader, fx.revoked} {
		_, err := svc.ResolveWorkspacePreview(ctx, fx.workspaceID, fx.repoID, reader, 3000, "")
		require.Equal(t, 403, httpStatus(err), "%v", err)
		_, err = svc.ResumeWorkspace(ctx, fx.workspaceID, fx.repoID, reader)
		require.Equal(t, 403, httpStatus(err), "%v", err)
		_, err = svc.ForkWorkspace(ctx, ForkWorkspaceInput{WorkspaceID: fx.workspaceID, RepositoryID: fx.repoID, UserID: reader, Name: "fork"})
		require.Equal(t, 403, httpStatus(err), "%v", err)
		_, err = svc.CreateWorkspaceSnapshot(ctx, CreateWorkspaceSnapshotInput{WorkspaceID: fx.workspaceID, RepositoryID: fx.repoID, UserID: reader, Name: "snap"})
		require.Equal(t, 403, httpStatus(err), "%v", err)
	}
	_, err := svc.ListWorkspaceFiles(ctx, fx.workspaceID, fx.repoID, fx.reader, "")
	require.Equal(t, 503, httpStatus(err), "%v", err)
	require.Zero(t, starts)
	require.Zero(t, publishes)

	for name, mutate := range map[string]func() error{
		"resume": func() error {
			_, err := svc.ResumeWorkspace(ctx, fx.workspaceID, fx.repoID, fx.writer)
			return err
		},
		"fork": func() error {
			_, err := svc.ForkWorkspace(ctx, ForkWorkspaceInput{WorkspaceID: fx.workspaceID, RepositoryID: fx.repoID, UserID: fx.writer, Name: "fork"})
			return err
		},
		"snapshot": func() error {
			_, err := svc.CreateWorkspaceSnapshot(ctx, CreateWorkspaceSnapshotInput{WorkspaceID: fx.workspaceID, RepositoryID: fx.repoID, UserID: fx.writer, Name: "snap"})
			return err
		},
	} {
		before := starts
		err := mutate()
		require.Error(t, err, name)
		require.NotEqual(t, 403, httpStatus(err), "%s: %v", name, err)
		require.Equal(t, before, starts, "a write grantee's %s cannot bypass admission", name)
	}
}

// TestSpawnWorkspaceChildrenIsOwnerOnly: children bill the caller, so only
// the owner of the running parent spawns them; every grantee sees no parent.
func TestSpawnWorkspaceChildrenIsOwnerOnly(t *testing.T) {
	ctx := context.Background()
	fx := newAuthorityFixture(t, "running", workspaceapi.WorkspaceRunning, false)
	fx.sandboxClient.snapshotVMFn = func(context.Context, string, sandbox.SnapshotRequest) (sandbox.SnapshotResult, error) {
		return sandbox.SnapshotResult{}, errAuthoritySideEffect
	}
	svc := NewWorkspaceService(fx.store, WithWorkspaceTransactions(fx.pool), WithWorkspaceSandboxClient(fx.sandboxClient),
		WithWorkspaceGitBaseURL(testWorkspaceGitBaseURL))
	spawn := func(userID int64) error {
		_, err := svc.SpawnWorkspaceChildren(ctx, SpawnWorkspaceChildrenInput{
			RepositoryID: fx.repoID, UserID: userID, ParentWorkspaceID: fx.workspaceID, Count: 1})
		return err
	}
	for _, grantee := range []int64{fx.writer, fx.reader, fx.revoked} {
		require.Equal(t, 404, httpStatus(spawn(grantee)))
	}
	var batches int
	require.NoError(t, fx.pool.QueryRow(ctx, `SELECT count(*) FROM workspace_child_batches WHERE parent_workspace_id = $1`, fx.workspaceID).Scan(&batches))
	require.Zero(t, batches)
	require.NoError(t, spawn(fx.owner))
	require.NoError(t, svc.WaitForProvisioning(ctx))
}
