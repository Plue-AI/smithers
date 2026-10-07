package flowdispatch

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

func TestInterruptedRuntimeSettlesInsteadOfPollingForever(t *testing.T) {
	for _, status := range []string{"interrupted", "uncertain"} {
		t.Run(status, func(t *testing.T) {
			store, _ := newFlowDispatchStore(t)
			runtime := newRecordingRuntime()
			runtime.status = status
			projector := &recordingProjector{}
			service, err := New(Config{Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) { return runtime, nil }), Projector: projector, ObservationDelay: time.Millisecond})
			require.NoError(t, err)
			startTestWorker(t, service, "interrupted-worker")
			request := testLaunchRequest("interrupted", ApprovalAuto)
			receipt, err := service.Admit(context.Background(), request)
			require.NoError(t, err)
			operation := waitOperation(t, store, request.Scope, receipt.OperationID, func(op jobs.Operation) bool { return op.State == jobs.StateFailed })
			var saved struct {
				Run struct {
					Status string `json:"status"`
				} `json:"run"`
			}
			require.NoError(t, json.Unmarshal(operation.TerminalReceipt, &saved))
			require.Equal(t, status, saved.Run.Status)
			projector.mu.Lock()
			defer projector.mu.Unlock()
			last := projector.updates[len(projector.updates)-1]
			require.Equal(t, jobs.StateFailed, last.State)
			require.Equal(t, status, last.Checkpoint.Run.Status)
		})
	}
}
