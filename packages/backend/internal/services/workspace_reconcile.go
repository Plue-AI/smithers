package services

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/runtimeports"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

// WorkspaceProvisioningReconcileInterval is how often the provisioning
// reconciler re-drives workspaces and sessions a rollout left pending.
const WorkspaceProvisioningReconcileInterval = 5 * time.Second

// WorkspaceProvisioningDrainTimeout bounds the shutdown join of detached
// provisioning goroutines: one full provisioning attempt plus margin.
const WorkspaceProvisioningDrainTimeout = workspaceProvisionTimeout + time.Minute

var errWorkspaceProvisionInProgress = errors.New("workspace provisioning is owned by another API")

// workspaceProvisionInProgress keeps the sentinel for internal callers and
// answers synchronous API callers with a retryable 503.
func workspaceProvisionInProgress(cause error) error {
	err := fmt.Errorf("%w: %w", errWorkspaceProvisionInProgress, pkgerrors.GuestNotReady("workspace is provisioning; retry shortly"))
	if cause != nil {
		return errors.Join(err, cause)
	}
	return err
}

type workspaceProvisionTasks struct {
	slots  chan struct{}
	wg     sync.WaitGroup
	active sync.Map
}

func newWorkspaceProvisionTasks() *workspaceProvisionTasks {
	return &workspaceProvisionTasks{slots: make(chan struct{}, 4)}
}

// trackProvision registers a detached provisioning goroutine so shutdown can
// join it. The returned func must be called when the goroutine exits.
func (s *WorkspaceService) trackProvision() func() {
	if s.provisionTasks == nil {
		return func() {}
	}
	s.provisionTasks.wg.Add(1)
	return s.provisionTasks.wg.Done
}

type workspaceRecoveryQueries interface {
	ListWorkspaceProvisioningRecovery(context.Context) ([]db.ListWorkspaceProvisioningRecoveryRow, error)
	CompletePendingWorkspaceSessions(context.Context, string) ([]string, error)
}

func (s *WorkspaceService) durableProvisioning() bool {
	_, durable := s.q.(workspaceRecoveryQueries)
	return durable
}

// WaitForProvisioning joins detached provisioning goroutines. HTTP shutdown
// cannot see them, so the process joins them before closing the database pool.
func (s *WorkspaceService) WaitForProvisioning(ctx context.Context) error {
	if s == nil || s.provisionTasks == nil {
		return nil
	}
	done := make(chan struct{})
	go func() { s.provisionTasks.wg.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// WithWorkspaceTransactions lets the service hold a workspace's provisioning
// lock across processes. Without it provisioning is serialized per process.
func WithWorkspaceTransactions(transactions RepositoryJobTransactions) WorkspaceServiceOption {
	return func(s *WorkspaceService) { s.transactions = transactions }
}

// Ownership is a database connection's advisory transaction lock, so an API
// crash releases it immediately. Row age is never evidence of failure.
func (s *WorkspaceService) withWorkspaceProvisionLock(ctx context.Context, workspace db.Workspace, fn func(db.Workspace) (db.Workspace, error)) (db.Workspace, error) {
	if s.transactions == nil || s.provisionTasks == nil {
		return fn(workspace)
	}
	// Keep ownership connections below the pool's query budget.
	select {
	case s.provisionTasks.slots <- struct{}{}:
		defer func() { <-s.provisionTasks.slots }()
	case <-ctx.Done():
		return workspace, ctx.Err()
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return workspace, workspaceProvisionInProgress(err)
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	acquired, err := db.New(tx).TryLockWorkspaceProvisioning(ctx, workspace.ID)
	if err != nil {
		return workspace, err
	}
	if !acquired {
		return workspace, workspaceProvisionInProgress(nil)
	}
	current, err := s.q.GetWorkspace(ctx, workspace.ID)
	if err != nil {
		return workspace, err
	}
	if current.DeletedAt.Valid {
		return current, pgx.ErrNoRows
	}
	return fn(current)
}

// ReconcileWorkspaceProvisioning re-drives workspaces left pending or starting
// by a stopped API and completes sessions waiting on a running workspace.
func (s *WorkspaceService) ReconcileWorkspaceProvisioning(ctx context.Context) error {
	q, ok := s.q.(workspaceRecoveryQueries)
	if !ok {
		return nil
	}
	rows, err := q.ListWorkspaceProvisioningRecovery(ctx)
	if err != nil {
		return err
	}
	for _, row := range rows {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		ws, err := s.q.GetWorkspace(ctx, row.ID)
		if err != nil {
			continue
		}
		s.provisionWorkspaceAsync(ctx, ws, CreateWorkspaceSessionInput{RepositoryID: row.RepositoryID, UserID: row.UserID, RepoOwner: row.RepositoryOwner, RepoName: row.RepositoryName, SourceBookmark: row.TargetBookmark})
	}
	return nil
}

// RunProvisioningReconciler reconciles now and then every
// WorkspaceProvisioningReconcileInterval until ctx is done.
func (s *WorkspaceService) RunProvisioningReconciler(ctx context.Context) {
	runWorkspaceProvisioningReconciler(ctx, WorkspaceProvisioningReconcileInterval, s.ReconcileWorkspaceProvisioning)
}

func runWorkspaceProvisioningReconciler(ctx context.Context, interval time.Duration, reconcile func(context.Context) error) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		func() {
			defer func() {
				if r := recover(); r != nil {
					slog.Error("workspace provisioning reconciliation panicked", "panic", r)
				}
			}()
			if err := reconcile(ctx); err != nil && ctx.Err() == nil {
				slog.Error("workspace provisioning reconciliation failed", "error", err)
			}
		}()
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *WorkspaceService) completeRecoveredSessions(ctx context.Context, id string) {
	q, ok := s.q.(workspaceRecoveryQueries)
	if !ok {
		return
	}
	ids, err := q.CompletePendingWorkspaceSessions(ctx, id)
	if err != nil {
		slog.Error("complete recovered workspace sessions", "workspace_id", id, "error", err)
		return
	}
	for _, sessionID := range ids {
		s.notifyWorkspaceSession(ctx, sessionID, "running")
	}
}

// Serialize the guest-side clone too: an old exec may still be finishing
// after its API disappeared. Completion lives beside the repository, so retry
// never removes an already initialized working copy.
func workspaceCloneOnce(command, marker string) string {
	return "mkdir -p " + shellQuote(marker) + " || exit $?\n(\nif command -v flock >/dev/null 2>&1; then flock 9 || exit $?; fi\nif [ -f " + shellQuote(marker+"/.complete") + " ]; then exit 0; fi\n(\nset -e\n" + command + "\n)\nrc=$?; [ \"$rc\" = 0 ] || exit \"$rc\"\ntouch " + shellQuote(marker+"/.complete") + "\n) 9>" + shellQuote(marker+"/.lock")
}

const workspaceCloneMarker = "/var/lib/smithers/workspace-clone"

// recoverUnregisteredWorkspaceVM adopts a sandbox the provider accepted before
// the API persisted vm_id. The inventory is deployment-owned, so this runs only
// when the Workspaces store implements runtimeports.WorkspaceSandboxAdoption.
func (s *WorkspaceService) recoverUnregisteredWorkspaceVM(ctx context.Context, workspace db.Workspace) (db.Workspace, error) {
	q, ok := s.q.(runtimeports.WorkspaceSandboxAdoption)
	if !ok || strings.TrimSpace(workspace.VmID) != "" || s.sandbox == nil {
		return workspace, nil
	}
	id, err := q.FindUnregisteredWorkspaceSandbox(ctx, workspace.ID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && strings.TrimSpace(id) == "") {
		return workspace, nil
	}
	if err != nil {
		return workspace, err
	}
	vm, err := s.sandbox.InspectSandbox(ctx, id)
	if err != nil || vm.State != sandbox.StateRunning {
		return workspace, workspaceProvisionInProgress(err)
	}
	updated, _, err := s.registerNewWorkspaceVM(ctx, workspace, id, "starting")
	return updated, err
}
