package flowdispatch

import (
	"context"
	"encoding/json"
	"math"
	"sync/atomic"
	"testing"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

type testSteerAuthorizer func(context.Context, SteerRequest) error

func (authorize testSteerAuthorizer) AuthorizeFlowSteer(ctx context.Context, request SteerRequest) error {
	return authorize(ctx, request)
}

var allowTestSteer = testSteerAuthorizer(func(context.Context, SteerRequest) error { return nil })

func TestTodoSteerReauthorizesBeforeWakeAndDelivery(t *testing.T) {
	for _, revokeAt := range []int32{0, 1, 2} {
		t.Run(map[int32]string{0: "allowed", 1: "removed before wake", 2: "removed while waking"}[revokeAt], func(t *testing.T) {
			store, _ := newFlowDispatchStore(t)
			runtime := todoWakeRuntime{newRecordingRuntime()}
			runtime.status = "waiting"
			var checks, resolves atomic.Int32
			request := testSteerRequest()
			request.FlowID = "todo"
			service, err := New(Config{Store: store,
				Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
					resolves.Add(1)
					return runtime, nil
				}),
				SteerAuthorizer: testSteerAuthorizer(func(_ context.Context, received SteerRequest) error {
					require.Equal(t, request.Body, received.Body)
					require.Equal(t, request.MessageID, received.MessageID)
					require.Equal(t, request.Scope, received.Scope)
					require.JSONEq(t, string(request.AuthorizationContext), string(received.AuthorizationContext))
					if checks.Add(1) == revokeAt {
						return &testRuntimeFailure{code: "steer_author_revoked"}
					}
					return nil
				}),
			})
			require.NoError(t, err)
			receipt, err := service.Steer(context.Background(), request)
			require.NoError(t, err)
			stop := startTestWorker(t, service, "steer-authority")
			result := waitOperation(t, store, request.Scope, receipt.OperationID, func(op jobs.Operation) bool { return op.State.Terminal() })
			stop()
			if revokeAt == 0 {
				require.Equal(t, jobs.StateCompleted, result.State)
				require.Len(t, runtime.steers, 1)
				require.EqualValues(t, 2, checks.Load())
			} else {
				require.Equal(t, jobs.StateFailed, result.State)
				require.Contains(t, string(result.TerminalReceipt), "steer_author_revoked")
				require.Empty(t, runtime.steers)
				require.Equal(t, revokeAt, checks.Load())
			}
			if revokeAt == 1 {
				require.Zero(t, resolves.Load())
			} else {
				require.EqualValues(t, 1, resolves.Load())
			}
		})
	}
}

func TestTodoSteerMissingAuthorizerRetainsInput(t *testing.T) {
	store, _ := newFlowDispatchStore(t)
	runtime := todoWakeRuntime{newRecordingRuntime()}
	runtime.status = "waiting"
	var resolves atomic.Int32
	resolver := flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		resolves.Add(1)
		return runtime, nil
	})
	service, err := New(Config{Store: store, Resolver: resolver})
	require.NoError(t, err)
	request := testSteerRequest()
	request.FlowID = "todo"
	receipt, err := service.Steer(context.Background(), request)
	require.NoError(t, err)
	stop := startTestWorker(t, service, "no-steer-authorizer")
	waitOperation(t, store, request.Scope, receipt.OperationID, func(op jobs.Operation) bool { return op.Attempt > 0 })
	stop()
	require.Zero(t, resolves.Load(), "missing authority must refuse before waking the host")
	require.Empty(t, runtime.steers)
	retained, err := store.Get(context.Background(), request.Scope, receipt.OperationID)
	require.NoError(t, err)
	require.False(t, retained.State.Terminal())
	service, err = New(Config{Store: store, Resolver: resolver, SteerAuthorizer: allowTestSteer})
	require.NoError(t, err)
	stop = startTestWorker(t, service, "restored-steer-authorizer")
	waitOperation(t, store, request.Scope, receipt.OperationID, func(op jobs.Operation) bool { return op.State == jobs.StateCompleted })
	stop()
	require.Len(t, runtime.steers, 1)
	require.Equal(t, request.MessageID, runtime.steers[0].MessageID)
	require.Equal(t, request.Body, runtime.steers[0].Body)
}

func testSteerRequest() SteerRequest {
	launch := testLaunchRequest("feedback-1", ApprovalManual)
	return SteerRequest{
		Scope: launch.Scope, RequestID: launch.RequestID, Target: launch.Target,
		FlowID: launch.FlowID, RunID: "run-1", MessageID: "message-1",
		CreatedAt: 1791228000000, Body: "Keep the question open; also cover cancellation.",
		AuthorizationContext: launch.AuthorizationContext,
	}
}

func TestSteerAdmissionRejectsInvalidInputs(t *testing.T) {
	cases := map[string]func(*SteerRequest){
		"request":         func(r *SteerRequest) { r.RequestID = " " },
		"flow":            func(r *SteerRequest) { r.FlowID = " " },
		"run":             func(r *SteerRequest) { r.RunID = " " },
		"message":         func(r *SteerRequest) { r.MessageID = " " },
		"body":            func(r *SteerRequest) { r.Body = " \n" },
		"negative time":   func(r *SteerRequest) { r.CreatedAt = -1 },
		"nan":             func(r *SteerRequest) { r.CreatedAt = math.NaN() },
		"infinite time":   func(r *SteerRequest) { r.CreatedAt = math.Inf(1) },
		"other tenant":    func(r *SteerRequest) { r.Target.TenantID = "other" },
		"other principal": func(r *SteerRequest) { r.Target.PrincipalID = "other" },
		"binding kind":    func(r *SteerRequest) { r.Target.BindingKind = "" },
		"binding id":      func(r *SteerRequest) { r.Target.BindingID = "" },
		"projection":      func(r *SteerRequest) { r.Projection = json.RawMessage(`{`) },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			request := testSteerRequest()
			change(&request)
			_, err := (&Service{}).Steer(context.Background(), request)
			require.Error(t, err, "invalid admission must stop before the jobs store")
		})
	}
}

// This host double models canonical receipt recovery, not model consumption.
// PostgreSQL and the dispatcher worker are real; guest acceptance is separate.
type steerReceiptRuntime struct {
	*recordingRuntime
	mode string
}

func (runtime *steerReceiptRuntime) Steer(_ context.Context, input flowruntime.Steer) (flowruntime.MutationResult, error) {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	runtime.steers = append(runtime.steers, input)
	result := flowruntime.MutationResult{Operation: "steer", ApplicationRequestID: input.ApplicationRequestID,
		Receipt: flowruntime.Receipt{Tag: "AlreadyApplied", ReceiptID: input.ApplicationRequestID, RunID: input.RunID}}
	switch runtime.mode {
	case "lost ack":
		runtime.status = "completed"
		if len(runtime.steers) == 1 {
			runtime.identity.OwnerGeneration++
			return flowruntime.MutationResult{}, &testRuntimeFailure{code: "transport", retryable: true}
		}
	case "terminal":
		result.Receipt = flowruntime.Receipt{Tag: "Terminal", RunID: input.RunID, Status: "completed"}
	case "wrong operation":
		result.Operation = "signal"
	case "wrong request":
		result.ApplicationRequestID = "another-input"
	case "wrong applied run":
		result.Receipt.RunID = "another-run"
	case "wrong terminal run":
		result.Receipt = flowruntime.Receipt{Tag: "Terminal", RunID: "another-run", Status: "completed"}
	}
	return result, nil
}

func TestSteerReceiptRecovery(t *testing.T) {
	for _, mode := range []string{"lost ack", "terminal", "wrong operation", "wrong request", "wrong applied run", "wrong terminal run"} {
		t.Run(mode, func(t *testing.T) {
			store, _ := newFlowDispatchStore(t)
			runtime := &steerReceiptRuntime{recordingRuntime: newRecordingRuntime(), mode: mode}
			runtime.status = "waiting"
			service, err := New(Config{Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) { return runtime, nil })})
			require.NoError(t, err)
			request := testSteerRequest()
			receipt, err := service.Steer(context.Background(), request)
			require.NoError(t, err)
			startTestWorker(t, service, "steer-recovery")
			operation := waitOperation(t, store, request.Scope, receipt.OperationID, func(op jobs.Operation) bool { return op.State.Terminal() })
			runtime.mu.Lock()
			defer runtime.mu.Unlock()
			require.Empty(t, runtime.signals)
			if mode == "lost ack" {
				require.Equal(t, jobs.StateCompleted, operation.State)
				require.Len(t, runtime.steers, 2)
				first, second := runtime.steers[0], runtime.steers[1]
				require.Equal(t, int64(1), first.OwnerGeneration)
				require.Equal(t, int64(2), second.OwnerGeneration)
				first.OwnerGeneration = second.OwnerGeneration
				require.Equal(t, first, second, "recovery must preserve the input identity and content")
				require.Contains(t, string(operation.TerminalReceipt), "AlreadyApplied")
			} else {
				require.Equal(t, jobs.StateFailed, operation.State)
				code := "invalid_steer_receipt"
				if mode == "terminal" {
					code = "runtime_run_terminal"
				}
				require.Contains(t, string(operation.TerminalReceipt), code)
			}
		})
	}
}
