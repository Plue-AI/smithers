package flowdispatch

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// dispatchSuite is this test binary's own database; each test adds a schema.
var dispatchSuite = postgresfixture.Suite{Empty: true}

func TestMain(m *testing.M) {
	os.Exit(dispatchSuite.Run(m))
}

func newFlowDispatchStore(t *testing.T) (*jobs.Store, *pgxpool.Pool) {
	t.Helper()
	suitePool := dispatchSuite.Pool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	schema := "flow_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	_, err := suitePool.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize())
	require.NoError(t, err)
	config, err := pgxpool.ParseConfig(dispatchSuite.URL(t))
	require.NoError(t, err)
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	require.NoError(t, err)
	require.NoError(t, pool.Ping(ctx))
	_, err = pool.Exec(ctx, jobs.SchemaSQL())
	require.NoError(t, err)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	t.Cleanup(func() {
		pool.Close()
		dropContext, dropCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer dropCancel()
		_, _ = suitePool.Exec(dropContext, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE")
	})
	return store, pool
}

type testRuntimeFailure struct {
	class     string
	code      string
	retryable bool
}

func (failure *testRuntimeFailure) FlowRuntimeClass() string { return failure.class }

func (failure *testRuntimeFailure) Error() string              { return failure.code }
func (failure *testRuntimeFailure) FlowRuntimeCode() string    { return failure.code }
func (failure *testRuntimeFailure) FlowRuntimeRetryable() bool { return failure.retryable }

type recordingRuntime struct {
	mu              sync.Mutex
	identity        flowruntime.Identity
	requireApproval bool
	approved        bool
	denied          bool
	status          string
	observeCount    int
	failFirstLaunch bool
	launches        []flowruntime.Launch
	signals         []flowruntime.Signal
	steers          []flowruntime.Steer
	launchEntered   chan struct{}
	launchRelease   chan struct{}
	launchOnce      sync.Once
	// executionDigest is the identity the host reports for what it planned.
	executionDigest string
	// flowID is the flow last launched; observation reports it.
	flowID    string
	cancels   int
	approvals int
	denials   int
}

func newRecordingRuntime() *recordingRuntime {
	return &recordingRuntime{identity: flowruntime.Identity{
		Protocol: flowruntime.Protocol, RuntimeArtifactDigest: strings.Repeat("a", 64),
		SourceRevision: strings.Repeat("b", 40), OwnerGeneration: 1,
	}}
}

func (runtime *recordingRuntime) Identity(context.Context) (flowruntime.Identity, error) {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	return runtime.identity, nil
}

func (runtime *recordingRuntime) Launch(ctx context.Context, input flowruntime.Launch) (flowruntime.LaunchResult, error) {
	runtime.mu.Lock()
	runtime.launches = append(runtime.launches, input)
	runtime.flowID = input.FlowID
	entered, release := runtime.launchEntered, runtime.launchRelease
	runtime.mu.Unlock()
	if entered != nil {
		runtime.launchOnce.Do(func() { close(entered) })
		select {
		case <-release:
		case <-ctx.Done():
			return flowruntime.LaunchResult{}, ctx.Err()
		}
	}

	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.failFirstLaunch {
		runtime.failFirstLaunch = false
		runtime.status = "running"
		runtime.identity.OwnerGeneration++
		return flowruntime.LaunchResult{}, &testRuntimeFailure{code: "transport", retryable: true}
	}
	if runtime.denied {
		return flowruntime.LaunchResult{}, &testRuntimeFailure{code: "plan_denied"}
	}
	if runtime.requireApproval && !runtime.approved {
		return flowruntime.LaunchResult{
			ApplicationRequestID: input.ApplicationRequestID, OwnerGeneration: input.OwnerGeneration,
			RuntimeArtifactDigest: input.RuntimeArtifactDigest, SourceRevision: input.SourceRevision,
			PlanID: "plan-1", ExecutionDigest: runtime.executionDigest, Approval: json.RawMessage(`{"target":{"_tag":"Plan","planId":"plan-1"}}`),
			Receipt: flowruntime.Receipt{Tag: "Parked", ReceiptID: "parked", PlanID: "plan-1", Status: "waiting-approval"},
		}, nil
	}
	tag := "Accepted"
	if runtime.status != "" {
		tag = "AlreadyApplied"
	} else {
		runtime.status = "running"
	}
	return flowruntime.LaunchResult{
		ApplicationRequestID: input.ApplicationRequestID, OwnerGeneration: input.OwnerGeneration,
		RuntimeArtifactDigest: input.RuntimeArtifactDigest, SourceRevision: input.SourceRevision,
		PlanID: "plan-1", ExecutionDigest: runtime.executionDigest, Receipt: flowruntime.Receipt{Tag: tag, ReceiptID: "accepted", RunID: "run-1"},
	}, nil
}

func (runtime *recordingRuntime) Approve(_ context.Context, input flowruntime.Decision) (flowruntime.MutationResult, error) {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	runtime.approved = true
	runtime.approvals++
	return flowruntime.MutationResult{Operation: "approve", ApplicationRequestID: input.ApplicationRequestID,
		Receipt: flowruntime.Receipt{Tag: "Accepted", ReceiptID: input.ApplicationRequestID}}, nil
}

func (runtime *recordingRuntime) Deny(_ context.Context, input flowruntime.Decision) (flowruntime.MutationResult, error) {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	runtime.denied = true
	runtime.denials++
	return flowruntime.MutationResult{Operation: "deny", ApplicationRequestID: input.ApplicationRequestID,
		Receipt: flowruntime.Receipt{Tag: "Terminal", ReceiptID: input.ApplicationRequestID, Status: "cancelled"}}, nil
}

func (runtime *recordingRuntime) Cancel(_ context.Context, input flowruntime.Lifecycle) (flowruntime.MutationResult, error) {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	runtime.status = "cancelled"
	runtime.cancels++
	return flowruntime.MutationResult{Operation: "cancel", ApplicationRequestID: input.ApplicationRequestID,
		Receipt: flowruntime.Receipt{Tag: "Terminal", ReceiptID: input.ApplicationRequestID, RunID: input.RunID, Status: "cancelled"}}, nil
}

func (runtime *recordingRuntime) Observe(_ context.Context, runID, cursor string, _ int) (flowruntime.Observation, error) {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	runtime.observeCount++
	if runtime.status == "running" && runtime.observeCount > 1 {
		runtime.status = "completed"
	}
	next := fmt.Sprintf("%d", runtime.observeCount)
	flowID := runtime.flowID
	if flowID == "" {
		flowID = "coding/dispatch"
	}
	return flowruntime.Observation{
		Run: flowruntime.Run{RunID: runID, FlowID: flowID, Status: runtime.status, PlanID: "plan-1"},
		Events: []flowruntime.Event{{Sequence: int64(runtime.observeCount), Kind: "control.run." + runtime.status,
			RunID: runID, Payload: json.RawMessage(`{}`)}},
		NextCursor: next, Terminal: terminalStatus(runtime.status),
	}, nil
}

func (runtime *recordingRuntime) Signal(_ context.Context, input flowruntime.Signal) (flowruntime.MutationResult, error) {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	runtime.signals = append(runtime.signals, input)
	return flowruntime.MutationResult{
		Operation: "signal", ApplicationRequestID: input.ApplicationRequestID,
		Receipt: flowruntime.Receipt{Tag: "Accepted", ReceiptID: input.ApplicationRequestID, RunID: input.RunID},
	}, nil
}
func (runtime *recordingRuntime) Steer(_ context.Context, input flowruntime.Steer) (flowruntime.MutationResult, error) {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	runtime.steers = append(runtime.steers, input)
	return flowruntime.MutationResult{Operation: "steer", ApplicationRequestID: input.ApplicationRequestID,
		Receipt: flowruntime.Receipt{Tag: "Accepted", ReceiptID: input.ApplicationRequestID, RunID: input.RunID}}, nil
}
func (*recordingRuntime) Resume(context.Context, flowruntime.Lifecycle) (flowruntime.MutationResult, error) {
	return flowruntime.MutationResult{}, nil
}

type recordingProjector struct {
	mu      sync.Mutex
	updates []ProjectionUpdate
}

func (projector *recordingProjector) ProjectFlowRuntime(_ context.Context, update ProjectionUpdate) error {
	projector.mu.Lock()
	defer projector.mu.Unlock()
	projector.updates = append(projector.updates, update)
	return nil
}

func testLaunchRequest(requestID string, policy ApprovalPolicy) LaunchRequest {
	return LaunchRequest{
		Scope: jobs.Scope{TenantID: "repository:5", PrincipalID: "user:9"}, RequestID: requestID,
		Target: flowruntime.Target{BindingKind: "agent-session", BindingID: "session-1"},
		FlowID: "coding/dispatch", Payload: json.RawMessage(`{"turnId":"turn-1"}`),
		AuthorizationContext: json.RawMessage(`{"role":"owner"}`),
		Projection:           json.RawMessage(`{"kind":"agent-workflow-run"}`),
		ApprovalPolicy:       policy,
	}
}

func startTestWorker(t *testing.T, service *Service, workerID string) context.CancelFunc {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- service.RunWorker(ctx, jobs.WorkerConfig{
			WorkerID: workerID, Capacity: 2, Lease: 2 * time.Second,
			PollInterval: 2 * time.Millisecond, RetryDelay: 2 * time.Millisecond,
		})
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			require.NoError(t, err)
		case <-time.After(5 * time.Second):
			t.Error("Flow worker did not stop")
		}
	})
	return cancel
}

func waitOperation(t *testing.T, store *jobs.Store, scope jobs.Scope, operationID string, match func(jobs.Operation) bool) jobs.Operation {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	var last jobs.Operation
	for time.Now().Before(deadline) {
		operation, err := store.Get(context.Background(), scope, operationID)
		require.NoError(t, err)
		last = operation
		if match(operation) {
			return operation
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("operation did not reach expected state: state=%s attempt=%d reconcile=%t terminal=%s", last.State, last.Attempt, last.NeedsReconciliation, last.TerminalReceipt)
	return jobs.Operation{}
}

func TestObservationCursorDistinguishesBeginningFromSequenceZero(t *testing.T) {
	page := flowruntime.Observation{
		Events: []flowruntime.Event{{Sequence: 0}, {Sequence: 1}}, NextCursor: "1",
	}
	require.True(t, validObservationPage("", page))
	require.False(t, validObservationPage("0", page), "an explicit cursor must not replay its event")
	page.Events = page.Events[1:]
	require.True(t, validObservationPage("0", page))
	page.Events = append(page.Events, page.Events[0])
	require.False(t, validObservationPage("0", page), "duplicate events remain invalid")
}

func TestAdmissionReturnsDuringUnresolvedLaunchAndAutoApprovalReachesTerminal(t *testing.T) {
	store, _ := newFlowDispatchStore(t)
	runtime := newRecordingRuntime()
	runtime.requireApproval = true
	runtime.launchEntered = make(chan struct{})
	runtime.launchRelease = make(chan struct{})
	projector := &recordingProjector{}
	service, err := New(Config{
		Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
			return runtime, nil
		}),
		Projector: projector, ObservationDelay: 2 * time.Millisecond,
	})
	require.NoError(t, err)
	startTestWorker(t, service, "flow-worker")

	request := testLaunchRequest("request-1", ApprovalAuto)
	receipt, err := service.Admit(context.Background(), request)
	require.NoError(t, err)
	select {
	case <-runtime.launchEntered:
	case <-time.After(5 * time.Second):
		t.Fatal("runtime launch did not begin")
	}
	type joinResult struct {
		receipt jobs.RequestReceipt
		err     error
	}
	joined := make(chan joinResult, 1)
	go func() {
		result, joinErr := service.Admit(context.Background(), request)
		joined <- joinResult{receipt: result, err: joinErr}
	}()
	select {
	case duplicate := <-joined:
		require.NoError(t, duplicate.err)
		require.True(t, duplicate.receipt.Joined)
		require.Equal(t, receipt.OperationID, duplicate.receipt.OperationID)
	case <-time.After(time.Second):
		t.Fatal("durable admission waited for unresolved runtime launch")
	}
	close(runtime.launchRelease)

	operation := waitOperation(t, store, request.Scope, receipt.OperationID, func(operation jobs.Operation) bool {
		return operation.State == jobs.StateCompleted
	})
	require.NotEmpty(t, operation.TerminalReceipt)
	runtime.mu.Lock()
	launches := append([]flowruntime.Launch(nil), runtime.launches...)
	runtime.mu.Unlock()
	require.GreaterOrEqual(t, len(launches), 2)
	for _, launch := range launches {
		require.Equal(t, receipt.OperationID, launch.ApplicationRequestID)
		require.Equal(t, int64(1), launch.Attempt)
	}
	projector.mu.Lock()
	defer projector.mu.Unlock()
	require.NotEmpty(t, projector.updates)
	require.Equal(t, jobs.StateCompleted, projector.updates[len(projector.updates)-1].State)
}

func TestWorkerRestartReconcilesLostAckAcrossOwnerGeneration(t *testing.T) {
	store, pool := newFlowDispatchStore(t)
	runtime := newRecordingRuntime()
	runtime.failFirstLaunch = true
	service, err := New(Config{
		Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
			return runtime, nil
		}), ObservationDelay: 2 * time.Millisecond,
	})
	require.NoError(t, err)
	request := testLaunchRequest("lost-ack", ApprovalManual)
	receipt, err := service.Admit(context.Background(), request)
	require.NoError(t, err)

	firstCtx, stopFirst := context.WithCancel(context.Background())
	firstDone := make(chan error, 1)
	go func() {
		firstDone <- service.RunWorker(firstCtx, jobs.WorkerConfig{
			WorkerID: "owner-one", Capacity: 1, Lease: 2 * time.Second,
			PollInterval: 2 * time.Millisecond, RetryDelay: time.Hour,
		})
	}()
	waitOperation(t, store, request.Scope, receipt.OperationID, func(operation jobs.Operation) bool {
		// StartExternal durably records the runtime identity before the first
		// network call. A lost acknowledgement therefore leaves a reconnectable
		// waiting checkpoint, not the pre-dispatch accepted state.
		return operation.Attempt == 1 && operation.State == jobs.StateWaiting &&
			len(operation.ExternalReceipt) > 0 && operation.NeedsReconciliation
	})
	stopFirst()
	require.NoError(t, <-firstDone)
	_, err = pool.Exec(context.Background(), `UPDATE product_job_dispatches
		SET next_attempt_at=clock_timestamp() WHERE operation_id=$1`, receipt.OperationID)
	require.NoError(t, err)

	startTestWorker(t, service, "owner-two")
	waitOperation(t, store, request.Scope, receipt.OperationID, func(operation jobs.Operation) bool {
		return operation.State == jobs.StateCompleted
	})
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	require.GreaterOrEqual(t, len(runtime.launches), 2)
	require.Equal(t, runtime.launches[0].ApplicationRequestID, runtime.launches[1].ApplicationRequestID)
	require.Equal(t, int64(1), runtime.launches[0].Attempt)
	require.Equal(t, int64(1), runtime.launches[1].Attempt)
	require.Equal(t, int64(1), runtime.launches[0].OwnerGeneration)
	require.Equal(t, int64(2), runtime.launches[1].OwnerGeneration)
}

func TestCancellationRacingFirstExternalCallNeverLaunchesRuntime(t *testing.T) {
	store, _ := newFlowDispatchStore(t)
	runtime := newRecordingRuntime()
	resolveEntered := make(chan struct{})
	resolveRelease := make(chan struct{})
	var resolveOnce sync.Once
	projector := &recordingProjector{}
	service, err := New(Config{
		Store: store,
		Resolver: flowruntime.ResolverFunc(func(ctx context.Context, _ flowruntime.Target) (flowruntime.Runtime, error) {
			resolveOnce.Do(func() { close(resolveEntered) })
			select {
			case <-resolveRelease:
				return runtime, nil
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}),
		Projector: projector, ObservationDelay: 2 * time.Millisecond,
	})
	require.NoError(t, err)
	startTestWorker(t, service, "cancel-before-launch")
	request := testLaunchRequest("cancel-before-runtime-launch", ApprovalManual)
	receipt, err := service.Admit(context.Background(), request)
	require.NoError(t, err)
	select {
	case <-resolveEntered:
	case <-time.After(5 * time.Second):
		t.Fatal("runtime resolution did not begin")
	}
	pending, err := service.CancelRequest(context.Background(), request.Scope, request.RequestID)
	require.NoError(t, err)
	require.True(t, pending.CancellationRequested)
	close(resolveRelease)
	operation := waitOperation(t, store, request.Scope, receipt.OperationID, func(operation jobs.Operation) bool {
		return operation.State == jobs.StateCancelled
	})
	require.Contains(t, string(operation.TerminalReceipt), "cancelled-before-runtime-launch")
	runtime.mu.Lock()
	require.Empty(t, runtime.launches)
	runtime.mu.Unlock()
	projector.mu.Lock()
	require.NotEmpty(t, projector.updates)
	require.Equal(t, jobs.StateCancelled, projector.updates[len(projector.updates)-1].State)
	projector.mu.Unlock()
}

func TestSignalAdmissionIsDurableIdempotentAndProjected(t *testing.T) {
	store, _ := newFlowDispatchStore(t)
	runtime := newRecordingRuntime()
	runtime.status = "waiting"
	projector := &recordingProjector{}
	service, err := New(Config{
		Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
			return runtime, nil
		}),
		Projector: projector, ObservationDelay: 2 * time.Millisecond,
	})
	require.NoError(t, err)
	request := SignalRequest{
		Scope: jobs.Scope{TenantID: "repository:5", PrincipalID: "user:9"}, RequestID: "signal-1",
		Target: flowruntime.Target{BindingKind: "repository-job-dispatch", BindingID: "dispatch-1"},
		FlowID: "coding/dispatch", RunID: "run-1", Name: "repository-job.author-reply",
		Payload: json.RawMessage(`{"comment":"continue"}`), AuthorizationContext: json.RawMessage(`{"role":"owner"}`),
		Projection: json.RawMessage(`{"kind":"repository-job-dispatch"}`),
	}
	receipt, err := service.Signal(context.Background(), request)
	require.NoError(t, err)
	duplicate, err := service.Signal(context.Background(), request)
	require.NoError(t, err)
	require.True(t, duplicate.Joined)
	require.Equal(t, receipt.OperationID, duplicate.OperationID)
	startTestWorker(t, service, "signal-owner")
	waitOperation(t, store, request.Scope, receipt.OperationID, func(operation jobs.Operation) bool {
		return operation.State == jobs.StateCompleted
	})
	runtime.mu.Lock()
	require.Len(t, runtime.signals, 1)
	require.Equal(t, receipt.OperationID, runtime.signals[0].ApplicationRequestID)
	runtime.mu.Unlock()
	projector.mu.Lock()
	final := projector.updates[len(projector.updates)-1]
	projector.mu.Unlock()
	require.Equal(t, jobs.StateCompleted, final.State)
	require.NotNil(t, final.Checkpoint.MutationReceipt)
}

func TestParkedLaunchCancellationIsDeliveredToCanonicalRuntime(t *testing.T) {
	store, _ := newFlowDispatchStore(t)
	runtime := newRecordingRuntime()
	runtime.requireApproval = true
	service, err := New(Config{
		Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
			return runtime, nil
		}), ObservationDelay: 20 * time.Millisecond,
	})
	require.NoError(t, err)
	startTestWorker(t, service, "cancelling-owner")
	request := testLaunchRequest("cancel-parked", ApprovalManual)
	receipt, err := service.Admit(context.Background(), request)
	require.NoError(t, err)
	waitOperation(t, store, request.Scope, receipt.OperationID, func(operation jobs.Operation) bool {
		return operation.State == jobs.StateWaiting && len(operation.ExternalReceipt) > 0
	})
	pending, err := service.CancelRequest(context.Background(), request.Scope, request.RequestID)
	require.NoError(t, err)
	require.True(t, pending.CancellationRequested)
	waitOperation(t, store, request.Scope, receipt.OperationID, func(operation jobs.Operation) bool {
		return operation.State == jobs.StateCancelled
	})
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	require.True(t, runtime.denied)
}

func TestIsolationRefusalPersistsInfrastructureClass(t *testing.T) {
	store, _ := newFlowDispatchStore(t)
	projector := &recordingProjector{}
	service, err := New(Config{Store: store, Projector: projector,
		Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
			return nil, &testRuntimeFailure{code: "isolation_required", class: "infra"}
		}),
	})
	require.NoError(t, err)
	request := testLaunchRequest("isolation-required", ApprovalManual)
	receipt, err := service.Admit(context.Background(), request)
	require.NoError(t, err)
	startTestWorker(t, service, "isolation-check")
	operation := waitOperation(t, store, request.Scope, receipt.OperationID, func(operation jobs.Operation) bool { return operation.State == jobs.StateFailed })
	var terminal map[string]any
	require.NoError(t, json.Unmarshal(operation.TerminalReceipt, &terminal))
	require.Equal(t, "isolation_required", terminal["errorCode"])
	require.Equal(t, "infra", terminal["errorClass"])
	projector.mu.Lock()
	defer projector.mu.Unlock()
	require.NotEmpty(t, projector.updates)
	projected := mustJSON(projector.updates[len(projector.updates)-1].Checkpoint)
	var checkpoint map[string]any
	require.NoError(t, json.Unmarshal(projected, &checkpoint))
	require.Equal(t, "isolation_required", checkpoint["failureCode"])
	require.Equal(t, "infra", checkpoint["failureClass"])
}

func TestOldRuntimeCheckpointRemainsReadableWithoutClass(t *testing.T) {
	legacy := json.RawMessage(`{"version":1,"failureCode":"runtime_unavailable","failureObservedAt":7}`)
	checkpoint, err := decodeCheckpoint(legacy)
	require.NoError(t, err)
	require.Equal(t, "runtime_unavailable", checkpoint.FailureCode)
	require.Equal(t, int64(7), checkpoint.FailureObservedAt)
	require.Empty(t, checkpoint.FailureClass)
	require.NotContains(t, string(mustJSON(checkpoint)), "failureClass")
	var receipt terminalReceipt
	require.NoError(t, json.Unmarshal([]byte(`{"kind":"bridge-refused","errorCode":"runtime_unavailable"}`), &receipt))
	require.Equal(t, "runtime_unavailable", receipt.ErrorCode)
	require.Empty(t, receipt.ErrorClass)
	require.NotContains(t, string(mustJSON(receipt)), "errorClass")
}

func TestRuntimeFailureClassesRespectTypedProductEnvelope(t *testing.T) {
	for _, class := range []string{"user", "permission", "capacity", "github", "infra", "conflict"} {
		err := fmt.Errorf("wrapped: %w", &testRuntimeFailure{code: "typed", class: class})
		require.Equal(t, class, runtimeFailureClass(err))
	}
	require.Empty(t, runtimeFailureClass(fmt.Errorf("unclassified")))
	require.Empty(t, runtimeFailureClass(&testRuntimeFailure{code: "legacy"}))
	require.Empty(t, runtimeFailureClass(&testRuntimeFailure{code: "unknown", class: "private-adapter-detail"}))
}
