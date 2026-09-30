package services

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	"github.com/smithersai/smithers/packages/backend/sandbox/sandboxfake"
)

// Child workspaces (#2802) run against real PostgreSQL; only the sandbox
// provider is the in-memory fake.

const childTestRepoFile = "/home/developer/workspace/README.md"

// childTestLogins are vendor sign-ins inside the parent that no child may inherit.
var childTestLogins = []string{
	"/home/developer/.claude/.credentials.json",
	"/home/developer/.codex/auth.json",
	"/root/.config/anthropic/key",
}

type childTestSecrets struct{}

func (childTestSecrets) LoadForProvisioning(context.Context, int64) (AgentEnvironmentProvisioningConfig, error) {
	return AgentEnvironmentProvisioningConfig{}, nil
}

func (childTestSecrets) LoadProxyBoundSecrets(context.Context, int64) ([]sandbox.EgressProxySecret, error) {
	return []sandbox.EgressProxySecret{{
		Name: "GITHUB_TOKEN", Value: "ghp-parent-secret", Hosts: []string{"api.github.com"},
		MatchHeaders: []string{"Authorization"},
	}}, nil
}

type childFixture struct {
	pool     *pgxpool.Pool
	queries  *db.Queries
	provider *sandboxfake.Provider
	svc      *WorkspaceService
	user     int64
	repo     int64
	parent   db.Workspace
}

// scrubChildLogins signs a fake machine out exactly as the guest scrub does.
func scrubChildLogins(machine *sandboxfake.Machine, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
	ok := int32(0)
	if req.Command != workspaceSandboxLoginScrubCommand() {
		return sandbox.ExecResult{StatusCode: &ok}, nil
	}
	for path := range machine.Files {
		for _, home := range workspaceSandboxLoginHomes {
			for _, rel := range workspaceVendorLoginPaths {
				if login := home + "/" + rel; path == login || strings.HasPrefix(path, login+"/") {
					delete(machine.Files, path)
				}
			}
		}
	}
	return sandbox.ExecResult{StatusCode: &ok}, nil
}

func newChildFixture(t *testing.T, entitlement *SandboxEntitlement) *childFixture {
	t.Helper()
	pool := newProductTestPool(t)
	user, repo := setupTestUserAndRepo(t, pool)
	queries := db.New(pool)
	provider := sandboxfake.New()
	provider.ExecFunc = scrubChildLogins
	opts := []WorkspaceServiceOption{
		WithWorkspaceSandboxClient(provider), WithWorkspaceTransactions(pool),
		WithWorkspaceAgentEnvironment(childTestSecrets{}),
	}
	if entitlement != nil {
		opts = append(opts, WithWorkspaceBillingPolicy(sandboxPolicyStub{entitlement: *entitlement}))
	}
	f := &childFixture{pool: pool, queries: queries, provider: provider, svc: NewWorkspaceService(queries, opts...), user: user, repo: repo}
	files := map[string]string{childTestRepoFile: "# parent tree"}
	for _, login := range childTestLogins {
		files[login] = "token-of-the-parent"
	}
	f.parent = f.workspace(t, "main", provider.Boot(files))
	return f
}

func (f *childFixture) workspace(t *testing.T, name, vmID string) db.Workspace {
	t.Helper()
	ctx := context.Background()
	row, err := f.queries.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: f.repo, UserID: f.user, Name: name,
		TargetBookmark: "main", Kind: "container", EnvironmentSource: defaultWorkspaceEnvironmentSource, Status: "starting"})
	require.NoError(t, err)
	row, err = f.queries.UpdateWorkspaceExecutionInfo(ctx, db.UpdateWorkspaceExecutionInfoParams{ID: row.ID, VmID: vmID, Status: "running"})
	require.NoError(t, err)
	return row
}

func (f *childFixture) spawn(t *testing.T, count int, profile string) (WorkspaceChildBatch, error) {
	t.Helper()
	batch, err := f.svc.SpawnWorkspaceChildren(context.Background(), SpawnWorkspaceChildrenInput{
		RepositoryID: f.repo, UserID: f.user, ParentWorkspaceID: f.parent.ID, Count: count, Profile: profile,
	})
	require.NoError(t, f.svc.WaitForProvisioning(context.Background()))
	return batch, err
}

func (f *childFixture) receipts(t *testing.T) []WorkspaceChild {
	t.Helper()
	children, err := f.svc.ListWorkspaceChildren(context.Background(), f.parent.ID, f.repo, f.user)
	require.NoError(t, err)
	return children
}

func (f *childFixture) exec(t *testing.T, sql string, args ...any) {
	t.Helper()
	_, err := f.pool.Exec(context.Background(), sql, args...)
	require.NoError(t, err)
}

func requireChildAPIError(t *testing.T, err error, code pkgerrors.Code, contains string) {
	t.Helper()
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	require.Equal(t, code, apiErr.Code, apiErr.Message)
	require.Contains(t, apiErr.Message, contains)
}

func TestWorkspaceChildrenBootFromOneSnapshotWithoutCredentials(t *testing.T) {
	f := newChildFixture(t, &SandboxEntitlement{ConcurrentChildren: 16, ChildMaxTTLSecs: 3600})
	batch, err := f.spawn(t, 3, "build")
	require.NoError(t, err)
	require.Equal(t, "build", batch.Profile)
	require.Len(t, batch.Children, 3)
	require.WithinDuration(t, time.Now().Add(time.Hour), batch.ExpiresAt, time.Minute, "the default TTL is capped by the plan")
	for i, child := range batch.Children {
		require.Equal(t, int32(i), child.Ordinal)
		require.Equal(t, "starting", child.Status, "admission returns before any child boots")
	}

	snapshots := f.provider.Snapshots()
	require.Len(t, snapshots, 1, "one batch takes one snapshot of the parent")
	creates := f.provider.Creates()
	require.Len(t, creates, 3)
	for _, req := range creates {
		require.Equal(t, snapshots[0], req.SnapshotID)
		require.Equal(t, int32(8192), *req.MemSizeMB)
		require.Equal(t, int32(2), *req.VCPUCount)
		require.Equal(t, int64(600), *req.IdleTimeoutSeconds)
		require.Equal(t, sandbox.PersistenceEphemeral, req.Persistence.Type)
		require.NotNil(t, req.EgressProxy)
		require.True(t, req.EgressProxy.Enabled, "a child still egresses only through its proxy")
		require.Empty(t, req.EgressProxy.Secrets, "a child's proxy binds no repository secret")
		require.NotContains(t, req.Files, workspaceClaudeScriptPath, "the snapshot already holds the toolchain")
		for _, service := range req.Init.Services {
			require.NotEqual(t, workspaceClaudeService, service.Name)
		}
	}

	receipts := f.receipts(t)
	require.Len(t, receipts, 3)
	for i, child := range receipts {
		require.Equal(t, batch.Children[i].WorkspaceID, child.WorkspaceID)
		require.Equal(t, "running", child.Status)
		require.Equal(t, snapshots[0], child.SnapshotID)
		require.NotNil(t, child.StartedAt)
		require.Nil(t, child.StoppedAt)
		machine, ok := f.provider.Machine(child.VMID)
		require.True(t, ok)
		require.Equal(t, "# parent tree", machine.Files[childTestRepoFile], "the child inherits the parent's tree")
		for _, login := range childTestLogins {
			require.NotContains(t, machine.Files, login, "the child starts signed out")
		}
		row, err := f.queries.GetWorkspace(context.Background(), child.WorkspaceID)
		require.NoError(t, err)
		require.True(t, row.IsFork)
		require.Equal(t, f.parent.ID, UUIDString(row.ParentWorkspaceID))
		require.Equal(t, int32(0), row.IdleTimeoutSecs, "the child reaper owns idleness")
	}
	parent, ok := f.provider.Machine(f.parent.VmID)
	require.True(t, ok)
	require.Len(t, parent.Files, 1+len(childTestLogins), "the parent keeps its own logins")

	// Children count against their own limit only.
	count, err := f.queries.CountActiveWorkspacesByUser(context.Background(), f.user)
	require.NoError(t, err)
	require.Equal(t, int64(1), count)
	active, err := f.queries.CountActiveSandboxesForUser(context.Background(), f.user)
	require.NoError(t, err)
	require.Equal(t, 1, active)
}

func TestWorkspaceChildrenAdmissionFailsClosed(t *testing.T) {
	f := newChildFixture(t, &SandboxEntitlement{ConcurrentChildren: 4, ChildMaxTTLSecs: 3600})
	ctx := context.Background()
	spawn := func(input SpawnWorkspaceChildrenInput) error {
		if input.RepositoryID == 0 {
			input.RepositoryID = f.repo
		}
		if input.UserID == 0 {
			input.UserID = f.user
		}
		if input.ParentWorkspaceID == "" {
			input.ParentWorkspaceID = f.parent.ID
		}
		_, err := f.svc.SpawnWorkspaceChildren(ctx, input)
		require.NoError(t, f.svc.WaitForProvisioning(ctx))
		return err
	}
	requireChildAPIError(t, spawn(SpawnWorkspaceChildrenInput{Count: 0}), pkgerrors.CodeBadRequest, "between 1 and 128")
	requireChildAPIError(t, spawn(SpawnWorkspaceChildrenInput{Count: 129}), pkgerrors.CodeBadRequest, "between 1 and 128")
	requireChildAPIError(t, spawn(SpawnWorkspaceChildrenInput{Count: 1, Profile: "huge"}), pkgerrors.CodeBadRequest, "profile")
	requireChildAPIError(t, spawn(SpawnWorkspaceChildrenInput{Count: 1, TTL: -time.Second}), pkgerrors.CodeBadRequest, "negative")
	requireChildAPIError(t, spawn(SpawnWorkspaceChildrenInput{Count: 1, TTL: 2 * time.Hour}), pkgerrors.CodeBadRequest, "at most 1h0m0s")
	requireChildAPIError(t, spawn(SpawnWorkspaceChildrenInput{Count: 1, UserID: f.user + 1000}), pkgerrors.CodeNotFound, "user")
	requireChildAPIError(t, spawn(SpawnWorkspaceChildrenInput{Count: 1, RepositoryID: f.repo + 1000}), pkgerrors.CodeNotFound, "workspace")
	requireChildAPIError(t, spawn(SpawnWorkspaceChildrenInput{Count: 1, ParentWorkspaceID: "00000000-0000-4000-8000-000000000001"}), pkgerrors.CodeNotFound, "workspace")

	other, _ := setupTestUserAndRepo(t, f.pool)
	requireChildAPIError(t, spawn(SpawnWorkspaceChildrenInput{Count: 1, UserID: other}), pkgerrors.CodeNotFound, "workspace")

	require.NoError(t, spawn(SpawnWorkspaceChildrenInput{Count: 3, TTL: 30 * time.Minute}))
	requireChildAPIError(t, spawn(SpawnWorkspaceChildrenInput{Count: 2}), pkgerrors.CodeQuotaExceeded, "3 of 4 live, 2 requested")
	require.NoError(t, spawn(SpawnWorkspaceChildrenInput{Count: 1}))
	requireChildAPIError(t, spawn(SpawnWorkspaceChildrenInput{Count: 1}), pkgerrors.CodeQuotaExceeded, "4 of 4 live")
	require.Len(t, f.receipts(t), 4, "a refused batch leaves no rows")

	child := f.receipts(t)[0].WorkspaceID
	_, err := f.svc.SpawnWorkspaceChildren(ctx, SpawnWorkspaceChildrenInput{RepositoryID: f.repo, UserID: f.user, ParentWorkspaceID: child, Count: 1})
	requireChildAPIError(t, err, pkgerrors.CodeBadRequest, "cannot spawn children")

	f.exec(t, `UPDATE workspaces SET status = 'suspended' WHERE id = $1`, f.parent.ID)
	requireChildAPIError(t, spawn(SpawnWorkspaceChildrenInput{Count: 1}), pkgerrors.CodeConflict, "must be running")
	f.exec(t, `UPDATE workspaces SET status = 'running', kind = 'vm' WHERE id = $1`, f.parent.ID)
	requireChildAPIError(t, spawn(SpawnWorkspaceChildrenInput{Count: 1}), pkgerrors.CodeBadRequest, "container")
}

func TestWorkspaceChildrenPlanLimits(t *testing.T) {
	t.Run("a plan without children refuses", func(t *testing.T) {
		f := newChildFixture(t, &SandboxEntitlement{})
		_, err := f.spawn(t, 1, "")
		requireChildAPIError(t, err, pkgerrors.CodeQuotaExceeded, "not included")
	})
	t.Run("a billing failure refuses", func(t *testing.T) {
		f := newChildFixture(t, nil)
		f.svc.billing = sandboxPolicyStub{err: errors.New("ledger down")}
		_, err := f.spawn(t, 1, "")
		require.ErrorContains(t, err, "ledger down")
	})
	t.Run("the hard cap wins over the plan", func(t *testing.T) {
		f := newChildFixture(t, &SandboxEntitlement{ConcurrentChildren: 1000, ChildMaxTTLSecs: 3600})
		batch, err := f.spawn(t, MaxWorkspaceChildren, "")
		require.NoError(t, err)
		require.Len(t, batch.Children, MaxWorkspaceChildren)
		_, err = f.spawn(t, 1, "")
		requireChildAPIError(t, err, pkgerrors.CodeQuotaExceeded, "128 of 128 live")
		require.Len(t, f.provider.Live(), MaxWorkspaceChildren+1)
		for _, req := range f.provider.Creates() {
			require.Equal(t, int32(2048), *req.MemSizeMB, "small is the default profile")
			require.Equal(t, int32(1), *req.VCPUCount)
		}
	})
	t.Run("without billing the hard cap applies", func(t *testing.T) {
		f := newChildFixture(t, nil)
		limit, ttl, err := f.svc.workspaceChildLimits(context.Background(), f.user)
		require.NoError(t, err)
		require.Equal(t, int64(MaxWorkspaceChildren), limit)
		require.Equal(t, 8*time.Hour, ttl)
		batch, err := f.spawn(t, 2, "")
		require.NoError(t, err)
		require.WithinDuration(t, time.Now().Add(4*time.Hour), batch.ExpiresAt, time.Minute)
	})
	t.Run("children never consume the workspace backstop", func(t *testing.T) {
		f := newChildFixture(t, nil)
		f.exec(t, `INSERT INTO workspaces (repository_id, user_id, name, is_fork, kind, status)
			SELECT $1, $2, 'filler-' || n, TRUE, 'container', 'running' FROM generate_series(1, 99) n`, f.repo, f.user)
		_, err := f.pool.Exec(context.Background(), `INSERT INTO workspaces (repository_id, user_id, name, is_fork, kind, status)
			VALUES ($1, $2, 'one-too-many', TRUE, 'container', 'running')`, f.repo, f.user)
		require.ErrorContains(t, err, "maximum of 100 active workspaces")
		_, err = f.spawn(t, 5, "")
		require.NoError(t, err)
		require.Len(t, f.receipts(t), 5)
	})
}

func TestWorkspaceChildrenAreReapedWithTheirParent(t *testing.T) {
	f := newChildFixture(t, nil)
	ctx := context.Background()
	_, err := f.spawn(t, 2, "")
	require.NoError(t, err)
	snapshot := f.provider.Snapshots()[0]

	// Suspending the parent cascades through the status funnel.
	require.NoError(t, f.svc.suspendWorkspace(ctx, f.parent))
	require.NoError(t, f.svc.WaitForProvisioning(ctx))
	for _, child := range f.receipts(t) {
		require.Equal(t, "stopped", child.Status)
		require.Equal(t, "parent_stopped", child.StopReason)
		require.NotNil(t, child.StoppedAt)
		_, live := f.provider.Machine(child.VMID)
		require.False(t, live, "a reaped child's machine is deleted")
		var tombstoned bool
		require.NoError(t, f.pool.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM workspaces WHERE id = $1`, child.WorkspaceID).Scan(&tombstoned))
		require.True(t, tombstoned)
	}
	require.Equal(t, []string{snapshot}, f.provider.Snapshots(), "the cascade leaves snapshot release to the sweep")
	require.NoError(t, f.svc.ReapWorkspaceChildren(ctx))
	require.Empty(t, f.provider.Snapshots(), "a drained batch releases its snapshot")
	require.Equal(t, []string{snapshot}, f.provider.Released())
	require.NoError(t, f.svc.ReapWorkspaceChildren(ctx), "a second sweep finds nothing")
	require.Equal(t, []string{snapshot}, f.provider.Released())

	// A stopped child is never resumed through the credentialed path.
	f.exec(t, `UPDATE workspaces SET deleted_at = NULL WHERE id = $1`, f.receipts(t)[0].WorkspaceID)
	row, err := f.queries.GetWorkspace(ctx, f.receipts(t)[0].WorkspaceID)
	require.NoError(t, err)
	require.Equal(t, "stopped", row.Status)
	_, err = f.svc.ensureExistingWorkspaceRunning(ctx, row)
	requireChildAPIError(t, err, pkgerrors.CodeConflict, "cannot be resumed")
}

func TestWorkspaceChildrenStopWhenTheParentStoppedEvenIfItResumed(t *testing.T) {
	f := newChildFixture(t, nil)
	ctx := context.Background()
	_, err := f.spawn(t, 2, "")
	require.NoError(t, err)
	// The parent is running again by the time the cascade queries.
	f.svc.cascadeWorkspaceChildren(ctx, f.parent.ID, "suspended")
	require.NoError(t, f.svc.WaitForProvisioning(ctx))
	for _, child := range f.receipts(t) {
		require.Equal(t, "parent_stopped", child.StopReason)
	}
	require.Equal(t, []string{f.parent.VmID}, f.provider.Live())
}

func TestWorkspaceChildrenNeverTakeTheCredentialedPath(t *testing.T) {
	f := newChildFixture(t, nil)
	ctx := context.Background()
	_, err := f.spawn(t, 1, "")
	require.NoError(t, err)
	child := f.receipts(t)[0]
	row, err := f.queries.GetWorkspace(ctx, child.WorkspaceID)
	require.NoError(t, err)

	// A running child with a running machine is answered as it is.
	got, err := f.svc.ensureWorkspaceRunningOwned(ctx, row, CreateWorkspaceSessionInput{})
	require.NoError(t, err)
	require.Equal(t, row.VmID, got.VmID)
	creates := len(f.provider.Creates())

	// Its machine stopped: no resume, no reprovision.
	_, err = f.provider.StopSandbox(ctx, row.VmID)
	require.NoError(t, err)
	_, err = f.svc.ensureWorkspaceRunningOwned(ctx, row, CreateWorkspaceSessionInput{})
	requireChildAPIError(t, err, pkgerrors.CodeConflict, "cannot be resumed")
	_, err = f.svc.ensureExistingWorkspaceRunning(ctx, row)
	requireChildAPIError(t, err, pkgerrors.CodeConflict, "cannot be resumed")

	// A child still booting is never provisioned by a session.
	starting := row
	starting.Status, starting.VmID = "starting", ""
	_, err = f.svc.ensureWorkspaceRunningOwned(ctx, starting, CreateWorkspaceSessionInput{})
	requireChildAPIError(t, err, pkgerrors.CodeConflict, "cannot be resumed")

	// A machine the provider lost is reported, not replaced.
	require.NoError(t, f.provider.DeleteSandbox(ctx, row.VmID))
	_, err = f.svc.ensureExistingWorkspaceRunning(ctx, row)
	require.Error(t, err)
	require.Len(t, f.provider.Creates(), creates, "no child machine was booted outside its batch")

	// A plain fork is not a child.
	fork := f.workspace(t, "fork", f.provider.Boot(nil))
	f.exec(t, `UPDATE workspaces SET is_fork = TRUE WHERE id = $1`, fork.ID)
	fork.IsFork = true
	handled, err := f.svc.runningWorkspaceChild(ctx, fork)
	require.NoError(t, err)
	require.False(t, handled)
}

func TestWorkspaceChildrenDropTheParentIdentity(t *testing.T) {
	f := newChildFixture(t, nil)
	_, err := f.spawn(t, 2, "")
	require.NoError(t, err)
	scrubs := map[string]bool{}
	for _, exec := range f.provider.Execs() {
		if exec.Command == workspaceChildIdentityScrubCommand() {
			scrubs[exec.SandboxID] = true
		}
	}
	for _, child := range f.receipts(t) {
		require.True(t, scrubs[child.VMID], "every child drops the parent's head reporter and bindings")
	}
	command := workspaceChildIdentityScrubCommand()
	for _, want := range []string{workspaceHeadReporterService, workspaceCodingConfigPath, workspaceGitCredentialEnvPath} {
		require.Contains(t, command, want)
	}

	t.Run("a child that keeps the parent's identity is discarded", func(t *testing.T) {
		f := newChildFixture(t, nil)
		f.provider.ExecFunc = func(machine *sandboxfake.Machine, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
			if req.Command == workspaceChildIdentityScrubCommand() {
				failed := int32(1)
				return sandbox.ExecResult{StatusCode: &failed, Stderr: "parent identity remains"}, nil
			}
			return scrubChildLogins(machine, req)
		}
		_, err := f.spawn(t, 1, "")
		require.NoError(t, err)
		require.Contains(t, f.receipts(t)[0].FailureMessage, "drop the parent's identity: parent identity remains")
		require.Equal(t, []string{f.parent.VmID}, f.provider.Live())
	})
	t.Run("an exec transport failure is a scrub failure", func(t *testing.T) {
		f := newChildFixture(t, nil)
		f.provider.ExecFunc = func(machine *sandboxfake.Machine, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
			if req.Command == workspaceChildIdentityScrubCommand() {
				return sandbox.ExecResult{}, errors.New("exec channel closed")
			}
			return scrubChildLogins(machine, req)
		}
		_, err := f.spawn(t, 1, "")
		require.NoError(t, err)
		require.Contains(t, f.receipts(t)[0].FailureMessage, "exec channel closed")
	})
}

func TestWorkspaceChildSnapshotsOutliveTheirRepository(t *testing.T) {
	f := newChildFixture(t, nil)
	ctx := context.Background()
	_, err := f.spawn(t, 1, "")
	require.NoError(t, err)
	require.Len(t, f.provider.Snapshots(), 1)
	// Deleting a repository hard-deletes its workspaces, parent and children.
	f.exec(t, `DELETE FROM workspaces WHERE repository_id = $1`, f.repo)
	require.NoError(t, f.svc.ReapWorkspaceChildren(ctx))
	require.Empty(t, f.provider.Snapshots(), "the batch keeps its snapshot for release after its parent is gone")
}

func TestWorkspaceChildrenSweepReasons(t *testing.T) {
	f := newChildFixture(t, nil)
	ctx := context.Background()
	_, err := f.spawn(t, 5, "")
	require.NoError(t, err)
	receipts := f.receipts(t)
	f.exec(t, `UPDATE workspace_child_batches SET expires_at = now() + interval '1 hour'`)
	// 0 stays; 1 idles; 2 is stopped by its user; 3 never booted; 4 failed elsewhere.
	f.exec(t, `UPDATE workspaces SET last_activity_at = now() - interval '11 minutes' WHERE id = $1`, receipts[1].WorkspaceID)
	f.exec(t, `UPDATE workspaces SET status = 'stopped', deleted_at = now() WHERE id = $1`, receipts[2].WorkspaceID)
	f.exec(t, `UPDATE workspaces SET status = 'starting', vm_id = '' WHERE id = $1`, receipts[3].WorkspaceID)
	f.exec(t, `UPDATE workspace_children SET created_at = now() - interval '11 minutes' WHERE workspace_id = $1`, receipts[3].WorkspaceID)
	f.exec(t, `UPDATE workspaces SET status = 'failed', failure_code = 'provisioning_failed', failure_message = 'x' WHERE id = $1`, receipts[4].WorkspaceID)
	require.NoError(t, f.svc.ReapWorkspaceChildren(ctx))

	got := map[string]string{}
	for _, child := range f.receipts(t) {
		got[child.WorkspaceID] = child.StopReason + "/" + child.Status
	}
	require.Equal(t, map[string]string{
		receipts[0].WorkspaceID: "/running",
		receipts[1].WorkspaceID: "idle/stopped",
		receipts[2].WorkspaceID: "requested/stopped",
		receipts[3].WorkspaceID: "abandoned/stopped",
		receipts[4].WorkspaceID: "failed/failed",
	}, got)
	require.Len(t, f.provider.Snapshots(), 1, "a batch with a live child keeps its snapshot")

	f.exec(t, `UPDATE workspace_child_batches SET expires_at = now() - interval '1 second'`)
	require.NoError(t, f.svc.ReapWorkspaceChildren(ctx))
	require.Equal(t, "expired", f.receipts(t)[0].StopReason)
	require.Empty(t, f.provider.Snapshots())
}

func TestWorkspaceChildrenFailuresAreRecorded(t *testing.T) {
	t.Run("a failed snapshot fails the whole batch", func(t *testing.T) {
		f := newChildFixture(t, nil)
		f.provider.SnapshotErr = errors.New("worker draining")
		_, err := f.spawn(t, 2, "")
		require.NoError(t, err, "admission succeeds before the snapshot")
		for _, child := range f.receipts(t) {
			require.Equal(t, "failed", child.Status)
			require.Equal(t, "failed", child.StopReason)
			require.Contains(t, child.FailureMessage, "worker draining")
		}
		require.Empty(t, f.provider.Creates())
	})
	t.Run("one child failing leaves its siblings running", func(t *testing.T) {
		f := newChildFixture(t, nil)
		var calls atomic.Int32
		f.provider.CreateErr = func(sandbox.CreateRequest) error {
			if calls.Add(1) == 1 {
				return errors.New("no capacity")
			}
			return nil
		}
		_, err := f.spawn(t, 3, "")
		require.NoError(t, err)
		states := map[string]int{}
		for _, child := range f.receipts(t) {
			states[child.Status]++
		}
		require.Equal(t, map[string]int{"failed": 1, "running": 2}, states)
	})
	t.Run("a child that cannot be signed out is discarded", func(t *testing.T) {
		f := newChildFixture(t, nil)
		f.provider.ExecFunc = func(*sandboxfake.Machine, sandbox.ExecRequest) (sandbox.ExecResult, error) {
			failed := int32(1)
			return sandbox.ExecResult{StatusCode: &failed, Stderr: "vendor login remains"}, nil
		}
		_, err := f.spawn(t, 1, "")
		require.NoError(t, err)
		child := f.receipts(t)[0]
		require.Equal(t, "failed", child.Status)
		require.Contains(t, child.FailureMessage, "sign the child out")
		require.Equal(t, []string{f.parent.VmID}, f.provider.Live(), "the signed-in machine is deleted")
	})
	t.Run("a child stopped while booting deletes its machine", func(t *testing.T) {
		f := newChildFixture(t, nil)
		f.provider.CreateErr = func(sandbox.CreateRequest) error {
			_, err := f.pool.Exec(context.Background(),
				`UPDATE workspace_children SET stopped_at = now(), stop_reason = 'requested' WHERE stopped_at IS NULL`)
			return err
		}
		_, err := f.spawn(t, 2, "")
		require.NoError(t, err)
		require.Equal(t, []string{f.parent.VmID}, f.provider.Live())
		require.Len(t, f.provider.Deleted(), 2)
	})
	t.Run("a machine that will not delete stays owned and counted until the sweep deletes it", func(t *testing.T) {
		f := newChildFixture(t, nil)
		ctx := context.Background()
		_, err := f.spawn(t, 1, "")
		require.NoError(t, err)
		child := f.receipts(t)[0]
		f.exec(t, `UPDATE workspace_child_batches SET expires_at = now() - interval '1 second'`)
		f.provider.DeleteErr = func(string) error { return errors.New("controller unavailable") }
		require.ErrorContains(t, f.svc.ReapWorkspaceChildren(ctx), "controller unavailable")
		require.Equal(t, "expired", f.receipts(t)[0].StopReason)
		_, live := f.provider.Machine(child.VMID)
		require.True(t, live)
		live64, err := f.queries.CountLiveWorkspaceChildren(ctx, f.user)
		require.NoError(t, err)
		require.Equal(t, int64(1), live64, "an undeleted machine still counts")
		require.Len(t, f.provider.Snapshots(), 1, "its snapshot stays while the machine exists")
		f.provider.DeleteErr = nil
		require.NoError(t, f.svc.ReapWorkspaceChildren(ctx))
		_, live = f.provider.Machine(child.VMID)
		require.False(t, live)
		live64, err = f.queries.CountLiveWorkspaceChildren(ctx, f.user)
		require.NoError(t, err)
		require.Zero(t, live64)
		require.Empty(t, f.provider.Snapshots())
	})
	t.Run("a failed boot whose machine will not delete is reclaimed by the sweep", func(t *testing.T) {
		f := newChildFixture(t, nil)
		ctx := context.Background()
		f.provider.ExecFunc = func(*sandboxfake.Machine, sandbox.ExecRequest) (sandbox.ExecResult, error) {
			failed := int32(1)
			return sandbox.ExecResult{StatusCode: &failed, Stderr: "vendor login remains"}, nil
		}
		f.provider.DeleteErr = func(id string) error {
			if id != f.parent.VmID {
				return errors.New("controller unavailable")
			}
			return nil
		}
		_, err := f.spawn(t, 1, "")
		require.NoError(t, err)
		child := f.receipts(t)[0]
		require.Equal(t, "failed", child.Status)
		require.NotEmpty(t, child.VMID, "the receipt owns the machine it booted")
		require.Len(t, f.provider.Live(), 2)
		f.provider.DeleteErr = nil
		require.NoError(t, f.svc.ReapWorkspaceChildren(ctx))
		require.Equal(t, []string{f.parent.VmID}, f.provider.Live())
	})
}

func TestWorkspaceChildrenStayOutOfCredentialedRecovery(t *testing.T) {
	f := newChildFixture(t, nil)
	f.provider.SnapshotErr = errors.New("hold the children in starting")
	ctx := context.Background()
	batch, err := f.svc.SpawnWorkspaceChildren(ctx, SpawnWorkspaceChildrenInput{RepositoryID: f.repo, UserID: f.user, ParentWorkspaceID: f.parent.ID, Count: 1})
	require.NoError(t, err)
	require.NoError(t, f.svc.WaitForProvisioning(ctx))
	f.exec(t, `UPDATE workspace_children SET stopped_at = NULL, stop_reason = NULL, failure_message = NULL`)
	f.exec(t, `UPDATE workspaces SET status = 'starting', deleted_at = NULL, updated_at = now() - interval '1 hour' WHERE id = $1`, batch.Children[0].WorkspaceID)
	rows, err := f.queries.ListWorkspaceProvisioningRecovery(ctx)
	require.NoError(t, err)
	for _, row := range rows {
		require.NotEqual(t, batch.Children[0].WorkspaceID, row.ID)
	}
}

func TestWorkspaceChildrenNeedTheSandboxProvider(t *testing.T) {
	svc := NewWorkspaceService(&mockWorkspaceQuerier{})
	_, err := svc.SpawnWorkspaceChildren(context.Background(), SpawnWorkspaceChildrenInput{Count: 1})
	requireChildAPIError(t, err, pkgerrors.CodeConflict, "sandbox provider")
	_, err = svc.ListWorkspaceChildren(context.Background(), "w", 1, 1)
	requireChildAPIError(t, err, pkgerrors.CodeConflict, "sandbox provider")
	require.NoError(t, svc.ReapWorkspaceChildren(context.Background()))
	handled, err := svc.runningWorkspaceChild(context.Background(), db.Workspace{IsFork: true})
	require.NoError(t, err)
	require.False(t, handled)
	svc.cascadeWorkspaceChildren(context.Background(), "w", "stopped")
	require.NoError(t, svc.WaitForProvisioning(context.Background()))
}

func TestWithoutWorkspaceBootstrap(t *testing.T) {
	req := sandbox.CreateRequest{
		Files: map[string]sandbox.SandboxFile{workspaceClaudeScriptPath: {}, "/keep": {}},
		Init: &sandbox.ServiceConfig{Services: []sandbox.ServiceSpec{
			{Name: workspaceClaudeService}, {Name: workspaceReadyService},
		}},
	}
	original := req.Init
	withoutWorkspaceBootstrap(&req)
	require.Equal(t, map[string]sandbox.SandboxFile{"/keep": {}}, req.Files)
	require.Equal(t, []sandbox.ServiceSpec{{Name: workspaceReadyService}}, req.Init.Services)
	require.Len(t, original.Services, 2, "the caller's init is not mutated")
	bare := sandbox.CreateRequest{}
	withoutWorkspaceBootstrap(&bare)
	require.Nil(t, bare.Init)
}

// childFaults fails the one named sqlc query (or BEGIN) inside child
// transactions, so every storage refusal is exercised against real PostgreSQL.
type childFaults struct {
	pool *pgxpool.Pool
	name atomic.Value
}

var errChildFault = errors.New("injected storage fault")

func (c *childFaults) failing(sql string) bool {
	name, _ := c.name.Load().(string)
	return name != "" && strings.Contains(sql, "-- name: "+name+" ")
}

func (c *childFaults) Begin(ctx context.Context) (pgx.Tx, error) {
	if name, _ := c.name.Load().(string); name == "BEGIN" {
		return nil, errChildFault
	}
	tx, err := c.pool.Begin(ctx)
	return childFaultTx{Tx: tx, faults: c}, err
}

type childFaultTx struct {
	pgx.Tx
	faults *childFaults
}

type childFaultRow struct{}

func (childFaultRow) Scan(...any) error { return errChildFault }

func (tx childFaultTx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	if tx.faults.failing(sql) {
		return pgconn.CommandTag{}, errChildFault
	}
	return tx.Tx.Exec(ctx, sql, args...)
}

func (tx childFaultTx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	if tx.faults.failing(sql) {
		return nil, errChildFault
	}
	return tx.Tx.Query(ctx, sql, args...)
}

func (tx childFaultTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	if tx.faults.failing(sql) {
		return childFaultRow{}
	}
	return tx.Tx.QueryRow(ctx, sql, args...)
}

// requireChildFault accepts the injected fault itself or an API error caused by it.
func requireChildFault(t *testing.T, err error) {
	t.Helper()
	var apiErr *pkgerrors.APIError
	if errors.As(err, &apiErr) {
		err = apiErr.Cause()
	}
	require.ErrorIs(t, err, errChildFault)
}

func (f *childFixture) inject(name string) *childFaults {
	faults := &childFaults{pool: f.pool}
	faults.name.Store(name)
	f.svc.transactions = faults
	return faults
}

func TestWorkspaceChildrenSurfaceEveryStorageFault(t *testing.T) {
	for _, name := range []string{
		"BEGIN", "LockUserForWorkspaceChildren", "GetWorkspaceChildParentForUpdate", "IsWorkspaceChild",
		"CountLiveWorkspaceChildren", "CreateWorkspaceChildBatch", "ReserveWorkspaceChildren",
		"CreateWorkspaceChildRows", "ListWorkspaceChildOrdinals",
	} {
		t.Run("admission "+name, func(t *testing.T) {
			f := newChildFixture(t, nil)
			f.inject(name)
			_, err := f.spawn(t, 2, "")
			requireChildFault(t, err)
			var rows int
			require.NoError(t, f.pool.QueryRow(context.Background(), `SELECT count(*) FROM workspace_children`).Scan(&rows))
			require.Zero(t, rows, "a refused admission commits nothing")
		})
	}

	t.Run("an unrecorded snapshot is deleted and fails the batch", func(t *testing.T) {
		f := newChildFixture(t, nil)
		f.inject("SetWorkspaceChildBatchSnapshot")
		_, err := f.spawn(t, 2, "")
		require.NoError(t, err)
		require.Empty(t, f.provider.Snapshots())
		require.Len(t, f.provider.Released(), 1)
		for _, child := range f.receipts(t) {
			require.Equal(t, "failed", child.Status)
			require.Contains(t, child.FailureMessage, errChildFault.Error())
		}
	})
	t.Run("a leaked unrecorded snapshot is only logged", func(t *testing.T) {
		f := newChildFixture(t, nil)
		f.inject("SetWorkspaceChildBatchSnapshot")
		f.provider.DeleteSnapshotErr = errors.New("controller unavailable")
		_, err := f.spawn(t, 1, "")
		require.NoError(t, err)
		require.Len(t, f.provider.Snapshots(), 1)
		require.Equal(t, "failed", f.receipts(t)[0].Status)
	})
	t.Run("an unrecorded start deletes the machine", func(t *testing.T) {
		f := newChildFixture(t, nil)
		f.inject("StartWorkspaceChild")
		_, err := f.spawn(t, 1, "")
		require.NoError(t, err)
		child := f.receipts(t)[0]
		require.Equal(t, "failed", child.Status)
		require.Contains(t, child.FailureMessage, "record the child")
		require.Equal(t, []string{f.parent.VmID}, f.provider.Live())
	})
	t.Run("an unrecorded failure leaves the child for the sweep", func(t *testing.T) {
		f := newChildFixture(t, nil)
		f.inject("StopWorkspaceChild")
		f.provider.CreateErr = func(sandbox.CreateRequest) error { return errors.New("no capacity") }
		_, err := f.spawn(t, 1, "")
		require.NoError(t, err)
		child := f.receipts(t)[0]
		require.Nil(t, child.StoppedAt)
		f.inject("")
		f.exec(t, `UPDATE workspace_children SET created_at = now() - interval '11 minutes'`)
		require.NoError(t, f.svc.ReapWorkspaceChildren(context.Background()))
		require.Equal(t, "abandoned", f.receipts(t)[0].StopReason)
	})
	t.Run("listing and sweeping report their faults", func(t *testing.T) {
		f := newChildFixture(t, nil)
		ctx := context.Background()
		_, err := f.spawn(t, 1, "")
		require.NoError(t, err)
		f.inject("ListWorkspaceChildReceipts")
		_, err = f.svc.ListWorkspaceChildren(ctx, f.parent.ID, f.repo, f.user)
		requireChildFault(t, err)
		f.inject("ListReapableWorkspaceChildren")
		requireChildFault(t, f.svc.ReapWorkspaceChildren(ctx))
		f.svc.cascadeWorkspaceChildren(ctx, f.parent.ID, "stopped")
		require.NoError(t, f.svc.WaitForProvisioning(ctx), "a failed cascade is only logged")
		f.inject("IsWorkspaceChild")
		_, err = f.svc.ensureExistingWorkspaceRunning(ctx, db.Workspace{ID: f.parent.ID, IsFork: true, Status: "suspended"})
		requireChildFault(t, err)

		f.inject("ListUnreleasedWorkspaceChildVMs")
		requireChildFault(t, f.svc.ReapWorkspaceChildren(ctx))

		f.inject("")
		f.exec(t, `UPDATE workspace_child_batches SET expires_at = now() - interval '1 second'`)
		f.inject("StopWorkspaceChild")
		requireChildFault(t, f.svc.ReapWorkspaceChildren(ctx))
		require.Nil(t, f.receipts(t)[0].StoppedAt)
		f.inject("ListDrainedWorkspaceChildSnapshots")
		requireChildFault(t, f.svc.ReapWorkspaceChildren(ctx))
		require.Equal(t, "expired", f.receipts(t)[0].StopReason)
		f.inject("MarkWorkspaceChildSnapshotDeleted")
		requireChildFault(t, f.svc.ReapWorkspaceChildren(ctx))
		f.inject("")
		f.provider.DeleteSnapshotErr = errors.New("controller unavailable")
		require.ErrorContains(t, f.svc.ReapWorkspaceChildren(ctx), "controller unavailable")
		f.provider.DeleteSnapshotErr = nil
		require.NoError(t, f.svc.ReapWorkspaceChildren(ctx), "an already deleted snapshot counts as released")
		var deleted bool
		require.NoError(t, f.pool.QueryRow(ctx, `SELECT bool_and(snapshot_deleted_at IS NOT NULL) FROM workspace_child_batches`).Scan(&deleted))
		require.True(t, deleted)
	})
	t.Run("an unrecorded machine is deleted at once", func(t *testing.T) {
		f := newChildFixture(t, nil)
		f.inject("RecordWorkspaceChildVM")
		_, err := f.spawn(t, 1, "")
		require.NoError(t, err)
		require.Equal(t, "failed", f.receipts(t)[0].Status)
		require.Equal(t, []string{f.parent.VmID}, f.provider.Live())
	})
	t.Run("an unrecorded release is retried by the sweep", func(t *testing.T) {
		f := newChildFixture(t, nil)
		ctx := context.Background()
		_, err := f.spawn(t, 1, "")
		require.NoError(t, err)
		f.exec(t, `UPDATE workspace_child_batches SET expires_at = now() - interval '1 second'`)
		f.inject("ReleaseWorkspaceChildVM")
		requireChildFault(t, f.svc.ReapWorkspaceChildren(ctx))
		f.inject("")
		require.NoError(t, f.svc.ReapWorkspaceChildren(ctx), "an already deleted machine counts as released")
		live, err := f.queries.CountLiveWorkspaceChildren(ctx, f.user)
		require.NoError(t, err)
		require.Zero(t, live)
	})
	t.Run("a child stopped while booting keeps an undeletable machine for the sweep", func(t *testing.T) {
		f := newChildFixture(t, nil)
		f.provider.CreateErr = func(sandbox.CreateRequest) error {
			_, err := f.pool.Exec(context.Background(),
				`UPDATE workspace_children SET stopped_at = now(), stop_reason = 'requested' WHERE stopped_at IS NULL`)
			return err
		}
		f.inject("ReleaseWorkspaceChildVM")
		_, err := f.spawn(t, 1, "")
		require.NoError(t, err)
		f.inject("")
		f.provider.CreateErr = nil
		require.NoError(t, f.svc.ReapWorkspaceChildren(context.Background()))
		require.Equal(t, []string{f.parent.VmID}, f.provider.Live())
	})
	t.Run("an unknown parent lists nothing", func(t *testing.T) {
		f := newChildFixture(t, nil)
		_, err := f.svc.ListWorkspaceChildren(context.Background(), "00000000-0000-4000-8000-000000000001", f.repo, f.user)
		requireChildAPIError(t, err, pkgerrors.CodeNotFound, "")
	})
}

func TestWorkspaceChildStopIsIdempotent(t *testing.T) {
	f := newChildFixture(t, nil)
	ctx := context.Background()
	_, err := f.spawn(t, 1, "")
	require.NoError(t, err)
	child := f.receipts(t)[0]
	require.NoError(t, f.svc.stopWorkspaceChild(ctx, child.WorkspaceID, "requested", ""))
	require.NoError(t, f.svc.stopWorkspaceChild(ctx, child.WorkspaceID, "expired", ""), "a second stop is a no-op")
	require.Equal(t, "requested", f.receipts(t)[0].StopReason)
	require.NoError(t, f.svc.ReapWorkspaceChildren(ctx))
	require.Equal(t, []string{f.parent.VmID}, f.provider.Live())
}

func TestWorkspaceChildrenInheritTheOutsiderMark(t *testing.T) {
	f := newChildFixture(t, nil)
	ctx := context.Background()
	require.NoError(t, f.queries.MarkOutsiderWorkspace(ctx, f.repo, f.parent.ID))
	_, err := f.spawn(t, 1, "")
	require.NoError(t, err)
	child := f.receipts(t)[0]
	outsider, err := f.queries.IsOutsiderWorkspace(ctx, child.WorkspaceID)
	require.NoError(t, err)
	require.True(t, outsider)
	require.Equal(t, sandbox.ConversationWithheldHostRules(), f.provider.Creates()[0].EgressProxy.HostRules)

	t.Run("a mark that cannot be read fails the child", func(t *testing.T) {
		f := newChildFixture(t, nil)
		f.svc.q = childOutsiderFault{Queries: f.queries}
		_, err := f.spawn(t, 1, "")
		require.NoError(t, err)
		require.Contains(t, f.receipts(t)[0].FailureMessage, "outsider mark")
	})
	t.Run("a request that cannot be built fails the child", func(t *testing.T) {
		f := newChildFixture(t, nil)
		f.svc.agentEnvironment = childTestSecretsFault{}
		_, err := f.spawn(t, 1, "")
		require.NoError(t, err)
		require.Contains(t, f.receipts(t)[0].FailureMessage, "build the child request")
	})
}

type childOutsiderFault struct{ *db.Queries }

func (childOutsiderFault) IsOutsiderWorkspace(context.Context, string) (bool, error) {
	return false, errChildFault
}

type childTestSecretsFault struct{ childTestSecrets }

func (childTestSecretsFault) LoadProxyBoundSecrets(context.Context, int64) ([]sandbox.EgressProxySecret, error) {
	return nil, errChildFault
}

func TestSandboxEntitlementCarriesChildLimits(t *testing.T) {
	for _, tc := range []struct {
		plan            string
		concurrent, ttl int64
	}{
		{BillingPlanFree, 0, 0},
		{BillingPlanPro, 16, 4 * 3600},
		{BillingPlanMax, 16, 8 * 3600},
	} {
		t.Run(tc.plan, func(t *testing.T) {
			svc, _ := sandboxTestBilling(tc.plan)
			entitlement, err := svc.SandboxEntitlement(context.Background(), 7)
			require.NoError(t, err)
			require.Equal(t, tc.plan, entitlement.PlanKey)
			require.Equal(t, tc.concurrent, entitlement.ConcurrentChildren)
			require.Equal(t, tc.ttl, entitlement.ChildMaxTTLSecs)
		})
	}
}
