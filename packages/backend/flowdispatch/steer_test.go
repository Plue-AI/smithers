package flowdispatch

import (
	"context"
	"encoding/json"
	"math"
	"testing"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

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
