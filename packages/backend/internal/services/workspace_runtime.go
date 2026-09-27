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
	ExitCode        int    `json:"exit_code"`
	Stdout          string `json:"stdout"`
	Stderr          string `json:"stderr"`
	OutputTruncated bool   `json:"output_truncated"`
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

func (s *WorkspaceService) ensureRuntimeWorkspaceRunning(ctx context.Context, row db.Workspace, requesterID int64) (db.Workspace, error) {
	unlock := s.lockRuntimeWorkspace(row.ID)
	defer unlock()
	current, err := s.currentRuntimeWorkspaceLocked(ctx, row)
	if err != nil {
		return row, err
	}
	return s.ensureRuntimeWorkspaceRunningLocked(ctx, current, requesterID)
}

// currentRuntimeWorkspaceLocked refreshes mutable product state after the
// caller enters the per-workspace critical section. A request may have loaded
// a running row before a concurrent suspend, stop, or delete completed; using
// that stale row could restart execution without restoring the product state.
// runtimeWorkspaceSpec names the repository revision the checkout will hold,
// so an isolated runtime can boot the matching prepared environment. The
// source is a hint for environment selection only; checkout authority stays
// in ensureRuntimeWorkspaceRepository.
func (s *WorkspaceService) runtimeWorkspaceSpec(ctx context.Context, row db.Workspace) workspaceapi.WorkspaceSpec {
	spec := workspaceapi.WorkspaceSpec{ID: row.ID}
	if row.RepositoryID <= 0 {
		return spec
	}
	slug, err := s.workspaceRepoSlug(ctx, row.RepositoryID)
	if err != nil {
		return spec
	}
	spec.Source = &workspaceapi.WorkspaceSource{Repository: slug, Revision: targetWorkspaceBookmark(row.TargetBookmark)}
	return spec
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

func (s *WorkspaceService) ensureRuntimeWorkspaceRunningLocked(ctx context.Context, row db.Workspace, requesterID int64) (db.Workspace, error) {
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
		observed, err = s.runtime.CreateWorkspace(createCtx, s.runtimeWorkspaceSpec(ctx, row))
	} else {
		observed, err = s.runtime.InspectWorkspace(operationCtx, row.ID)
	}
	if err != nil {
		if errors.Is(err, workspaceapi.ErrWorkspaceNotFound) {
			return row, pkgerrors.Conflict("workspace runtime no longer exists; create a fresh workspace")
		}
		return row, pkgerrors.Internal("inspect workspace runtime: " + err.Error())
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
		observed, err = s.runtime.StartWorkspace(startCtx, row.ID)
		if err != nil {
			return row, pkgerrors.Internal("start workspace runtime: " + err.Error())
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
		return pkgerrors.Internal("stop workspace runtime: " + err.Error())
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
		return pkgerrors.Internal("delete workspace runtime: " + err.Error())
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
	observed, err := snapshots.ForkColdSnapshot(operationCtx, snapshot.SnapshotID, workspaceapi.WorkspaceSpec{ID: row.ID})
	if err != nil {
		return row, pkgerrors.Internal("restore workspace snapshot: " + err.Error())
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
		observed, err = s.runtime.StartWorkspace(startCtx, row.ID)
		if err != nil {
			return row, pkgerrors.Internal("start restored workspace: " + err.Error())
		}
	}
	if observed.State != workspaceapi.WorkspaceRunning {
		return row, pkgerrors.Conflict("restored workspace runtime is " + string(observed.State))
	}
	if err := s.adoptRuntimeWorkspaceRepository(ctx, row, requesterID); err != nil {
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

func (s *WorkspaceService) forkRuntimeWorkspace(ctx context.Context, input ForkWorkspaceInput) (WorkspaceResponse, error) {
	if err := s.enforceWorkspaceQuota(ctx, input.UserID); err != nil {
		return WorkspaceResponse{}, err
	}
	source, err := s.loadOwnedWorkspace(ctx, input.WorkspaceID, input.RepositoryID, input.UserID)
	if err != nil {
		return WorkspaceResponse{}, err
	}
	snapshots, err := s.runtimeSnapshots()
	if err != nil {
		return WorkspaceResponse{}, err
	}
	source, err = s.ensureRuntimeWorkspaceRunning(ctx, source, input.UserID)
	if err != nil {
		return WorkspaceResponse{}, err
	}
	created, err := s.createWorkspaceRow(ctx, db.CreateWorkspaceParams{
		RepositoryID:           source.RepositoryID,
		UserID:                 source.UserID,
		Name:                   strings.TrimSpace(input.Name),
		IsFork:                 true,
		ParentWorkspaceID:      stringToUUID(source.ID),
		SourceSnapshotID:       source.SourceSnapshotID,
		TargetBookmark:         source.TargetBookmark,
		Kind:                   source.Kind,
		EnvironmentSource:      source.EnvironmentSource,
		EnvironmentRevision:    source.EnvironmentRevision,
		EnvironmentClosureHash: source.EnvironmentClosureHash,
		Status:                 "starting",
	})
	if err != nil {
		return WorkspaceResponse{}, mapWorkspaceCreateError(err, "create fork workspace")
	}

	unlockSource := s.lockRuntimeWorkspace(source.ID)
	defer unlockSource()
	unlockCreated := s.lockRuntimeWorkspace(created.ID)
	defer unlockCreated()
	source, err = s.ensureRuntimeWorkspaceRunningLocked(ctx, source, input.UserID)
	if err != nil {
		s.markWorkspaceProvisionFailed(ctx, created, err)
		return WorkspaceResponse{}, err
	}
	temporarySnapshotID := "workspace-fork-" + created.ID + "-" + uuid.NewString()
	if err := s.stopRuntimeWorkspaceLocked(ctx, source, input.UserID, "fork-stop:"+created.ID); err != nil {
		s.markWorkspaceProvisionFailed(ctx, created, err)
		return WorkspaceResponse{}, err
	}
	snapshotCtx, err := s.workspaceRuntimeContext(ctx, source, input.UserID, workspaceLifecycleOperation(source, "fork-snapshot:"+created.ID))
	if err != nil {
		resumeCtx, cancel := detachedRuntimeContext(ctx, workspaceResumeTimeout)
		_, _ = s.ensureRuntimeWorkspaceRunningLocked(resumeCtx, source, input.UserID)
		cancel()
		s.markWorkspaceProvisionFailed(ctx, created, err)
		return WorkspaceResponse{}, err
	}
	cold, snapshotErr := snapshots.CreateColdSnapshot(snapshotCtx, source.ID, workspaceapi.ColdSnapshotSpec{ID: temporarySnapshotID})
	resumeCtx, cancelResume := detachedRuntimeContext(ctx, workspaceResumeTimeout)
	_, resumeErr := s.ensureRuntimeWorkspaceRunningLocked(resumeCtx, source, input.UserID)
	cancelResume()
	if snapshotErr != nil {
		err = pkgerrors.Internal("snapshot workspace for fork: " + snapshotErr.Error())
		if resumeErr != nil {
			err = errors.Join(err, resumeErr)
		}
		s.markWorkspaceProvisionFailed(ctx, created, err)
		return WorkspaceResponse{}, err
	}
	cleanupSnapshot := func() {
		cleanupCtx, cancel := detachedRuntimeContext(ctx, 30*time.Second)
		defer cancel()
		operationCtx, contextErr := s.workspaceRuntimeContext(cleanupCtx, source, input.UserID, workspaceLifecycleOperation(source, "delete-fork-snapshot:"+created.ID))
		if contextErr == nil {
			_ = snapshots.DeleteColdSnapshot(operationCtx, temporarySnapshotID)
		}
	}
	defer cleanupSnapshot()
	if cold.ID != temporarySnapshotID || cold.SourceWorkspaceID != source.ID {
		err = pkgerrors.Internal("workspace runtime returned a mismatched fork snapshot")
		s.markWorkspaceProvisionFailed(ctx, created, err)
		return WorkspaceResponse{}, err
	}
	if resumeErr != nil {
		s.markWorkspaceProvisionFailed(ctx, created, resumeErr)
		return WorkspaceResponse{}, resumeErr
	}

	forkCtx, err := s.workspaceRuntimeContext(ctx, created, input.UserID, workspaceLifecycleOperation(created, "fork-from:"+source.ID))
	if err != nil {
		s.markWorkspaceProvisionFailed(ctx, created, err)
		return WorkspaceResponse{}, err
	}
	observed, err := snapshots.ForkColdSnapshot(forkCtx, temporarySnapshotID, workspaceapi.WorkspaceSpec{ID: created.ID})
	if err != nil {
		err = pkgerrors.Internal("fork workspace runtime: " + err.Error())
		s.markWorkspaceProvisionFailed(ctx, created, err)
		return WorkspaceResponse{}, err
	}
	cleanupFork := true
	defer func() {
		if !cleanupFork {
			return
		}
		cleanupCtx, cancel := detachedRuntimeContext(ctx, 30*time.Second)
		defer cancel()
		_ = s.deleteRuntimeWorkspaceLocked(cleanupCtx, created, input.UserID)
	}()
	if observed.ID != created.ID {
		err = pkgerrors.Internal("workspace runtime returned a mismatched fork")
		s.markWorkspaceProvisionFailed(ctx, created, err)
		return WorkspaceResponse{}, err
	}
	if observed.State == workspaceapi.WorkspaceStopped {
		startCtx, contextErr := s.workspaceRuntimeContext(ctx, created, input.UserID, workspaceLifecycleOperation(created, "start-fork"))
		if contextErr != nil {
			s.markWorkspaceProvisionFailed(ctx, created, contextErr)
			return WorkspaceResponse{}, contextErr
		}
		observed, err = s.runtime.StartWorkspace(startCtx, created.ID)
		if err != nil {
			err = pkgerrors.Internal("start forked workspace runtime: " + err.Error())
			s.markWorkspaceProvisionFailed(ctx, created, err)
			return WorkspaceResponse{}, err
		}
	}
	if observed.State != workspaceapi.WorkspaceRunning {
		err = pkgerrors.Conflict("forked workspace runtime is " + string(observed.State))
		s.markWorkspaceProvisionFailed(ctx, created, err)
		return WorkspaceResponse{}, err
	}
	if err := s.adoptRuntimeWorkspaceRepository(ctx, created, input.UserID); err != nil {
		s.markWorkspaceProvisionFailed(ctx, created, err)
		return WorkspaceResponse{}, err
	}
	updated, err := s.q.UpdateWorkspaceStatus(ctx, db.UpdateWorkspaceStatusParams{ID: created.ID, Status: "running"})
	if err != nil {
		return WorkspaceResponse{}, pkgerrors.Internal("update forked workspace status: " + err.Error())
	}
	cleanupFork = false
	_ = s.q.TouchWorkspaceActivity(ctx, updated.ID)
	s.meterWorkspaceUsage(ctx, created, "running")
	s.notifyWorkspace(ctx, updated.ID, "running")
	return s.toWorkspaceResponse(updated), nil
}

func (s *WorkspaceService) createRuntimeWorkspaceSnapshot(ctx context.Context, input CreateWorkspaceSnapshotInput, snapshotName string) (WorkspaceSnapshotResponse, error) {
	row, err := s.loadOwnedWorkspace(ctx, input.WorkspaceID, input.RepositoryID, input.UserID)
	if err != nil {
		return WorkspaceSnapshotResponse{}, err
	}
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
		resumeCtx, cancel := detachedRuntimeContext(ctx, workspaceResumeTimeout)
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
		resumeCtx, cancel := detachedRuntimeContext(ctx, workspaceResumeTimeout)
		_, _ = s.ensureRuntimeWorkspaceRunningLocked(resumeCtx, suspended, input.UserID)
		cancel()
		return WorkspaceSnapshotResponse{}, err
	}
	created, snapshotErr := snapshots.CreateColdSnapshot(operationCtx, row.ID, workspaceapi.ColdSnapshotSpec{ID: runtimeSnapshotID})
	resumeCtx, cancelResume := detachedRuntimeContext(ctx, workspaceResumeTimeout)
	resumed, resumeErr := s.ensureRuntimeWorkspaceRunningLocked(resumeCtx, suspended, input.UserID)
	cancelResume()
	if snapshotErr != nil {
		resultErr := error(pkgerrors.Internal("create workspace snapshot: " + snapshotErr.Error()))
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
		return pkgerrors.Internal("delete workspace snapshot: " + err.Error())
	}
	return nil
}

func (s *WorkspaceService) ExecuteWorkspaceCommand(ctx context.Context, workspaceID string, repositoryID, userID int64, input WorkspaceCommandInput) (WorkspaceCommandResult, error) {
	if !s.hasWorkspaceRuntime() || !s.runtime.Capabilities().Execution {
		return WorkspaceCommandResult{}, pkgerrors.Internal("workspace execution unavailable")
	}
	if strings.TrimSpace(input.OperationID) == "" {
		return WorkspaceCommandResult{}, pkgerrors.BadRequest("operation_id is required")
	}
	if len(input.Args) == 0 || strings.TrimSpace(input.Args[0]) == "" {
		return WorkspaceCommandResult{}, pkgerrors.BadRequest("command args are required")
	}
	row, err := s.loadWorkspaceWithAccess(ctx, workspaceID, repositoryID, userID, WorkspaceAccessWrite)
	if err != nil {
		return WorkspaceCommandResult{}, err
	}
	row, err = s.ensureRuntimeWorkspaceRunning(ctx, row, userID)
	if err != nil {
		return WorkspaceCommandResult{}, err
	}
	operationCtx, err := s.workspaceRuntimeContext(ctx, row, userID, input.OperationID)
	if err != nil {
		return WorkspaceCommandResult{}, err
	}
	result, err := s.runtime.ExecuteCommand(operationCtx, row.ID, workspaceapi.Command{
		Args: append([]string(nil), input.Args...), Directory: input.Directory, Environment: cloneStringMap(input.Environment),
	})
	if err != nil {
		return WorkspaceCommandResult{}, pkgerrors.Internal("execute workspace command: " + err.Error())
	}
	_ = s.q.TouchWorkspaceActivity(ctx, row.ID)
	s.touchWorkspaceEntryRecency(ctx, row.ID, "command")
	return WorkspaceCommandResult{ExitCode: result.ExitCode, Stdout: result.Stdout, Stderr: result.Stderr, OutputTruncated: result.OutputTruncated}, nil
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
	row, err := s.loadWorkspaceWithAccess(ctx, workspaceID, repositoryID, userID, WorkspaceAccessWrite)
	if err != nil {
		return WorkspaceManagedService{}, err
	}
	row, err = s.ensureRuntimeWorkspaceRunning(ctx, row, userID)
	if err != nil {
		return WorkspaceManagedService{}, err
	}
	operationCtx, err := s.workspaceRuntimeContext(ctx, row, userID, input.OperationID)
	if err != nil {
		return WorkspaceManagedService{}, err
	}
	started, err := s.runtime.StartService(operationCtx, row.ID, workspaceapi.ServiceSpec{
		Name: input.Name, Identity: identity,
		Command:      workspaceapi.Command{Args: append([]string(nil), input.Args...), Directory: input.Directory, Environment: cloneStringMap(input.Environment)},
		ReadyAddress: runtimeReadyAddress(input.Port), ReadyTimeout: 30 * time.Second,
	})
	if err != nil {
		return WorkspaceManagedService{}, pkgerrors.Internal("start workspace service: " + err.Error())
	}
	s.touchWorkspaceEntryRecency(ctx, row.ID, "service-start")
	return runtimeManagedService(started.Name, workspaceapi.ServiceRunning, started.Address, 0), nil
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
		return nil, pkgerrors.Internal("list workspace services: " + err.Error())
	}
	result := make([]WorkspaceManagedService, 0, len(observed))
	for _, service := range observed {
		result = append(result, runtimeManagedService(service.Name, service.State, service.Address, service.ExitCode))
	}
	return result, nil
}

func (s *WorkspaceService) ResolveWorkspacePreview(ctx context.Context, workspaceID string, repositoryID, userID int64, port uint16, hostname string) (WorkspacePreviewAccess, error) {
	if !s.hasWorkspaceRuntime() || port == 0 {
		return WorkspacePreviewAccess{}, pkgerrors.BadRequest("preview port is required")
	}
	row, err := s.loadWorkspaceWithAccess(ctx, workspaceID, repositoryID, userID, WorkspaceAccessRead)
	if err != nil {
		return WorkspacePreviewAccess{}, err
	}
	row, err = s.ensureRuntimeWorkspaceRunning(ctx, row, userID)
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
	row, err := s.loadOwnedWorkspace(ctx, session.WorkspaceID, repositoryID, userID)
	if err != nil {
		return nil, err
	}
	row, err = s.ensureRuntimeWorkspaceRunning(ctx, row, userID)
	if err != nil {
		return nil, err
	}
	terminalVersion := session.UpdatedAt.UTC().UnixNano()
	operationCtx, err := s.workspaceRuntimeContext(ctx, row, userID, "workspace-terminal:"+session.ID+":v"+strconv.FormatInt(terminalVersion, 10))
	if err != nil {
		return nil, err
	}
	terminal, err := s.runtime.OpenWorkspaceTerminal(operationCtx, row.ID, workspaceapi.Command{Args: []string{"/bin/sh"}})
	if err != nil {
		return nil, pkgerrors.Internal("open workspace terminal: " + err.Error())
	}
	if columns == 0 {
		columns = 80
	}
	if rows == 0 {
		rows = 24
	}
	if err := terminal.Resize(ctx, columns, rows); err != nil {
		_ = terminal.Close()
		return nil, pkgerrors.Internal("resize workspace terminal").WithCause(err)
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
