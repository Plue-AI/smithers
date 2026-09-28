package services

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// recordingFlowInvoker records the launch InvokeWorkflow admits.
type recordingFlowInvoker struct {
	launches  []InvokedFlowLaunch
	cancelled []int64
}

func (r *recordingFlowInvoker) Invoke(_ context.Context, launch InvokedFlowLaunch) (db.WorkflowRun, db.WorkflowDefinition, error) {
	r.launches = append(r.launches, launch)
	return db.WorkflowRun{ID: 42, RepositoryID: launch.RepositoryID, Status: "queued", ExecutionPlane: WorkflowRunPlaneFlow},
		db.WorkflowDefinition{ID: 11, Name: launch.FlowID, Path: invokedFlowPath(launch.FlowID)}, nil
}

func (r *recordingFlowInvoker) CancelInvokedRun(_ context.Context, _ int64, runID int64) error {
	r.cancelled = append(r.cancelled, runID)
	return nil
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
// dispatcher and jobs store.
type invokedFlowTestFixture struct {
	pool         *pgxpool.Pool
	store        *jobs.Store
	invoked      *InvokedFlowService
	api          WorkflowAPIService
	userID       int64
	repositoryID int64
	run          db.WorkflowRun
}

func newInvokedFlowTestFixture(t *testing.T) invokedFlowTestFixture {
	t.Helper()
	pool := newProductTestPool(t)
	ctx := context.Background()
	q := db.New(pool)
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")
	f := invokedFlowTestFixture{pool: pool}
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO users(username,lower_username,email,lower_email) VALUES($1,$1,$2,$2) RETURNING id`,
		"owner"+suffix, suffix+"@example.invalid").Scan(&f.userID))
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO repositories(user_id,name,lower_name) VALUES($1,$2,$2) RETURNING id`,
		f.userID, "repo"+suffix).Scan(&f.repositoryID))
	var err error
	f.store, err = jobs.NewStore(pool)
	require.NoError(t, err)
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: f.store, Resolver: flowruntime.ResolverFunc(
		func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
			return nil, errors.New("admission must not resolve a runtime")
		})})
	require.NoError(t, err)
	f.invoked = NewInvokedFlowService(pool, NewRepositoryJobService(q, nil, pool), invokedFlowTestWorkspaces{workspaceID: uuid.NewString()})
	f.invoked.SetFlowDispatcher(dispatcher)
	f.api = NewWorkflowAPIService(q, NewWorkflowRunService(q), WithWorkflowAPIFlowInvoker(f.invoked))
	result, err := f.api.InvokeWorkflow(ctx, InvokeWorkflowInput{RepositoryID: f.repositoryID, UserID: f.userID, Identifier: "echo"})
	require.NoError(t, err)
	f.run = result.Run
	return f
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
