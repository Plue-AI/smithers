package services

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// SuspendWorkspace suspends a running workspace.
func (s *WorkspaceService) SuspendWorkspace(ctx context.Context, workspaceID string, repositoryID, userID int64) (WorkspaceResponse, error) {
	if s.q == nil {
		return WorkspaceResponse{}, pkgerrors.Internal("workspace store unavailable")
	}

	workspace, err := s.loadOwnedWorkspace(ctx, workspaceID, repositoryID, userID)
	if err != nil {
		return WorkspaceResponse{}, err
	}
	if err := s.suspendWorkspace(ctx, workspace); err != nil {
		return WorkspaceResponse{}, err
	}

	workspace, err = s.loadOwnedWorkspace(ctx, workspaceID, repositoryID, userID)
	if err != nil {
		return WorkspaceResponse{}, err
	}
	return s.toWorkspaceResponse(workspace), nil
}

// ResumeWorkspace resumes a suspended workspace.
func (s *WorkspaceService) ResumeWorkspace(ctx context.Context, workspaceID string, repositoryID, userID int64) (WorkspaceResponse, error) {
	if s.q == nil {
		return WorkspaceResponse{}, pkgerrors.Internal("workspace store unavailable")
	}

	var resumed db.Workspace
	err := s.withWorkspaceMutation(ctx, workspaceID, repositoryID, userID, func(ctx context.Context, workspace db.Workspace) error {
		var err error
		resumed, err = s.ensureExistingWorkspaceRunningFor(ctx, workspace, userID)
		return err
	})
	if err != nil {
		return WorkspaceResponse{}, err
	}
	return s.toWorkspaceResponse(resumed), nil
}

// DeleteWorkspace stops and deletes a workspace execution environment.
func (s *WorkspaceService) DeleteWorkspace(ctx context.Context, workspaceID string, repositoryID, userID int64) error {
	if s.q == nil {
		return pkgerrors.Internal("workspace store unavailable")
	}

	workspace, err := s.loadOwnedWorkspace(ctx, workspaceID, repositoryID, userID)
	if err != nil {
		return err
	}

	return s.destroyWorkspace(ctx, workspace)
}

// StopWorkspace shuts down execution while retaining the workspace row and
// persistent files.
func (s *WorkspaceService) StopWorkspace(ctx context.Context, workspaceID string, repositoryID, userID int64) (_ WorkspaceResponse, retErr error) {
	defer func() { s.observeWorkspaceLifecycle("stop", retErr) }()
	store, ok := s.q.(interface {
		StopWorkspaceRetainingRow(context.Context, string) (db.StopWorkspaceRetainingRowRow, error)
	})
	if !ok {
		return WorkspaceResponse{}, pkgerrors.Internal("workspace stop store unavailable")
	}
	workspace, err := s.loadOwnedWorkspace(ctx, workspaceID, repositoryID, userID)
	if err != nil {
		return WorkspaceResponse{}, err
	}
	if workspace.Status == "stopped" {
		return WorkspaceResponse{}, pkgerrors.Conflict("workspace is already stopped")
	}
	if s.runtime == nil && workspace.VmID != "" && s.sandbox == nil {
		return WorkspaceResponse{}, pkgerrors.Internal("workspace sandbox unavailable")
	}
	// Unlike best-effort cleanup, an explicit stop must report a failed token
	// revocation so it can be retried before marking the workspace stopped.
	if workspace.HeadPushTokenID.Valid {
		if err := s.q.DeleteAccessToken(ctx, db.DeleteAccessTokenParams{ID: workspace.HeadPushTokenID.Int64, UserID: workspace.UserID}); err != nil {
			return WorkspaceResponse{}, pkgerrors.Internal("revoke workspace credentials: " + err.Error())
		}
	}
	if s.runtime != nil {
		unlock := s.lockRuntimeWorkspace(workspace.ID)
		defer unlock()
		workspace, err = s.currentRuntimeWorkspaceLocked(ctx, workspace)
		if err != nil {
			return WorkspaceResponse{}, err
		}
		if workspace.Status == "stopped" {
			return WorkspaceResponse{}, pkgerrors.Conflict("workspace is already stopped")
		}
		if err := s.stopRuntimeWorkspaceLocked(ctx, workspace, userID, "stop"); err != nil {
			return WorkspaceResponse{}, err
		}
	} else if err := s.teardownWorkspaceVM(ctx, workspace); err != nil {
		return WorkspaceResponse{}, err
	}
	stopped, err := store.StopWorkspaceRetainingRow(ctx, workspace.ID)
	if err != nil {
		return WorkspaceResponse{}, pkgerrors.Internal("stop workspace: " + err.Error())
	}
	workspace = db.Workspace(stopped)
	s.meterWorkspaceUsage(ctx, workspace, workspace.Status)
	s.notifyWorkspace(ctx, workspace.ID, workspace.Status)
	return s.toWorkspaceResponse(workspace), nil
}

// UpdateWorkspacePodStatus handles optional workspace runtime status reports.
func (s *WorkspaceService) UpdateWorkspacePodStatus(ctx context.Context, input UpdateWorkspacePodStatusInput) error {
	if s.q == nil {
		return pkgerrors.Internal("workspace store unavailable")
	}

	switch input.Status {
	case "running", "suspended", "stopped", "failed":
	default:
		return pkgerrors.BadRequest("invalid status: must be running, suspended, stopped, or failed")
	}

	if _, err := s.q.UpdateWorkspaceStatus(ctx, db.UpdateWorkspaceStatusParams{
		ID:     input.WorkspaceID,
		Status: input.Status,
	}); err != nil {
		return pkgerrors.Internal("update workspace status: " + err.Error())
	}
	s.meterWorkspaceStatusUsage(ctx, input.WorkspaceID, input.Status)
	s.notifyWorkspace(ctx, input.WorkspaceID, input.Status)
	return nil
}

// UpdateWorkspaceHead persists one atomic guest status sample. The guest owns
// working-copy snapshotting, so the control plane never guesses at @ from the
// repo-host's bookmark-only view.
func (s *WorkspaceService) UpdateWorkspaceHead(ctx context.Context, input UpdateWorkspaceHeadInput) error {
	if s.q == nil {
		return pkgerrors.Internal("workspace store unavailable")
	}
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.ChangeID = strings.TrimSpace(input.ChangeID)
	input.CommitID = strings.TrimSpace(input.CommitID)
	if input.WorkspaceID == "" {
		return pkgerrors.BadRequest("workspace id is required")
	}
	if input.ChangeID == "" || input.CommitID == "" {
		return pkgerrors.BadRequest("change_id and commit_id are required")
	}
	if input.Ahead < 0 || input.Behind < 0 {
		return pkgerrors.BadRequest("ahead and behind must be non-negative")
	}
	if _, err := s.q.UpdateWorkspaceHead(ctx, db.UpdateWorkspaceHeadParams{
		ID:           input.WorkspaceID,
		HeadChangeID: input.ChangeID,
		HeadCommitID: input.CommitID,
		Ahead:        input.Ahead,
		Behind:       input.Behind,
	}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("workspace not found")
		}
		return pkgerrors.Internal("update workspace head: " + err.Error())
	}
	return nil
}

func (s *WorkspaceService) teardownWorkspaceVM(ctx context.Context, workspace db.Workspace) error {
	s.revokeWorkspaceHeadToken(ctx, workspace)
	s.retireBoxHostCredentials(ctx, workspace)
	if s.runtime != nil {
		return s.deleteRuntimeWorkspace(ctx, workspace, workspace.UserID)
	}
	if workspace.VmID != "" && s.sandbox != nil {
		// A 404 means the VM is already gone (reclaimed out-of-band or a prior
		// delete that failed to soft-delete the row). That is the desired terminal
		// state, so treat it as a successful delete and proceed — otherwise the
		// row keeps its active concurrent-sandbox slot forever and the spec's
		// "delete one to continue" promise becomes unsatisfiable (the user cannot
		// even free the slot without manual DB surgery).
		if err := s.sandbox.DeleteSandbox(ctx, workspace.VmID); err != nil && !vmAlreadyGone(err) {
			return pkgerrors.Internal("delete sandbox: " + err.Error())
		}
		// The active-VM gauge +1 is recorded when a row enters 'running', and
		// suspend already decrements on the running->suspended CAS. Decrementing
		// here unconditionally double-counted deletes of suspended workspaces and
		// drove the gauge negative — so gate the -1 on winning the running->
		// suspended CAS ourselves before the final stopped/deleted transition.
		if _, err := s.q.SuspendRunningWorkspace(ctx, workspace.ID); err == nil {
			s.meterWorkspaceUsage(ctx, workspace, "suspended")
			if s.sandboxMetrics != nil {
				s.sandboxMetrics.AddSandboxActiveVMs("workspace", -1)
			}
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.Internal("update workspace status: " + err.Error())
		}
		slog.Info("sandbox deleted", "vm_id", workspace.VmID, "type", "workspace")
	}

	return nil
}

func (s *WorkspaceService) destroyWorkspace(ctx context.Context, workspace db.Workspace) (retErr error) {
	defer func() { s.observeWorkspaceLifecycle("stop", retErr) }()
	if s.runtime != nil {
		unlock := s.lockRuntimeWorkspace(workspace.ID)
		defer unlock()
		current, err := s.currentRuntimeWorkspaceLocked(ctx, workspace)
		if err != nil {
			return err
		}
		s.revokeWorkspaceHeadToken(ctx, current)
		s.retireBoxHostCredentials(ctx, current)
		if err := s.deleteRuntimeWorkspaceLocked(ctx, current, current.UserID); err != nil {
			return err
		}
		workspace = current
	} else if err := s.teardownWorkspaceVM(ctx, workspace); err != nil {
		return err
	}
	if err := s.deleteWorkspaceRefs(ctx, workspace); err != nil {
		return err
	}

	// Ticket 0105: DeleteWorkspace is soft. We stamp deleted_at so that
	// the row drops out of MaxActiveWorkspacesPerUser accounting and the
	// spec promise "delete one to continue" holds. The tombstoned row is
	// retained (not DROP'd) so realtime-synchronized clients can observe the
	// transition and so admin support can un-tombstone if needed.
	if _, err := s.q.SoftDeleteWorkspace(ctx, workspace.ID); err != nil {
		return pkgerrors.Internal("soft-delete workspace: " + err.Error())
	}
	s.dropFlowJournal(ctx, workspace.ID)
	s.meterWorkspaceUsage(ctx, workspace, "stopped")
	s.notifyWorkspace(ctx, workspace.ID, "stopped")

	return nil
}

// DestroyWorkspace stops a workspace and all of its sessions, then deletes the sandbox provider VM.
func (s *WorkspaceService) DestroyWorkspace(ctx context.Context, workspaceID string) error {
	if s.q == nil {
		return pkgerrors.Internal("workspace store unavailable")
	}

	workspace, err := s.q.GetWorkspace(ctx, workspaceID)
	if err != nil {
		return pkgerrors.NotFound("workspace not found")
	}

	return s.destroyWorkspace(ctx, workspace)
}

// CleanupIdleSessions stops sessions whose last activity has exceeded their idle timeout.
func (s *WorkspaceService) CleanupIdleSessions(ctx context.Context) error {
	if s.q == nil {
		return nil
	}

	idleSessions, err := s.q.ListIdleWorkspaceSessions(ctx)
	if err != nil {
		return err
	}
	for _, session := range idleSessions {
		_ = s.DestroySession(ctx, session.ID, session.RepositoryID, session.UserID)
	}
	return nil
}

// CleanupIdleWorkspaces suspends workspaces whose last activity has exceeded their idle timeout.
func (s *WorkspaceService) CleanupIdleWorkspaces(ctx context.Context) error {
	defer s.sweepSandboxUsage(ctx)
	if s.q == nil {
		return nil
	}

	idleWorkspaces, err := s.q.ListIdleWorkspaces(ctx)
	if err != nil {
		return err
	}
	for _, workspace := range idleWorkspaces {
		// A failed suspend must be VISIBLE: this loop silently retrying the
		// same error every sweep is how already-stopped VMs stayed 'running'
		// (and quota-counted) for a week without anyone knowing.
		if err := s.suspendWorkspace(ctx, workspace); err != nil {
			slog.Warn("idle workspace suspend failed", "workspace_id", workspace.ID, "vm_id", workspace.VmID, "error", err)
		}
	}
	return nil
}

// CleanupOverQuotaWorkspaces suspends running workspaces after their owner has
// exhausted today's sandbox hours, regardless of workspace or session activity.
func (s *WorkspaceService) CleanupOverQuotaWorkspaces(ctx context.Context) error {
	if s.q == nil || s.billing == nil {
		return nil
	}
	workspaces, err := s.q.ListRunningWorkspaces(ctx)
	if err != nil {
		return fmt.Errorf("list running workspaces: %w", err)
	}

	// Resolve each owner's plan and metering once per pass. A failed read leaves
	// that owner's workspaces running; returning the error lets the cleaner count
	// the failure and retry on its next tick.
	limits := make(map[int64]*pkgerrors.APIError)
	var errs []error
	for _, workspace := range workspaces {
		if err := ctx.Err(); err != nil {
			return errors.Join(append(errs, err)...)
		}
		limit, checked := limits[workspace.UserID]
		if !checked {
			entitlement, err := sandboxEntitlementForUser(ctx, s.billing, workspace.UserID)
			if err != nil {
				slog.Warn("sandbox hours check failed", "user_id", workspace.UserID, "error", err)
				if recorder, ok := s.sandboxMetrics.(SandboxHoursMeteringRecorder); ok {
					recorder.AddSandboxHoursMeteringError()
				}
				errs = append(errs, fmt.Errorf("sandbox hours for user %d: %w", workspace.UserID, err))
			} else {
				limit = sandboxDailyHoursError(entitlement)
			}
			limits[workspace.UserID] = limit
		}
		if limit == nil {
			continue
		}
		child, err := s.overQuotaWorkspaceChild(ctx, workspace)
		if err != nil {
			errs = append(errs, fmt.Errorf("check over-quota workspace child %s: %w", workspace.ID, err))
			continue
		}
		if child {
			continue
		}
		if err := s.suspendWorkspace(ctx, workspace); err != nil {
			slog.Warn("over-quota workspace suspend failed", "workspace_id", workspace.ID, "user_id", workspace.UserID, "error", err)
			errs = append(errs, fmt.Errorf("suspend over-quota workspace %s: %w", workspace.ID, err))
			continue
		}
		s.auditHoursCapSuspension(ctx, workspace, limit)
	}
	return errors.Join(errs...)
}

// SandboxHoursMeteringRecorder counts sweep passes that could not read an
// owner's sandbox-hours metering and so left that owner's workspaces running.
type SandboxHoursMeteringRecorder interface {
	AddSandboxHoursMeteringError()
}

// auditHoursCapSuspension records a sweep suspension with the plan-limit error
// the owner receives when resuming before reset_at.
func (s *WorkspaceService) auditHoursCapSuspension(ctx context.Context, workspace db.Workspace, limit *pkgerrors.APIError) {
	if s.audit == nil {
		return
	}
	ownerID := workspace.UserID
	metadata := map[string]any{
		"code":          limit.Code,
		"limit_kind":    limit.LimitKind,
		"plan_key":      limit.PlanKey,
		"message":       limit.Message,
		"repository_id": workspace.RepositoryID,
		"vm_id":         workspace.VmID,
	}
	if limit.Limit != nil {
		metadata["limit"] = *limit.Limit
	}
	if limit.UpgradePlanKey != "" {
		metadata["upgrade_plan_key"] = limit.UpgradePlanKey
	}
	if limit.ResetAt != nil {
		metadata["reset_at"] = limit.ResetAt.UTC().Format(time.RFC3339)
	}
	s.audit.Log(ctx, AuditEvent{
		EventType:  "workspace.suspend",
		ActorName:  "system",
		TargetType: "user",
		TargetID:   &ownerID,
		TargetName: workspace.ID,
		Action:     limit.LimitKind,
		Metadata:   metadata,
	})
}

// CleanupStalePendingWorkspaces marks stale pending/starting workspaces without a VM as failed.
// It also reaps workspaces stranded in 'starting' WITH a registered VM — the
// rows an API crash mid-provision leaves behind. Those were previously
// invisible to every sweeper (ListStalePendingWorkspaces requires vm_id=”)
// while still counting toward the per-user active-workspace quota, so a few
// crashes could drive a user into quota_exceeded with no recovery path.
func (s *WorkspaceService) CleanupStalePendingWorkspaces(ctx context.Context) error {
	// With durable provisioning ownership, row age is not evidence of failure:
	// re-drive the row instead of failing it.
	if s.durableProvisioning() {
		return s.ReconcileWorkspaceProvisioning(ctx)
	}
	if s.q == nil {
		return nil
	}

	staleWorkspaces, err := s.q.ListStalePendingWorkspaces(ctx, int32(workspaceStaleAfter/time.Second))
	if err != nil {
		return err
	}
	for _, workspace := range staleWorkspaces {
		if _, updateErr := s.failWorkspace(ctx, workspace, errors.New("workspace provisioning timed out")); updateErr != nil {
			return updateErr
		}
	}

	// A LIVE provision legitimately holds 'starting' + vm_id for minutes (cold
	// clone), so these rows use a longer threshold that exceeds the detached
	// provisioning goroutine's hard timeout: past it, no provisioner can still
	// be running and the row is provably stranded.
	staleSecs := int32(workspaceStartingWithVMStaleAfter / time.Second)
	strandedWorkspaces, err := s.q.ListStaleStartingWorkspacesWithVM(ctx, staleSecs)
	if err != nil {
		return err
	}
	for _, workspace := range strandedWorkspaces {
		// CAS re-checks status+staleness so a row that just finished
		// provisioning (or was attached and marked running) is left untouched —
		// and its VM is only deleted after the fail transition is won.
		if _, failErr := s.q.FailStaleStartingWorkspace(ctx, db.FailStaleStartingWorkspaceParams{
			ID:             workspace.ID,
			StaleAfterSecs: staleSecs,
		}); failErr != nil {
			if errors.Is(failErr, pgx.ErrNoRows) {
				continue
			}
			return pkgerrors.Internal("fail stranded starting workspace: " + failErr.Error())
		}
		s.deleteOrphanedWorkspaceVM(ctx, workspace.VmID)
		s.observeWorkspaceLifecycle("fail", nil)
		s.meterWorkspaceUsage(ctx, workspace, "failed")
		s.notifyWorkspace(ctx, workspace.ID, "failed")
		slog.Warn("reaped workspace stranded in starting with a vm", "workspace_id", workspace.ID, "vm_id", workspace.VmID)
	}
	return nil
}

// ensureExistingWorkspaceRunning starts a workspace on its owner's behalf.
func (s *WorkspaceService) ensureExistingWorkspaceRunning(ctx context.Context, workspace db.Workspace) (db.Workspace, error) {
	return s.ensureExistingWorkspaceRunningFor(ctx, workspace, workspace.UserID)
}

// ensureExistingWorkspaceRunningFor starts a workspace for a requester with
// write authority over it, held for the whole transition (#3212).
func (s *WorkspaceService) ensureExistingWorkspaceRunningFor(ctx context.Context, workspace db.Workspace, requesterID int64) (db.Workspace, error) {
	result := workspace
	err := s.withWorkspaceMutationAuthority(ctx, workspace, requesterID, func(ctx context.Context) error {
		var err error
		result, err = s.ensureExistingWorkspaceRunningAuthorized(ctx, workspace, requesterID)
		return err
	})
	return result, err
}

func (s *WorkspaceService) ensureExistingWorkspaceRunningAuthorized(ctx context.Context, workspace db.Workspace, requesterID int64) (db.Workspace, error) {
	if err := s.refuseRebuildRequired(workspace); err != nil {
		return workspace, err
	}
	if handled, err := s.runningWorkspaceChild(ctx, workspace); handled || err != nil {
		return workspace, err
	}
	if s.runtime != nil {
		return s.ensureRuntimeWorkspaceRunning(ctx, workspace, requesterID)
	}
	if s.sandbox == nil {
		return workspace, pkgerrors.Internal("sandbox provider unavailable")
	}
	if strings.TrimSpace(workspace.VmID) == "" {
		return workspace, pkgerrors.Conflict("workspace VM has not been provisioned")
	}

	vm, err := s.sandbox.InspectSandbox(ctx, workspace.VmID)
	if err != nil {
		if vmAlreadyGone(err) {
			// The VM was reclaimed out-of-band. This resume path carries no
			// provisioning input, so advise a fresh create (which — with the
			// delete-tolerates-404 fix — the user can now do after removing the
			// zombie) rather than 500ing forever on every resume/SSH attempt.
			return workspace, s.missingWorkspaceVM(ctx, workspace, requesterID)
		}
		// The same funnel the session-create path uses for the same call.
		// Internal() threw the controller's verdict away and reported every
		// box-tier failure as a plue defect, so resume, SSH, terminals,
		// language servers, file facets and coding all told the user "plue is
		// broken" when the honest answer was "a worker is draining" or "the
		// egress proxy is down".
		return workspace, workspaceProvisioningError("get sandbox", err)
	}

	if vm.State == sandbox.StateRunning {
		if workspace.Status != "running" {
			if readyErr := s.waitForWorkspaceGuestActivation(ctx, workspace); readyErr != nil {
				return workspace, readyErr
			}
			updated, updateErr := s.q.UpdateWorkspaceStatus(ctx, db.UpdateWorkspaceStatusParams{
				ID:     workspace.ID,
				Status: "running",
			})
			if updateErr == nil {
				workspace = updated
			}
		}
		s.meterWorkspaceUsage(ctx, workspace, workspace.Status)
		_ = s.q.TouchWorkspaceActivity(ctx, workspace.ID)
		return workspace, nil
	}

	updated, err := s.resumeWorkspaceVM(ctx, workspace)
	if err != nil {
		if isWorkspaceGuestNotReady(err) {
			return workspace, err
		}
		// Ahead of every other verdict: a full pool says nothing about this
		// guest, which is still suspended with its disk intact. Advising a
		// fresh create would talk the user into throwing away a healthy box.
		if isNoCapacityError(err) {
			return s.refuseResumeForNoCapacity(ctx, workspace, err)
		}
		if isHardResumeFailure(err) {
			updated, err = s.resumeWorkspaceVM(ctx, workspace)
			if err == nil {
				return updated, nil
			}
			// The pool can fill between the two attempts, and the retry's
			// verdict is the one that counts.
			if isNoCapacityError(err) {
				return s.refuseResumeForNoCapacity(ctx, workspace, err)
			}
		}
		return workspace, retryableWorkspaceResumeError(err)
	}
	return updated, nil
}

func (s *WorkspaceService) ensureWorkspaceRunning(ctx context.Context, workspace db.Workspace, input CreateWorkspaceSessionInput) (db.Workspace, error) {
	return s.withWorkspaceProvisionLock(ctx, workspace, func(current db.Workspace) (db.Workspace, error) {
		return s.ensureWorkspaceRunningOwned(ctx, current, input)
	})
}

func (s *WorkspaceService) ensureWorkspaceRunningOwned(ctx context.Context, workspace db.Workspace, input CreateWorkspaceSessionInput) (db.Workspace, error) {
	if err := s.refuseRebuildRequired(workspace); err != nil {
		return workspace, err
	}
	if handled, err := s.runningWorkspaceChild(ctx, workspace); handled || err != nil {
		return workspace, err
	}
	durable := s.durableProvisioning()
	provisioning := workspace.Status == "starting" || workspace.Status == "pending"
	if s.runtime != nil {
		requesterID := input.UserID
		if requesterID == 0 {
			requesterID = workspace.UserID
		}
		// Runtime creates replay by workspace ID; a snapshot row replays its restore.
		if durable && provisioning && workspace.SourceSnapshotID.Valid {
			snapshot, err := s.q.GetWorkspaceSnapshot(ctx, UUIDString(workspace.SourceSnapshotID))
			if err != nil {
				return workspace, err
			}
			return s.restoreRuntimeWorkspaceSnapshot(ctx, workspace, snapshot, requesterID)
		}
		return s.ensureRuntimeWorkspaceRunning(ctx, workspace, requesterID)
	}
	if durable && provisioning {
		var err error
		workspace, err = s.recoverUnregisteredWorkspaceVM(ctx, workspace)
		if err != nil {
			return workspace, err
		}
		if workspace.SourceSnapshotID.Valid && strings.TrimSpace(workspace.VmID) == "" {
			snapshot, err := s.q.GetWorkspaceSnapshot(ctx, UUIDString(workspace.SourceSnapshotID))
			if err != nil {
				return workspace, err
			}
			return s.createWorkspaceVMFromSnapshot(ctx, workspace, snapshot)
		}
		return s.provisionWorkspaceVM(ctx, workspace, input, true)
	}
	if strings.TrimSpace(workspace.VmID) == "" {
		return s.createWorkspaceVM(ctx, workspace, input)
	}

	vm, err := s.sandbox.InspectSandbox(ctx, workspace.VmID)
	if err != nil {
		if vmAlreadyGone(err) {
			// Primary references stay intact for recovery, including when the VM
			// disappears after create's liveness probe. Derived rows can rebuild.
			return s.reprovisionWorkspaceVM(ctx, workspace, input, err)
		}
		return workspace, workspaceProvisioningError("get sandbox", err)
	}
	if vm.State == sandbox.StateRunning {
		if workspace.Status != "running" {
			if readyErr := s.waitForWorkspaceGuestActivation(ctx, workspace); readyErr != nil {
				return workspace, readyErr
			}
			updated, updateErr := s.q.UpdateWorkspaceStatus(ctx, db.UpdateWorkspaceStatusParams{
				ID:     workspace.ID,
				Status: "running",
			})
			if updateErr == nil {
				workspace = updated
			}
		}
		s.meterWorkspaceUsage(ctx, workspace, workspace.Status)
		return workspace, nil
	}

	updated, err := s.resumeWorkspaceVM(ctx, workspace)
	if err != nil {
		if isWorkspaceGuestNotReady(err) {
			return workspace, err
		}
		// Capacity refusals have their own retry pacing and do not need an immediate retry.
		if isNoCapacityError(err) {
			return s.refuseResumeForNoCapacity(ctx, workspace, err)
		}
		// The controller has forgotten this sandbox (404). Inspect said it was
		// there a moment ago, so the VM died between the two calls — a worker
		// rollout mid-deploy does exactly this. Preserve primary references;
		// only derived workspaces can rebuild in place.
		if vmAlreadyGone(err) && canProvisionWorkspace(input) {
			return s.reprovisionWorkspaceVM(ctx, workspace, input, err)
		}
		// Retry server failures once, retaining the original VM and disk.
		if isHardResumeFailure(err) {
			updated, err = s.resumeWorkspaceVM(ctx, workspace)
			if err == nil {
				return updated, nil
			}
			// The pool can fill between the two attempts, and the retry's
			// verdict is the one that counts: never reprovision off a 503.
			if isNoCapacityError(err) {
				return s.refuseResumeForNoCapacity(ctx, workspace, err)
			}
			if vmAlreadyGone(err) && canProvisionWorkspace(input) {
				return s.reprovisionWorkspaceVM(ctx, workspace, input, err)
			}
		}
		return workspace, retryableWorkspaceResumeError(err)
	}
	return updated, nil
}

func isWorkspaceGuestNotReady(err error) bool {
	var apiErr *pkgerrors.APIError
	return errors.As(err, &apiErr) && apiErr.Code == pkgerrors.CodeGuestNotReady
}

// Both runtime adapters apply the same admission rule. A running product row
// retains its reservation when execution idle-sleeps; suspended rows need a slot.
func (s *WorkspaceService) authorizeWorkspaceResume(ctx context.Context, row db.Workspace) error {
	if row.Status == "running" {
		return authorizeCountedSandboxResumeForUser(ctx, s.billing, row.UserID, row.ID, row.VmID)
	}
	return authorizeSandboxStartForUser(ctx, s.billing, row.UserID)
}

func (s *WorkspaceService) resumeWorkspaceVM(ctx context.Context, workspace db.Workspace) (out db.Workspace, retErr error) {
	defer func() { s.observeWorkspaceLifecycle("resume", retErr) }()
	if err := s.authorizeWorkspaceResume(ctx, workspace); err != nil {
		return workspace, err
	}
	var stampErr error
	workspace, stampErr = s.stampResumedWorkspaceIdleTimeout(ctx, workspace)
	if stampErr != nil {
		return workspace, stampErr
	}
	idleTimeout := s.workspaceIdleTimeoutSeconds
	if s.billing != nil {
		idleTimeout = int64(workspace.IdleTimeoutSecs)
	}
	resumeCtx, cancel := context.WithTimeout(ctx, workspaceResumeProvisionTimeout)
	defer cancel()
	setupCtx, cancelSetup := context.WithTimeout(resumeCtx, workspaceResumeTimeout)
	defer cancelSetup()

	var binding *workspaceProviderBinding
	if (s.providerConnections != nil || s.providerBootstrap) && workspace.Kind != "agent" {
		var err error
		binding, err = s.resolveWorkspaceProviderBindings(setupCtx, workspace)
		if err != nil {
			return workspace, err
		}
	}
	var egress *sandbox.EgressProxyPolicy
	if binding != nil {
		egress = binding.egress
	} else if outsider, err := s.outsiderWorkspace(setupCtx, workspace.ID); err != nil || outsider {
		// Without provider bindings a resume keeps the box's proxy; a box
		// that ran outsider-started work gets its narrowed one instead.
		if egress, err = s.workspaceEgressProxy(setupCtx, workspace.RepositoryID, workspace.ID); err != nil {
			return workspace, err
		}
	}
	resumeStartedAt := time.Now()
	// Readiness is a first-boot contract. Resume returns when the controller
	// reports the sandbox running; it must not wait for a one-shot boot signal.
	waitForReady := false
	startCtx, cancelStart := context.WithTimeout(resumeCtx, workspaceResumeTimeout)
	defer cancelStart()
	if _, err := s.sandbox.StartSandbox(startCtx, workspace.VmID, sandbox.StartRequest{
		EgressProxy:        egress,
		IdleTimeoutSeconds: &idleTimeout,
		WaitForReady:       &waitForReady,
	}); err != nil {
		return workspace, err
	}
	if err := s.waitForWorkspaceGuestActivation(startCtx, workspace); err != nil {
		return workspace, err
	}
	if err := finishWorkspaceArtifacts(resumeCtx, s.sandbox, workspace.VmID, workspaceBootstrapScriptForKind(workspace.Kind)); err != nil {
		return workspace, err
	}
	if client, ok := s.sandbox.(workspaceArtifactClient); ok {
		if err := waitForWorkspaceArtifactBootstrap(resumeCtx, client, workspace.VmID); err != nil {
			return workspace, err
		}
	}
	if binding != nil {
		// Refresh persistent auth settings without repeating the repository setup script.
		binding.environment.SetupScript = ""
		if err := s.runWorkspaceAgentEnvironmentSetup(resumeCtx, workspace, workspace.VmID, binding); err != nil {
			return workspace, err
		}
	}
	resumeDuration := time.Since(resumeStartedAt)
	if s.sandboxMetrics != nil {
		s.sandboxMetrics.ObserveSandboxVMSuspend(resumeDuration.Seconds())
	}

	// CAS into 'running': only the request that wins the transition increments
	// the active-VM gauge, so concurrent resumes of the same workspace (StartSandbox
	// is idempotent on sandbox provider's side) cannot over-count one VM.
	updated, err := s.q.ResumeWorkspaceToRunning(ctx, workspace.ID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// A concurrent resume already marked the row running (or the
			// workspace was deleted mid-resume). Return the current row without
			// touching the gauge — the winner accounted for it.
			current, loadErr := s.q.GetWorkspace(ctx, workspace.ID)
			if loadErr != nil {
				return workspace, pkgerrors.Internal("load workspace after resume: " + loadErr.Error())
			}
			if err := s.refuseUnnarrowedOutsiderBox(ctx, current, egress); err != nil {
				return current, err
			}
			_ = s.q.TouchWorkspaceActivity(ctx, current.ID)
			return current, nil
		}
		return workspace, pkgerrors.Internal("update workspace status: " + err.Error())
	}
	s.meterWorkspaceUsage(ctx, workspace, "running")
	resumedAt := time.Now().UTC()
	if err = s.q.MarkWorkspaceResumed(ctx, db.MarkWorkspaceResumedParams{ID: workspace.ID, ResumedAt: resumedAt}); err != nil {
		return workspace, pkgerrors.Internal("record workspace resume: " + err.Error())
	}
	// MarkWorkspaceResumed wrote these after the CAS returned its row.
	if !updated.StartedAt.Valid {
		updated.StartedAt = pgtype.Timestamptz{Time: resumedAt, Valid: true}
	}
	updated.ResumedAt = pgtype.Timestamptz{Time: resumedAt, Valid: true}
	if s.sandboxMetrics != nil {
		s.sandboxMetrics.AddSandboxActiveVMs("workspace", 1)
	}
	if err := s.refuseUnnarrowedOutsiderBox(ctx, updated, egress); err != nil {
		return updated, err
	}
	_ = s.q.TouchWorkspaceActivity(ctx, updated.ID)
	updated = s.installWorkspaceHeadReporterBestEffort(ctx, updated, workspace.VmID)
	// Re-publish the desktop port: the controller's domain mapping carries
	// the placement generation, which a resume can move.
	s.notifyWorkspace(ctx, updated.ID, "running")
	slog.Info("sandbox resumed", "vm_id", workspace.VmID, "type", "workspace", "duration_ms", resumeDuration.Milliseconds())
	return updated, nil
}

func (s *WorkspaceService) reprovisionWorkspaceVM(ctx context.Context, workspace db.Workspace, input CreateWorkspaceSessionInput, cause error) (db.Workspace, error) {
	if !workspace.IsFork {
		// Session/SSH opens must not silently replace the primary's recovery
		// identity. Create retires the old row and allocates a distinct primary.
		return workspace, s.missingWorkspaceVM(ctx, workspace, input.UserID)
	}
	// If the row still holds the gauge's +1 (DB said running while the VM was
	// actually down), release it via the running->suspended CAS so the -1 pairs
	// exactly once with the +1 the replacement VM will record.
	if _, err := s.q.SuspendRunningWorkspace(ctx, workspace.ID); err == nil {
		s.meterWorkspaceUsage(ctx, workspace, "suspended")
		if s.sandboxMetrics != nil {
			s.sandboxMetrics.AddSandboxActiveVMs("workspace", -1)
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return workspace, pkgerrors.Internal("update workspace status: " + err.Error())
	}

	// Replacing a lost VM consumes fresh capacity, just like resuming one.
	if err := authorizeSandboxStartForUser(ctx, s.billing, workspace.UserID); err != nil {
		return workspace, err
	}
	var stampErr error
	workspace, stampErr = s.stampResumedWorkspaceIdleTimeout(ctx, workspace)
	if stampErr != nil {
		return workspace, stampErr
	}

	// Reset the row to a re-registerable state (vm_id='', status='starting') and
	// open a new provisioning generation.
	//
	// Clearing vm_id is what lets the replacement register: marking the row
	// 'failed' while keeping the stale vm_id made createWorkspaceVM's
	// RegisterWorkspaceVM guard (vm_id='' AND status IN ('pending','starting'))
	// unmatchable, so the freshly booted replacement VM was deleted as an orphan
	// and the workspace was returned as a bogus wonElsewhere success.
	//
	// Advancing the generation is what lets the replacement be CREATED at all:
	// it seeds the controller Idempotency-Key (workspaceProvisionAttempt), and
	// the previous attempt's key carries the previous attempt's request digest.
	reset, err := s.resetWorkspaceForReprovision(ctx, workspace)
	if err != nil {
		return workspace, pkgerrors.Internal("reset workspace for reprovision: " + err.Error())
	}
	// The old VM is unreferenced now that the row points nowhere; reap it so a
	// half-started VM cannot leak (best-effort — sandbox provider 404s are tolerated).
	s.deleteOrphanedWorkspaceVM(ctx, workspace.VmID)

	slog.Warn(
		"workspace resume failed; reprovisioning sandbox",
		"workspace_id",
		workspace.ID,
		"old_vm_id",
		workspace.VmID,
		"error",
		cause,
	)
	return s.createWorkspaceVM(ctx, reset, input)
}

// workspaceReprovisionResetter is the optional querier surface that clears the
// dead vm_id and advances the provisioning generation in ONE statement. It is
// asked for by assertion, exactly like workspaceVMRegistrar, so the many test
// queriers that implement only the base WorkspaceQuerier keep compiling.
type workspaceReprovisionResetter interface {
	ResetWorkspaceForReprovision(ctx context.Context, id string) (db.Workspace, error)
}

// resetWorkspaceForReprovision hands the row back ready for a replacement VM:
// vm_id cleared, status 'starting', provisioning_generation advanced. The
// fallback keeps the generation bump in memory so a querier without the
// dedicated statement still derives a fresh idempotency key for this attempt.
func (s *WorkspaceService) resetWorkspaceForReprovision(ctx context.Context, workspace db.Workspace) (db.Workspace, error) {
	if resetter, ok := s.q.(workspaceReprovisionResetter); ok {
		// pgx.ErrNoRows here means the row was soft-deleted mid-reprovision:
		// there is nothing left to reprovision into, so it propagates.
		reset, err := resetter.ResetWorkspaceForReprovision(ctx, workspace.ID)
		if err != nil {
			return workspace, err
		}
		return reset, nil
	}
	reset, err := s.q.UpdateWorkspaceExecutionInfo(ctx, db.UpdateWorkspaceExecutionInfoParams{
		ID:     workspace.ID,
		VmID:   "",
		Status: "starting",
	})
	if err != nil {
		return workspace, err
	}
	reset.ProvisioningGeneration = workspace.ProvisioningGeneration + 1
	return reset, nil
}

// refuseUnnarrowedOutsiderBox suspends a box that is running with an egress
// policy computed before its workspace was marked as having run
// outsider-started work (a resume racing the mark). It runs once the box is
// visibly running, so a mark committed earlier is seen here and a mark
// committed later sees the box running (NarrowOutsiderEgress suspends it).
func (s *WorkspaceService) refuseUnnarrowedOutsiderBox(ctx context.Context, workspace db.Workspace, egress *sandbox.EgressProxyPolicy) error {
	if egress != nil && len(egress.HostRules) > 0 {
		return nil
	}
	outsider, err := s.outsiderWorkspace(ctx, workspace.ID)
	if err == nil && !outsider {
		return nil
	}
	if suspendErr := s.suspendWorkspace(ctx, workspace); suspendErr != nil {
		slog.Warn("suspend a box that booted before its outsider mark", "workspace_id", workspace.ID, "error", suspendErr)
	}
	failure := pkgerrors.New(pkgerrors.CodeServiceUnavailable, "the workspace restarts with the egress of a box that ran outsider-started work; retry")
	failure.RetryAfter = 5
	return failure
}

// NarrowOutsiderEgress makes sure every proxy a marked workspace runs is
// narrowed before outsider-started work runs on it, then seals the
// workspace so later runs skip the check. A workspace runtime narrows the
// running box itself (WorkspaceConversationEgress). Otherwise a box that
// booted before the mark is suspended once: its next start computes the
// narrowed policy. A boot in flight is waited for.
func (s *WorkspaceService) NarrowOutsiderEgress(ctx context.Context, workspaceID string) error {
	sealed, err := s.q.IsOutsiderWorkspaceEgressSealed(ctx, workspaceID)
	if err != nil || sealed {
		return err
	}
	if s.hasWorkspaceRuntime() {
		// Creates and starts hold the workspace lock: none is in flight here,
		// and one that was is visible as pending or starting below.
		unlock := s.lockRuntimeWorkspace(workspaceID)
		defer unlock()
	}
	workspace, err := s.q.GetWorkspace(ctx, workspaceID)
	if err != nil {
		return err
	}
	if workspace.Status == "pending" || workspace.Status == "starting" {
		// A boot in flight may have computed its policy before the mark.
		return pkgerrors.Conflict("the workspace is starting; outsider-started work waits for it")
	}
	if s.hasWorkspaceRuntime() {
		if err := s.withholdRuntimeConversation(ctx, workspace, workspace.UserID); err != nil {
			return err
		}
		return s.q.SealOutsiderWorkspaceEgress(ctx, workspaceID)
	}
	switch workspace.Status {
	case "running":
		if err := s.suspendWorkspace(ctx, workspace); err != nil {
			return err
		}
	}
	return s.q.SealOutsiderWorkspaceEgress(ctx, workspaceID)
}

// withholdRuntimeConversation has the workspace runtime run a marked
// workspace's egress without GitHub conversation, before it creates or
// starts the box and before outsider-started work runs on it. A runtime
// that cannot fails the operation closed.
func (s *WorkspaceService) withholdRuntimeConversation(ctx context.Context, row db.Workspace, requesterID int64) error {
	outsider, err := s.outsiderWorkspace(ctx, row.ID)
	if err != nil {
		return pkgerrors.Internal("read the workspace's outsider mark").WithCause(err)
	}
	if !outsider {
		return nil
	}
	egress, ok := s.runtime.(workspaceapi.WorkspaceConversationEgress)
	if !ok {
		return pkgerrors.Conflict("this workspace runtime cannot withhold GitHub conversation from outsider-started work")
	}
	// A fresh operation each time: a retry after a failure is not a replay.
	operationCtx, err := s.workspaceRuntimeContext(ctx, row, requesterID,
		workspaceLifecycleOperation(row, "withhold-conversation:"+strconv.FormatInt(time.Now().UnixNano(), 10)))
	if err != nil {
		return err
	}
	if err := egress.WithholdConversationEgress(operationCtx, row.ID); err != nil {
		return pkgerrors.Internal("withhold GitHub conversation from the workspace's egress").WithCause(err)
	}
	return nil
}

func (s *WorkspaceService) suspendWorkspace(ctx context.Context, workspace db.Workspace) (retErr error) {
	defer func() { s.observeWorkspaceLifecycle("suspend", retErr) }()
	if s.runtime != nil {
		unlock := s.lockRuntimeWorkspace(workspace.ID)
		defer unlock()
		current, err := s.currentRuntimeWorkspaceLocked(ctx, workspace)
		if err != nil {
			return err
		}
		if current.Status == "suspended" || current.Status == "stopped" {
			return nil
		}
		if current.Status != "running" {
			return pkgerrors.Conflict("workspace is " + current.Status)
		}
		s.revokeWorkspaceHeadToken(ctx, current)
		s.retireBoxHostCredentials(ctx, current)
		suspended, err := s.q.SuspendRunningWorkspace(ctx, current.ID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil
			}
			return pkgerrors.Internal("update workspace status: " + err.Error())
		}
		if err := s.stopRuntimeWorkspaceLocked(ctx, suspended, current.UserID, "suspend"); err != nil {
			rollbackCtx, cancel := detachedRuntimeContext(ctx, workspaceResumeProvisionTimeout)
			defer cancel()
			running, updateErr := s.q.UpdateWorkspaceStatus(rollbackCtx, db.UpdateWorkspaceStatusParams{ID: current.ID, Status: "running"})
			if updateErr == nil {
				_, updateErr = s.ensureRuntimeWorkspaceRunningLocked(rollbackCtx, running, current.UserID)
			}
			if updateErr != nil {
				return pkgerrors.Internal(err.Error() + "; restore workspace after failed suspend: " + updateErr.Error())
			}
			return err
		}
		s.meterWorkspaceUsage(ctx, suspended, "suspended")
		s.notifyWorkspace(ctx, suspended.ID, "suspended")
		return nil
	}
	if s.sandbox == nil || strings.TrimSpace(workspace.VmID) == "" {
		return nil
	}
	if workspace.Status == "suspended" || workspace.Status == "stopped" {
		return nil
	}
	s.revokeWorkspaceHeadToken(ctx, workspace)
	s.retireBoxHostCredentials(ctx, workspace)

	startedAt := time.Now()
	if _, err := s.sandbox.SuspendSandbox(ctx, workspace.VmID); err != nil {
		// sandbox provider suspends idle VMs on its own, so by the time the idle
		// sweeper (or a user) asks, the VM is frequently already off —
		// "VM is not running" (and a VM that no longer exists) IS the desired
		// end state, not a failure. Treating it as one left the row 'running'
		// forever, permanently holding a concurrent-sandbox quota slot; three
		// leaked slots bricked ALL workspace provisioning for the user.
		if !vmAlreadyStopped(err) {
			return pkgerrors.Internal("suspend sandbox: " + err.Error())
		}
		slog.Info("sandbox already stopped; reconciling status", "vm_id", workspace.VmID, "type", "workspace")
	} else {
		duration := time.Since(startedAt)
		if s.sandboxMetrics != nil {
			s.sandboxMetrics.ObserveSandboxVMSuspend(duration.Seconds())
		}
		slog.Info("sandbox suspended", "vm_id", workspace.VmID, "type", "workspace", "duration_ms", duration.Milliseconds())
	}
	// Gate the -1 on WINNING the running->suspended CAS. The in-memory guard
	// above is a stale-read fast path only; UpdateWorkspaceStatus was
	// unconditional (WHERE id=$1), so two concurrent suspends (a user + the idle
	// sweeper, or a suspend racing a failed workspace whose VM was already
	// reclaimed) both reached the decrement and drove the gauge negative. The
	// CAS returns the row to exactly one caller — and only that caller
	// decrements and notifies — so the -1 pairs one-to-one with the +1 recorded
	// when the row entered 'running'.
	if _, err := s.q.SuspendRunningWorkspace(ctx, workspace.ID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			slog.Info("workspace already left 'running'; skipping suspend accounting", "workspace_id", workspace.ID, "vm_id", workspace.VmID)
			return nil
		}
		return pkgerrors.Internal("update workspace status: " + err.Error())
	}
	if s.sandboxMetrics != nil {
		s.sandboxMetrics.AddSandboxActiveVMs("workspace", -1)
	}
	s.meterWorkspaceUsage(ctx, workspace, "suspended")
	s.notifyWorkspace(ctx, workspace.ID, "suspended")
	return nil
}

// suspendWorkspaceIfSessionless suspends a workspace after its last session
// ended. Unlike suspendWorkspace, the decision is made atomically in the DB:
// the running->suspended CAS only matches while NO active (pending/starting/
// running) session exists, so a session created concurrently with the destroy
// can never be handed a workspace this call just decided to suspend. After the
// VM suspend it re-checks for sessions that slipped into the tiny CAS->SuspendSandbox
// window and resumes the VM for them.
func (s *WorkspaceService) suspendWorkspaceIfSessionless(ctx context.Context, workspace db.Workspace) (retErr error) {
	defer func() { s.observeWorkspaceLifecycle("suspend", retErr) }()
	if s.runtime != nil {
		unlock := s.lockRuntimeWorkspace(workspace.ID)
		defer unlock()
		current, err := s.currentRuntimeWorkspaceLocked(ctx, workspace)
		if err != nil {
			if apiErr, ok := err.(*pkgerrors.APIError); ok && apiErr.Code == pkgerrors.CodeNotFound {
				return nil
			}
			return err
		}
		if current.Status != "running" {
			return nil
		}
		suspended, err := s.q.SuspendRunningWorkspaceIfSessionless(ctx, current.ID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil
			}
			return pkgerrors.Internal("update workspace status: " + err.Error())
		}
		if err := s.stopRuntimeWorkspaceLocked(ctx, suspended, current.UserID, "sessionless-suspend"); err != nil {
			// Reconcile the product row back to running because the runtime stop
			// did not reach its required terminal state.
			rollbackCtx, cancel := detachedRuntimeContext(ctx, workspaceResumeProvisionTimeout)
			defer cancel()
			running, updateErr := s.q.UpdateWorkspaceStatus(rollbackCtx, db.UpdateWorkspaceStatusParams{ID: current.ID, Status: "running"})
			if updateErr == nil {
				_, updateErr = s.ensureRuntimeWorkspaceRunningLocked(rollbackCtx, running, current.UserID)
			}
			if updateErr != nil {
				return pkgerrors.Internal(err.Error() + "; restore workspace after failed sessionless suspend: " + updateErr.Error())
			}
			return err
		}
		s.meterWorkspaceUsage(ctx, suspended, "suspended")
		s.notifyWorkspace(ctx, suspended.ID, "suspended")
		active, countErr := s.q.CountActiveSessionsForWorkspace(ctx, suspended.ID)
		if countErr == nil && active > 0 {
			_, resumeErr := s.ensureRuntimeWorkspaceRunningLocked(ctx, suspended, current.UserID)
			return resumeErr
		}
		return nil
	}
	if s.sandbox == nil || strings.TrimSpace(workspace.VmID) == "" {
		return nil
	}

	if _, err := s.q.SuspendRunningWorkspaceIfSessionless(ctx, workspace.ID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Not running, or an active session (re)appeared — nothing to suspend.
			return nil
		}
		return pkgerrors.Internal("update workspace status: " + err.Error())
	}
	if s.sandboxMetrics != nil {
		s.sandboxMetrics.AddSandboxActiveVMs("workspace", -1)
	}
	s.meterWorkspaceUsage(ctx, workspace, "suspended")
	s.notifyWorkspace(ctx, workspace.ID, "suspended")

	startedAt := time.Now()
	if _, err := s.sandbox.SuspendSandbox(ctx, workspace.VmID); err != nil {
		if !vmAlreadyStopped(err) {
			return pkgerrors.Internal("suspend sandbox: " + err.Error())
		}
		slog.Info("sandbox already stopped; reconciling status", "vm_id", workspace.VmID, "type", "workspace")
	} else {
		duration := time.Since(startedAt)
		if s.sandboxMetrics != nil {
			s.sandboxMetrics.ObserveSandboxVMSuspend(duration.Seconds())
		}
		slog.Info("sandbox suspended", "vm_id", workspace.VmID, "type", "workspace", "duration_ms", duration.Milliseconds())
	}

	// Close the residual window: a session created between the CAS and the VM
	// suspend saw a running VM and may have marked itself running. Bring the VM
	// back up for it (resumeWorkspaceVM re-CASes into 'running' and re-pairs the
	// gauge), instead of stranding a "running" session on a suspended VM.
	active, err := s.q.CountActiveSessionsForWorkspace(ctx, workspace.ID)
	if err == nil && active > 0 {
		slog.Info("session appeared during last-session suspend; resuming workspace", "workspace_id", workspace.ID, "vm_id", workspace.VmID)
		if _, resumeErr := s.resumeWorkspaceVM(ctx, workspace); resumeErr != nil {
			return pkgerrors.Internal("resume workspace for new session: " + resumeErr.Error())
		}
	}
	return nil
}

// vmAlreadyStopped reports whether a sandbox provider suspend failure means the VM is
// already not running (auto-suspended by sandbox provider's idle policy) or gone
// entirely — states where the workspace must still be marked suspended so its
// concurrent-sandbox quota slot is released.
func vmAlreadyStopped(err error) bool {
	var statusErr *sandbox.StatusError
	if !errors.As(err, &statusErr) {
		return false
	}
	if statusErr.StatusCode == 404 {
		return true
	}
	return statusErr.StatusCode == 400 &&
		strings.Contains(strings.ToLower(statusErr.Message), "not running")
}

// vmAlreadyGone reports whether a sandbox provider error means the sandbox no
// longer exists. Deleting or looking it up is then a no-op that must not fail
// the caller; unlike vmAlreadyStopped, this does not treat a stopped sandbox as
// gone. The self-hosted controller reports this condition as HTTP 404.
func vmAlreadyGone(err error) bool {
	if errors.Is(err, sandbox.ErrNotFound) {
		return true
	}
	var statusErr *sandbox.StatusError
	if !errors.As(err, &statusErr) {
		return false
	}
	return statusErr.StatusCode == 404
}

// Server failures are retryable and say nothing about the persisted disk.
func isHardResumeFailure(err error) bool {
	var statusErr *sandbox.StatusError
	return errors.As(err, &statusErr) && statusErr.StatusCode >= 500 && statusErr.StatusCode < 600
}

// isNoCapacityError reports whether a failure means "the pool has no room",
// which is a TRANSIENT refusal and never a verdict on the guest. The controller
// re-charges the worker reservation a suspend handed back BEFORE any worker RPC
// (Controller.startPlacement) and preserves the stopped placement exactly as it
// was, so the VM and its disk are untouched and resumable the moment a slot
// frees up.
func isNoCapacityError(err error) bool {
	var statusErr *sandbox.StatusError
	if errors.As(err, &statusErr) {
		if strings.EqualFold(strings.TrimSpace(statusErr.Code), string(pkgerrors.CodeNoCapacity)) ||
			strings.EqualFold(strings.TrimSpace(statusErr.ErrorCode), string(pkgerrors.CodeNoCapacity)) {
			return true
		}
	}
	var apiErr *pkgerrors.APIError
	return errors.As(err, &apiErr) && apiErr.Code == pkgerrors.CodeNoCapacity
}

// workspaceNoCapacityMessage is user-facing verbatim: writeRouteError passes
// no_capacity messages through uncensored and apps/app renders plue's refusals
// as written. It says what happened, that nothing was lost, and what to do —
// in product vocabulary, never the provider's "no healthy Microsandbox worker
// has sufficient capacity".
const workspaceNoCapacityMessage = "The workspace pool is full right now. Your workspace and its files are safe; try again in a moment."

// suspendWorkspaceAfterNoCapacity parks a workspace the pool had no room for.
// It keeps vm_id — the whole point is that the same computer, with the same
// disk, comes back on the next open — and only settles the row's status.
//
// Two transitions matter. A row still reading 'running' (the DB said running
// while the guest was actually down) holds a +1 on the active-VM gauge that
// nothing will ever pair; the CAS releases it exactly once. A row mid-provision
// ('starting'/'pending') must not be left there: the stranded-'starting' reaper
// FAILS such a row and DELETES its VM, which is precisely the box loss this
// path exists to prevent.
func (s *WorkspaceService) suspendWorkspaceAfterNoCapacity(ctx context.Context, workspace db.Workspace) db.Workspace {
	if s.q == nil || strings.TrimSpace(workspace.VmID) == "" {
		return workspace
	}
	updated, err := s.q.SuspendRunningWorkspace(ctx, workspace.ID)
	if err == nil {
		if s.sandboxMetrics != nil {
			s.sandboxMetrics.AddSandboxActiveVMs("workspace", -1)
		}
		s.meterWorkspaceUsage(ctx, workspace, "suspended")
		s.notifyWorkspace(ctx, workspace.ID, "suspended")
		return updated
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		slog.Warn("could not park workspace after a full pool", "workspace_id", workspace.ID, "error", err)
		return workspace
	}
	if workspace.Status == "suspended" || workspace.Status == "stopped" {
		return workspace
	}
	updated, err = s.q.UpdateWorkspaceStatus(ctx, db.UpdateWorkspaceStatusParams{
		ID:     workspace.ID,
		Status: "suspended",
	})
	if err != nil {
		slog.Warn("could not park workspace after a full pool", "workspace_id", workspace.ID, "error", err)
		return workspace
	}
	s.meterWorkspaceUsage(ctx, workspace, "suspended")
	s.notifyWorkspace(ctx, workspace.ID, "suspended")
	return updated
}

// refuseResumeForNoCapacity is the single verdict every resume path takes when
// the pool is full: park the row, touch nothing else, and hand the caller a
// retryable 503 with a Retry-After.
func (s *WorkspaceService) refuseResumeForNoCapacity(ctx context.Context, workspace db.Workspace, cause error) (db.Workspace, error) {
	slog.Warn("workspace resume refused: the pool is full",
		"workspace_id", workspace.ID, "vm_id", workspace.VmID, "error", cause)
	return s.suspendWorkspaceAfterNoCapacity(ctx, workspace), pkgerrors.NoCapacity(workspaceNoCapacityMessage)
}

// WorkspaceLifecycleMetricsObserver records lifecycle operation outcomes.
type WorkspaceLifecycleMetricsObserver interface {
	ObserveWorkspaceLifecycle(action, result string)
}

func (s *WorkspaceService) observeWorkspaceLifecycle(action string, err error) {
	metrics, ok := s.sandboxMetrics.(WorkspaceLifecycleMetricsObserver)
	if !ok {
		return
	}
	result := "success"
	if err != nil {
		result = "failure"
	}
	metrics.ObserveWorkspaceLifecycle(action, result)
}

// retryableWorkspaceResumeError keeps the suspended VM and its disk. A
// controller 5xx or a resume timeout says nothing about the persisted files, so
// the caller retries later; only a 404 (vmAlreadyGone) justifies replacement.
func retryableWorkspaceResumeError(cause error) *pkgerrors.APIError {
	if isHardResumeFailure(cause) || errors.Is(cause, context.DeadlineExceeded) {
		failure := pkgerrors.New(pkgerrors.CodeServiceUnavailable, "workspace resume temporarily unavailable; retry, or run `smithers workspace create` for a fresh workspace")
		failure.RetryAfter = 5
		return failure
	}
	return workspaceProvisioningError("resume sandbox", cause)
}
