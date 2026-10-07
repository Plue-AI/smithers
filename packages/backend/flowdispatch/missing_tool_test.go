package flowdispatch

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

type certifiedFailureProjector struct {
	recordingProjector
	certificationMu sync.Mutex
	tool            *CertifiedMissingTool
	calls           int
	failOnce        bool
}

func (p *certifiedFailureProjector) CertifyFlowFailure(_ context.Context, update ProjectionUpdate) (*CertifiedMissingTool, error) {
	p.certificationMu.Lock()
	defer p.certificationMu.Unlock()
	p.calls++
	if p.failOnce {
		p.failOnce = false
		return nil, errors.New("receipt store unavailable")
	}
	return p.tool, nil
}

type failedCommandRuntime struct{ *recordingRuntime }

func (r *failedCommandRuntime) Observe(ctx context.Context, id, cursor string, limit int) (flowruntime.Observation, error) {
	observed, err := r.recordingRuntime.Observe(ctx, id, cursor, limit)
	observed.Run.Status = "failed"
	observed.Run.FailureFault = "factory"
	observed.Run.FailureTag = "coding/Error/fast_gate"
	observed.Terminal = true
	return observed, err
}

func TestTerminalMissingToolCertification(t *testing.T) {
	for _, name := range []string{"certified", "no certified exit", "receipt store recovery", "completed"} {
		t.Run(name, func(t *testing.T) {
			store, _ := newFlowDispatchStore(t)
			projector := &certifiedFailureProjector{}
			if name != "no certified exit" {
				projector.tool = &CertifiedMissingTool{Name: "figlet", File: ".smithers/machine.json", OperationID: "command-receipt"}
			}
			projector.failOnce = name == "receipt store recovery"
			var runtime flowruntime.Runtime = &failedCommandRuntime{newRecordingRuntime()}
			if name == "completed" {
				runtime = newRecordingRuntime()
			}
			service, err := New(Config{Store: store, Projector: projector, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) { return runtime, nil })})
			require.NoError(t, err)
			request := testLaunchRequest("certification", ApprovalAuto)
			receipt, err := service.Admit(t.Context(), request)
			require.NoError(t, err)
			startTestWorker(t, service, "certification-worker")
			operation := waitOperation(t, store, request.Scope, receipt.OperationID, func(op jobs.Operation) bool { return op.State.Terminal() })
			var terminal terminalReceipt
			require.NoError(t, json.Unmarshal(operation.TerminalReceipt, &terminal))
			if name == "completed" {
				require.Equal(t, jobs.StateCompleted, operation.State)
				require.Nil(t, terminal.MissingTool)
			} else {
				require.Equal(t, jobs.StateFailed, operation.State)
				require.Equal(t, projector.tool, terminal.MissingTool)
				projector.mu.Lock()
				require.NotEmpty(t, projector.updates)
				require.Equal(t, projector.tool, projector.updates[len(projector.updates)-1].Checkpoint.FailureMissingTool)
				projector.mu.Unlock()
			}
			projector.certificationMu.Lock()
			defer projector.certificationMu.Unlock()
			switch name {
			case "completed":
				require.Zero(t, projector.calls)
			case "receipt store recovery":
				require.GreaterOrEqual(t, projector.calls, 2)
			default:
				require.Equal(t, 1, projector.calls)
			}
		})
	}
}
