package flowdispatch

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

func TestTodoWakeDeadlineAndBackoff(t *testing.T) {
	start := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	checkpoint := RuntimeCheckpoint{WakeStartedAt: start.UnixMilli()}
	require.False(t, todoWakeExpired(checkpoint, start.Add(15*time.Minute-time.Millisecond)))
	require.True(t, todoWakeExpired(checkpoint, start.Add(15*time.Minute)))
	require.True(t, todoWakeExpired(checkpoint, start.Add(24*time.Hour)))
	require.False(t, todoWakeExpired(RuntimeCheckpoint{}, start))
	for attempt, want := range map[int]time.Duration{-1: time.Second, 0: time.Second, 1: time.Second, 2: 2 * time.Second, 6: 32 * time.Second, 100: 32 * time.Second} {
		require.Equal(t, want, todoWakeBackoff(attempt))
	}
}

type todoWakeRuntime struct{ *recordingRuntime }

func (r todoWakeRuntime) Observe(ctx context.Context, run, cursor string, limit int) (flowruntime.Observation, error) {
	observation, err := r.recordingRuntime.Observe(ctx, run, cursor, limit)
	observation.Run.FlowID = "todo"
	return observation, err
}

func TestTodoWakeReplayKeepsSignalIdentity(t *testing.T) {
	store, _ := newFlowDispatchStore(t)
	runtime := newRecordingRuntime()
	runtime.status = "waiting"
	var unavailable atomic.Bool
	unavailable.Store(true)
	resolver := flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		if unavailable.Load() {
			return nil, &testRuntimeFailure{code: "runtime_host_not_running"}
		}
		return todoWakeRuntime{runtime}, nil
	})
	service, err := New(Config{Store: store, Resolver: resolver})
	require.NoError(t, err)
	request := SignalRequest{Scope: jobs.Scope{TenantID: "repository:5", PrincipalID: "user:9"}, RequestID: "member-steer", Target: flowruntime.Target{BindingKind: "workspace", BindingID: "waiting", WorkspaceID: "waiting"}, FlowID: "todo", RunID: "run-1", Name: "steer", Payload: json.RawMessage(`{"text":"Keep notes.txt"}`)}
	receipt, err := service.Signal(context.Background(), request)
	require.NoError(t, err)
	stop := startTestWorker(t, service, "before-restart")
	waiting := waitOperation(t, store, request.Scope, receipt.OperationID, func(op jobs.Operation) bool { return op.State == jobs.StateWaiting })
	checkpoint, err := decodeCheckpoint(waiting.ExternalReceipt)
	require.NoError(t, err)
	require.Positive(t, checkpoint.WakeStartedAt)
	require.Equal(t, "wake", checkpoint.FailureStep)
	runtime.mu.Lock()
	require.Empty(t, runtime.signals)
	runtime.mu.Unlock()
	stop()
	unavailable.Store(false)
	restarted, err := New(Config{Store: store, Resolver: resolver})
	require.NoError(t, err)
	duplicate, err := restarted.Signal(context.Background(), request)
	require.NoError(t, err)
	require.Equal(t, receipt.OperationID, duplicate.OperationID)
	startTestWorker(t, restarted, "after-restart")
	waitOperation(t, store, request.Scope, receipt.OperationID, func(op jobs.Operation) bool { return op.State == jobs.StateCompleted })
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	require.Len(t, runtime.signals, 1)
	require.Equal(t, receipt.OperationID, runtime.signals[0].ApplicationRequestID)
	require.Equal(t, "run-1", runtime.signals[0].RunID)
	require.Empty(t, runtime.launches, "wake must not launch another run")
}

func TestTodoWakeExpiredReplayNeverStartsOrConsumes(t *testing.T) {
	store, pool := newFlowDispatchStore(t)
	var starts atomic.Int32
	service, err := New(Config{Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		starts.Add(1)
		t.Error("expired wake reached resolver")
		return nil, nil
	})})
	require.NoError(t, err)
	request := SignalRequest{Scope: jobs.Scope{TenantID: "repository:5", PrincipalID: "user:9"}, RequestID: "expired-steer", Target: flowruntime.Target{BindingKind: "workspace", BindingID: "waiting", WorkspaceID: "waiting"}, FlowID: "todo", RunID: "same-run", Name: "steer", Payload: json.RawMessage(`{"text":"Keep notes.txt"}`)}
	receipt, err := service.Signal(context.Background(), request)
	require.NoError(t, err)
	operation, err := store.Get(context.Background(), request.Scope, receipt.OperationID)
	require.NoError(t, err)
	var payload signalPayload
	require.NoError(t, json.Unmarshal(operation.Payload, &payload))
	checkpoint := RuntimeCheckpoint{Version: 1, Target: payload.Target, FlowID: "todo", RunID: "same-run", WakeStartedAt: time.Now().Add(-16 * time.Minute).UnixMilli()}
	_, err = pool.Exec(context.Background(), `UPDATE product_job_dispatches SET external_receipt=$2 WHERE operation_id=$1`, receipt.OperationID, mustJSON(checkpoint))
	require.NoError(t, err)
	startTestWorker(t, service, "expired-restart")
	failed := waitOperation(t, store, request.Scope, receipt.OperationID, func(op jobs.Operation) bool { return op.State == jobs.StateFailed })
	final, err := decodeCheckpoint(failed.ExternalReceipt)
	require.NoError(t, err)
	var terminal terminalReceipt
	require.NoError(t, json.Unmarshal(failed.TerminalReceipt, &terminal))
	require.Equal(t, "wake", terminal.ErrorStep)
	require.Equal(t, "wake_timeout", terminal.ErrorCode)
	require.Equal(t, checkpoint.WakeStartedAt, final.WakeStartedAt)
	require.Zero(t, starts.Load())
}
