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

func (s *WorkspaceService) captureAndSleep(ctx context.Context, row db.Workspace, sessionless bool) error {
	unavailable := func(err error) error {
		return pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branch sleep requires verified capture, runtime binding and state publication").WithCause(err)
	}
	store, ok := s.branchHeads.(workspaceSnapshotStore)
	if !ok || s.branchCapture == nil || !s.hasWorkspaceRuntime() || s.requireBranchMachineProviders() != nil {
		return unavailable(nil)
	}
	unlock := s.lockRuntimeWorkspace(row.ID)
	defer unlock()
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
		recovery, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
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
	finish, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	if err = s.transitionBranchMachine(finish, row, "releasing", "suspended", ""); err != nil {
		return unavailable(err)
	}
	s.revokeWorkspaceHeadToken(finish, current)
	s.meterWorkspaceUsage(finish, current, "suspended")
	return nil
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
	return tx.Commit(ctx)
}
