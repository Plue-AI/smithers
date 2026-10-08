package services

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// TrustedMainMachine resolves the stored run, current credential and role, and
// exclusive ephemeral workspace. A read failure never grants secret delivery.
func TrustedMainMachine(ctx context.Context, store interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, q *db.Queries, workspace string) (bool, error) {
	var run db.WorkflowRun
	var credential []byte
	var e trustedMainEvidence
	err := store.QueryRow(ctx, `SELECT r.id,r.repository_id,r.trigger_event,r.trigger_ref,i.user_id,
 i.manual_credential,i.background_workspace_id::text,i.trusted_main_revision,i.source_revision,
 EXISTS(SELECT 1 FROM workspace_shares s WHERE s.workspace_id=w.id),
 EXISTS(SELECT 1 FROM mythical_items m WHERE m.workspace_id=w.id::text),w.id::text
 FROM workflow_run_flow_invocations i JOIN workflow_runs r ON r.id=i.workflow_run_id
 JOIN workspaces w ON w.id=i.background_workspace_id AND w.id=i.workspace_id
 WHERE w.id=$1::uuid AND w.repository_id=r.repository_id AND w.user_id=i.user_id
 AND w.deleted_at IS NULL AND w.source_commit=i.trusted_main_revision AND r.status IN ('queued','running')`, workspace).Scan(
		&run.ID, &run.RepositoryID, &run.TriggerEvent, &run.TriggerRef, &e.PersonID, &credential,
		&e.BackgroundWorkspace, &e.TrustedRevision, &e.SourceRevision, &e.Shared, &e.Outsider, &e.Workspace)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var c middleware.Credential
	if json.Unmarshal(credential, &c) != nil {
		return false, nil
	}
	info, err := middleware.ReloadCredential(ctx, q, c, time.Now())
	if errors.Is(err, middleware.ErrCredentialGone) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	e.Active = info.User.ID == e.PersonID && info.User.IsActive && !info.User.ProhibitLogin && !info.User.DeletedAt.Valid
	e.Manual = !info.IsTokenAuth && info.SessionHash != "" && info.CredentialKind() == middleware.CredentialPerson
	e.Role, err = InstallRoleOf(ctx, q, e.PersonID)
	if err != nil {
		return false, err
	}
	repo, err := q.GetRepoByID(ctx, run.RepositoryID)
	if err != nil {
		return false, err
	}
	return workflowRunOnTrustedMain(run, repo, e), nil
}

func (s *InvokedFlowService) manualMainCredential(ctx context.Context, runID int64) (*middleware.AuthInfo, error) {
	var raw []byte
	var person int64
	if err := s.pool.QueryRow(ctx, `SELECT manual_credential,user_id FROM workflow_run_flow_invocations WHERE workflow_run_id=$1`, runID).Scan(&raw, &person); err != nil {
		return nil, err
	}
	var credential middleware.Credential
	if err := json.Unmarshal(raw, &credential); err != nil {
		return nil, err
	}
	q := db.New(s.pool)
	info, err := middleware.ReloadCredential(ctx, q, credential, time.Now())
	if err != nil {
		return nil, err
	}
	role, err := InstallRoleOf(ctx, q, info.User.ID)
	if err != nil {
		return nil, err
	}
	if info.User.ID != person || info.IsTokenAuth || info.CredentialKind() != middleware.CredentialPerson || (role != InstallOwner && role != InstallMaintainer) {
		return nil, middleware.ErrCredentialGone
	}
	return info, nil
}

func (s *InvokedFlowService) IsBackgroundFlowHost(ctx context.Context, workspace string) (bool, error) {
	return db.New(s.pool).IsWorkflowBackgroundWorkspace(ctx, workspace)
}
