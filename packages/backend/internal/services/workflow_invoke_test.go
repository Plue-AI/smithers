package services

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/webhooks"
)

// recordingFlowInvoker records the launch InvokeWorkflow admits.
type recordingFlowInvoker struct {
	launches []InvokedFlowLaunch
}

func (r *recordingFlowInvoker) Invoke(_ context.Context, launch InvokedFlowLaunch) (db.WorkflowRun, db.WorkflowDefinition, error) {
	r.launches = append(r.launches, launch)
	return db.WorkflowRun{ID: 42, RepositoryID: launch.RepositoryID, Status: "queued", ExecutionPlane: WorkflowRunPlaneFlow},
		db.WorkflowDefinition{ID: 11, Name: launch.FlowID, Path: invokedFlowPath(launch.FlowID)}, nil
}

func TestInvokeWorkflowLaunchesTheNamedFlow(t *testing.T) {
	invoker := &recordingFlowInvoker{}
	svc := NewWorkflowAPIService(&mockWorkflowAPIQuerier{}, nil, WithWorkflowAPIFlowInvoker(invoker))

	result, err := svc.InvokeWorkflow(context.Background(), InvokeWorkflowInput{
		RepositoryID: 7, UserID: 3, Identifier: " echo ",
		Input: map[string]interface{}{"goal": "hello"}, TriggerRef: "trunk",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(42), result.Run.ID)
	assert.Equal(t, "flows/echo/flow.ts", result.Definition.Path)
	require.Len(t, invoker.launches, 1)
	launch := invoker.launches[0]
	assert.Equal(t, InvokedFlowLaunch{RepositoryID: 7, UserID: 3, FlowID: "echo", Input: launch.Input, TriggerRef: "trunk"}, launch)
	assert.JSONEq(t, `{"goal":"hello"}`, string(launch.Input))

	_, err = svc.InvokeWorkflow(context.Background(), InvokeWorkflowInput{RepositoryID: 7, UserID: 3, Identifier: "echo"})
	require.NoError(t, err)
	assert.Equal(t, "main", invoker.launches[1].TriggerRef, "an unset ref records main")
	assert.Nil(t, invoker.launches[1].Input)
}

func TestInvokeWorkflowBillingDeniedLaunchesNothing(t *testing.T) {
	policy := &denyWorkflowDispatchBillingPolicy{}
	invoker := &recordingFlowInvoker{}
	svc := NewWorkflowAPIService(&mockWorkflowAPIQuerier{}, nil, WithWorkflowAPIBillingPolicy(policy), WithWorkflowAPIFlowInvoker(invoker))
	_, err := svc.InvokeWorkflow(context.Background(), InvokeWorkflowInput{RepositoryID: 7, UserID: 3, Identifier: "echo"})
	require.Error(t, err)
	assert.Equal(t, 1, policy.dispatchCalls)
	assert.Empty(t, invoker.launches, "billing refusal must precede the launch")
}

func TestInvokeWorkflowReadsAFlowNameOrItsPath(t *testing.T) {
	for identifier, want := range map[string]string{
		"echo": "echo", "flows/echo/flow.ts": "echo", "ci-2": "ci-2", "7": "7",
	} {
		invoker := &recordingFlowInvoker{}
		svc := NewWorkflowAPIService(&mockWorkflowAPIQuerier{}, nil, WithWorkflowAPIFlowInvoker(invoker))
		_, err := svc.InvokeWorkflow(context.Background(), InvokeWorkflowInput{RepositoryID: 7, UserID: 3, Identifier: identifier})
		require.NoError(t, err, identifier)
		require.Len(t, invoker.launches, 1, identifier)
		assert.Equal(t, want, invoker.launches[0].FlowID, identifier)
	}
}

func TestInvokeWorkflowRejectsInvalidRequests(t *testing.T) {
	for _, tc := range []struct {
		name       string
		input      InvokeWorkflowInput
		noInvoker  bool
		wantStatus int
	}{
		{"blank flow", InvokeWorkflowInput{UserID: 3, Identifier: "  "}, false, 400},
		{"legacy workflow file", InvokeWorkflowInput{UserID: 3, Identifier: ".smithers/workflows/echo.tsx"}, false, 400},
		{"uppercase name", InvokeWorkflowInput{UserID: 3, Identifier: "Echo"}, false, 400},
		{"flow directory", InvokeWorkflowInput{UserID: 3, Identifier: "flows/echo"}, false, 400},
		{"nested path", InvokeWorkflowInput{UserID: 3, Identifier: "flows/a/b/flow.ts"}, false, 400},
		{"traversal", InvokeWorkflowInput{UserID: 3, Identifier: "../echo"}, false, 400},
		{"no person", InvokeWorkflowInput{Identifier: "echo"}, false, 401},
		{"no Flow runtime", InvokeWorkflowInput{UserID: 3, Identifier: "echo"}, true, 503},
	} {
		invoker := &recordingFlowInvoker{}
		var opts []WorkflowAPIServiceOption
		if !tc.noInvoker {
			opts = append(opts, WithWorkflowAPIFlowInvoker(invoker))
		}
		svc := NewWorkflowAPIService(&mockWorkflowAPIQuerier{}, nil, opts...)
		tc.input.RepositoryID = 7
		_, err := svc.InvokeWorkflow(context.Background(), tc.input)
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, err, &apiErr, tc.name)
		assert.Equal(t, tc.wantStatus, apiErr.Status, tc.name)
		assert.Empty(t, invoker.launches, tc.name)
	}
}

type invokedFlowTestWorkspaces struct{ workspaceID string }

func (w invokedFlowTestWorkspaces) CreateWorkspace(context.Context, CreateWorkspaceInput) (WorkspaceResponse, error) {
	return WorkspaceResponse{ID: w.workspaceID, Status: "running"}, nil
}

// TestInvokeWorkflowAdmitsThroughFlowDispatch drives an invocation through
// the real Flow dispatcher and jobs store: the run is admitted as one
// canonical Flow launch on the flow plane, which the sandbox scheduler never
// claims, and the runtime's run id is recorded against the product run.
func TestInvokeWorkflowAdmitsThroughFlowDispatch(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	q := db.New(pool)
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")
	var userID, repositoryID int64
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO users(username,lower_username,email,lower_email) VALUES($1,$1,$2,$2) RETURNING id`,
		"owner"+suffix, suffix+"@example.invalid").Scan(&userID))
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO repositories(user_id,name,lower_name) VALUES($1,$2,$2) RETURNING id`,
		userID, "repo"+suffix).Scan(&repositoryID))
	workspaceID := uuid.NewString()
	_, err := pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,status) VALUES($1,$2,$3,'running')`, workspaceID, repositoryID, userID)
	require.NoError(t, err)

	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Resolver: flowruntime.ResolverFunc(
		func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
			return nil, errors.New("admission must not resolve a runtime")
		})})
	require.NoError(t, err)
	invoked := NewInvokedFlowService(pool, NewRepositoryJobService(q, nil, pool), invokedFlowTestWorkspaces{workspaceID: workspaceID})
	invoked.SetFlowDispatcher(dispatcher)
	api := NewWorkflowAPIService(q, nil, WithWorkflowAPIFlowInvoker(invoked))

	result, err := api.InvokeWorkflow(ctx, InvokeWorkflowInput{
		RepositoryID: repositoryID, UserID: userID, Identifier: "echo",
		Input: map[string]interface{}{"goal": "hello"}, TriggerRef: "main",
	})
	require.NoError(t, err)
	assert.Equal(t, "queued", result.Run.Status)
	assert.Equal(t, WorkflowRunPlaneFlow, result.Run.ExecutionPlane, "the sandbox scheduler claims only sandbox-plane runs")
	assert.Equal(t, InvokeTriggerEvent, result.Run.TriggerEvent)
	assert.Equal(t, "flows/echo/flow.ts", result.Definition.Path)

	scope := repositoryJobFlowScope(repositoryID, userID)
	operation, err := store.GetByRequest(ctx, scope, flowdispatch.OperationLaunch, invokedFlowRequestID(result.Run.ID))
	require.NoError(t, err)
	var launch struct {
		Target     flowruntime.Target `json:"target"`
		FlowID     string             `json:"flowId"`
		Payload    json.RawMessage    `json:"payload"`
		Projection json.RawMessage    `json:"projection"`
	}
	require.NoError(t, json.Unmarshal(operation.Payload, &launch))
	assert.Equal(t, "echo", launch.FlowID)
	assert.JSONEq(t, `{"goal":"hello"}`, string(launch.Payload))

	authority, err := invoked.ResolveFlowHostTarget(ctx, launch.Target)
	require.NoError(t, err)
	assert.Equal(t, workspaceID, authority.WorkspaceID)

	project := func(state jobs.State, run *flowruntime.FlowRuntimeRun) {
		t.Helper()
		require.NoError(t, invoked.ProjectFlowRuntime(ctx, flowdispatch.ProjectionUpdate{
			OperationID: operation.ID, Scope: scope, State: state,
			Checkpoint: flowdispatch.RuntimeCheckpoint{
				Version: 1, Target: launch.Target, FlowID: "echo", Projection: launch.Projection,
				RunID: "flow-run-1", Run: run,
			},
		}))
	}
	project(jobs.StateRunning, nil)
	host, err := q.GetWorkflowRunCodingHost(ctx, result.Run.ID)
	require.NoError(t, err)
	assert.Equal(t, "flow-run-1", host.HostRunID)
	assert.Equal(t, "echo", host.FlowID)
	run, err := q.GetWorkflowRun(ctx, db.GetWorkflowRunParams{ID: result.Run.ID, RepositoryID: repositoryID})
	require.NoError(t, err)
	assert.Equal(t, "running", run.Status)

	project(jobs.StateCompleted, &flowruntime.FlowRuntimeRun{RunID: "flow-run-1", FlowID: "echo", Status: "completed"})
	run, err = q.GetWorkflowRun(ctx, db.GetWorkflowRunParams{ID: result.Run.ID, RepositoryID: repositoryID})
	require.NoError(t, err)
	assert.Equal(t, "success", run.Status)
	assert.True(t, run.CompletedAt.Valid)
}

// invokedFlowTestFixture is one invoked run admitted through the real
// dispatcher, jobs store and workflow run service.
type invokedFlowTestFixture struct {
	pool         *pgxpool.Pool
	store        *jobs.Store
	dispatcher   *flowdispatch.Service
	resolved     *atomic.Int32
	invoked      *InvokedFlowService
	api          WorkflowAPIService
	runs         WorkflowRunService
	webhooks     *invokedFlowWebhooks
	codec        webhook.SecretCodec
	owner        *db.User
	repository   string
	workspaceID  string
	userID       int64
	repositoryID int64
	run          db.WorkflowRun
}

// invokedFlowWebhooks records the workflow_run webhooks the real terminal
// publisher sends.
type invokedFlowWebhooks struct {
	mu     sync.Mutex
	events []webhooks.WorkflowRunEventPayload
}

func (w *invokedFlowWebhooks) DispatchEvent(_ context.Context, _ int64, eventType webhooks.EventType, payload any) error {
	if eventType == webhooks.EventTypeWorkflowRun {
		w.mu.Lock()
		defer w.mu.Unlock()
		w.events = append(w.events, payload.(webhooks.WorkflowRunEventPayload))
	}
	return nil
}

func (w *invokedFlowWebhooks) DispatchOrgEvent(context.Context, int64, webhooks.EventType, any) error {
	return nil
}

func (w *invokedFlowWebhooks) actions() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	actions := make([]string, 0, len(w.events))
	for _, event := range w.events {
		actions = append(actions, event.Action)
	}
	return actions
}

func newInvokedFlowTestFixture(t *testing.T) invokedFlowTestFixture {
	t.Helper()
	pool := newProductTestPool(t)
	ctx := context.Background()
	q := db.New(pool)
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")
	f := invokedFlowTestFixture{pool: pool, resolved: &atomic.Int32{}, webhooks: &invokedFlowWebhooks{}, repository: "repo" + suffix}
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO users(username,lower_username,email,lower_email) VALUES($1,$1,$2,$2) RETURNING id`,
		"owner"+suffix, suffix+"@example.invalid").Scan(&f.userID))
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO repositories(user_id,name,lower_name,default_bookmark) VALUES($1,$2,$2,'main') RETURNING id`,
		f.userID, f.repository).Scan(&f.repositoryID))
	owner, err := q.GetUserByID(ctx, f.userID)
	require.NoError(t, err)
	f.owner = &owner
	f.workspaceID = uuid.NewString()
	_, err = pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,status) VALUES($1,$2,$3,'running')`, f.workspaceID, f.repositoryID, f.userID)
	require.NoError(t, err)
	f.codec, err = webhook.NewSecretCodec("invoked-flow-secret-key")
	require.NoError(t, err)
	f.store, err = jobs.NewStore(pool)
	require.NoError(t, err)
	f.runs = NewWorkflowRunService(q, WithWorkflowRunWebhookDispatcher(f.webhooks))
	f.invoked = NewInvokedFlowService(pool, NewRepositoryJobService(q, nil, pool), invokedFlowTestWorkspaces{workspaceID: f.workspaceID})
	f.invoked.SetSecretInjector(NewSecretInjector(q, f.codec))
	f.invoked.SetTerminalPublisher(f.runs.(WorkflowRunTerminalPublisher))
	f.runs.(interface {
		SetCancelParticipant(WorkflowRunCancelParticipant)
	}).SetCancelParticipant(f.invoked)
	f.dispatcher, err = flowdispatch.New(flowdispatch.Config{Store: f.store, Projector: f.invoked, Resolver: flowruntime.ResolverFunc(
		func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
			f.resolved.Add(1)
			return nil, errors.New("admission must not resolve a runtime")
		})})
	require.NoError(t, err)
	f.invoked.SetFlowDispatcher(f.dispatcher)
	f.api = NewWorkflowAPIService(q, f.runs, WithWorkflowAPIFlowInvoker(f.invoked))
	result, err := f.api.InvokeWorkflow(ctx, InvokeWorkflowInput{RepositoryID: f.repositoryID, UserID: f.userID, Identifier: "echo"})
	require.NoError(t, err)
	f.run = result.Run
	return f
}

func (f invokedFlowTestFixture) scope() jobs.Scope {
	return repositoryJobFlowScope(f.repositoryID, f.userID)
}

func (f invokedFlowTestFixture) operation(t *testing.T) jobs.Operation {
	t.Helper()
	operation, err := f.store.GetByRequest(context.Background(), f.scope(), flowdispatch.OperationLaunch, invokedFlowRequestID(f.run.ID))
	require.NoError(t, err)
	return operation
}

func (f invokedFlowTestFixture) status(t *testing.T) string {
	t.Helper()
	run, err := f.api.GetWorkflowRun(context.Background(), f.repositoryID, f.run.ID)
	require.NoError(t, err)
	return run.Status
}

// project delivers one projection the dispatcher would send for this run.
func (f invokedFlowTestFixture) project(t *testing.T, update flowdispatch.ProjectionUpdate) {
	t.Helper()
	operation := f.operation(t)
	var launch struct {
		Target     flowruntime.Target `json:"target"`
		Projection json.RawMessage    `json:"projection"`
	}
	require.NoError(t, json.Unmarshal(operation.Payload, &launch))
	_, err := f.invoked.ResolveFlowHostTarget(context.Background(), launch.Target)
	require.NoError(t, err)
	update.OperationID, update.Scope = operation.ID, f.scope()
	update.Checkpoint.Version, update.Checkpoint.Target, update.Checkpoint.FlowID = 1, launch.Target, "echo"
	update.Checkpoint.Projection = launch.Projection
	require.NoError(t, f.invoked.ProjectFlowRuntime(context.Background(), update))
}

func (f invokedFlowTestFixture) logs(t *testing.T) []db.WorkflowLog {
	t.Helper()
	logs, err := f.api.ListWorkflowLogsSince(context.Background(), f.run.ID, 0, 1000)
	require.NoError(t, err)
	return logs
}

func (f invokedFlowTestFixture) steps(t *testing.T) []db.WorkflowStep {
	t.Helper()
	steps, err := f.api.ListWorkflowSteps(context.Background(), f.run.ID)
	require.NoError(t, err)
	return steps
}

func TestInvokedFlowCancelReachesTheFlowLaunchAndReplayIsRefused(t *testing.T) {
	f := newInvokedFlowTestFixture(t)
	ctx := context.Background()

	require.NoError(t, f.api.CancelWorkflowRun(ctx, f.repositoryID, f.run.ID))
	run, err := f.api.GetWorkflowRun(ctx, f.repositoryID, f.run.ID)
	require.NoError(t, err)
	assert.Equal(t, "cancelled", run.Status)
	operation, err := f.store.GetByRequest(ctx, repositoryJobFlowScope(f.repositoryID, f.userID), flowdispatch.OperationLaunch, invokedFlowRequestID(f.run.ID))
	require.NoError(t, err)
	assert.True(t, operation.CancellationRequested, "the Flow launch receives the cancel")

	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, f.api.ResumeRun(ctx, f.repositoryID, f.run.ID), &apiErr)
	assert.Equal(t, 409, apiErr.Status, "no queue would claim a resumed flow-plane run")
	_, err = f.api.RerunRun(ctx, RerunInput{RepositoryID: f.repositoryID, RunID: f.run.ID, UserID: f.userID})
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 409, apiErr.Status)
}

func TestInvokedFlowTargetRefusesAnotherPersonOrALostWriter(t *testing.T) {
	f := newInvokedFlowTestFixture(t)
	ctx := context.Background()
	target := flowruntime.Target{
		TenantID: repositoryJobFlowScope(f.repositoryID, f.userID).TenantID, PrincipalID: "user:" + strconv.FormatInt(f.userID+1000, 10),
		BindingKind: invokedFlowBinding, BindingID: strconv.FormatInt(f.run.ID, 10),
	}
	_, err := f.invoked.ResolveFlowHostTarget(ctx, target)
	var failure flowruntime.Failure
	require.ErrorAs(t, err, &failure)
	assert.Equal(t, "runtime_target_forbidden", failure.FlowRuntimeCode(), "another person cannot host the run")

	target.PrincipalID = repositoryJobFlowScope(f.repositoryID, f.userID).PrincipalID
	_, err = f.pool.Exec(ctx, `UPDATE repositories SET is_archived=TRUE WHERE id=$1`, f.repositoryID)
	require.NoError(t, err)
	_, err = f.invoked.ResolveFlowHostTarget(ctx, target)
	require.ErrorAs(t, err, &failure)
	assert.Equal(t, "runtime_target_forbidden", failure.FlowRuntimeCode(), "the invoker must still write the repository")

	target.BindingKind = "repository-setup"
	_, err = f.invoked.ResolveFlowHostTarget(ctx, target)
	require.ErrorAs(t, err, &failure)
	assert.Equal(t, "runtime_target_unsupported", failure.FlowRuntimeCode())
}

// failingCancelDispatcher records the Flow cancellation in the product
// transaction, then fails, as a request that times out or a process that
// stops between the two writes would.
type failingCancelDispatcher struct {
	InvokedFlowDispatcher
}

func (d failingCancelDispatcher) CancelRequestInTx(ctx context.Context, tx pgx.Tx, scope jobs.Scope, requestID string) (jobs.Operation, error) {
	if _, err := d.InvokedFlowDispatcher.CancelRequestInTx(ctx, tx, scope, requestID); err != nil {
		return jobs.Operation{}, err
	}
	return jobs.Operation{}, errors.New("connection lost after the Flow cancellation")
}

// A product cancel and its Flow launch's cancellation commit together: a
// failure between them leaves neither, so the run is not reported cancelled
// while its Flow stays runnable; the retried cancel commits both, and the
// worker settles the launch without ever resolving a runtime.
func TestInvokedFlowCancelCommitsWithTheFlowLaunchOrNotAtAll(t *testing.T) {
	f := newInvokedFlowTestFixture(t)
	ctx := context.Background()

	f.invoked.SetFlowDispatcher(failingCancelDispatcher{f.dispatcher})
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, f.api.CancelWorkflowRun(ctx, f.repositoryID, f.run.ID), &apiErr)
	assert.Equal(t, 500, apiErr.Status)
	assert.Equal(t, "queued", f.status(t), "the product cancel rolled back with the Flow cancel")
	assert.False(t, f.operation(t).CancellationRequested, "the Flow cancel rolled back with the product cancel")
	assert.Equal(t, "queued", f.steps(t)[0].Status)

	f.invoked.SetFlowDispatcher(f.dispatcher)
	require.NoError(t, f.api.CancelWorkflowRun(ctx, f.repositoryID, f.run.ID))
	assert.Equal(t, "cancelled", f.status(t))
	assert.True(t, f.operation(t).CancellationRequested)
	assert.Equal(t, "cancelled", f.steps(t)[0].Status)

	workerCtx, stop := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() {
		done <- f.dispatcher.RunWorker(workerCtx, jobs.WorkerConfig{
			WorkerID: "invoked-cancel", Capacity: 1, Lease: 5 * time.Second,
			PollInterval: 10 * time.Millisecond, RetryDelay: 20 * time.Millisecond,
		})
	}()
	require.Eventually(t, func() bool { return f.operation(t).State == jobs.StateCancelled }, 10*time.Second, 20*time.Millisecond)
	stop()
	require.NoError(t, <-done)
	assert.Zero(t, f.resolved.Load(), "a cancelled launch never reaches a runtime")
	assert.Equal(t, "cancelled", f.status(t))
}

// An invoked run's host receives the repository and organization variables
// and secrets a workflow run receives, from the same stores: a repository
// value overrides the organization's, a secret overrides a variable, and a
// main-only secret stays out of an invocation. A box with write shares never
// receives a secret; the run fails typed instead of running without it.
func TestInvokedFlowHostReceivesTheWorkflowEnvironment(t *testing.T) {
	f := newInvokedFlowTestFixture(t)
	ctx := context.Background()
	q := db.New(f.pool)
	variables := NewVariableService(q)
	secrets := NewSecretService(q, f.codec)
	yes := true
	for name, value := range map[string]string{"REGION": "repo-region", "TOKEN": "variable-token"} {
		_, err := variables.SetVariable(ctx, f.owner, f.owner.Username, f.repository, name, value)
		require.NoError(t, err)
	}
	_, err := secrets.SetSecret(ctx, f.owner, f.owner.Username, f.repository, "TOKEN", "secret-token", nil)
	require.NoError(t, err)
	_, err = secrets.SetSecret(ctx, f.owner, f.owner.Username, f.repository, "DEPLOY_KEY", "main-only", &yes)
	require.NoError(t, err)

	authority, err := f.invoked.ResolveFlowHostTarget(ctx, flowruntime.Target{
		TenantID: f.scope().TenantID, PrincipalID: f.scope().PrincipalID,
		BindingKind: invokedFlowBinding, BindingID: strconv.FormatInt(f.run.ID, 10),
	})
	require.NoError(t, err)
	environment, err := f.invoked.FlowHostEnvironment(ctx, authority)
	require.NoError(t, err)
	assert.Equal(t, map[string]string{"REGION": "repo-region", "TOKEN": "secret-token"}, environment, "a secret overrides a variable; a main-only secret stays out")

	// An organization repository's host takes the organization's variables
	// and secrets under the repository's own.
	var orgID, orgRepositoryID int64
	require.NoError(t, f.pool.QueryRow(ctx, `INSERT INTO organizations(name,lower_name) VALUES($1,$1) RETURNING id`, "org"+f.repository).Scan(&orgID))
	require.NoError(t, f.pool.QueryRow(ctx, `INSERT INTO repositories(org_id,name,lower_name,default_bookmark) VALUES($1,$2,$2,'main') RETURNING id`,
		orgID, f.repository).Scan(&orgRepositoryID))
	orgSecret, err := f.codec.EncryptString("org-secret")
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `INSERT INTO organization_variables(organization_id,name,value) VALUES($1,'REGION','org-region'),($1,'ORG_ONLY','org')`, orgID)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `INSERT INTO organization_secrets(organization_id,name,value_encrypted) VALUES($1,'ORG_SECRET',$2)`, orgID, []byte(orgSecret))
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `INSERT INTO repository_variables(repository_id,name,value) VALUES($1,'REGION','repo-region')`, orgRepositoryID)
	require.NoError(t, err)
	orgAuthority := authority
	orgAuthority.RepositoryID = orgRepositoryID
	environment, err = f.invoked.FlowHostEnvironment(ctx, orgAuthority)
	require.NoError(t, err)
	assert.Equal(t, map[string]string{"REGION": "repo-region", "ORG_ONLY": "org", "ORG_SECRET": "org-secret"}, environment)

	other := authority
	other.Target.BindingKind = "repository-setup"
	environment, err = f.invoked.FlowHostEnvironment(ctx, other)
	require.NoError(t, err)
	assert.Nil(t, environment, "only an invoked run's host takes the workflow environment")

	guest := createSecretIntegrationUserIn(t, f.pool, "invokedguest")
	_, err = f.pool.Exec(ctx, `INSERT INTO workspace_shares(workspace_id,owner_user_id,grantee_user_id,level) VALUES($1,$2,$3,'write')`, f.workspaceID, f.userID, guest)
	require.NoError(t, err)
	_, err = f.invoked.FlowHostEnvironment(ctx, authority)
	var failure flowruntime.Failure
	require.ErrorAs(t, err, &failure)
	assert.Equal(t, "runtime_workspace_shared", failure.FlowRuntimeCode())
	assert.False(t, failure.FlowRuntimeRetryable())
}

func createSecretIntegrationUserIn(t *testing.T, pool *pgxpool.Pool, prefix string) int64 {
	t.Helper()
	name := prefix + strings.ReplaceAll(uuid.NewString(), "-", "")
	var id int64
	require.NoError(t, pool.QueryRow(context.Background(),
		`INSERT INTO users(username,lower_username,email,lower_email) VALUES($1,$1,$2,$2) RETURNING id`,
		name, name+"@example.invalid").Scan(&id))
	return id
}

// The flow is the run's one step. Its journal pages are the step's log, each
// logged once even when a retry re-delivers a page, with the repository's
// secrets redacted; a failure logs its typed reason.
func TestInvokedFlowJournalAndFailureReachTheRunLog(t *testing.T) {
	f := newInvokedFlowTestFixture(t)
	ctx := context.Background()
	_, err := NewSecretService(db.New(f.pool), f.codec).SetSecret(ctx, f.owner, f.owner.Username, f.repository, "API_KEY", "sk-live-123", nil)
	require.NoError(t, err)

	steps := f.steps(t)
	require.Len(t, steps, 1, "the step exists as soon as the run is invoked")
	assert.Equal(t, "echo", steps[0].Name)
	assert.Equal(t, "queued", steps[0].Status)

	running := &flowruntime.FlowRuntimeRun{RunID: "flow-run-1", FlowID: "echo", Status: "running"}
	page := flowdispatch.ProjectionUpdate{
		State: jobs.StateWaiting, EventsAfter: "",
		Checkpoint: flowdispatch.RuntimeCheckpoint{RunID: "flow-run-1", Run: running, Cursor: "2"},
		Events: []flowruntime.FlowRuntimeEvent{
			{Sequence: 1, Kind: "node.started", Payload: json.RawMessage(`{"node":"echo"}`)},
			{Sequence: 2, Kind: "node.output", Payload: json.RawMessage(`{"text":"calling with sk-live-123"}`)},
		},
	}
	f.project(t, page)
	f.project(t, page) // a retry re-delivers the page before its cursor was saved
	logs := f.logs(t)
	require.Len(t, logs, 2, "a re-delivered page is logged once")
	assert.Equal(t, `node.started {"node":"echo"}`, logs[0].Entry)
	assert.Equal(t, `node.output {"text":"calling with `+redactedSecretValue+`"}`, logs[1].Entry)
	assert.Equal(t, steps[0].ID, logs[0].WorkflowStepID)
	assert.Equal(t, "running", f.steps(t)[0].Status)
	assert.Equal(t, "running", f.status(t))

	failed := &flowruntime.FlowRuntimeRun{RunID: "flow-run-1", FlowID: "echo", Status: "failed"}
	f.project(t, flowdispatch.ProjectionUpdate{
		State:      jobs.StateFailed,
		Checkpoint: flowdispatch.RuntimeCheckpoint{RunID: "flow-run-1", Run: failed, Cursor: "2", FailureCode: "runtime_workspace_unavailable"},
	})
	assert.Equal(t, "failure", f.status(t))
	assert.Equal(t, "failure", f.steps(t)[0].Status)
	logs = f.logs(t)
	require.Len(t, logs, 3)
	assert.Equal(t, "system", logs[2].Stream)
	assert.Equal(t, "flow failed: runtime_workspace_unavailable", logs[2].Entry)
}

// A Flow that fails before it ever starts (a refused bridge) still names its
// reason on the run.
func TestInvokedFlowRefusedBeforeStartLogsItsReason(t *testing.T) {
	f := newInvokedFlowTestFixture(t)
	f.project(t, flowdispatch.ProjectionUpdate{
		State: jobs.StateFailed, Checkpoint: flowdispatch.RuntimeCheckpoint{FailureCode: "runtime_target_forbidden"},
	})
	assert.Equal(t, "failure", f.status(t))
	logs := f.logs(t)
	require.Len(t, logs, 1)
	assert.Equal(t, "flow failed: runtime_target_forbidden", logs[0].Entry)
}

// The projection that wins an invoked run's terminal transition publishes it
// through the workflow run service, so workflow_run webhook subscribers hear
// every completion and failure exactly once.
func TestInvokedFlowTerminalProjectionPublishesTheWorkflowRunOnce(t *testing.T) {
	for _, tc := range []struct {
		flowStatus string
		state      jobs.State
		action     string
	}{
		{"completed", jobs.StateCompleted, "completed"},
		{"failed", jobs.StateFailed, "failure"},
		{"cancelled", jobs.StateCancelled, "cancelled"},
	} {
		t.Run(tc.flowStatus, func(t *testing.T) {
			f := newInvokedFlowTestFixture(t)
			terminal := flowdispatch.ProjectionUpdate{State: tc.state, Checkpoint: flowdispatch.RuntimeCheckpoint{
				RunID: "flow-run-1", Run: &flowruntime.FlowRuntimeRun{RunID: "flow-run-1", FlowID: "echo", Status: tc.flowStatus},
			}}
			f.project(t, terminal)
			f.project(t, terminal)
			assert.Equal(t, []string{tc.action}, f.webhooks.actions())
		})
	}
}
