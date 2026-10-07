package flowdispatch

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

func cursorEvent(sequence int64, offsets ...int64) flowruntime.Event {
	cursor := &flowruntime.EventCursor{Sequence: sequence}
	if len(offsets) != 0 {
		cursor.Offset = &offsets[0]
	}
	return flowruntime.Event{Sequence: sequence, Cursor: cursor}
}

func TestObservationCursorPreservesExpansionProgress(t *testing.T) {
	cases := []struct {
		name, before, next string
		events             []flowruntime.Event
		hasMore            bool
	}{
		{name: "empty beginning"},
		{name: "first partial event", next: "v1:0:0", events: []flowruntime.Event{cursorEvent(0, 0)}, hasMore: true},
		{name: "next partial event", before: "v1:0:0", next: "v1:0:1", events: []flowruntime.Event{cursorEvent(0, 1)}, hasMore: true},
		{name: "final expansion member", before: "v1:0:1", next: "0", events: []flowruntime.Event{cursorEvent(0)}},
		{name: "all expanded members", next: "0", events: []flowruntime.Event{cursorEvent(0, 0), cursorEvent(0, 1), cursorEvent(0)}},
		{name: "legacy checkpoint", before: "0", next: "1", events: []flowruntime.Event{{Sequence: 1}}},
		{name: "expanded after legacy checkpoint", before: "0", next: "1", events: []flowruntime.Event{cursorEvent(1, 0), cursorEvent(1)}},
		{name: "empty partial page", before: "v1:1:0", next: "v1:1:0"},
		{name: "empty legacy page", before: "1", next: "1"},
		{name: "highest safe journal integer", next: "9007199254740990", events: []flowruntime.Event{cursorEvent(9007199254740990)}},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			require.True(t, validObservationPage(item.before, flowruntime.Observation{
				Events: item.events, NextCursor: item.next, HasMore: item.hasMore,
			}))
		})
	}
}

func TestObservationCursorRejectsInvalidProgress(t *testing.T) {
	cases := []struct {
		name, before, next string
		events             []flowruntime.Event
		hasMore            bool
	}{
		{name: "duplicate partial", before: "v1:0:0", next: "v1:0:0", events: []flowruntime.Event{cursorEvent(0, 0)}},
		{name: "regressing offset", before: "v1:0:1", next: "0", events: []flowruntime.Event{cursorEvent(0, 0)}},
		{name: "partial after complete", before: "0", next: "v1:0:0", events: []flowruntime.Event{cursorEvent(0, 0)}},
		{name: "duplicate final", next: "0", events: []flowruntime.Event{cursorEvent(0), cursorEvent(0)}},
		{name: "complete then partial", next: "0", events: []flowruntime.Event{cursorEvent(0), cursorEvent(0, 0)}},
		{name: "skipped final expansion", next: "0", events: []flowruntime.Event{cursorEvent(0, 0)}},
		{name: "unobserved progress", next: "1"},
		{name: "empty page claims more", hasMore: true},
		{name: "partial page without progress", before: "v1:0:0", next: "v1:0:0", hasMore: true},
		{name: "negative sequence", next: "0", events: []flowruntime.Event{cursorEvent(-1)}},
		{name: "negative offset", next: "0", events: []flowruntime.Event{cursorEvent(0, -1)}},
		{name: "unsafe sequence", next: "9007199254740991", events: []flowruntime.Event{cursorEvent(9007199254740991)}},
		{name: "unsafe offset", next: "0", events: []flowruntime.Event{cursorEvent(0, 9007199254740991)}},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			require.False(t, validObservationPage(item.before, flowruntime.Observation{
				Events: item.events, NextCursor: item.next, HasMore: item.hasMore,
			}))
		})
	}
	for _, invalid := range []string{"-1", "+0", "00", " 0", "0 ", "1.0", "9007199254740991", "9223372036854775808", "v2:0:0", "v1:0", "v1:0:0:0", "v1:00:0", "v1:0:+0", "v1:0:-1", "v1:0:9007199254740991"} {
		t.Run("invalid cursor "+invalid, func(t *testing.T) {
			require.False(t, validObservationPage(invalid, flowruntime.Observation{NextCursor: invalid}))
		})
	}
}

type observationFixturePage struct {
	AfterCursor string              `json:"afterCursor"`
	Events      []flowruntime.Event `json:"events"`
	NextCursor  string              `json:"nextCursor"`
	HasMore     bool                `json:"hasMore"`
}

func sharedCursorPages(t *testing.T) []observationFixturePage {
	t.Helper()
	data, err := os.ReadFile("../../smithers/gateway/testdata/runtime-bridge-v1.json")
	require.NoError(t, err)
	var fixture struct {
		CursorPages []observationFixturePage `json:"cursorPages"`
	}
	require.NoError(t, json.Unmarshal(data, &fixture))
	require.Len(t, fixture.CursorPages, 6)
	return fixture.CursorPages
}

func TestObservationCursorsAcceptSharedGatewayWirePages(t *testing.T) {
	for i, page := range sharedCursorPages(t) {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			require.True(t, validObservationPage(page.AfterCursor, flowruntime.Observation{
				Events: page.Events, NextCursor: page.NextCursor, HasMore: page.HasMore,
			}))
		})
	}
}

type pagedObservationRuntime struct {
	*recordingRuntime
	pages   []observationFixturePage
	cursors []string
}

func (runtime *pagedObservationRuntime) Observe(_ context.Context, runID, cursor string, _ int) (flowruntime.Observation, error) {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	index := len(runtime.cursors)
	if index >= len(runtime.pages) || runtime.pages[index].AfterCursor != cursor {
		return flowruntime.Observation{}, &testRuntimeFailure{code: "unexpected_observation_cursor"}
	}
	runtime.cursors = append(runtime.cursors, cursor)
	page := runtime.pages[index]
	status := "running"
	if index == len(runtime.pages)-1 {
		status = "completed"
	}
	return flowruntime.Observation{
		Run:    flowruntime.Run{RunID: runID, FlowID: "coding/dispatch", Status: status},
		Events: page.Events, NextCursor: page.NextCursor, HasMore: page.HasMore, Terminal: terminalStatus(status),
	}, nil
}

func TestWorkerReconnectsFromPersistedPartialObservationCursor(t *testing.T) {
	store, _ := newFlowDispatchStore(t)
	runtime := &pagedObservationRuntime{recordingRuntime: newRecordingRuntime(), pages: sharedCursorPages(t)}
	projector := &recordingProjector{}
	service, err := New(Config{
		Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
			return runtime, nil
		}), Projector: projector, ObservationDelay: time.Millisecond, ObservationPages: 1,
	})
	require.NoError(t, err)
	request := testLaunchRequest("expanded-journal", ApprovalManual)
	receipt, err := service.Admit(context.Background(), request)
	require.NoError(t, err)
	startTestWorker(t, service, "expanded-journal-owner")
	operation := waitOperation(t, store, request.Scope, receipt.OperationID, func(operation jobs.Operation) bool {
		return operation.State.Terminal()
	})
	require.Equal(t, jobs.StateCompleted, operation.State, string(operation.TerminalReceipt))
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	require.Equal(t, []string{"", "", "v1:0:0", "v1:0:1", "0", "1"}, runtime.cursors)
	require.Len(t, runtime.launches, 1, "observation retries must not relaunch the run")
	checkpoint, err := decodeCheckpoint(operation.ExternalReceipt)
	require.NoError(t, err)
	require.Equal(t, "1", checkpoint.Cursor)
}

type signalReceiptRuntime struct {
	*recordingRuntime
	lostAck  bool
	terminal bool
}

func (runtime *signalReceiptRuntime) Signal(_ context.Context, input flowruntime.Signal) (flowruntime.MutationResult, error) {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	runtime.signals = append(runtime.signals, input)
	if runtime.terminal {
		return flowruntime.MutationResult{Operation: "signal", ApplicationRequestID: input.ApplicationRequestID,
			Receipt: flowruntime.Receipt{Tag: "Terminal", RunID: input.RunID, Status: "completed"}}, nil
	}
	runtime.status = "completed"
	if runtime.lostAck && len(runtime.signals) == 1 {
		return flowruntime.MutationResult{}, &testRuntimeFailure{code: "transport", retryable: true}
	}
	return flowruntime.MutationResult{Operation: "signal", ApplicationRequestID: input.ApplicationRequestID,
		Receipt: flowruntime.Receipt{Tag: "AlreadyApplied", ReceiptID: input.ApplicationRequestID, RunID: input.RunID}}, nil
}

func TestSignalReconcilesCanonicalReceiptAfterRunCompletes(t *testing.T) {
	for _, terminal := range []bool{false, true} {
		name := "lost acknowledgement"
		if terminal {
			name = "terminal refusal"
		}
		t.Run(name, func(t *testing.T) {
			store, _ := newFlowDispatchStore(t)
			runtime := &signalReceiptRuntime{recordingRuntime: newRecordingRuntime(), lostAck: !terminal, terminal: terminal}
			runtime.status = "waiting"
			projector := &recordingProjector{}
			service, err := New(Config{
				Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
					return runtime, nil
				}), Projector: projector, ObservationDelay: time.Millisecond,
			})
			require.NoError(t, err)
			launch := testLaunchRequest("signal-receipt", ApprovalManual)
			receipt, err := service.Signal(context.Background(), SignalRequest{
				Scope: launch.Scope, RequestID: launch.RequestID, Target: launch.Target,
				FlowID: launch.FlowID, RunID: "run-1", Name: "reply", Payload: []byte(`{}`),
				AuthorizationContext: launch.AuthorizationContext, Projection: launch.Projection,
			})
			require.NoError(t, err)
			startTestWorker(t, service, "signal-receipt-owner")
			operation := waitOperation(t, store, launch.Scope, receipt.OperationID, func(operation jobs.Operation) bool {
				return operation.State.Terminal()
			})
			if terminal {
				require.Equal(t, jobs.StateFailed, operation.State, "a Terminal signal receipt means no signal was delivered")
				require.Contains(t, string(operation.TerminalReceipt), "runtime_run_terminal")
			} else {
				require.Equal(t, jobs.StateCompleted, operation.State, "replay the delivered signal before treating the run as unavailable")
				runtime.mu.Lock()
				calls := append([]flowruntime.Signal(nil), runtime.signals...)
				runtime.mu.Unlock()
				require.Len(t, calls, 2)
				require.Equal(t, calls[0].ApplicationRequestID, calls[1].ApplicationRequestID)
			}
			projector.mu.Lock()
			defer projector.mu.Unlock()
			require.NotEmpty(t, projector.updates)
			require.Equal(t, operation.State, projector.updates[len(projector.updates)-1].State)
		})
	}
}

type approvalReceiptRuntime struct {
	*recordingRuntime
	store             *jobs.Store
	scope             jobs.Scope
	launchOperationID string
	approvals         atomic.Int32
}

func (runtime *approvalReceiptRuntime) Approve(ctx context.Context, input flowruntime.Decision) (flowruntime.MutationResult, error) {
	result, err := runtime.recordingRuntime.Approve(ctx, input)
	if err != nil || runtime.approvals.Add(1) > 1 {
		result.Receipt.Tag = "AlreadyApplied"
		return result, err
	}
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for {
		operation, err := runtime.store.Get(ctx, runtime.scope, runtime.launchOperationID)
		if err != nil {
			return flowruntime.MutationResult{}, err
		}
		if operation.State.Terminal() {
			return flowruntime.MutationResult{}, &testRuntimeFailure{code: "transport", retryable: true}
		}
		select {
		case <-ctx.Done():
			return flowruntime.MutationResult{}, ctx.Err()
		case <-ticker.C:
		}
	}
}

func TestApprovalReconcilesLostAcknowledgementAfterLaunchCompletes(t *testing.T) {
	store, _ := newFlowDispatchStore(t)
	runtime := &approvalReceiptRuntime{recordingRuntime: newRecordingRuntime(), store: store}
	runtime.requireApproval = true
	service, err := New(Config{
		Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
			return runtime, nil
		}), ObservationDelay: time.Millisecond,
	})
	require.NoError(t, err)
	request := testLaunchRequest("approval-lost-ack", ApprovalManual)
	launch, err := service.Admit(context.Background(), request)
	require.NoError(t, err)
	runtime.scope, runtime.launchOperationID = request.Scope, launch.OperationID
	startTestWorker(t, service, "approval-replay-owner")
	waitOperation(t, store, request.Scope, launch.OperationID, func(operation jobs.Operation) bool {
		checkpoint, err := decodeCheckpoint(operation.ExternalReceipt)
		return err == nil && checkpoint.PlanID != "" && len(checkpoint.Approval) != 0
	})
	approval, err := service.Approve(context.Background(), request.Scope, launch.OperationID, "approval-replay", request.AuthorizationContext)
	require.NoError(t, err)
	operation := waitOperation(t, store, request.Scope, approval.OperationID, func(operation jobs.Operation) bool {
		return operation.State.Terminal()
	})
	require.Equal(t, jobs.StateCompleted, operation.State, "a settled launch must not hide the successful approval receipt")
	require.Equal(t, int32(2), runtime.approvals.Load())
	require.Contains(t, string(operation.TerminalReceipt), "AlreadyApplied")
}

func TestResolverPreservesFailureClassification(t *testing.T) {
	for _, item := range []struct {
		name      string
		err       error
		code      string
		retryable bool
	}{
		{name: "permanent identity refusal", err: &testRuntimeFailure{code: "runtime_identity_conflict"}, code: "runtime_identity_conflict"},
		{name: "temporary typed failure", err: fmt.Errorf("wrapped: %w", &testRuntimeFailure{code: "runtime_start_failed", retryable: true}), code: "runtime_start_failed", retryable: true},
		{name: "unknown transport", err: errors.New("unavailable"), code: "runtime_unavailable", retryable: true},
		{name: "nil runtime", code: "runtime_unavailable", retryable: true},
	} {
		t.Run(item.name, func(t *testing.T) {
			service := &Service{
				resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
					return nil, item.err
				}), runtimeCallTimeout: time.Second,
			}
			_, _, err := service.resolve(context.Background(), flowruntime.Target{}, flowruntime.Identity{})
			require.Error(t, err)
			code, retryable := runtimeFailure(err)
			require.Equal(t, item.code, code)
			require.Equal(t, item.retryable, retryable)
		})
	}
}

// A host upgrade waits for runs pinned to the old host (plue#538), so the
// resolver answers a pinned run with another artifact only when the old host
// was already gone. That run must fail terminal, never re-poll.
func TestResolveFailsRunPinnedToSupersededHostIdentity(t *testing.T) {
	upgraded := newRecordingRuntime()
	upgraded.identity.RuntimeArtifactDigest = strings.Repeat("c", 64)
	upgraded.identity.OwnerGeneration = 2
	service := &Service{
		resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
			return upgraded, nil
		}), runtimeCallTimeout: time.Second,
	}
	pinned := newRecordingRuntime().identity
	_, _, err := service.resolve(context.Background(), flowruntime.Target{}, pinned)
	require.Error(t, err)
	code, retryable := runtimeFailure(err)
	require.Equal(t, "runtime_identity_changed", code)
	require.False(t, retryable)

	current := upgraded.identity
	current.OwnerGeneration = 1
	_, identity, err := service.resolve(context.Background(), flowruntime.Target{}, current)
	require.NoError(t, err, "an owner-generation change alone is reconnectable")
	require.Equal(t, upgraded.identity, identity)
}

func TestCancellationBeforeDispatchRetriesProjectionInWorker(t *testing.T) {
	store, _ := newFlowDispatchStore(t)
	var projections atomic.Int32
	var resolutions atomic.Int32
	service, err := New(Config{
		Store: store,
		Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
			resolutions.Add(1)
			return nil, errors.New("cancelled launch must not resolve a runtime")
		}),
		Projector: ProjectorFunc(func(_ context.Context, update ProjectionUpdate) error {
			if update.State != jobs.StateCancelled {
				return fmt.Errorf("unexpected projection state %s", update.State)
			}
			if projections.Add(1) == 1 {
				return errors.New("transient projection failure")
			}
			return nil
		}),
	})
	require.NoError(t, err)
	request := testLaunchRequest("cancel-unstarted-projection", ApprovalManual)
	receipt, err := service.Admit(context.Background(), request)
	require.NoError(t, err)
	pending, err := service.CancelRequest(context.Background(), request.Scope, request.RequestID)
	require.NoError(t, err, "cancellation admission must not perform product projection")
	require.True(t, pending.CancellationRequested)
	require.False(t, pending.State.Terminal(), "the worker must settle only after projection succeeds")
	require.Zero(t, projections.Load())
	startTestWorker(t, service, "cancellation-projection-owner")
	operation := waitOperation(t, store, request.Scope, receipt.OperationID, func(operation jobs.Operation) bool {
		return operation.State == jobs.StateCancelled
	})
	require.GreaterOrEqual(t, projections.Load(), int32(2))
	require.Zero(t, resolutions.Load())
	require.Contains(t, string(operation.TerminalReceipt), "cancelled-before-runtime-launch")
}

func TestCancellationBeforeDispatchSurvivesExpiredClaim(t *testing.T) {
	store, pool := newFlowDispatchStore(t)
	var projections atomic.Int32
	var resolutions atomic.Int32
	service, err := New(Config{
		Store: store,
		Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
			resolutions.Add(1)
			return nil, errors.New("cancelled launch must not resolve a runtime")
		}),
		Projector: ProjectorFunc(func(_ context.Context, update ProjectionUpdate) error {
			if update.State == jobs.StateCancelled {
				projections.Add(1)
			}
			return nil
		}),
	})
	require.NoError(t, err)
	request := testLaunchRequest("cancel-unstarted-expired-claim", ApprovalManual)
	receipt, err := service.Admit(context.Background(), request)
	require.NoError(t, err)
	claim, err := store.Claim(context.Background(), "crashed-cancellation-owner", time.Minute)
	require.NoError(t, err)
	require.Equal(t, receipt.OperationID, claim.OperationID)
	_, err = service.CancelRequest(context.Background(), request.Scope, request.RequestID)
	require.NoError(t, err)
	_, err = pool.Exec(context.Background(), `UPDATE product_job_dispatches
		SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1`, receipt.OperationID)
	require.NoError(t, err)
	recovered, err := store.RecoverExpiredForOperations(context.Background(), []string{OperationLaunch}, 10)
	require.NoError(t, err)
	require.Equal(t, 1, recovered)
	pending, err := store.Get(context.Background(), request.Scope, receipt.OperationID)
	require.NoError(t, err)
	require.False(t, pending.State.Terminal(), "expired recovery must preserve the pending projection")
	startTestWorker(t, service, "replacement-cancellation-owner")
	operation := waitOperation(t, store, request.Scope, receipt.OperationID, func(operation jobs.Operation) bool {
		return operation.State == jobs.StateCancelled
	})
	require.Equal(t, int32(1), projections.Load())
	require.Zero(t, resolutions.Load())
	require.Contains(t, string(operation.TerminalReceipt), "cancelled-before-runtime-launch")
}

func TestCancellationRejectsNonLaunchOperations(t *testing.T) {
	for _, operation := range []string{OperationApprove, OperationSignal, OperationSteer} {
		t.Run(operation, func(t *testing.T) {
			store, _ := newFlowDispatchStore(t)
			service, err := New(Config{
				Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
					return nil, errors.New("unused")
				}),
			})
			require.NoError(t, err)
			scope := jobs.Scope{TenantID: "tenant", PrincipalID: "owner"}
			receipt, err := store.Admit(context.Background(), jobs.Admission{
				Scope: scope, Operation: operation, RequestID: "non-launch",
				Payload: []byte(`{}`), AuthorizationContext: []byte(`{}`), EffectPolicy: jobs.EffectReconcile,
			})
			require.NoError(t, err)
			_, err = service.Cancel(context.Background(), scope, receipt.OperationID)
			require.ErrorIs(t, err, ErrNotLaunchOperation)
			pending, err := store.Get(context.Background(), scope, receipt.OperationID)
			require.NoError(t, err)
			require.Equal(t, jobs.StateAccepted, pending.State)
			require.False(t, pending.CancellationRequested)
		})
	}
}

// journalRuntime serves a fixed journal by cursor, any number of times.
type journalRuntime struct {
	*recordingRuntime
	pages map[string]flowruntime.Observation
}

func (runtime *journalRuntime) Observe(_ context.Context, runID, cursor string, _ int) (flowruntime.Observation, error) {
	page, ok := runtime.pages[cursor]
	if !ok {
		return flowruntime.Observation{}, &testRuntimeFailure{code: "unexpected_observation_cursor"}
	}
	page.Run.RunID = runID
	return page, nil
}

// failingEventProjector refuses the first journal page it is given.
type failingEventProjector struct {
	recordingProjector
	refused bool
}

func (projector *failingEventProjector) ProjectFlowRuntime(ctx context.Context, update ProjectionUpdate) error {
	projector.mu.Lock()
	refuse := len(update.Events) > 0 && !projector.refused
	projector.refused = projector.refused || refuse
	projector.mu.Unlock()
	if refuse {
		return errors.New("projection store unavailable")
	}
	return projector.recordingProjector.ProjectFlowRuntime(ctx, update)
}

// Every observed journal page reaches the projection with the cursor it was
// read after, before that cursor is saved: a projection that fails is given
// the same page again rather than losing it.
func TestObservedJournalPagesReachTheProjectionBeforeTheirCursorIsSaved(t *testing.T) {
	store, _ := newFlowDispatchStore(t)
	running := flowruntime.Run{FlowID: "coding/dispatch", Status: "running"}
	completed := flowruntime.Run{FlowID: "coding/dispatch", Status: "completed"}
	runtime := &journalRuntime{recordingRuntime: newRecordingRuntime(), pages: map[string]flowruntime.Observation{
		"":  {Run: running, Events: []flowruntime.Event{{Sequence: 0, Kind: "node.started"}, {Sequence: 1, Kind: "node.output"}}, NextCursor: "1"},
		"1": {Run: completed, Events: []flowruntime.Event{{Sequence: 2, Kind: "node.finished"}}, NextCursor: "2", Terminal: true},
	}}
	projector := &failingEventProjector{}
	service, err := New(Config{
		Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
			return runtime, nil
		}), Projector: projector, ObservationDelay: time.Millisecond,
	})
	require.NoError(t, err)
	request := testLaunchRequest("journal-pages", ApprovalAuto)
	receipt, err := service.Admit(context.Background(), request)
	require.NoError(t, err)
	startTestWorker(t, service, "journal-pages-owner")
	operation := waitOperation(t, store, request.Scope, receipt.OperationID, func(operation jobs.Operation) bool {
		return operation.State.Terminal()
	})
	require.Equal(t, jobs.StateCompleted, operation.State, string(operation.TerminalReceipt))

	projector.mu.Lock()
	defer projector.mu.Unlock()
	require.True(t, projector.refused)
	var pages []string
	var kinds []string
	for _, update := range projector.updates {
		if len(update.Events) == 0 {
			continue
		}
		pages = append(pages, update.EventsAfter+"->"+update.Checkpoint.Cursor)
		for _, event := range update.Events {
			kinds = append(kinds, event.Kind)
		}
	}
	require.Equal(t, []string{"->1", "1->2"}, pages, "the refused first page is delivered again from the same cursor")
	require.Equal(t, []string{"node.started", "node.output", "node.finished"}, kinds)
}

// heldRuntime keeps an accepted run running until done is set.
type heldRuntime struct {
	*recordingRuntime
	done atomic.Bool
}

func (runtime *heldRuntime) Observe(ctx context.Context, runID, cursor string, limit int) (flowruntime.Observation, error) {
	observation, err := runtime.recordingRuntime.Observe(ctx, runID, cursor, limit)
	if err == nil && !runtime.done.Load() {
		observation.Run.Status, observation.Terminal = "running", false
		for index := range observation.Events {
			observation.Events[index].Kind = "control.run.running"
		}
	}
	return observation, err
}

// The resolver defers a host upgrade while HasPinnedLaunches finds work on
// the old host: an accepted run, or a plan parked on approval (plue#538).
func TestHasPinnedLaunchesFindsAcceptedAndParkedRunsUntilTheySettle(t *testing.T) {
	for _, parked := range []bool{false, true} {
		name := map[bool]string{false: "accepted", true: "parked"}[parked]
		t.Run(name, func(t *testing.T) {
			store, _ := newFlowDispatchStore(t)
			runtime := &heldRuntime{recordingRuntime: newRecordingRuntime()}
			runtime.requireApproval = parked
			service, err := New(Config{
				Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
					return runtime, nil
				}),
				ObservationDelay: 10 * time.Millisecond, MaxObservationDelay: 50 * time.Millisecond,
			})
			require.NoError(t, err)
			startTestWorker(t, service, "pinned-worker")
			request := testLaunchRequest("pinned-"+name, ApprovalManual)
			host := runtime.identity
			other := host
			other.RuntimeArtifactDigest = strings.Repeat("c", 64)
			pinned := func(scope jobs.Scope, identity flowruntime.Identity) bool {
				t.Helper()
				active, err := HasPinnedLaunches(context.Background(), store, scope, identity)
				require.NoError(t, err)
				return active
			}

			receipt, err := service.Admit(context.Background(), request)
			require.NoError(t, err)
			waitOperation(t, store, request.Scope, receipt.OperationID, func(operation jobs.Operation) bool {
				return operation.State == jobs.StateWaiting && len(operation.ExternalReceipt) > 0
			})
			require.True(t, pinned(request.Scope, host))
			require.False(t, pinned(request.Scope, other), "another host identity has no pinned work")
			require.False(t, pinned(jobs.Scope{TenantID: "repository:6", PrincipalID: "user:9"}, host), "another scope has no pinned work")

			if parked {
				_, err = service.Approve(context.Background(), request.Scope, receipt.OperationID, "pinned-approval", request.AuthorizationContext)
				require.NoError(t, err)
				waitOperation(t, store, request.Scope, receipt.OperationID, func(operation jobs.Operation) bool {
					checkpoint, err := decodeCheckpoint(operation.ExternalReceipt)
					return err == nil && checkpoint.RunID == "run-1"
				})
				require.True(t, pinned(request.Scope, host), "an approved run is still pinned")
			}
			runtime.done.Store(true)
			waitOperation(t, store, request.Scope, receipt.OperationID, func(operation jobs.Operation) bool {
				return operation.State == jobs.StateCompleted
			})
			require.False(t, pinned(request.Scope, host), "a settled run releases its host")
		})
	}
}
