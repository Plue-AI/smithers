package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// invokedFlowBinding names an invoked run's Flow host target and projection.
const invokedFlowBinding = "workflow-invoke"

// InvokedFlowDispatcher is the flowdispatch.Service surface an invocation uses.
type InvokedFlowDispatcher interface {
	AdmitInTx(context.Context, pgx.Tx, flowdispatch.LaunchRequest) (jobs.RequestReceipt, error)
	CancelRequestInTx(context.Context, pgx.Tx, jobs.Scope, string) (jobs.Operation, error)
}

// InvokedFlowService runs an invoked repository flow on the canonical Flow
// runtime: it admits one Flow launch in the same transaction as the product
// run, authorizes the launch's host on the invoker's box, and projects the
// runtime's receipts, journal and failures back onto workflow_runs and the
// run's step and log.
type InvokedFlowService struct {
	pool           *pgxpool.Pool
	repositoryJobs *RepositoryJobService
	workspaces     RepositorySetupWorkspace
	dispatcher     InvokedFlowDispatcher
	secrets        *SecretInjector
	terminal       WorkflowRunTerminalPublisher
	sources        repositorySourceHost
}

func NewInvokedFlowService(pool *pgxpool.Pool, repositoryJobs *RepositoryJobService, workspaces RepositorySetupWorkspace) *InvokedFlowService {
	return &InvokedFlowService{pool: pool, repositoryJobs: repositoryJobs, workspaces: workspaces}
}

func (s *InvokedFlowService) SetFlowDispatcher(dispatcher InvokedFlowDispatcher) {
	s.dispatcher = dispatcher
}

// SetSecretInjector gives an invoked run's host the repository and
// organization variables and secrets a workflow run receives, and redacts
// those secrets from the run's log.
func (s *InvokedFlowService) SetSecretInjector(secrets *SecretInjector) {
	s.secrets = secrets
}

// SetTerminalPublisher settles what a terminal run announces (workflow_run
// webhook, commit status, check run, downstream triggers, metrics) when the
// Flow's terminal projection wins the run's transition.
func (s *InvokedFlowService) SetTerminalPublisher(publisher WorkflowRunTerminalPublisher) {
	s.terminal = publisher
}

// SetFlowSourceReader gives invocation the repo host it reads the trigger
// ref's commit and the flow file through, so an unknown flow or ref is
// refused before a run exists.
func (s *InvokedFlowService) SetFlowSourceReader(host repositorySourceHost) {
	s.sources = host
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

// flowSourceCommit is the commit the trigger ref names, where the flow file
// must exist. An unknown ref or flow is NotFound, so a typo never becomes a
// run.
func (s *InvokedFlowService) flowSourceCommit(ctx context.Context, launch InvokedFlowLaunch) (string, error) {
	repository, err := s.repositoryJobs.repositoryName(ctx, db.RepositoryJobRegistration{RepositoryID: launch.RepositoryID, UserID: launch.UserID})
	if err != nil {
		return "", err
	}
	owner, name, _ := strings.Cut(repository, "/")
	commit, found, err := bookmarkCommit(ctx, s.sources, owner, name, launch.TriggerRef)
	if err != nil {
		return "", pkgerrors.Internal("failed to resolve " + launch.TriggerRef).WithCause(err)
	}
	if !found {
		return "", pkgerrors.NotFound(fmt.Sprintf("bookmark %q not found", launch.TriggerRef))
	}
	path := invokedFlowPath(launch.FlowID)
	if _, err := s.sources.GetFileAtChange(ctx, owner, name, commit, path); err != nil {
		if status, ok := repohost.IsStatusError(err); ok && status.StatusCode == 404 {
			return "", pkgerrors.NotFound(fmt.Sprintf("flow %q not found: %s does not exist at %s", launch.FlowID, path, launch.TriggerRef))
		}
		return "", pkgerrors.Internal("failed to read " + path).WithCause(err)
	}
	return commit, nil
}

// Invoke creates the queued flow-plane run and admits its Flow launch in one
// transaction. It returns before any host is resolved or contacted.
func (s *InvokedFlowService) Invoke(ctx context.Context, launch InvokedFlowLaunch, admit WorkflowRunAdmission) (db.WorkflowRun, db.WorkflowDefinition, error) {
	if s == nil || s.pool == nil || s.dispatcher == nil || s.repositoryJobs == nil || s.sources == nil {
		return db.WorkflowRun{}, db.WorkflowDefinition{}, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "the Flow runtime is not configured on this deployment")
	}
	if admit == nil {
		return db.WorkflowRun{}, db.WorkflowDefinition{}, pkgerrors.Internal("workflow run admission is required")
	}
	triggerCommit, err := s.flowSourceCommit(ctx, launch)
	if err != nil {
		return db.WorkflowRun{}, db.WorkflowDefinition{}, err
	}
	var run db.WorkflowRun
	var def db.WorkflowDefinition
	err = admit(ctx, func(ctx context.Context, admission pgx.Tx) error {
		if admission != nil {
			run, def, err = s.insertInvocation(ctx, admission, launch, triggerCommit)
			return err
		}
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return pkgerrors.Internal("failed to begin workflow run transaction").WithCause(err)
		}
		defer func() { _ = tx.Rollback(context.Background()) }()
		if run, def, err = s.insertInvocation(ctx, tx, launch, triggerCommit); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return pkgerrors.Internal("failed to commit workflow run transaction").WithCause(err)
		}
		return nil
	})
	if err != nil {
		return db.WorkflowRun{}, db.WorkflowDefinition{}, err
	}
	return run, def, nil
}

// insertInvocation writes the run, its one step, the Flow launch and the
// invocation record in the caller's transaction.
func (s *InvokedFlowService) insertInvocation(ctx context.Context, tx pgx.Tx, launch InvokedFlowLaunch, triggerCommit string) (db.WorkflowRun, db.WorkflowDefinition, error) {
	input := launch.Input
	if len(input) == 0 {
		input = json.RawMessage(`{}`)
	}
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
	// The flow is the run's one step; its journal is the step's log.
	step, err := q.CreateWorkflowStep(ctx, db.CreateWorkflowStepParams{WorkflowRunID: run.ID, Name: launch.FlowID, Position: 1, Status: "queued"})
	if err != nil {
		return db.WorkflowRun{}, db.WorkflowDefinition{}, pkgerrors.Internal("failed to create workflow step").WithCause(err)
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
	if _, err := tx.Exec(ctx, `INSERT INTO workflow_run_flow_invocations(workflow_run_id,user_id,flow_id,operation_id,workflow_step_id,trigger_commit) VALUES($1,$2,$3,$4,$5,$6)`,
		run.ID, launch.UserID, launch.FlowID, receipt.OperationID, step.ID, triggerCommit); err != nil {
		return db.WorkflowRun{}, db.WorkflowDefinition{}, pkgerrors.Internal("failed to record the invocation").WithCause(err)
	}
	return run, def, nil
}

// CancelWorkflowRunInTx records the Flow launch's cancellation in the
// transaction that cancels an invoked run, so the product's terminal status
// and the runtime's cancellation commit together or not at all. A run that
// is not an invocation, or whose launch is already gone, is a no-op.
func (s *InvokedFlowService) CancelWorkflowRunInTx(ctx context.Context, tx pgx.Tx, run db.WorkflowRun) error {
	if s == nil || run.ExecutionPlane != WorkflowRunPlaneFlow {
		return nil
	}
	var userID int64
	var stepID pgtype.Int8
	err := tx.QueryRow(ctx, `SELECT user_id, workflow_step_id FROM workflow_run_flow_invocations WHERE workflow_run_id=$1`, run.ID).Scan(&userID, &stepID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if stepID.Valid {
		if _, err := tx.Exec(ctx, `UPDATE workflow_steps SET status='cancelled',completed_at=NOW(),updated_at=NOW() WHERE id=$1 AND status IN ('queued','running')`, stepID.Int64); err != nil {
			return err
		}
	}
	if s.dispatcher == nil {
		return errors.New("the Flow runtime is not configured on this deployment")
	}
	_, err = s.dispatcher.CancelRequestInTx(ctx, tx, repositoryJobFlowScope(run.RepositoryID, userID), invokedFlowRequestID(run.ID))
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
	StepID               pgtype.Int8
	LogCursor            string
	TriggerRef           string
	TriggerCommit        string
	SourceRevision       string
}

func scanInvokedFlow(row pgx.Row) (invokedFlowRecord, error) {
	var record invokedFlowRecord
	err := row.Scan(&record.UserID, &record.RepositoryID, &record.FlowID, &record.OperationID, &record.WorkspaceID, &record.Status,
		&record.StepID, &record.LogCursor, &record.TriggerRef, &record.TriggerCommit, &record.SourceRevision)
	return record, err
}

const invokedFlowColumns = `i.user_id, r.repository_id, i.flow_id, i.operation_id, COALESCE(i.workspace_id::text,''), r.status,
	i.workflow_step_id, i.log_cursor, r.trigger_ref, i.trigger_commit, i.source_revision
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

// FlowHostEnvironment is the start environment an invoked run's host adds to
// its box's: the repository and organization variables and secrets a
// workflow run receives, without main-only secrets (an invocation is never a
// trusted run on the default bookmark). A secret never reaches a box with
// write shares, whose guests could read it; such a run fails typed instead of
// running without it. Other targets add nothing.
func (s *InvokedFlowService) FlowHostEnvironment(ctx context.Context, authority flowhost.Authority) (map[string]string, error) {
	if authority.Target.BindingKind != invokedFlowBinding || s == nil || s.secrets == nil {
		return nil, nil
	}
	environment, secrets, err := s.secrets.RepositoryEnvironmentAndSecrets(ctx, authority.RepositoryID, false)
	if err != nil {
		return nil, repositoryJobFlowFailure{code: "runtime_environment_unavailable", retryable: false}
	}
	if len(secrets) > 0 {
		shared, err := db.New(s.pool).HasWritableWorkspaceShares(ctx, authority.WorkspaceID)
		if err != nil {
			return nil, repositoryJobFlowFailure{code: "runtime_environment_unavailable", retryable: true}
		}
		if shared {
			return nil, repositoryJobFlowFailure{code: "runtime_workspace_shared", retryable: false}
		}
	}
	return environment, nil
}

// invokedFlowLogEntryLimit bounds one journal event's log line.
const invokedFlowLogEntryLimit = 16 << 10

// invokedFlowLogEntry renders one journal event as a log line: its kind and
// payload.
func invokedFlowLogEntry(event flowruntime.FlowRuntimeEvent) string {
	entry := event.Kind
	if payload := strings.TrimSpace(string(event.Payload)); payload != "" && payload != "null" && payload != "{}" {
		entry += " " + payload
	}
	if len(entry) > invokedFlowLogEntryLimit {
		entry = strings.ToValidUTF8(entry[:invokedFlowLogEntryLimit], "") + " …"
	}
	return entry
}

// invokedFlowSource is the system log line naming the source an invoked run
// read.
func invokedFlowSource(record invokedFlowRecord, revision string) string {
	entry := fmt.Sprintf("flow source: box %s snapshot %s", record.WorkspaceID, revision)
	if record.TriggerCommit != "" {
		entry += fmt.Sprintf(" (%s was %s at invocation)", record.TriggerRef, record.TriggerCommit)
	}
	return entry
}

// invokedFlowFailure is the system log line naming why an invoked run failed.
func invokedFlowFailure(checkpoint flowdispatch.RuntimeCheckpoint) string {
	if code := strings.TrimSpace(checkpoint.FailureCode); code != "" {
		return "flow failed: " + code
	}
	if run := checkpoint.Run; run != nil && strings.TrimSpace(run.ExecutionObservation) != "" {
		return "flow failed: " + strings.TrimSpace(run.ExecutionObservation)
	}
	return "flow failed"
}

// ProjectFlowRuntime makes an invoked workflow_runs row a receipt projection
// of its Flow launch: the runtime run id, running, the terminal status, the
// flow's step, and its journal and failure as the step's redacted log.
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
	stepID := record.StepID.Int64
	if !record.StepID.Valid {
		// A run invoked before its flow had a step gets one on first sight.
		step, err := q.CreateWorkflowStep(ctx, db.CreateWorkflowStepParams{WorkflowRunID: projection.WorkflowRunID, Name: record.FlowID, Position: 1, Status: "queued"})
		if err != nil {
			return fmt.Errorf("create invoked Flow step: %w", err)
		}
		stepID = step.ID
		if _, err := tx.Exec(ctx, `UPDATE workflow_run_flow_invocations SET workflow_step_id=$2 WHERE workflow_run_id=$1`, projection.WorkflowRunID, stepID); err != nil {
			return err
		}
	}
	status := invokedRunStatus(update)
	var logs []db.InsertWorkflowRunLogNextSequenceRow
	appendLog := func(stream, entry string) error {
		if len(logs) == 0 {
			// Serialize the run's log sequence as every appender does.
			if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, projection.WorkflowRunID); err != nil {
				return err
			}
		}
		inserted, err := q.InsertWorkflowRunLogNextSequence(ctx, db.InsertWorkflowRunLogNextSequenceParams{
			WorkflowRunID: projection.WorkflowRunID, WorkflowStepID: stepID, Stream: stream, Entry: storableWorkflowLogEntry(entry),
		})
		if err == nil {
			logs = append(logs, inserted)
		}
		return err
	}
	// The host runs the box's working copy, not trigger_ref: the run names
	// the snapshot that ran beside the commit its ref named at invocation.
	if revision := checkpoint.Identity.SourceRevision; checkpoint.RunID != "" && record.SourceRevision == "" && revision != "" {
		if _, err := tx.Exec(ctx, `UPDATE workflow_run_flow_invocations SET source_revision=$2 WHERE workflow_run_id=$1`, projection.WorkflowRunID, revision); err != nil {
			return err
		}
		if err := appendLog("system", invokedFlowSource(record, revision)); err != nil {
			return fmt.Errorf("log invoked Flow source: %w", err)
		}
	}
	var redact map[string]string
	if s.secrets != nil && (len(update.Events) > 0 || status == "failure") {
		if _, redact, err = s.secrets.RepositoryEnvironmentAndSecrets(ctx, record.RepositoryID, false); err != nil {
			return fmt.Errorf("load invoked Flow log redaction: %w", err)
		}
	}
	// A page is logged once: only when it continues the logged journal.
	if len(update.Events) > 0 && update.EventsAfter == record.LogCursor && checkpoint.Cursor != record.LogCursor {
		for _, event := range update.Events {
			if err := appendLog("stdout", RedactSecretValues(redact, invokedFlowLogEntry(event))); err != nil {
				return fmt.Errorf("log invoked Flow event: %w", err)
			}
		}
		if _, err := tx.Exec(ctx, `UPDATE workflow_run_flow_invocations SET log_cursor=$2 WHERE workflow_run_id=$1`, projection.WorkflowRunID, checkpoint.Cursor); err != nil {
			return err
		}
	}
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
		if _, err := q.UpdateWorkflowStepStatusRunning(ctx, stepID); err != nil {
			return err
		}
	case status != "" && status != "running" && !IsTerminalWorkflowRunStatus(record.Status):
		tag, err := tx.Exec(ctx, `UPDATE workflow_runs SET status=$2,started_at=COALESCE(started_at,NOW()),completed_at=NOW(),updated_at=NOW()
			WHERE id=$1 AND status IN ('queued','running')`, projection.WorkflowRunID, status)
		if err != nil {
			return err
		}
		changed = tag.RowsAffected() == 1
		if changed && status == "failure" {
			if err := appendLog("system", RedactSecretValues(redact, invokedFlowFailure(checkpoint))); err != nil {
				return fmt.Errorf("log invoked Flow failure: %w", err)
			}
		}
	}
	if status != "" && status != "running" {
		if _, err := tx.Exec(ctx, `UPDATE workflow_steps SET status=$2,started_at=COALESCE(started_at,NOW()),completed_at=NOW(),updated_at=NOW()
			WHERE id=$1 AND status IN ('queued','running')`, stepID, status); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	notify := db.New(s.pool)
	for _, inserted := range logs {
		payload, _ := json.Marshal(map[string]any{
			"log_id": inserted.ID, "workflow_step_id": inserted.WorkflowStepID, "sequence": inserted.Sequence,
			"stream": inserted.Stream, "entry": inserted.Entry,
		})
		_ = notify.NotifyWorkflowRunLog(ctx, db.NotifyWorkflowRunLogParams{RunID: projection.WorkflowRunID, Payload: string(payload)})
	}
	if changed {
		NotifyWorkflowRunEvent(ctx, notify, projection.WorkflowRunID, "workflow_flow."+status)
		if status != "running" && s.terminal != nil {
			// Only the projection whose write won the terminal transition
			// publishes it, so a repeated projection publishes nothing.
			if run, err := notify.GetWorkflowRun(ctx, db.GetWorkflowRunParams{ID: projection.WorkflowRunID, RepositoryID: record.RepositoryID}); err == nil {
				s.terminal.PublishWorkflowRunTerminal(context.WithoutCancel(ctx), run)
			}
		}
	}
	return nil
}

var _ flowhost.TargetResolver = (*InvokedFlowService)(nil)
var _ flowdispatch.Projector = (*InvokedFlowService)(nil)
var _ InvokedFlowDispatcher = (*flowdispatch.Service)(nil)
