package flowdispatch

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// Only the remote host is substituted. Admission, leases, cursor persistence,
// retry and settlement use the real dispatcher and PostgreSQL job store.
type terminalPagesRuntime struct {
	*recordingRuntime
	terminalLaunch  bool
	finalStatus     string
	failedRead      bool
	failRead        bool
	cursors         []string
	pauseAfterFirst chan struct{}
	paused          bool
}

func (r *terminalPagesRuntime) Launch(ctx context.Context, input flowruntime.Launch) (flowruntime.LaunchResult, error) {
	result, err := r.recordingRuntime.Launch(ctx, input)
	if r.terminalLaunch {
		result.Receipt.Tag = "Terminal"
		result.Receipt.Status = r.finalStatus
	}
	return result, err
}
func (r *terminalPagesRuntime) Observe(ctx context.Context, runID, cursor string, _ int) (flowruntime.Observation, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cursors = append(r.cursors, cursor)
	sequence := 0
	if cursor != "" {
		value, err := strconv.Atoi(cursor)
		if err != nil {
			return flowruntime.Observation{}, err
		}
		sequence = value + 1
	}
	if sequence > 2 {
		return flowruntime.Observation{}, errors.New("read past terminal journal tail")
	}
	if sequence == 1 && r.pauseAfterFirst != nil && !r.paused {
		r.paused = true
		close(r.pauseAfterFirst)
		<-ctx.Done()
		return flowruntime.Observation{}, ctx.Err()
	}
	if r.failRead && sequence == 1 && !r.failedRead {
		r.failedRead = true
		return flowruntime.Observation{}, &testRuntimeFailure{code: "transport", retryable: true}
	}
	output := `{"answer":"retained"}`
	return flowruntime.Observation{
		Run:        flowruntime.Run{RunID: runID, FlowID: "coding/dispatch", Status: r.finalStatus, FinalOutput: &output},
		Events:     []flowruntime.Event{{Sequence: int64(sequence), RunID: runID, Kind: "retained.receipt", Payload: json.RawMessage(`{"evidence":true}`)}},
		NextCursor: strconv.Itoa(sequence), HasMore: sequence < 2, Terminal: true,
	}, nil
}

func TestTerminalObservationSurvivesWorkerReplacement(t *testing.T) {
	store, _ := newFlowDispatchStore(t)
	runtime := &terminalPagesRuntime{recordingRuntime: newRecordingRuntime(), finalStatus: "completed", pauseAfterFirst: make(chan struct{})}
	projector := &terminalPagesProjector{seen: map[int64]int{}}
	service, err := New(Config{Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) { return runtime, nil }), Projector: projector, ObservationPages: 1, ObservationDelay: time.Millisecond})
	require.NoError(t, err)
	request := testLaunchRequest("terminal-replacement", ApprovalAuto)
	receipt, err := service.Admit(t.Context(), request)
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- service.RunWorker(ctx, jobs.WorkerConfig{WorkerID: "old-terminal-owner", Capacity: 1, Lease: time.Second, PollInterval: time.Millisecond, RetryDelay: time.Millisecond})
	}()
	select {
	case <-runtime.pauseAfterFirst:
	case <-time.After(5 * time.Second):
		t.Fatal("worker never reached the second terminal page")
	}
	op, err := store.Get(t.Context(), request.Scope, receipt.OperationID)
	require.NoError(t, err)
	require.False(t, op.State.Terminal())
	checkpoint, err := decodeCheckpoint(op.ExternalReceipt)
	require.NoError(t, err)
	require.Equal(t, "0", checkpoint.Cursor)
	cancel()
	select {
	case err := <-done:
		require.NoError(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("old worker did not stop")
	}
	startTestWorker(t, service, "new-terminal-owner")
	op = waitOperation(t, store, request.Scope, receipt.OperationID, func(op jobs.Operation) bool { return op.State.Terminal() })
	require.Equal(t, jobs.StateCompleted, op.State)
	projector.mu.Lock()
	defer projector.mu.Unlock()
	require.Equal(t, map[int64]int{0: 1, 1: 1, 2: 1}, projector.seen)
	require.False(t, projector.earlySettlement)
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	require.Equal(t, []string{"", "0", "0", "1"}, runtime.cursors)
	require.Len(t, runtime.launches, 1)
}

type terminalPagesProjector struct {
	mu              sync.Mutex
	seen            map[int64]int
	failWrite       bool
	failed          bool
	earlySettlement bool
}

func (p *terminalPagesProjector) ProjectFlowRuntime(_ context.Context, update ProjectionUpdate) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, event := range update.Events {
		p.seen[event.Sequence]++
		// Model a sink write whose acknowledgement was lost: the dispatcher must
		// replay this page, while a consumer deduplicates its stable event identity.
		if p.failWrite && event.Sequence == 1 && !p.failed {
			p.failed = true
			return errors.New("lost projection acknowledgement")
		}
	}
	if update.State.Terminal() && (p.seen[0] == 0 || p.seen[1] == 0 || p.seen[2] == 0) {
		p.earlySettlement = true
	}
	return nil
}

func TestTerminalObservationDrainsEveryPageBeforeSettlement(t *testing.T) {
	for _, status := range []string{"completed", "failed", "cancelled"} {
		for _, terminalLaunch := range []bool{false, true} {
			for _, pages := range []int{1, 4} {
				t.Run(status+"/terminal-launch="+strconv.FormatBool(terminalLaunch)+"/page-budget="+strconv.Itoa(pages), func(t *testing.T) {
					store, _ := newFlowDispatchStore(t)
					runtime := &terminalPagesRuntime{recordingRuntime: newRecordingRuntime(), finalStatus: status, terminalLaunch: terminalLaunch}
					projector := &terminalPagesProjector{seen: map[int64]int{}}
					service, err := New(Config{Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) { return runtime, nil }), Projector: projector, ObservationPages: pages, ObservationDelay: time.Millisecond})
					require.NoError(t, err)
					request := testLaunchRequest("terminal-pages", ApprovalAuto)
					receipt, err := service.Admit(t.Context(), request)
					require.NoError(t, err)
					startTestWorker(t, service, "terminal-pages-owner")
					op := waitOperation(t, store, request.Scope, receipt.OperationID, func(op jobs.Operation) bool { return op.State.Terminal() })
					require.Equal(t, map[string]jobs.State{"completed": jobs.StateCompleted, "failed": jobs.StateFailed, "cancelled": jobs.StateCancelled}[status], op.State)
					projector.mu.Lock()
					seen, early := projector.seen, projector.earlySettlement
					projector.mu.Unlock()
					require.False(t, early, "product settlement discarded unread terminal evidence")
					require.Equal(t, map[int64]int{0: 1, 1: 1, 2: 1}, seen)
					var saved terminalReceipt
					require.NoError(t, json.Unmarshal(op.TerminalReceipt, &saved))
					require.Equal(t, "2", saved.Cursor)
					require.NotNil(t, saved.Run.FinalOutput)
					require.JSONEq(t, `{"answer":"retained"}`, *saved.Run.FinalOutput)
					runtime.mu.Lock()
					defer runtime.mu.Unlock()
					require.Equal(t, []string{"", "0", "1"}, runtime.cursors)
					require.Len(t, runtime.launches, 1)
				})
			}
		}
	}
}

func TestTerminalObservationRetriesUndeliveredPages(t *testing.T) {
	for _, failure := range []string{"read", "projection"} {
		t.Run(failure, func(t *testing.T) {
			store, _ := newFlowDispatchStore(t)
			runtime := &terminalPagesRuntime{recordingRuntime: newRecordingRuntime(), finalStatus: "failed", failRead: failure == "read"}
			projector := &terminalPagesProjector{seen: map[int64]int{}, failWrite: failure == "projection"}
			service, err := New(Config{Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) { return runtime, nil }), Projector: projector, ObservationPages: 1, ObservationDelay: time.Millisecond})
			require.NoError(t, err)
			request := testLaunchRequest("terminal-retry", ApprovalAuto)
			receipt, err := service.Admit(t.Context(), request)
			require.NoError(t, err)
			startTestWorker(t, service, "terminal-retry-owner")
			op := waitOperation(t, store, request.Scope, receipt.OperationID, func(op jobs.Operation) bool { return op.State.Terminal() })
			require.Equal(t, jobs.StateFailed, op.State)
			projector.mu.Lock()
			defer projector.mu.Unlock()
			require.False(t, projector.earlySettlement)
			require.Equal(t, 1, projector.seen[0])
			require.Equal(t, 1, projector.seen[2])
			require.Equal(t, map[string]int{"read": 1, "projection": 2}[failure], projector.seen[1])
			runtime.mu.Lock()
			defer runtime.mu.Unlock()
			require.Equal(t, []string{"", "0", "0", "1"}, runtime.cursors)
			require.Len(t, runtime.launches, 1)
		})
	}
}
