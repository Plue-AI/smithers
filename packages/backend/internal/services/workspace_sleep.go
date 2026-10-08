package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// BranchCapture is the authenticated daemon capture contract. Success means
// native snapshot, verified object delivery and the entire outbox's durable
// acknowledgement have completed, not just that capture was requested.
type BranchCapture interface {
	Capture(context.Context, string) (machined.CaptureResult, error)
}

func WithBranchCapture(capture BranchCapture) WorkspaceServiceOption {
	return func(s *WorkspaceService) { s.branchCapture = capture }
}

// EnableMachineIdleRelease connects admission to the same capture/stop lifecycle
// as explicit Sleep. The lifecycle owns its barrier and confirmed-stop receipt;
// the scheduler never issues a second stop or captures on an unverified branch.
func (s *WorkspaceService) EnableMachineIdleRelease(freeDisk func(context.Context) (int64, error), observe func(context.Context, db.Workspace) (microsandbox.AdmissionSafety, error)) error {
	runtime, ok := s.runtime.(interface {
		AdmissionSnapshot() []microsandbox.AdmissionRequest
		SetAdmissionIdleProviders(microsandbox.AdmissionIdleProviders) error
	})
	if !ok || observe == nil || s.machineAdmission == nil {
		return errors.New("automatic branch release providers unavailable")
	}
	return runtime.SetAdmissionIdleProviders(microsandbox.AdmissionIdleProviders{
		FreeDisk: freeDisk,
		Safety: func(ctx context.Context) ([]microsandbox.AdmissionSafety, error) {
			seen := map[string]bool{}
			var observations []microsandbox.AdmissionSafety
			for _, request := range runtime.AdmissionSnapshot() {
				if request.State != "granted" || request.Class == "background" || seen[request.Holder] || !strings.HasPrefix(request.Holder, "workspace:") {
					continue
				}
				seen[request.Holder] = true
				row, err := s.q.GetWorkspace(ctx, strings.TrimPrefix(request.Holder, "workspace:"))
				if err != nil {
					return nil, err
				}
				if row.Status != "running" || row.DeletedAt.Valid {
					continue
				}
				safety, err := observe(ctx, row)
				if err != nil {
					return nil, err
				}
				safety.Holder = request.Holder
				observations = append(observations, safety)
			}
			return observations, nil
		},
		Prepare: func(ctx context.Context, holder string) error {
			id := strings.TrimPrefix(holder, "workspace:")
			unlock := s.lockRuntimeWorkspace(id)
			defer unlock()
			row, err := s.q.GetWorkspace(ctx, id)
			if err != nil {
				return err
			}
			fresh, err := observe(ctx, row)
			if err != nil {
				return err
			}
			if !fresh.PresenceKnown || !fresh.SessionsKnown || !fresh.RunKnown || fresh.Presence || fresh.Terminal || fresh.SSH || fresh.RunningStep ||
				fresh.BurstsEnabled && (!fresh.BurstsKnown || fresh.BurstOpen) || fresh.DocumentsEnabled && (!fresh.DocumentsKnown || fresh.Unflushed) {
				return errors.New("branch is no longer safe-idle")
			}
			if err := s.captureAndSleepLocked(ctx, row, true); err != nil {
				return err
			}
			current, err := s.q.GetWorkspace(ctx, id)
			if err != nil {
				return err
			}
			if current.Status != "suspended" && current.Status != "stopped" {
				return errors.New("branch admission changed before capture")
			}
			return nil
		},
		Stop: func(ctx context.Context, holder string) error {
			row, err := s.q.GetWorkspace(ctx, strings.TrimPrefix(holder, "workspace:"))
			if err != nil {
				return err
			}
			if row.Status != "suspended" && row.Status != "stopped" {
				return errors.New("branch stop is unconfirmed")
			}
			return nil // captureAndSleepLocked already observed the runtime stop.
		},
	})
}

func (s *WorkspaceService) captureAndSleep(ctx context.Context, row db.Workspace, sessionless bool) error {
	unlock := s.lockRuntimeWorkspace(row.ID)
	defer unlock()
	return s.captureAndSleepLocked(ctx, row, sessionless)
}

func (s *WorkspaceService) captureAndSleepLocked(ctx context.Context, row db.Workspace, sessionless bool) error {
	if s.prepareFlowHostCapture != nil {
		if err := s.prepareFlowHostCapture(ctx, row.ID); err != nil {
			return err
		}
	}
	if fence, ok := s.runtime.(interface {
		WithCaptureWritersExcluded(context.Context, string, func(context.Context) error) error
	}); ok {
		// The trusted-process head publisher snapshots periodically. Stop that
		// supervised writer before the final native capture; guest capture owns
		// its daemon barrier instead. Resume provisions the publisher again.
		operationCtx, err := s.workspaceRuntimeContext(ctx, row, row.UserID, workspaceLifecycleOperation(row, "capture"))
		if err != nil {
			return err
		}
		if err := s.runtime.StopService(operationCtx, row.ID, workspaceHeadReporterService); err != nil {
			return err
		}
		return fence.WithCaptureWritersExcluded(ctx, row.ID, func(ctx context.Context) error {
			return s.captureAndSleepExcluded(context.WithValue(ctx, branchWriterExclusionKey{}, true), row, sessionless)
		})
	}
	return s.captureAndSleepExcluded(ctx, row, sessionless)
}

// SetFlowHostCapturePreparation stops only hosts whose pinned launches have
// settled. The runtime's writer fence still verifies quiescence before capture.
func (s *WorkspaceService) SetFlowHostCapturePreparation(prepare func(context.Context, string) error) {
	s.prepareFlowHostCapture = prepare
}

type branchWriterExclusionKey struct{}
type branchFinalCaptureKey struct{}
type branchFinalCapture struct {
	Head string `json:"head"`
	Tree string `json:"tree"`
	VMID string `json:"vm_id"`
}

func (s *WorkspaceService) captureAndSleepExcluded(ctx context.Context, row db.Workspace, sessionless bool) error {
	unavailable := func(err error) error {
		return pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branch sleep requires verified capture, runtime binding and state publication").WithCause(err)
	}
	store, ok := s.branchHeads.(workspaceSnapshotStore)
	if !ok || s.branchCapture == nil || !s.hasWorkspaceRuntime() || s.requireBranchMachineProviders() != nil {
		return unavailable(nil)
	}
	var err error
	row, err = s.q.GetWorkspace(ctx, row.ID)
	if err != nil {
		return unavailable(err)
	}
	if row.Status == "suspended" || row.Status == "stopped" {
		return nil
	}
	if row.Status != "running" || row.VmID == "" {
		return pkgerrors.Conflict("branch is not awake")
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return unavailable(err)
	}
	err = s.branchMachineProviders.LaneBinding(ctx, tx, row.RepositoryID, row.TargetBookmark, row.ID)
	_ = tx.Rollback(context.WithoutCancel(ctx))
	if err != nil {
		return unavailable(err)
	}
	operationCtx, err := s.workspaceRuntimeContext(ctx, row, row.UserID, workspaceLifecycleOperation(row, "sleep"))
	if err != nil {
		return unavailable(err)
	}
	if err = s.transitionBranchMachine(ctx, row, "running", "releasing", "", sessionless); err != nil {
		if sessionless && errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return unavailable(err)
	}
	// Cancellation must not strand a live VM in releasing. An inspection failure
	// is not evidence that it is awake: retain releasing and the failure receipt.
	fail := func(cause error) error {
		recovery, cancel := context.WithTimeout(context.WithoutCancel(operationCtx), 10*time.Second)
		defer cancel()
		next := "releasing"
		observed, inspectErr := s.runtime.InspectWorkspace(recovery, row.ID)
		if inspectErr == nil && observed.State == workspaceapi.WorkspaceRunning {
			next = "running"
		}
		_ = s.transitionBranchMachine(recovery, row, "releasing", next, "capture or stop failed")
		return unavailable(cause)
	}
	capture, err := s.branchCapture.Capture(ctx, row.ID)
	if err != nil {
		return fail(err)
	}
	current, err := s.q.GetWorkspace(ctx, row.ID)
	if err != nil {
		return fail(err)
	}
	if capture.Head == "" || capture.Tree == "" || current.HeadCommitID != capture.Head {
		return fail(fmt.Errorf("capture head has no durable projection"))
	}
	slug, err := s.workspaceRepoSlug(ctx, row.RepositoryID)
	if err != nil {
		return fail(err)
	}
	owner, repo, _ := strings.Cut(slug, "/")
	advertisement, err := store.InfoRefsUploadPack(ctx, owner, repo)
	if err != nil {
		return fail(err)
	}
	refs, err := parseUploadPackAdvertisement(advertisement)
	if err != nil {
		return fail(err)
	}
	verified := false
	for _, ref := range refs {
		if ref.name == repohost.BranchHeadRef(row.ID) && ref.oid == capture.Head {
			verified = true
		}
	}
	if !verified {
		return fail(fmt.Errorf("capture ref mismatch"))
	}
	commit, err := store.GetChange(ctx, owner, repo, capture.Head)
	if err != nil {
		return fail(err)
	}
	if commit.CommitID != capture.Head {
		return fail(fmt.Errorf("capture object unavailable"))
	}
	// No not-found/already-stopped fallback: successful stop is the receipt.
	if err = s.runtime.StopWorkspace(operationCtx, row.ID); err != nil {
		return fail(err)
	}
	finish, cancel := context.WithTimeout(context.WithoutCancel(operationCtx), 10*time.Second)
	defer cancel()
	observed, err := s.runtime.InspectWorkspace(finish, row.ID)
	if err != nil {
		return fail(err)
	}
	if observed.ID != row.ID || observed.State != workspaceapi.WorkspaceStopped {
		return fail(fmt.Errorf("branch stop is unconfirmed"))
	}
	if excluded, _ := ctx.Value(branchWriterExclusionKey{}).(bool); excluded {
		finish = context.WithValue(finish, branchFinalCaptureKey{}, branchFinalCapture{capture.Head, capture.Tree, row.VmID})
	}
	if err = s.transitionBranchMachine(finish, row, "releasing", "suspended", ""); err != nil {
		return unavailable(err)
	}
	s.revokeWorkspaceHeadToken(finish, current)
	s.meterWorkspaceUsage(finish, current, "suspended")
	return nil
}

// CaptureAndStop is install quiesce's machine step (spec §16.5.1, T-MCH-07's
// final capture). Each awake branch machine takes the sleep path: verified
// capture, then a confirmed stop that retains its disk. Quiesce ends sessions
// first, so open sessions do not block it. A failure names its branch, and a
// machine still awake afterwards refuses; an unavailable provider is never an
// empty machine list.
func (s *WorkspaceService) CaptureAndStop(ctx context.Context) error {
	if err := s.QuiesceAvailable(); err != nil {
		return err
	}
	running, err := s.q.ListRunningWorkspaces(ctx)
	if err != nil {
		return fmt.Errorf("list awake machines: %w", err)
	}
	var failures []error
	for _, row := range running {
		if err := ctx.Err(); err != nil {
			return errors.Join(append(failures, err)...)
		}
		if err := s.quiesceMachine(ctx, row); err != nil {
			failures = append(failures, err)
		}
	}
	if len(failures) > 0 {
		return errors.Join(failures...)
	}
	// A machine woken while the others were captured is still awake.
	awake, err := s.q.ListRunningWorkspaces(ctx)
	if err != nil {
		return fmt.Errorf("list awake machines: %w", err)
	}
	for _, row := range awake {
		failures = append(failures, fmt.Errorf("branch %s: still awake after capture", quiesceBranchName(row)))
	}
	return errors.Join(failures...)
}

// QuiesceAvailable reports whether every provider the machine step needs is
// composed. Quiesce asks before it freezes, so a missing one refuses with
// admissions still open.
func (s *WorkspaceService) QuiesceAvailable() error {
	if _, ok := s.branchHeads.(workspaceSnapshotStore); !ok || s.branchCapture == nil || !s.hasWorkspaceRuntime() || s.requireBranchMachineProviders() != nil {
		return pkgerrors.New(pkgerrors.CodeServiceUnavailable, "quiesce requires verified branch capture and the machine runtime")
	}
	return nil
}

func (s *WorkspaceService) quiesceMachine(ctx context.Context, row db.Workspace) error {
	owned, err := s.branchMachineOwned(ctx, row.UserID)
	if err != nil {
		return fmt.Errorf("branch %s: %w", quiesceBranchName(row), err)
	}
	if !owned {
		return fmt.Errorf("branch %s: not a branch machine; quiesce cannot capture it", quiesceBranchName(row))
	}
	if err := s.suspendWorkspace(ctx, row); err != nil {
		return fmt.Errorf("branch %s: %w", quiesceBranchName(row), err)
	}
	return nil
}

func quiesceBranchName(row db.Workspace) string {
	if row.TargetBookmark != "" {
		return row.TargetBookmark
	}
	return row.ID
}

// Commit state and its notification together. Branch live subscriptions project
// this same row; a rollback can never publish a state that did not persist.
func (s *WorkspaceService) transitionBranchMachine(ctx context.Context, row db.Workspace, from, to, failure string, sessionless ...bool) error {
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	idle := len(sessionless) > 0 && sessionless[0]
	result, err := tx.Exec(ctx, `UPDATE workspaces SET status=$3::varchar,updated_at=NOW(),suspended_at=CASE WHEN $3::varchar='suspended' THEN NOW() ELSE suspended_at END WHERE id=$1 AND status=$2 AND vm_id=$4 AND deleted_at IS NULL AND (NOT $5::boolean OR NOT EXISTS (SELECT 1 FROM workspace_sessions s WHERE s.workspace_id=workspaces.id AND s.status IN ('pending','starting','running')))`, row.ID, from, to, row.VmID, idle)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		if idle {
			return pgx.ErrNoRows
		}
		return pkgerrors.Conflict("branch machine changed")
	}
	payload, err := json.Marshal(map[string]string{"status": to})
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `SELECT pg_notify($1,$2)`, "workspace_status_"+strings.ReplaceAll(row.ID, "-", ""), string(payload)); err != nil {
		return err
	}
	if failure != "" {
		payload, _ := json.Marshal(map[string]string{"branch": row.ID, "message": failure})
		if _, err = jobs.RecordFactInTx(ctx, tx, jobs.Scope{TenantID: fmt.Sprint(row.RepositoryID), PrincipalID: "branch:" + row.ID}, uuid.NewString(), "branch.sleep", "failed", payload); err != nil {
			return err
		}
	}
	if capture, ok := ctx.Value(branchFinalCaptureKey{}).(branchFinalCapture); ok && to == "suspended" {
		payload, err := json.Marshal(capture)
		if err != nil {
			return err
		}
		if _, err = jobs.RecordFactInTx(ctx, tx, jobs.Scope{TenantID: fmt.Sprint(row.RepositoryID), PrincipalID: "branch:" + row.ID}, uuid.NewString(), "branch.final_capture", "completed", payload); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
