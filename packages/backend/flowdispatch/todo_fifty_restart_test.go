package flowdispatch

import (
	"context"
	"encoding/json"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// A PostgreSQL delivery qualification, with a test-only guest protocol peer.
// This does not qualify the built-in engine's held waits or real-machine times.
func TestTodoFiftyPendingSignalsRestoreAfterDispatcherRestart(t *testing.T) {
	store, _ := newFlowDispatchStore(t)
	runtime := newRecordingRuntime()
	runtime.status = "waiting"
	var granted atomic.Bool
	resolver := flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		if !granted.Load() {
			return nil, &testRuntimeFailure{code: "runtime_host_not_running"}
		}
		return todoWakeRuntime{runtime}, nil
	})
	before, err := New(Config{Store: store, Resolver: resolver})
	require.NoError(t, err)
	scope := jobs.Scope{TenantID: "repository:5", PrincipalID: "user:9"}
	requests := make([]SignalRequest, 50)
	receipts := make([]jobs.RequestReceipt, 50)
	for i := range requests {
		requests[i] = SignalRequest{Scope: scope, RequestID: fmt.Sprintf("held-steer-%02d", i), Target: flowruntime.Target{BindingKind: "workspace", BindingID: fmt.Sprintf("workspace-%02d", i), WorkspaceID: fmt.Sprintf("workspace-%02d", i)}, FlowID: "todo", RunID: fmt.Sprintf("held-run-%02d", i), Name: "steer", Payload: json.RawMessage(`{"text":"Keep notes.txt"}`)}
		receipts[i], err = before.Signal(context.Background(), requests[i])
		require.NoError(t, err)
	}
	stop := startTestWorker(t, before, "fifty-before")
	for i := range receipts {
		waitOperation(t, store, scope, receipts[i].OperationID, func(op jobs.Operation) bool {
			c, err := decodeCheckpoint(op.ExternalReceipt)
			return err == nil && op.State == jobs.StateWaiting && c.FailureStep == "wake" && c.WakeStartedAt > 0
		})
	}
	stop()
	runtime.mu.Lock()
	require.Empty(t, runtime.signals)
	runtime.mu.Unlock()
	ready := time.Now()
	after, err := New(Config{Store: store, Resolver: resolver})
	require.NoError(t, err)
	for i := range requests {
		duplicate, err := after.Signal(context.Background(), requests[i])
		require.NoError(t, err)
		require.Equal(t, receipts[i].OperationID, duplicate.OperationID)
	}
	restored := time.Since(ready)
	granted.Store(true)
	grant := time.Now()
	startTestWorker(t, after, "fifty-after")
	for i := range receipts {
		waitOperation(t, store, scope, receipts[i].OperationID, func(op jobs.Operation) bool { return op.State == jobs.StateCompleted })
	}
	delivered := time.Since(grant)
	require.Less(t, restored, 60*time.Second)
	require.Less(t, delivered, 60*time.Second)
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	require.Len(t, runtime.signals, 50)
	require.Empty(t, runtime.launches, "restart must never launch replacement runs")
	seen := map[string]string{}
	for _, signal := range runtime.signals {
		require.NotContains(t, seen, signal.ApplicationRequestID)
		seen[signal.ApplicationRequestID] = signal.RunID
	}
	for i := range receipts {
		require.Equal(t, requests[i].RunID, seen[receipts[i].OperationID])
	}
	t.Logf("restored_pending=50 readiness_to_replay=%s grant_to_all_delivered=%s; protocol fixture, no guest wake timing", restored, delivered)
}
