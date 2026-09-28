package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// invokedFlowBinding names an invoked run's Flow host target and projection.
const invokedFlowBinding = "workflow-invoke"

// InvokedFlowDispatcher is the flowdispatch.Service surface an invocation uses.
type InvokedFlowDispatcher interface {
	AdmitInTx(context.Context, pgx.Tx, flowdispatch.LaunchRequest) (jobs.RequestReceipt, error)
	CancelRequest(context.Context, jobs.Scope, string) (jobs.Operation, error)
}

// InvokedFlowService runs an invoked repository flow on the canonical Flow
// runtime: it admits one Flow launch in the same transaction as the product
// run, authorizes the launch's host on the invoker's box, and projects the
// runtime's receipts back onto workflow_runs.
type InvokedFlowService struct {
	pool           *pgxpool.Pool
	repositoryJobs *RepositoryJobService
	workspaces     RepositorySetupWorkspace
	dispatcher     InvokedFlowDispatcher
}

func NewInvokedFlowService(pool *pgxpool.Pool, repositoryJobs *RepositoryJobService, workspaces RepositorySetupWorkspace) *InvokedFlowService {
	return &InvokedFlowService{pool: pool, repositoryJobs: repositoryJobs, workspaces: workspaces}
}

func (s *InvokedFlowService) SetFlowDispatcher(dispatcher InvokedFlowDispatcher) {
	s.dispatcher = dispatcher
}

type invokedFlowProjection struct {
	Kind          string `json:"kind"`
	WorkflowRunID int64  `json:"workflowRunId"`
}

// InvokedFlowLaunch is one validated invocation.
type InvokedFlowLaunch struct {
	RepositoryID int64
	UserID       int64
	FlowID       string
	Input        json.RawMessage
	TriggerRef   string
}

func invokedFlowRequestID(runID int64) string {
	return "workflow-invoke:" + strconv.FormatInt(runID, 10)
}

func invokedFlowPath(flowID string) string {
	return "flows/" + flowID + "/flow.ts"
}

// Invoke creates the queued flow-plane run and admits its Flow launch in one
// transaction. It returns before any host is resolved or contacted.
func (s *InvokedFlowService) Invoke(ctx context.Context, launch InvokedFlowLaunch) (db.WorkflowRun, db.WorkflowDefinition, error) {
	if s == nil || s.pool == nil || s.dispatcher == nil {
		return db.WorkflowRun{}, db.WorkflowDefinition{}, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "the Flow runtime is not configured on this deployment")
	}
	input := launch.Input
	if len(input) == 0 {
		input = json.RawMessage(`{}`)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return db.WorkflowRun{}, db.WorkflowDefinition{}, pkgerrors.Internal("failed to begin workflow run transaction").WithCause(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	q := db.New(tx)
	// Flow files are not synced definitions; the run references its flow
	// by an inactive definition row, as dispatch does for referenced files.
	def, err := q.EnsureWorkflowDefinitionReference(ctx, db.EnsureWorkflowDefinitionReferenceParams{
		RepositoryID: launch.RepositoryID, Name: launch.FlowID, Path: invokedFlowPath(launch.FlowID), Config: json.RawMessage(`{}`),
	})
	if err != nil {
		return db.WorkflowRun{}, db.WorkflowDefinition{}, pkgerrors.Internal("failed to record workflow definition").WithCause(err)
	}
	run, err := q.CreateWorkflowRun(ctx, db.CreateWorkflowRunParams{
		RepositoryID: launch.RepositoryID, WorkflowDefinitionID: def.ID, Status: "queued",
		TriggerEvent: InvokeTriggerEvent, TriggerRef: launch.TriggerRef, DispatchInputs: launch.Input,
		ExecutionPlane: WorkflowRunPlaneFlow,
	})
	if err != nil {
		return db.WorkflowRun{}, db.WorkflowDefinition{}, pkgerrors.Internal("failed to create workflow run").WithCause(err)
	}
	projection, _ := json.Marshal(invokedFlowProjection{Kind: invokedFlowBinding, WorkflowRunID: run.ID})
	authorization, _ := json.Marshal(map[string]any{
		"repositoryId": launch.RepositoryID, "userId": launch.UserID, "workflowRunId": run.ID,
	})
	receipt, err := s.dispatcher.AdmitInTx(ctx, tx, flowdispatch.LaunchRequest{
		Scope:     repositoryJobFlowScope(launch.RepositoryID, launch.UserID),
		RequestID: invokedFlowRequestID(run.ID),
		Target:    flowruntime.Target{BindingKind: invokedFlowBinding, BindingID: strconv.FormatInt(run.ID, 10)},
		FlowID:    launch.FlowID, Payload: input, Projection: projection,
		AuthorizationContext: authorization,
		// The person who invoked the flow is its approval.
		ApprovalPolicy: flowdispatch.ApprovalAuto,
	})
	if err != nil {
		return db.WorkflowRun{}, db.WorkflowDefinition{}, pkgerrors.Internal("failed to admit the Flow launch").WithCause(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO workflow_run_flow_invocations(workflow_run_id,user_id,flow_id,operation_id) VALUES($1,$2,$3,$4)`,
		run.ID, launch.UserID, launch.FlowID, receipt.OperationID); err != nil {
		return db.WorkflowRun{}, db.WorkflowDefinition{}, pkgerrors.Internal("failed to record the invocation").WithCause(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return db.WorkflowRun{}, db.WorkflowDefinition{}, pkgerrors.Internal("failed to commit workflow run transaction").WithCause(err)
	}
	return run, def, nil
}

// CancelInvokedRun delivers a product cancel to the run's Flow launch. A run
// that is not an invocation, or whose launch is already gone, is a no-op.
func (s *InvokedFlowService) CancelInvokedRun(ctx context.Context, repositoryID, runID int64) error {
	if s == nil || s.pool == nil || s.dispatcher == nil {
		return nil
	}
	var userID int64
	err := s.pool.QueryRow(ctx, `SELECT i.user_id FROM workflow_run_flow_invocations i JOIN workflow_runs r ON r.id=i.workflow_run_id
		WHERE i.workflow_run_id=$1 AND r.repository_id=$2`, runID, repositoryID).Scan(&userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	_, err = s.dispatcher.CancelRequest(ctx, repositoryJobFlowScope(repositoryID, userID), invokedFlowRequestID(runID))
	if errors.Is(err, jobs.ErrNotFound) {
		return nil
	}
	return err
}

type invokedFlowRecord struct {
	UserID, RepositoryID int64
	FlowID, OperationID  string
	WorkspaceID          string
	Status               string
}

func scanInvokedFlow(row pgx.Row) (invokedFlowRecord, error) {
	var record invokedFlowRecord
	err := row.Scan(&record.UserID, &record.RepositoryID, &record.FlowID, &record.OperationID, &record.WorkspaceID, &record.Status)
	return record, err
}

const invokedFlowColumns = `i.user_id, r.repository_id, i.flow_id, i.operation_id, COALESCE(i.workspace_id::text,''), r.status
	FROM workflow_run_flow_invocations i JOIN workflow_runs r ON r.id=i.workflow_run_id WHERE i.workflow_run_id=$1`

// ResolveFlowHostTarget authorizes an invoked run's host on the invoker's
// box: the invoker must still write the repository. The first resolution
// selects the box and keeps it for the run.
func (s *InvokedFlowService) ResolveFlowHostTarget(ctx context.Context, target flowruntime.Target) (flowhost.Authority, error) {
	refuse := func(code string, retry bool) (flowhost.Authority, error) {
		return flowhost.Authority{}, repositoryJobFlowFailure{code: code, retryable: retry}
	}
	if s == nil || s.pool == nil || s.repositoryJobs == nil {
		return refuse("runtime_resolver_unavailable", true)
	}
	runID, err := strconv.ParseInt(target.BindingID, 10, 64)
	if target.BindingKind != invokedFlowBinding || err != nil || runID <= 0 {
		return refuse("runtime_target_unsupported", false)
	}
	repositoryID, repositoryOK := scopedFlowRuntimeID(target.TenantID, "repository:")
	userID, userOK := scopedFlowRuntimeID(target.PrincipalID, "user:")
	if !repositoryOK || !userOK || target.WorkspaceID != "" {
		return refuse("runtime_target_invalid", false)
	}
	record, err := scanInvokedFlow(s.pool.QueryRow(ctx, "SELECT "+invokedFlowColumns, runID))
	if err != nil {
		return refuse("runtime_target_not_found", !errors.Is(err, pgx.ErrNoRows))
	}
	if record.UserID != userID || record.RepositoryID != repositoryID {
		return refuse("runtime_target_forbidden", false)
	}
	if _, err := s.repositoryJobs.authorizedRepo(ctx, repositoryID, userID, true); err != nil {
		return refuse("runtime_target_forbidden", false)
	}
	workspaceID := record.WorkspaceID
	if workspaceID == "" {
		if s.workspaces == nil {
			return refuse("runtime_workspace_unavailable", true)
		}
		repository, err := s.repositoryJobs.repositoryName(ctx, db.RepositoryJobRegistration{RepositoryID: repositoryID, UserID: userID})
		if err != nil {
			return refuse("runtime_binding_unavailable", true)
		}
		owner, name, _ := strings.Cut(repository, "/")
		workspace, err := s.workspaces.CreateWorkspace(ctx, CreateWorkspaceInput{RepositoryID: repositoryID, UserID: userID, RepoOwner: owner, RepoName: name, Kind: "vm"})
		if err != nil {
			return flowhost.Authority{}, err
		}
		if workspace.Status != "running" {
			return refuse("runtime_workspace_not_ready", true)
		}
		// Two recovered deliveries may race; the first selected box wins.
		err = s.pool.QueryRow(ctx, `UPDATE workflow_run_flow_invocations SET workspace_id=COALESCE(workspace_id,$2::uuid) WHERE workflow_run_id=$1 RETURNING workspace_id::text`,
			runID, workspace.ID).Scan(&workspaceID)
		if err != nil {
			return refuse("runtime_binding_unavailable", true)
		}
	}
	workspace, err := db.New(s.pool).GetWorkspaceForUserRepo(ctx, db.GetWorkspaceForUserRepoParams{ID: workspaceID, RepositoryID: repositoryID, UserID: userID})
	if err != nil || workspace.DeletedAt.Valid {
		return refuse("runtime_workspace_unavailable", false)
	}
	return flowhost.Authority{Target: target, RepositoryID: repositoryID, UserID: userID, WorkspaceID: workspaceID, CatalogKey: flowhost.CatalogCoding}, nil
}

// invokedRunStatus maps a Flow observation to a workflow_runs status. It
// reports "" while the run is neither started nor terminal.
func invokedRunStatus(update flowdispatch.ProjectionUpdate) string {
	if run := update.Checkpoint.Run; run != nil {
		switch run.Status {
		case "completed":
			return "success"
		case "failed":
			return "failure"
		case "cancelled":
			return "cancelled"
		}
	}
	switch update.State {
	case jobs.StateCompleted:
		return "success"
	case jobs.StateFailed:
		return "failure"
	case jobs.StateCancelled:
		return "cancelled"
	}
	if update.Checkpoint.RunID != "" {
		return "running"
	}
	return ""
}

// ProjectFlowRuntime makes an invoked workflow_runs row a receipt projection
// of its Flow launch: the runtime run id, running, and the terminal status.
func (s *InvokedFlowService) ProjectFlowRuntime(ctx context.Context, update flowdispatch.ProjectionUpdate) error {
	var projection invokedFlowProjection
	if json.Unmarshal(update.Checkpoint.Projection, &projection) != nil || projection.Kind != invokedFlowBinding {
		return nil
	}
	if s == nil || s.pool == nil {
		return errors.New("invoked Flow projection is unavailable")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	record, err := scanInvokedFlow(tx.QueryRow(ctx, "SELECT "+invokedFlowColumns+" FOR UPDATE OF i", projection.WorkflowRunID))
	if errors.Is(err, pgx.ErrNoRows) {
		// The run was deleted with its repository; nothing is left to project.
		return nil
	}
	if err != nil {
		return err
	}
	checkpoint := update.Checkpoint
	if update.OperationID != record.OperationID || update.Scope != repositoryJobFlowScope(record.RepositoryID, record.UserID) ||
		checkpoint.Target.BindingKind != invokedFlowBinding || checkpoint.Target.BindingID != strconv.FormatInt(projection.WorkflowRunID, 10) ||
		checkpoint.FlowID != record.FlowID || (checkpoint.Run != nil && checkpoint.Run.RunID != checkpoint.RunID) {
		return fmt.Errorf("invoked Flow projection identity differs for workflow run %d", projection.WorkflowRunID)
	}
	q := db.New(tx)
	if checkpoint.RunID != "" {
		if record.WorkspaceID == "" {
			return errors.New("invoked Flow run started before its box was selected")
		}
		if _, err := q.RecordWorkflowRunCodingHost(ctx, db.RecordWorkflowRunCodingHostParams{
			WorkflowRunID: projection.WorkflowRunID, WorkspaceID: record.WorkspaceID,
			HostRunID: checkpoint.RunID, FlowID: record.FlowID,
		}); err != nil {
			return fmt.Errorf("record invoked Flow run: %w", err)
		}
	}
	status := invokedRunStatus(update)
	changed := false
	switch {
	case status == "running" && record.Status == "queued":
		// The status trigger admits queued->running off the sandbox plane
		// only for the run this transaction names.
		if _, err := tx.Exec(ctx, `SELECT set_config('smithers.workflow_run_status_id',$1,true)`, strconv.FormatInt(projection.WorkflowRunID, 10)); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `UPDATE workflow_runs SET status='running',started_at=COALESCE(started_at,NOW()),updated_at=NOW() WHERE id=$1 AND status='queued'`, projection.WorkflowRunID)
		if err != nil {
			return err
		}
		changed = tag.RowsAffected() == 1
	case status != "" && status != "running" && !IsTerminalWorkflowRunStatus(record.Status):
		tag, err := tx.Exec(ctx, `UPDATE workflow_runs SET status=$2,started_at=COALESCE(started_at,NOW()),completed_at=NOW(),updated_at=NOW()
			WHERE id=$1 AND status IN ('queued','running')`, projection.WorkflowRunID, status)
		if err != nil {
			return err
		}
		changed = tag.RowsAffected() == 1
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if changed {
		NotifyWorkflowRunEvent(ctx, db.New(s.pool), projection.WorkflowRunID, "workflow_flow."+status)
	}
	return nil
}

var _ flowhost.TargetResolver = (*InvokedFlowService)(nil)
var _ flowdispatch.Projector = (*InvokedFlowService)(nil)
var _ InvokedFlowDispatcher = (*flowdispatch.Service)(nil)
