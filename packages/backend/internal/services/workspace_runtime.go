package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/runtimeports"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// WorkspaceCommandInput is an admitted interactive command. OperationID is a
// durable retry identity supplied by the product request; command output is
// direct execution evidence and is not a Flow completion receipt.
type WorkspaceCommandInput struct {
	OperationID string            `json:"operation_id"`
	Args        []string          `json:"args"`
	Directory   string            `json:"directory,omitempty"`
	Environment map[string]string `json:"environment,omitempty"`
}

type WorkspaceCommandResult struct {
	ExitCode        int                       `json:"exit_code"`
	Stdout          string                    `json:"stdout"`
	Stderr          string                    `json:"stderr"`
	OutputTruncated bool                      `json:"output_truncated"`
	Error           *microsandbox.RecipeError `json:"error,omitempty"`
}

type WorkspaceServiceLaunchInput struct {
	OperationID string            `json:"operation_id"`
	Name        string            `json:"name"`
	Args        []string          `json:"args"`
	Directory   string            `json:"directory,omitempty"`
	Environment map[string]string `json:"environment,omitempty"`
	Port        uint16            `json:"port,omitempty"`
}

// WorkspacePreviewAccess is consumed by the authenticated HTTP preview
// handler. Proxy is true only for a loopback target that must never be exposed
// as a browser-visible upstream URL.
type WorkspacePreviewAccess struct {
	URL   string
	Proxy bool
}

type workspaceRuntimeLock struct {
	mutex      sync.Mutex
	references int
}

// workspaceRuntimeLockRegistry serializes lifecycle transitions for one
// product workspace while allowing unrelated tenants and workspaces to make
// progress independently. WorkspaceService config copies share the pointer.
type workspaceRuntimeLockRegistry struct {
	mutex   sync.Mutex
	entries map[string]*workspaceRuntimeLock
}

func (s *WorkspaceService) lockRuntimeWorkspace(workspaceID string) func() {
	if s.runtimeLocks == nil {
		s.runtimeLocks = &workspaceRuntimeLockRegistry{entries: make(map[string]*workspaceRuntimeLock)}
	}
	registry := s.runtimeLocks
	workspaceID = strings.TrimSpace(workspaceID)
	registry.mutex.Lock()
	entry := registry.entries[workspaceID]
	if entry == nil {
		entry = &workspaceRuntimeLock{}
		registry.entries[workspaceID] = entry
	}
	entry.references++
	registry.mutex.Unlock()
	entry.mutex.Lock()
	return func() {
		entry.mutex.Unlock()
		registry.mutex.Lock()
		entry.references--
		if entry.references == 0 && registry.entries[workspaceID] == entry {
			delete(registry.entries, workspaceID)
		}
		registry.mutex.Unlock()
	}
}

func detachedRuntimeContext(parent context.Context, timeout time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(parent), timeout)
}

func (s *WorkspaceService) hasWorkspaceRuntime() bool {
	return s != nil && s.runtime != nil
}

func (s *WorkspaceService) workspaceRuntimeContext(ctx context.Context, row db.Workspace, requesterID int64, operationID string) (context.Context, error) {
	operation := workspaceapi.Operation{
		TenantID:    strconv.FormatInt(row.UserID, 10),
		PrincipalID: strconv.FormatInt(requesterID, 10),
		OperationID: strings.TrimSpace(operationID),
	}
	if s.runtimeIdentity != nil {
		resolved, err := s.runtimeIdentity(ctx, row, requesterID)
		if err != nil {
			return nil, pkgerrors.Internal("resolve workspace runtime identity").WithCause(err)
		}
		operation.TenantID = strings.TrimSpace(resolved.TenantID)
		operation.PrincipalID = strings.TrimSpace(resolved.PrincipalID)
		if operation.OperationID == "" {
			operation.OperationID = strings.TrimSpace(resolved.OperationID)
		}
	}
	if operation.TenantID == "" || operation.PrincipalID == "" {
		return nil, pkgerrors.Internal("workspace runtime identity unavailable")
	}
	return workspaceapi.WithOperation(ctx, operation), nil
}

func workspaceLifecycleOperation(row db.Workspace, action string) string {
	version := row.UpdatedAt.UTC().UnixNano()
	if version == 0 {
		version = row.CreatedAt.UTC().UnixNano()
	}
	return fmt.Sprintf("workspace:%s:g%d:v%d:%s", row.ID, row.ProvisioningGeneration, version, action)
}

// ensureRuntimeWorkspaceRunning creates or starts the workspace for a
// requester with write authority over it, held for the whole transition.
func (s *WorkspaceService) ensureRuntimeWorkspaceRunning(ctx context.Context, row db.Workspace, requesterID int64) (db.Workspace, error) {
	result := row
	err := s.withWorkspaceMutationAuthority(ctx, row, requesterID, func(ctx context.Context) error {
		unlock := s.lockRuntimeWorkspace(row.ID)
		defer unlock()
		current, err := s.currentRuntimeWorkspaceLocked(ctx, row)
		if err != nil {
			return err
		}
		result, err = s.ensureRuntimeWorkspaceRunningLocked(ctx, current, requesterID)
		return err
	})
	return result, err
}

// runningRuntimeWorkspace serves a reader: it returns the workspace only while
// it already runs and never creates or starts it.
func (s *WorkspaceService) runningRuntimeWorkspace(ctx context.Context, row db.Workspace, requesterID int64) (db.Workspace, error) {
	if !s.hasWorkspaceRuntime() {
		return row, pkgerrors.Internal("workspace runtime unavailable")
	}
	unlock := s.lockRuntimeWorkspace(row.ID)
	defer unlock()
	current, err := s.currentRuntimeWorkspaceLocked(ctx, row)
	if err != nil {
		return row, err
	}
	if current.Status != "running" {
		return current, errWorkspaceStopped()
	}
	operationCtx, err := s.workspaceRuntimeContext(ctx, current, requesterID, "")
	if err != nil {
		return current, err
	}
	observed, err := s.runtime.InspectWorkspace(operationCtx, current.ID)
	if err != nil {
		if errors.Is(err, workspaceapi.ErrWorkspaceNotFound) {
			return current, errWorkspaceStopped()
		}
		return current, runtimeOperationError("inspect workspace runtime", err)
	}
	if validationErr := validateRuntimeWorkspace(current.ID, observed); validationErr != nil {
		return current, pkgerrors.Internal(validationErr.Error())
	}
	if observed.State != workspaceapi.WorkspaceRunning {
		return current, errWorkspaceStopped()
	}
	return current, nil
}

// currentRuntimeWorkspaceLocked refreshes mutable product state after the
// caller enters the per-workspace critical section. A request may have loaded
// a running row before a concurrent suspend, stop, or delete completed; using
// that stale row could restart execution without restoring the product state.
// runtimeWorkspaceSpec names the repository revision the checkout will hold,
// so an isolated runtime can boot the matching prepared environment. The
// source is a hint for environment selection only; checkout authority stays
// in ensureRuntimeWorkspaceRepository.
//
// VM and desktop workspaces always boot a registered NixOS image. A placed
// closure selects its exact image; an ordinary workspace resolves the current
// repository image or platform base. Neither can fall back to a container.
func (s *WorkspaceService) runtimeWorkspaceSpec(ctx context.Context, row db.Workspace) (workspaceapi.WorkspaceSpec, error) {
	if strings.TrimSpace(row.Kind) == "desktop" {
		return workspaceapi.WorkspaceSpec{ID: row.ID}, pkgerrors.BadRequest("kind must be container or vm")
	}
	resources, err := s.runtimeWorkspaceResources(row)
	if err != nil {
		return workspaceapi.WorkspaceSpec{ID: row.ID}, err
	}
	spec := workspaceapi.WorkspaceSpec{ID: row.ID, Resources: resources}
	if kind := sandboxKindForWorkspace(row.Kind); kind != "container" {
		if !s.runtime.Capabilities().EnvironmentImages {
			return spec, pkgerrors.EnvironmentImageUnavailable("this workspace runtime cannot boot a NixOS environment image")
		}
		if s.environmentImages == nil {
			return spec, pkgerrors.EnvironmentImageUnavailable("this deployment has no NixOS environment image registry")
		}
		var image runtimeports.SandboxEnvironmentImage
		if closure := strings.TrimSpace(row.EnvironmentClosureHash); closure != "" {
			image, err = s.environmentImages.Pinned(ctx, row.RepositoryID, kind, closure)
		} else {
			image, err = s.environmentImages.Resolve(ctx, row.RepositoryID, kind)
		}
		if err != nil {
			return spec, err
		}
		spec.Environment = &workspaceapi.WorkspaceEnvironmentImage{Kind: kind, Image: image.Image, ClosureHash: image.ClosureHash}
	}
	if row.RepositoryID <= 0 {
		return spec, nil
	}
	slug, err := s.workspaceRepoSlug(ctx, row.RepositoryID)
	if err != nil {
		return spec, nil
	}
	spec.Source = &workspaceapi.WorkspaceSource{Repository: slug, Revision: targetWorkspaceBookmark(row.TargetBookmark)}
	return spec, nil
}

func (s *WorkspaceService) currentRuntimeWorkspaceLocked(ctx context.Context, expected db.Workspace) (db.Workspace, error) {
	current, err := s.q.GetWorkspace(ctx, expected.ID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return expected, pkgerrors.NotFound("workspace not found")
		}
		return expected, pkgerrors.Internal("reload workspace state: " + err.Error())
	}
	if current.ID != expected.ID || current.RepositoryID != expected.RepositoryID || current.UserID != expected.UserID {
		return expected, pkgerrors.Internal("workspace identity changed during runtime reconciliation")
	}
	return current, nil
}

func validateRuntimeWorkspace(expectedID string, observed workspaceapi.Workspace) error {
	if observed.ID != expectedID {
		return fmt.Errorf("runtime returned workspace %q for %q", observed.ID, expectedID)
	}
	return nil
}

// lostWorkerError keeps the controller's typed host_lease_lost (503, infra)
// when a workspace's worker was replaced, as the create path does
// (workspaceProvisioningError); nil for any other cause.
func lostWorkerError(err error) error {
	if details := workspaceFailureDetailsFor(err); details.Code == pkgerrors.CodeHostLeaseLost {
		return pkgerrors.New(details.Code, details.Message)
	}
	return nil
}

// lostWorker reports whether err is the typed lost-worker failure, which a
// caller passes through instead of recasting as a data error.
func lostWorker(err error) bool {
	var apiErr *pkgerrors.APIError
	return errors.As(err, &apiErr) && apiErr.Code == pkgerrors.CodeHostLeaseLost
}

// runtimeOperationError types a failed runtime call: a lost worker is an
// infrastructure fault the user retries elsewhere, not a product bug.
func runtimeOperationError(operation string, err error) error {
	if lost := lostWorkerError(err); lost != nil {
		return lost
	}
	// A full host refused before it touched a machine: the honest answer is
	// no_capacity, as on the sandbox path (workspaceProvisioningError).
	if isMachineCapacityError(err) {
		return pkgerrors.NoCapacity(workspaceNoCapacityMessage).WithCause(err)
	}
	return pkgerrors.Internal(operation + ": " + err.Error())
}

func (s *WorkspaceService) ensureRuntimeWorkspaceRunningLocked(ctx context.Context, row db.Workspace, requesterID int64) (db.Workspace, error) {
	if err := s.refuseRebuildRequired(row); err != nil {
		return row, err
	}
	if !s.hasWorkspaceRuntime() {
		return row, pkgerrors.Internal("workspace runtime unavailable")
	}
	operationCtx, err := s.workspaceRuntimeContext(ctx, row, requesterID, workspaceLifecycleOperation(row, "inspect"))
	if err != nil {
		return row, err
	}

	var observed workspaceapi.Workspace
	if row.Status == "failed" {
		return row, pkgerrors.Conflict("workspace provisioning failed; create a fresh workspace")
	}
	create := row.Status == "pending" || row.Status == "starting"
	if create {
		createCtx, contextErr := s.workspaceRuntimeContext(ctx, row, requesterID, workspaceLifecycleOperation(row, "create"))
		if contextErr != nil {
			return row, contextErr
		}
		if err := s.withholdRuntimeConversation(ctx, row, requesterID); err != nil {
			return row, err
		}
		spec, specErr := s.runtimeWorkspaceSpec(ctx, row)
		if specErr != nil {
			return row, specErr
		}
		observed, err = s.runtime.CreateWorkspace(createCtx, spec)
	} else {
		observed, err = s.runtime.InspectWorkspace(operationCtx, row.ID)
	}
	if err != nil {
		if errors.Is(err, workspaceapi.ErrWorkspaceNotFound) {
			return row, s.missingWorkspaceVM(ctx, row, requesterID)
		}
		return row, runtimeOperationError("inspect workspace runtime", err)
	}
	if validationErr := validateRuntimeWorkspace(row.ID, observed); validationErr != nil {
		if create {
			cleanupCtx, cancel := detachedRuntimeContext(ctx, 30*time.Second)
			_ = s.deleteRuntimeWorkspaceLocked(cleanupCtx, row, requesterID)
			cancel()
		}
		return row, pkgerrors.Internal(validationErr.Error())
	}

	if observed.State == workspaceapi.WorkspaceStopped {
		// Creation already holds the admission made before the product row was
		// inserted. A later resume must recheck the common billing policy.
		if !create {
			if err := s.authorizeWorkspaceResume(ctx, row); err != nil {
				return row, err
			}
		}
		startCtx, contextErr := s.workspaceRuntimeContext(ctx, row, requesterID, workspaceLifecycleOperation(row, "start"))
		if contextErr != nil {
			return row, contextErr
		}
		if err := s.withholdRuntimeConversation(ctx, row, requesterID); err != nil {
			return row, err
		}
		observed, err = s.runtime.StartWorkspace(startCtx, row.ID)
		if isNoCapacityError(err) {
			return s.refuseResumeForNoCapacity(ctx, row, err)
		}
		if err != nil {
			return row, runtimeOperationError("start workspace runtime", err)
		}
		if validationErr := validateRuntimeWorkspace(row.ID, observed); validationErr != nil {
			return row, pkgerrors.Internal(validationErr.Error())
		}
	}
	if observed.State != workspaceapi.WorkspaceRunning {
		return row, pkgerrors.Conflict("workspace runtime is " + string(observed.State))
	}
	// Repository materialization is part of the common product transition to
	// running. Both trusted process and isolated runtimes execute the same
	// authorized, receipt-backed checkout before the durable row is activated.
	if err := s.ensureRuntimeWorkspaceRepository(ctx, row, requesterID); err != nil {
		return row, err
	}

	if row.Status != "running" {
		updated, updateErr := s.q.UpdateWorkspaceStatus(ctx, db.UpdateWorkspaceStatusParams{ID: row.ID, Status: "running"})
		if updateErr != nil {
			return row, pkgerrors.Internal("update workspace status: " + updateErr.Error())
		}
		row = updated
		s.meterWorkspaceUsage(ctx, row, "running")
		s.notifyWorkspace(ctx, row.ID, "running")
	}
	row = s.ensureRuntimeWorkspaceHeadReporter(ctx, row, requesterID, observed)
	_ = s.q.TouchWorkspaceActivity(ctx, row.ID)
	return row, nil
}

func (s *WorkspaceService) stopRuntimeWorkspace(ctx context.Context, row db.Workspace, requesterID int64, action string) error {
	unlock := s.lockRuntimeWorkspace(row.ID)
	defer unlock()
	return s.stopRuntimeWorkspaceLocked(ctx, row, requesterID, action)
}

func (s *WorkspaceService) stopRuntimeWorkspaceLocked(ctx context.Context, row db.Workspace, requesterID int64, action string) error {
	operationCtx, err := s.workspaceRuntimeContext(ctx, row, requesterID, workspaceLifecycleOperation(row, action))
	if err != nil {
		return err
	}
	if err := s.runtime.StopWorkspace(operationCtx, row.ID); err != nil && !errors.Is(err, workspaceapi.ErrWorkspaceStopped) && !errors.Is(err, workspaceapi.ErrWorkspaceNotFound) {
		return runtimeOperationError("stop workspace runtime", err)
	}
	return nil
}

func (s *WorkspaceService) deleteRuntimeWorkspace(ctx context.Context, row db.Workspace, requesterID int64) error {
	unlock := s.lockRuntimeWorkspace(row.ID)
	defer unlock()
	return s.deleteRuntimeWorkspaceLocked(ctx, row, requesterID)
}

func (s *WorkspaceService) deleteRuntimeWorkspaceLocked(ctx context.Context, row db.Workspace, requesterID int64) error {
	operationCtx, err := s.workspaceRuntimeContext(ctx, row, requesterID, workspaceLifecycleOperation(row, "delete"))
	if err != nil {
		return err
	}
	if err := s.runtime.DeleteWorkspace(operationCtx, row.ID); err != nil && !errors.Is(err, workspaceapi.ErrWorkspaceNotFound) {
		return runtimeOperationError("delete workspace runtime", err)
	}
	return nil
}

func (s *WorkspaceService) runtimeSnapshots() (workspaceapi.WorkspaceSnapshots, error) {
	if !s.hasWorkspaceRuntime() || !s.runtime.Capabilities().ColdSnapshots {
		return nil, pkgerrors.New(pkgerrors.CodeNotImplemented, "workspace runtime does not support cold snapshots")
	}
	snapshots, ok := s.runtime.(workspaceapi.WorkspaceSnapshots)
	if !ok {
		return nil, pkgerrors.Internal("workspace runtime advertises cold snapshots without implementing them")
	}
	return snapshots, nil
}

func (s *WorkspaceService) restoreRuntimeWorkspaceSnapshot(ctx context.Context, row db.Workspace, snapshot db.WorkspaceSnapshot, requesterID int64) (db.Workspace, error) {
	snapshots, err := s.runtimeSnapshots()
	if err != nil {
		return row, err
	}
	unlock := s.lockRuntimeWorkspace(row.ID)
	defer unlock()
	operationCtx, err := s.workspaceRuntimeContext(ctx, row, requesterID, workspaceLifecycleOperation(row, "restore-snapshot:"+snapshot.ID))
	if err != nil {
		return row, err
	}
	if err := s.withholdRuntimeConversation(ctx, row, requesterID); err != nil {
		return row, err
	}
	resources, err := s.runtimeWorkspaceResources(row)
	if err != nil {
		return row, err
	}
	observed, err := snapshots.ForkColdSnapshot(operationCtx, snapshot.SnapshotID, workspaceapi.WorkspaceSpec{ID: row.ID, Resources: resources})
	if err != nil {
		if errors.Is(err, workspaceapi.ErrWorkspaceNotFound) {
			return row, unavailableWorkspaceSnapshot(row, err)
		}
		return row, runtimeOperationError("restore workspace snapshot", err)
	}
	cleanupRestored := true
	defer func() {
		if !cleanupRestored {
			return
		}
		cleanupCtx, cancel := detachedRuntimeContext(ctx, 30*time.Second)
		defer cancel()
		_ = s.deleteRuntimeWorkspaceLocked(cleanupCtx, row, requesterID)
	}()
	if observed.ID != row.ID {
		return row, pkgerrors.Internal("workspace runtime restored a mismatched workspace")
	}
	if observed.State == workspaceapi.WorkspaceStopped {
		startCtx, contextErr := s.workspaceRuntimeContext(ctx, row, requesterID, workspaceLifecycleOperation(row, "start-restored-snapshot:"+snapshot.ID))
		if contextErr != nil {
			return row, contextErr
		}
		if err := s.withholdRuntimeConversation(ctx, row, requesterID); err != nil {
			return row, err
		}
		observed, err = s.runtime.StartWorkspace(startCtx, row.ID)
		if err != nil {
			return row, runtimeOperationError("start restored workspace", err)
		}
	}
	if observed.State != workspaceapi.WorkspaceRunning {
		return row, pkgerrors.Conflict("restored workspace runtime is " + string(observed.State))
	}
	if err := s.adoptRuntimeWorkspaceRepository(ctx, row, requesterID); err != nil {
		return row, err
	}
	// A restored snapshot starts signed out of its taker's vendor logins (#2805).
	if err := s.scrubRuntimeWorkspaceLogins(ctx, row, requesterID); err != nil {
		return row, err
	}
	updated, err := s.q.UpdateWorkspaceStatus(ctx, db.UpdateWorkspaceStatusParams{ID: row.ID, Status: "running"})
	if err != nil {
		return row, pkgerrors.Internal("update restored workspace status: " + err.Error())
	}
	cleanupRestored = false
	_ = s.q.TouchWorkspaceActivity(ctx, row.ID)
	s.meterWorkspaceUsage(ctx, row, "running")
	s.notifyWorkspace(ctx, row.ID, "running")
	return updated, nil
}

// Runtime forks use stack-resolved revisions, never machine snapshots. Until
// the authorized stack operation is wired, retain access checks but refuse
// before creating a workspace, waking the source, or invoking the runtime.
func (s *WorkspaceService) forkRuntimeWorkspace(ctx context.Context, input ForkWorkspaceInput) (WorkspaceResponse, error) {
	err := s.withWorkspaceMutation(ctx, input.WorkspaceID, input.RepositoryID, input.UserID, func(ctx context.Context, source db.Workspace) error {
		if err := s.requireBranchMachineProviders(); err != nil {
			return err
		}
		if err := s.enforceWorkspaceQuota(ctx, source.UserID); err != nil {
			return err
		}
		return pkgerrors.New(pkgerrors.CodeServiceUnavailable, "revision-based fork unavailable")
	})
	return WorkspaceResponse{}, err
}

func (s *WorkspaceService) createRuntimeWorkspaceSnapshot(ctx context.Context, input CreateWorkspaceSnapshotInput, snapshotName string) (WorkspaceSnapshotResponse, error) {
	var response WorkspaceSnapshotResponse
	err := s.withWorkspaceMutation(ctx, input.WorkspaceID, input.RepositoryID, input.UserID, func(ctx context.Context, row db.Workspace) error {
		var err error
		response, err = s.createRuntimeWorkspaceSnapshotAuthorized(ctx, input, snapshotName, row)
		return err
	})
	return response, err
}

func (s *WorkspaceService) createRuntimeWorkspaceSnapshotAuthorized(ctx context.Context, input CreateWorkspaceSnapshotInput, snapshotName string, row db.Workspace) (WorkspaceSnapshotResponse, error) {
	snapshots, err := s.runtimeSnapshots()
	if err != nil {
		return WorkspaceSnapshotResponse{}, err
	}
	unlock := s.lockRuntimeWorkspace(row.ID)
	defer unlock()
	row, err = s.ensureRuntimeWorkspaceRunningLocked(ctx, row, input.UserID)
	if err != nil {
		return WorkspaceSnapshotResponse{}, err
	}

	runtimeSnapshotID := "workspace-snapshot-" + uuid.NewString()
	if err := s.stopRuntimeWorkspaceLocked(ctx, row, input.UserID, "snapshot-stop:"+runtimeSnapshotID); err != nil {
		return WorkspaceSnapshotResponse{}, err
	}
	suspended, err := s.q.SuspendRunningWorkspace(ctx, row.ID)
	if err != nil {
		resumeCtx, cancel := detachedRuntimeContext(ctx, workspaceResumeProvisionTimeout)
		_, _ = s.ensureRuntimeWorkspaceRunningLocked(resumeCtx, row, input.UserID)
		cancel()
		if errors.Is(err, pgx.ErrNoRows) {
			return WorkspaceSnapshotResponse{}, pkgerrors.Conflict("workspace changed while snapshotting")
		}
		return WorkspaceSnapshotResponse{}, pkgerrors.Internal("suspend workspace for snapshot: " + err.Error())
	}
	s.meterWorkspaceUsage(ctx, row, "suspended")
	s.notifyWorkspace(ctx, row.ID, "suspended")

	operationCtx, err := s.workspaceRuntimeContext(ctx, suspended, input.UserID, workspaceLifecycleOperation(suspended, "snapshot:"+runtimeSnapshotID))
	if err != nil {
		resumeCtx, cancel := detachedRuntimeContext(ctx, workspaceResumeProvisionTimeout)
		_, _ = s.ensureRuntimeWorkspaceRunningLocked(resumeCtx, suspended, input.UserID)
		cancel()
		return WorkspaceSnapshotResponse{}, err
	}
	created, snapshotErr := snapshots.CreateColdSnapshot(operationCtx, row.ID, workspaceapi.ColdSnapshotSpec{ID: runtimeSnapshotID})
	resumeCtx, cancelResume := detachedRuntimeContext(ctx, workspaceResumeProvisionTimeout)
	resumed, resumeErr := s.ensureRuntimeWorkspaceRunningLocked(resumeCtx, suspended, input.UserID)
	cancelResume()
	if snapshotErr != nil {
		resultErr := runtimeOperationError("create workspace snapshot", snapshotErr)
		if resumeErr != nil {
			resultErr = errors.Join(resultErr, resumeErr)
		}
		return WorkspaceSnapshotResponse{}, resultErr
	}
	if created.ID != runtimeSnapshotID || created.SourceWorkspaceID != row.ID {
		deleteCtx, cancel := detachedRuntimeContext(ctx, 30*time.Second)
		if operationCtx, contextErr := s.workspaceRuntimeContext(deleteCtx, suspended, input.UserID, workspaceLifecycleOperation(suspended, "delete-snapshot:"+runtimeSnapshotID)); contextErr == nil {
			_ = snapshots.DeleteColdSnapshot(operationCtx, runtimeSnapshotID)
		}
		cancel()
		resultErr := error(pkgerrors.Internal("workspace runtime returned a mismatched snapshot"))
		if resumeErr != nil {
			resultErr = errors.Join(resultErr, resumeErr)
		}
		return WorkspaceSnapshotResponse{}, resultErr
	}
	if resumeErr != nil {
		deleteCtx, cancel := detachedRuntimeContext(ctx, 30*time.Second)
		if operationCtx, contextErr := s.workspaceRuntimeContext(deleteCtx, suspended, input.UserID, workspaceLifecycleOperation(suspended, "delete-snapshot:"+runtimeSnapshotID)); contextErr == nil {
			_ = snapshots.DeleteColdSnapshot(operationCtx, runtimeSnapshotID)
		}
		cancel()
		return WorkspaceSnapshotResponse{}, resumeErr
	}

	persisted, err := s.q.CreateWorkspaceSnapshot(ctx, db.CreateWorkspaceSnapshotParams{
		RepositoryID: row.RepositoryID,
		UserID:       row.UserID,
		WorkspaceID:  row.ID,
		Name:         snapshotName,
		SnapshotID:   runtimeSnapshotID,
	})
	if err != nil {
		deleteCtx, cancel := detachedRuntimeContext(ctx, 30*time.Second)
		if operationCtx, contextErr := s.workspaceRuntimeContext(deleteCtx, resumed, input.UserID, workspaceLifecycleOperation(resumed, "delete-snapshot:"+runtimeSnapshotID)); contextErr == nil {
			_ = snapshots.DeleteColdSnapshot(operationCtx, runtimeSnapshotID)
		}
		cancel()
		return WorkspaceSnapshotResponse{}, pkgerrors.Internal("persist workspace snapshot: " + err.Error())
	}
	return toWorkspaceSnapshotResponse(persisted), nil
}

func (s *WorkspaceService) deleteRuntimeWorkspaceSnapshot(ctx context.Context, snapshot db.WorkspaceSnapshot, requesterID int64) error {
	snapshots, err := s.runtimeSnapshots()
	if err != nil {
		return err
	}
	row, loadErr := s.q.GetWorkspace(ctx, snapshot.WorkspaceID)
	if loadErr != nil {
		row = db.Workspace{ID: snapshot.WorkspaceID, RepositoryID: snapshot.RepositoryID, UserID: snapshot.UserID, UpdatedAt: snapshot.UpdatedAt}
	}
	operationCtx, err := s.workspaceRuntimeContext(ctx, row, requesterID, "workspace-snapshot:"+snapshot.ID+":delete:v"+strconv.FormatInt(snapshot.UpdatedAt.UTC().UnixNano(), 10))
	if err != nil {
		return err
	}
	if err := snapshots.DeleteColdSnapshot(operationCtx, snapshot.SnapshotID); err != nil && !errors.Is(err, workspaceapi.ErrWorkspaceNotFound) {
		return runtimeOperationError("delete workspace snapshot", err)
	}
	return nil
}

func (s *WorkspaceService) executeWorkspaceCommand(ctx context.Context, workspaceID string, repositoryID, userID int64, input WorkspaceCommandInput) (WorkspaceCommandResult, error) {
	if !s.hasWorkspaceRuntime() || !s.runtime.Capabilities().Execution {
		return WorkspaceCommandResult{}, pkgerrors.Internal("workspace execution unavailable")
	}
	// Write authority is held from start through execution (f2b1c6c5), so a
	// revocation or demotion waits for the command.
	var output WorkspaceCommandResult
	err := s.withWorkspaceMutation(ctx, workspaceID, repositoryID, userID, func(ctx context.Context, _ db.Workspace) error {
		prepared, err := s.prepareWorkspaceCommand(ctx, workspaceID, repositoryID, userID, input)
		if err != nil {
			return err
		}
		output, err = s.executePreparedWorkspaceCommand(prepared.context, prepared.row, input)
		return err
	})
	return output, err
}

// Refresh status under the same lock used by lifecycle transitions. A command
// may resume an existing resource, but must never create a pending workspace.
func (s *WorkspaceService) ensureRuntimeWorkspaceCommandReady(ctx context.Context, row db.Workspace, userID int64) (db.Workspace, error) {
	unlock := s.lockRuntimeWorkspace(row.ID)
	defer unlock()
	current, err := s.currentRuntimeWorkspaceLocked(ctx, row)
	if err != nil {
		return row, err
	}
	if err := workspaceCommandReadinessError(current.Status); err != nil {
		return current, err
	}
	return s.ensureRuntimeWorkspaceRunningLocked(ctx, current, userID)
}

type preparedWorkspaceCommand struct {
	row     db.Workspace
	context context.Context
}

func (s *WorkspaceService) prepareWorkspaceCommand(ctx context.Context, workspaceID string, repositoryID, userID int64, input WorkspaceCommandInput) (preparedWorkspaceCommand, error) {
	if !s.hasWorkspaceRuntime() || !s.runtime.Capabilities().Execution {
		return preparedWorkspaceCommand{}, pkgerrors.Internal("workspace execution unavailable")
	}
	if strings.TrimSpace(input.OperationID) == "" {
		return preparedWorkspaceCommand{}, pkgerrors.BadRequest("operation_id is required")
	}
	if len(input.Args) == 0 || strings.TrimSpace(input.Args[0]) == "" {
		return preparedWorkspaceCommand{}, pkgerrors.BadRequest("command args are required")
	}
	row, err := s.loadWorkspaceWithAccess(ctx, workspaceID, repositoryID, userID, WorkspaceAccessWrite)
	if err != nil {
		return preparedWorkspaceCommand{}, err
	}
	// Starting or resuming the machine is a mutation: hold write authority
	// across it (f2b1c6c5). executeWorkspaceCommand holds it across the whole
	// command; a queued job re-checks it before this preparation.
	err = s.withWorkspaceMutationAuthority(ctx, row, userID, func(ctx context.Context) error {
		var readyErr error
		row, readyErr = s.ensureRuntimeWorkspaceCommandReady(ctx, row, userID)
		return readyErr
	})
	if err != nil {
		return preparedWorkspaceCommand{}, err
	}
	operationCtx, err := s.workspaceRuntimeContext(ctx, row, userID, input.OperationID)
	if err != nil {
		return preparedWorkspaceCommand{}, err
	}
	return preparedWorkspaceCommand{row: row, context: operationCtx}, nil
}

func (s *WorkspaceService) executePreparedWorkspaceCommand(ctx context.Context, row db.Workspace, input WorkspaceCommandInput) (WorkspaceCommandResult, error) {
	result, err := s.runtime.ExecuteCommand(ctx, row.ID, workspaceapi.Command{
		Args: append([]string(nil), input.Args...), Directory: input.Directory, Environment: cloneStringMap(input.Environment),
	})
	output := WorkspaceCommandResult{ExitCode: result.ExitCode, Stdout: result.Stdout, Stderr: result.Stderr, OutputTruncated: result.OutputTruncated}
	if err != nil {
		var recipe *microsandbox.RecipeError
		// Missing-tool annotation accompanies a certified process exit. Keep
		// the completed receipt and its evidence, but never override a runtime
		// termination fence with an actionable diagnostic.
		if result.ExitCode != 127 || !errors.As(err, &recipe) || recipe.Code != "missing_machine_tool" || recipe.Class != "user" || errors.Is(err, workspaceapi.ErrCommandTerminationUnconfirmed) || errors.Is(err, workspaceapi.ErrCommandCancelled) {
			return output, err
		}
		output.Error = recipe
	}
	_ = s.q.TouchWorkspaceActivity(ctx, row.ID)
	s.touchWorkspaceEntryRecency(ctx, row.ID, "command")
	return output, nil
}

func cloneStringMap(source map[string]string) map[string]string {
	if len(source) == 0 {
		return nil
	}
	result := make(map[string]string, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}

func serviceIdentity(input WorkspaceServiceLaunchInput) string {
	encoded, _ := json.Marshal(struct {
		Name        string
		Args        []string
		Directory   string
		Environment map[string]string
		Port        uint16
	}{input.Name, input.Args, input.Directory, input.Environment, input.Port})
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:])
}

func (s *WorkspaceService) LaunchWorkspaceService(ctx context.Context, workspaceID string, repositoryID, userID int64, input WorkspaceServiceLaunchInput) (WorkspaceManagedService, error) {
	if !s.hasWorkspaceRuntime() || !s.runtime.Capabilities().ManagedServices {
		return WorkspaceManagedService{}, pkgerrors.Internal("workspace managed services unavailable")
	}
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" || !workspaceServiceNamePattern.MatchString(input.Name) {
		return WorkspaceManagedService{}, pkgerrors.BadRequest("invalid workspace service name")
	}
	if len(input.Args) == 0 || strings.TrimSpace(input.Args[0]) == "" {
		return WorkspaceManagedService{}, pkgerrors.BadRequest("service command args are required")
	}
	if strings.TrimSpace(input.OperationID) == "" {
		return WorkspaceManagedService{}, pkgerrors.BadRequest("operation_id is required")
	}
	identity := serviceIdentity(input)
	var managed WorkspaceManagedService
	err := s.withWorkspaceMutation(ctx, workspaceID, repositoryID, userID, func(ctx context.Context, row db.Workspace) error {
		row, err := s.ensureRuntimeWorkspaceRunning(ctx, row, userID)
		if err != nil {
			return err
		}
		operationCtx, err := s.workspaceRuntimeContext(ctx, row, userID, input.OperationID)
		if err != nil {
			return err
		}
		started, err := s.runtime.StartService(operationCtx, row.ID, workspaceapi.ServiceSpec{
			Name: input.Name, Identity: identity,
			Command:      workspaceapi.Command{Args: append([]string(nil), input.Args...), Directory: input.Directory, Environment: cloneStringMap(input.Environment)},
			ReadyAddress: runtimeReadyAddress(input.Port), ReadyTimeout: 30 * time.Second,
		})
		if err != nil {
			return runtimeOperationError("start workspace service", err)
		}
		s.touchWorkspaceEntryRecency(ctx, row.ID, "service-start")
		managed = runtimeManagedService(started.Name, workspaceapi.ServiceRunning, started.Address, 0)
		return nil
	})
	return managed, err
}

func runtimeReadyAddress(port uint16) string {
	if port == 0 {
		return ""
	}
	return net.JoinHostPort("127.0.0.1", strconv.Itoa(int(port)))
}

func runtimeManagedService(name string, state workspaceapi.ServiceState, address string, exitCode int) WorkspaceManagedService {
	normalized := "stopped"
	switch state {
	case workspaceapi.ServiceRunning:
		normalized = "running"
	case workspaceapi.ServiceFailed:
		normalized = "failed"
	case workspaceapi.ServiceExited:
		if exitCode != 0 {
			normalized = "failed"
		}
	}
	port := 0
	if _, rawPort, err := net.SplitHostPort(strings.TrimSpace(address)); err == nil {
		if parsed, parseErr := strconv.ParseUint(rawPort, 10, 16); parseErr == nil {
			port = int(parsed)
		}
	}
	return WorkspaceManagedService{Name: name, State: normalized, Port: port}
}

func (s *WorkspaceService) listRuntimeWorkspaceServices(ctx context.Context, row db.Workspace, userID int64) ([]WorkspaceManagedService, error) {
	catalog, ok := s.runtime.(workspaceapi.WorkspaceServiceCatalog)
	if !ok {
		return nil, pkgerrors.Internal("workspace service listing unavailable")
	}
	operationCtx, err := s.workspaceRuntimeContext(ctx, row, userID, "")
	if err != nil {
		return nil, err
	}
	observed, err := catalog.ListServices(operationCtx, row.ID)
	if err != nil {
		return nil, runtimeOperationError("list workspace services", err)
	}
	result := make([]WorkspaceManagedService, 0, len(observed))
	for _, service := range observed {
		result = append(result, runtimeManagedService(service.Name, service.State, service.Address, service.ExitCode))
	}
	return result, nil
}

// ResolveWorkspacePreview answers a preview request. Starting the workspace
// and publishing routed ingress are mutations, so they need write authority
// held for the whole request. A reader only reaches a loopback preview of a
// workspace that already runs; it never starts the owner's machine or
// publishes a route (#3212).
func (s *WorkspaceService) ResolveWorkspacePreview(ctx context.Context, workspaceID string, repositoryID, userID int64, port uint16, hostname string) (WorkspacePreviewAccess, error) {
	if port == 0 {
		return WorkspacePreviewAccess{}, pkgerrors.BadRequest("preview port is required")
	}
	if s == nil || s.q == nil {
		return WorkspacePreviewAccess{}, pkgerrors.Internal("workspace store unavailable")
	}
	row, err := s.loadWorkspaceWithAccess(ctx, workspaceID, repositoryID, userID, WorkspaceAccessRead)
	if err != nil {
		return WorkspacePreviewAccess{}, err
	}
	writable, err := s.workspaceWritable(ctx, row, userID)
	if err != nil {
		return WorkspacePreviewAccess{}, err
	}
	if !writable {
		return s.readerWorkspacePreview(ctx, row, userID, port)
	}
	var access WorkspacePreviewAccess
	err = s.withWorkspaceMutationAuthority(ctx, row, userID, func(ctx context.Context) error {
		var err error
		access, err = s.publishWorkspacePreview(ctx, row, userID, port, hostname)
		return err
	})
	return access, err
}

func (s *WorkspaceService) readerWorkspacePreview(ctx context.Context, row db.Workspace, userID int64, port uint16) (WorkspacePreviewAccess, error) {
	if !s.hasWorkspaceRuntime() || !s.runtime.Capabilities().LoopbackPreview {
		return WorkspacePreviewAccess{}, pkgerrors.Forbidden("access denied: write permission required")
	}
	row, err := s.runningRuntimeWorkspace(ctx, row, userID)
	if err != nil {
		return WorkspacePreviewAccess{}, err
	}
	operationCtx, err := s.workspaceRuntimeContext(ctx, row, userID, "")
	if err != nil {
		return WorkspacePreviewAccess{}, err
	}
	target, err := s.runtime.PreviewTarget(operationCtx, row.ID, port)
	if err != nil {
		return WorkspacePreviewAccess{}, pkgerrors.New(pkgerrors.CodePreviewUnavailable, "workspace preview unavailable")
	}
	return WorkspacePreviewAccess{URL: target.URL, Proxy: true}, nil
}

func (s *WorkspaceService) publishWorkspacePreview(ctx context.Context, row db.Workspace, userID int64, port uint16, hostname string) (WorkspacePreviewAccess, error) {
	if !s.hasWorkspaceRuntime() {
		row, err := s.ensureExistingWorkspaceRunningFor(ctx, row, userID)
		if err != nil {
			return WorkspacePreviewAccess{}, err
		}
		previews := []WorkspaceManagedService{{Port: int(port)}}
		if err := s.publishWorkspaceServicePreviews(ctx, row, previews); err != nil {
			return WorkspacePreviewAccess{}, err
		}
		return WorkspacePreviewAccess{URL: previews[0].URL}, nil
	}
	row, err := s.ensureRuntimeWorkspaceRunning(ctx, row, userID)
	if err != nil {
		return WorkspacePreviewAccess{}, err
	}
	operationCtx, err := s.workspaceRuntimeContext(ctx, row, userID, workspaceLifecycleOperation(row, "preview:"+strconv.Itoa(int(port))+":"+strings.TrimSpace(hostname)))
	if err != nil {
		return WorkspacePreviewAccess{}, err
	}
	if s.runtime.Capabilities().LoopbackPreview {
		target, targetErr := s.runtime.PreviewTarget(operationCtx, row.ID, port)
		if targetErr != nil {
			return WorkspacePreviewAccess{}, pkgerrors.New(pkgerrors.CodePreviewUnavailable, "workspace preview unavailable")
		}
		return WorkspacePreviewAccess{URL: target.URL, Proxy: true}, nil
	}
	publisher, ok := s.runtime.(workspaceapi.RoutedPreviewPublisher)
	if !ok {
		return WorkspacePreviewAccess{}, pkgerrors.New(pkgerrors.CodePreviewUnavailable, "workspace preview unavailable")
	}
	if strings.TrimSpace(hostname) == "" {
		hostname = workspaceServicePreviewDomain(row.ID, int(port))
	}
	routed, publishErr := publisher.PublishWorkspacePreview(operationCtx, row.ID, workspaceapi.RoutedPreviewSpec{Hostname: hostname, Port: port})
	if publishErr != nil {
		return WorkspacePreviewAccess{}, pkgerrors.New(pkgerrors.CodePreviewUnavailable, "workspace preview unavailable")
	}
	routedURL, parseErr := url.Parse(strings.TrimSpace(routed.URL))
	if parseErr != nil || routedURL.Scheme != "https" || !strings.EqualFold(routedURL.Hostname(), hostname) ||
		routedURL.User != nil || routedURL.RawQuery != "" || routedURL.Fragment != "" {
		return WorkspacePreviewAccess{}, pkgerrors.New(pkgerrors.CodePreviewUnavailable, "workspace preview unavailable")
	}
	return WorkspacePreviewAccess{URL: routed.URL}, nil
}

func (s *WorkspaceService) WorkspaceRuntimeTerminalAvailable() bool {
	return s.hasWorkspaceRuntime() && s.runtime.Capabilities().Terminal
}

func (s *WorkspaceService) OpenWorkspaceTerminal(ctx context.Context, sessionID string, repositoryID, userID int64, columns, rows uint16) (workspaceapi.Terminal, error) {
	if !s.WorkspaceRuntimeTerminalAvailable() {
		return nil, pkgerrors.Internal("workspace terminal unavailable")
	}
	session, err := s.loadOwnedWorkspaceSession(ctx, sessionID, repositoryID, userID)
	if err != nil {
		return nil, err
	}
	if session.Status != "running" {
		return nil, pkgerrors.Conflict("workspace session is not running")
	}
	var terminal workspaceapi.Terminal
	var credential *terminalCredential
	err = s.withWorkspaceMutation(ctx, session.WorkspaceID, repositoryID, userID, func(ctx context.Context, row db.Workspace) error {
		row, err := s.ensureRuntimeWorkspaceRunning(ctx, row, userID)
		if err != nil {
			return err
		}
		terminalVersion := session.UpdatedAt.UTC().UnixNano()
		operationCtx, err := s.workspaceRuntimeContext(ctx, row, userID, "workspace-terminal:"+session.ID+":v"+strconv.FormatInt(terminalVersion, 10))
		if err != nil {
			return err
		}
		command := workspaceapi.Command{Args: []string{"/bin/sh"}}
		// The shell starts signed in: its delegated credential is in its file
		// before the shell can read SMITHERS_TOKEN_FILE.
		if credential, err = s.signInWorkspaceTerminal(operationCtx, row, session.ID, userID); err != nil {
			return runtimeOperationError("sign in workspace terminal", err)
		}
		if credential != nil {
			command.Environment = credential.environment()
		}
		terminal, err = s.runtime.OpenWorkspaceTerminal(operationCtx, row.ID, command)
		if err != nil {
			if credential != nil {
				credential.Close()
			}
			return runtimeOperationError("open workspace terminal", err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if credential != nil {
		terminal = &signedInTerminal{Terminal: terminal, terminalCredential: credential}
	}
	if columns == 0 {
		columns = 80
	}
	if rows == 0 {
		rows = 24
	}
	if err := terminal.Resize(ctx, columns, rows); err != nil {
		_ = terminal.Close()
		return nil, runtimeOperationError("resize workspace terminal", err)
	}
	return terminal, nil
}

func mapRuntimeFileError(err error, kind string) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, fs.ErrNotExist) || errors.Is(err, workspaceapi.ErrWorkspaceNotFound) {
		return pkgerrors.NotFound("workspace " + kind + " not found")
	}
	return pkgerrors.Internal("workspace " + kind + " operation failed")
}
