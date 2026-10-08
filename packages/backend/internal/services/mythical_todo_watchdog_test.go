package services

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

func watchdogStep(i int) flowruntime.Event {
	return flowruntime.Event{Kind: "control.engine.event", Payload: []byte(fmt.Sprintf(`{"version":1,"eventType":"flows.engine.attempt-finished","executionId":"child","payload":{"runId":"child","stepKeyDigest":"step-%d","attempt":1,"state":"succeeded"}}`, i))}
}

func TestTodoWatchdogRetainsStepsAndExcludesWaits(t *testing.T) {
	start := time.Date(2026, 10, 6, 10, 0, 0, 0, time.UTC)
	item := db.MythicalItem{State: "running", Attempt: 1, FlowDigest: pgtype.Text{String: todoPinOne, Valid: true}}
	update := flowdispatch.ProjectionUpdate{Checkpoint: flowdispatch.RuntimeCheckpoint{Run: &flowruntime.Run{Status: "running"}}, Events: []flowruntime.Event{watchdogStep(1)}}
	// The admitted run needs a timer before observation: a non-yielding
	// override may prevent the host from returning its first running page.
	ack := flowdispatch.ProjectionUpdate{State: jobs.StateWaiting, Checkpoint: flowdispatch.RuntimeCheckpoint{RunID: "accepted"}}
	projectTodoWatchdog(&item, ack, start)
	require.Equal(t, start.UnixMilli(), mythicalChecksOf(item).Watchdog.ActiveSince)
	projectTodoWatchdog(&item, update, start)
	projectTodoWatchdog(&item, update, start.Add(time.Minute))
	w := mythicalChecksOf(item).Watchdog
	require.Len(t, w.Steps, 1, "replayed completion spends one step")
	require.Equal(t, time.Minute.Milliseconds(), w.elapsed(start.Add(time.Minute)))
	update.Checkpoint.Run.PendingWaits = []flowruntime.PendingWait{{CreatedAt: float64(start.Add(2 * time.Minute).UnixMilli())}}
	projectTodoWatchdog(&item, update, start.Add(time.Hour))
	w = mythicalChecksOf(item).Watchdog
	require.Equal(t, (2 * time.Minute).Milliseconds(), w.ActiveMillis)
	require.Zero(t, w.ActiveSince)
	// Rehydrate the persisted JSON, then resume the same attempt after a wait.
	item.Checks = mythicalChecksOf(item).encode()
	update.Checkpoint.Run.PendingWaits = nil
	projectTodoWatchdog(&item, update, start.Add(2*time.Hour))
	require.Equal(t, (2 * time.Minute).Milliseconds(), mythicalChecksOf(item).Watchdog.ActiveMillis)
	item.PausedAt = pgtype.Timestamptz{Time: start.Add(2*time.Hour + time.Minute), Valid: true}
	projectTodoWatchdog(&item, update, start.Add(3*time.Hour))
	require.Equal(t, (3 * time.Minute).Milliseconds(), mythicalChecksOf(item).Watchdog.ActiveMillis)
	require.Zero(t, mythicalChecksOf(item).Watchdog.ActiveSince)
	item.PausedAt = pgtype.Timestamptz{}
	acceptTodoWatchdog(&item, start.Add(4*time.Hour))
	require.False(t, todoWatchdogEligible(item), "first acceptance ends the pre-proposal allowance")
}

func TestTodoWatchdogAndAccounting(t *testing.T) {
	for _, boundary := range []string{"time", "steps"} {
		t.Run(boundary, func(t *testing.T) {
			o, session := newTodoAdmission(t)
			o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
			start := time.Now().UTC()

			item := o.fileTodo(session, "watchdog-"+boundary)
			o.wake()
			launch := o.launcher.last("todo")
			update := flowdispatch.ProjectionUpdate{State: jobs.StateWaiting, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: launch.Projection, FlowID: "todo", RunID: "watchdog-run", ExecutionDigest: todoPinOne, Run: &flowruntime.Run{RunID: "watchdog-run", Status: "running"}}}
			if boundary == "steps" {
				for i := range 1023 {
					update.Events = append(update.Events, watchdogStep(i))
				}
			}
			require.NoError(t, o.service.ProjectFlowRuntime(t.Context(), update))
			stack, err := db.New(o.pool).GetMythicalStack(t.Context(), o.repoID)
			require.NoError(t, err)
			current := o.byID(uuidString(item.ID))
			start = time.UnixMilli(mythicalChecksOf(current).Watchdog.ActiveSince)
			st := &mythicalItemStep{s: o.service, r: &mythicalRun{row: stack}, now: start.Add(4*time.Hour - time.Millisecond)}
			if boundary == "steps" {
				st.now = start
			}
			before, _, err := st.enforceTodoWatchdog(t.Context(), current)
			require.NoError(t, err)
			require.Nil(t, before)
			require.Equal(t, "running", o.byID(uuidString(item.ID)).State, "the preceding boundary remains runnable")
			if boundary == "time" {
				st.now = start.Add(4 * time.Hour)
			} else {
				update.Events = []flowruntime.Event{watchdogStep(1023)}
				require.NoError(t, o.service.ProjectFlowRuntime(t.Context(), update))
			}
			_, saved, err := st.enforceTodoWatchdog(t.Context(), o.byID(uuidString(item.ID)))
			require.NoError(t, err)
			require.True(t, saved)
			stopped := o.byID(uuidString(item.ID))
			require.Equal(t, "blocked", stopped.State, stopped.Reason)
			require.Equal(t, &mythicalFault{Class: "factory", Tag: "no_proposal", Kind: mythicalFailPlan}, mythicalChecksOf(stopped).Fault)
			require.EqualValues(t, 1, mythicalChecksOf(stopped).Launches)
			require.Equal(t, mythicalChecksOf(stopped).AdmissionDay, mythicalChecksOf(o.byID(uuidString(item.ID))).AdmissionDay)
			require.Len(t, o.launcher.byFlow("todo"), 1, "watchdog adds no model launch or daily charge")
			o.wake()
			require.Equal(t, "blocked", o.byID(uuidString(item.ID)).State)
			require.Len(t, o.launcher.byFlow("todo"), 1, "an expired attempt waits for person Retry")
		})
	}
}

func TestTodoWatchdogSurvivesSameAttemptRecovery(t *testing.T) {
	o, session := newTodoAdmission(t)
	o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
	now := time.Now().UTC()
	o.service.now = func() time.Time { return now }
	item := o.fileTodo(session, "watchdog-outage")
	id := uuidString(item.ID)
	now = now.Add(time.Minute)
	o.wake()
	require.Equal(t, "running", o.byID(id).State)
	launch := o.launcher.last("todo")
	update := flowdispatch.ProjectionUpdate{State: jobs.StateWaiting, Checkpoint: flowdispatch.RuntimeCheckpoint{
		Projection: launch.Projection, FlowID: "todo", RunID: "before-outage", ExecutionDigest: todoPinOne,
		Run: &flowruntime.Run{RunID: "before-outage", Status: "running"}}, Events: []flowruntime.Event{watchdogStep(1)}}
	require.NoError(t, o.service.ProjectFlowRuntime(t.Context(), update))
	now = now.Add(time.Minute)
	update.State, update.Checkpoint.Run.Status = jobs.StateFailed, "failed"
	update.Checkpoint.FailureCode = "runtime_connection_lost"
	require.NoError(t, o.service.ProjectFlowRuntime(t.Context(), update))
	require.NotNil(t, mythicalChecksOf(o.byID(id)).Watchdog)
	spent := *mythicalChecksOf(o.byID(id)).Watchdog
	require.Equal(t, time.Minute.Milliseconds(), spent.ActiveMillis)
	require.Zero(t, spent.ActiveSince)
	require.Len(t, spent.Steps, 1)
	retained := o.byID(id)
	retained.Plan = json.RawMessage(`{"title":"Retained plan","steps":["Add the greeting"],"checks":[]}`)
	_, err := o.service.queries().SaveMythicalItem(t.Context(), retained)
	require.NoError(t, err)
	o.wake()
	retrying := o.byID(id)
	require.Equal(t, "retrying", retrying.State)
	require.Zero(t, retrying.Attempt, "the existing outage policy does not spend an attempt")

	// A delayed recovery still owns the first attempt's already-spent budget.
	now = now.Add(3 * time.Minute)
	o.wake()
	recovered := o.byID(id)
	require.EqualValues(t, 1, recovered.Attempt)
	require.Equal(t, "running", recovered.State, recovered.Reason)
	require.Equal(t, &spent, mythicalChecksOf(recovered).Watchdog, "same-attempt admission must not reset the allowance or charge backoff")
	require.Equal(t, mythicalChecksOf(retrying).AdmissionDay, mythicalChecksOf(recovered).AdmissionDay)
	require.EqualValues(t, 2, mythicalChecksOf(recovered).Launches)
	require.JSONEq(t, string(retained.Plan), string(recovered.Plan), "outage recovery retains the preceding plan")

	launch = o.launcher.last("todo")
	update.Checkpoint.Projection = launch.Projection
	update.State, update.Checkpoint.Run.Status = jobs.StateWaiting, "running"
	update.Checkpoint.RunID, update.Checkpoint.Run.RunID = "after-outage", "after-outage"
	update.Checkpoint.FailureCode = ""
	update.Events = []flowruntime.Event{watchdogStep(1), watchdogStep(2)}
	require.NoError(t, o.service.ProjectFlowRuntime(t.Context(), update))
	w := mythicalChecksOf(o.byID(id)).Watchdog
	require.Len(t, w.Steps, 2, "replayed completions remain deduplicated after admission")
	require.Equal(t, time.Minute.Milliseconds(), w.ActiveMillis)
	require.Equal(t, now.UnixMilli(), w.ActiveSince)

	// A factory failure spends the attempt: the next attempt gets a new
	// allowance, while daily admission is still charged only once.
	projectTodoPlanFailure(t, o, "after-outage")
	o.wake()
	o.wake()
	fresh := o.byID(id)
	require.EqualValues(t, 2, fresh.Attempt)
	require.JSONEq(t, string(retained.Plan), string(fresh.Plan), "a new run without a plan must not erase the latest plan")
	require.Nil(t, mythicalChecksOf(fresh).Watchdog)
	require.Equal(t, mythicalChecksOf(recovered).AdmissionDay, mythicalChecksOf(fresh).AdmissionDay)
}

func TestTodoWatchdogExhaustedVeryHardContinuationDoesNotLaunch(t *testing.T) {
	o, session := newTodoAdmission(t)
	o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
	id := uuidString(o.fileTodo(session, "watchdog-very-hard").ID)
	for attempt := 1; attempt <= mythicalAttempts; attempt++ {
		o.wake()
		item := o.byID(id)
		require.EqualValues(t, attempt, item.Attempt)
		runID := fmt.Sprintf("attempt-%d", attempt)
		projectTodoPlanFailure(t, o, runID)
		o.wake()
		require.Equal(t, "retrying", o.byID(id).State)
	}
	item := o.byID(id)
	require.True(t, mythicalChecksOf(item).VeryHard)
	require.EqualValues(t, mythicalAttempts-1, item.Attempt, "the final continuation reuses the last logical attempt")
	// An older checkpoint may already have queued a continuation at the
	// watchdog bound. Upgrading must refuse its launch rather than reset it.
	checks := mythicalChecksOf(item)
	checks.Watchdog = &todoWatchdog{}
	for i := range 1024 {
		checks.Watchdog.Steps = append(checks.Watchdog.Steps, fmt.Sprintf("spent-%d", i))
	}
	item.Checks = checks.encode()
	_, err := o.service.queries().SaveMythicalItem(t.Context(), item)
	require.NoError(t, err)
	o.wake()
	item = o.byID(id)
	require.Equal(t, "blocked", item.State, item.Reason)
	require.EqualValues(t, mythicalAttempts, item.Attempt)
	require.Len(t, o.launcher.byFlow("todo"), mythicalAttempts, "an exhausted attempt cannot launch a fresh guest")
	require.EqualValues(t, mythicalAttempts, mythicalChecksOf(item).Launches)
	require.Len(t, mythicalChecksOf(item).Watchdog.Steps, 1024)
	require.Equal(t, "no_proposal", mythicalChecksOf(item).Fault.Tag)
}

func TestTodoRetainsPinnedSourceAlongsideEditingBase(t *testing.T) {
	o, session := newTodoAdmission(t)
	o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
	first := o.fileTodo(session, "editing-prefix")
	o.wake()
	first = o.byID(uuidString(first.ID))
	candidate := o.laneResult(first.WorkspaceID, first.BaseCommit, map[string]string{"PREFIX.md": "prefix\n"}, "prefix")
	_, err := o.pool.Exec(t.Context(), `UPDATE mythical_items SET state='integrating',candidate_base=$2,candidate_head=$3,candidate_verified=true WHERE id=$1`, first.ID, first.BaseCommit, candidate)
	require.NoError(t, err)
	item := o.fileTodo(session, "pinned-source-import")
	o.wake()
	item = o.byID(uuidString(item.ID))
	source := mythicalChecksOf(item).FlowSource
	require.NotEqual(t, item.BaseCommit, source, "the stack prefix and admitted main source are distinct objects")
	require.Equal(t, item.BaseCommit, o.hostRef("refs/smithers/workspaces/"+item.WorkspaceID+"/sources/"+item.BaseCommit))
	require.Equal(t, source, o.hostRef("refs/smithers/workspaces/"+item.WorkspaceID+"/sources/"+source))
}

// This envelope is from the actual bundled-host J5 control journal. ControlLive
// exports its kind/payload unchanged; v2-only fixtures missed every real step.
func TestTodoWatchdogCountsNativeControlEvents(t *testing.T) {
	raw, err := os.ReadFile("testdata/todo-watchdog-native-completion.json")
	require.NoError(t, err)
	now := time.Now()
	item := db.MythicalItem{State: "running", Attempt: 1, FlowDigest: pgtype.Text{String: todoPinOne, Valid: true}}
	event := flowruntime.Event{Kind: "control.engine.event", Payload: raw}
	update := flowdispatch.ProjectionUpdate{Events: []flowruntime.Event{event}, Checkpoint: flowdispatch.RuntimeCheckpoint{Run: &flowruntime.Run{Status: "running"}}}
	projectTodoWatchdog(&item, update, now)
	require.Len(t, mythicalChecksOf(item).Watchdog.Steps, 1, "the real host's completed step must spend the allowance")
	// A replayed page has a different transport cursor, but the same instance.
	update.Events[0].Sequence = 1234
	projectTodoWatchdog(&item, update, now.Add(time.Minute))
	require.Len(t, mythicalChecksOf(item).Watchdog.Steps, 1)
	var envelope map[string]any
	require.NoError(t, json.Unmarshal(raw, &envelope))
	envelope["payload"].(map[string]any)["attempt"] = 2
	second, err := json.Marshal(envelope)
	require.NoError(t, err)
	update.Events[0].Payload = second
	projectTodoWatchdog(&item, update, now)
	require.Len(t, mythicalChecksOf(item).Watchdog.Steps, 2, "another completed attempt is a distinct instance")
	for name, mutate := range map[string]func(map[string]any){
		"unknown-version":    func(e map[string]any) { e["version"] = 99 },
		"started":            func(e map[string]any) { e["eventType"] = "flows.engine.attempt-started" },
		"nonterminal":        func(e map[string]any) { e["payload"].(map[string]any)["state"] = "running" },
		"missing-attempt":    func(e map[string]any) { delete(e["payload"].(map[string]any), "attempt") },
		"zero-attempt":       func(e map[string]any) { e["payload"].(map[string]any)["attempt"] = 0 },
		"wrong-execution":    func(e map[string]any) { e["payload"].(map[string]any)["runId"] = "unrelated" },
		"missing-digest":     func(e map[string]any) { delete(e["payload"].(map[string]any), "stepKeyDigest") },
		"negative-attempt":   func(e map[string]any) { e["payload"].(map[string]any)["attempt"] = -1 },
		"fractional-attempt": func(e map[string]any) { e["payload"].(map[string]any)["attempt"] = 1.5 },
		"empty-execution":    func(e map[string]any) { e["executionId"] = ""; e["payload"].(map[string]any)["runId"] = "" },
		"oversized-execution": func(e map[string]any) {
			e["executionId"] = strings.Repeat("e", 1025)
			e["payload"].(map[string]any)["runId"] = e["executionId"]
		},
		"oversized-digest": func(e map[string]any) { e["payload"].(map[string]any)["stepKeyDigest"] = strings.Repeat("d", 1025) },
	} {
		t.Run(name, func(t *testing.T) {
			var bad map[string]any
			require.NoError(t, json.Unmarshal(raw, &bad))
			mutate(bad)
			encoded, err := json.Marshal(bad)
			require.NoError(t, err)
			current := db.MythicalItem{State: "running", Attempt: 1, FlowDigest: item.FlowDigest}
			projectTodoWatchdog(&current, flowdispatch.ProjectionUpdate{Events: []flowruntime.Event{{Kind: "control.engine.event", Payload: encoded}}}, now)
			require.Empty(t, mythicalChecksOf(current).Watchdog.Steps)
		})
	}
}

func TestTodoWatchdogRetainedLifecycleIdentity(t *testing.T) {
	native := watchdogStep(1)
	legacy := flowruntime.Event{Kind: "flows.engine.v2.attempt-lifecycle", Payload: []byte(`{"version":2,"executionId":"child","stepKeyDigest":"step-1","attempt":1,"lifecycle":{"state":"failed"}}`)}
	first, ok := todoCompletedStep(native)
	require.True(t, ok)
	second, ok := todoCompletedStep(legacy)
	require.True(t, ok)
	require.Equal(t, first, second, "one instance cannot be charged twice across retained event encodings")
	for _, raw := range []string{`{`, `null`, `{"version":2}`, `{"version":2,"executionId":"child","stepKeyDigest":"step-1","attempt":-1,"lifecycle":{"state":"failed"}}`} {
		_, ok := todoCompletedStep(flowruntime.Event{Kind: legacy.Kind, Payload: []byte(raw)})
		require.False(t, ok)
	}
	_, ok = todoCompletedStep(flowruntime.Event{Kind: "unrecognized", Payload: native.Payload})
	require.False(t, ok)
}

func TestTodoWatchdogBoundsNativeEvidence(t *testing.T) {
	item := db.MythicalItem{State: "running", Attempt: 1, FlowDigest: pgtype.Text{String: todoPinOne, Valid: true}}
	update := flowdispatch.ProjectionUpdate{}
	for i := range 1030 {
		update.Events = append(update.Events, watchdogStep(i))
	}
	projectTodoWatchdog(&item, update, time.Now())
	require.Len(t, mythicalChecksOf(item).Watchdog.Steps, 1024, "the persisted allowance stays bounded even when a page crosses it")
	before := append([]byte(nil), item.Checks...)
	projectTodoWatchdog(&item, update, time.Now())
	require.JSONEq(t, string(before), string(item.Checks), "a replayed oversized page cannot grow evidence")
}

// The worker's snapshot can expire while a person or proposal commits.
// Re-read under the stack lock before spending cancellations or retiring lanes.
func TestTodoWatchdogKeepsConcurrentSettlement(t *testing.T) {
	for _, change := range []string{"proposal", "drop", "pause", "new attempt", "step progress"} {
		t.Run(change, func(t *testing.T) {
			o, session := newTodoAdmission(t)
			o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
			item := o.fileTodo(session, "race-watchdog")
			o.wake()
			item = o.byID(uuidString(item.ID))
			checks := mythicalChecksOf(item)
			checks.Watchdog = &todoWatchdog{ActiveMillis: (4 * time.Hour).Milliseconds()}
			item.Checks = checks.encode()
			item, err := db.New(o.pool).SaveMythicalItem(t.Context(), item)
			require.NoError(t, err)
			current := item
			switch change {
			case "proposal":
				acceptTodoWatchdog(&current, time.Now())
			case "drop":
				current.State = "cancelled"
			case "pause":
				current.PausedAt = pgtype.Timestamptz{Time: time.Now(), Valid: true}
			case "new attempt":
				current.Attempt++
				current.RequestRunID = "next-run"
			case "step progress":
				current.Summary = "new evidence"
			}
			current, err = db.New(o.pool).SaveMythicalItem(t.Context(), current)
			require.NoError(t, err)
			stack, err := db.New(o.pool).GetMythicalStack(t.Context(), o.repoID)
			require.NoError(t, err)
			st := &mythicalItemStep{s: o.service, r: &mythicalRun{row: stack}, now: time.Now()}
			next, saved, err := st.enforceTodoWatchdog(t.Context(), item)
			require.NoError(t, err)
			require.True(t, saved, "the caller must not advance its stale snapshot")
			require.Equal(t, current, *next)
			require.Equal(t, current, o.byID(uuidString(item.ID)))
			require.Empty(t, o.lanes.deleted, "a stale timer never retires a lane")
			require.Len(t, o.launcher.byFlow("todo"), 1)
		})
	}
}

func TestTodoWatchdogWaitsForOfferingRunToObserveProposal(t *testing.T) {
	now := time.Now()
	item := db.MythicalItem{State: "verifying", Attempt: 1, WorkspaceID: "coding", RequestRunID: "offering", FlowDigest: pgtype.Text{String: todoPinOne, Valid: true}}
	checks := mythicalChecks{FlowSource: strings.Repeat("a", 40), RunAttached: true, ProposalRun: "offering", Watchdog: &todoWatchdog{ActiveSince: now.UnixMilli()}}
	item.Checks = checks.encode()
	acceptTodoWatchdog(&item, now.Add(time.Hour))
	require.False(t, mythicalChecksOf(item).Watchdog.Accepted)
	for _, state := range []string{"verifying", "proposing", "proposed"} {
		item.State = state
		require.True(t, todoWatchdogEligible(item), state)
	}
	checks = mythicalChecksOf(item)
	checks.ProposalRun = ""
	item.Checks = checks.encode()
	acceptTodoWatchdog(&item, now.Add(time.Hour))
	require.True(t, mythicalChecksOf(item).Watchdog.Accepted)
	require.False(t, todoWatchdogEligible(item))
}

func TestTodoWatchdogRestoresPreviouslyAcceptedUnobservedProposal(t *testing.T) {
	o, session := newTodoAdmission(t)
	o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
	item := o.fileTodo(session, "restore-proposal-bound")
	o.wake()
	item = o.byID(uuidString(item.ID))
	item.State, item.RequestRunID = "proposed", "offering"
	checks := mythicalChecksOf(item)
	checks.RunAttached, checks.ProposalRun = true, "offering"
	checks.Watchdog = &todoWatchdog{Accepted: true, ActiveMillis: time.Hour.Milliseconds()}
	item.Checks = checks.encode()
	item, err := db.New(o.pool).SaveMythicalItem(t.Context(), item)
	require.NoError(t, err)
	stack, err := db.New(o.pool).GetMythicalStack(t.Context(), o.repoID)
	require.NoError(t, err)
	now := time.Now().Truncate(time.Millisecond)
	st := &mythicalItemStep{s: o.service, r: &mythicalRun{row: stack}, now: now}
	restored, saved, err := st.enforceTodoWatchdog(t.Context(), item)
	require.NoError(t, err)
	require.True(t, saved)
	require.False(t, mythicalChecksOf(*restored).Watchdog.Accepted)
	require.Equal(t, now.UnixMilli(), mythicalChecksOf(*restored).Watchdog.ActiveSince)
	require.Equal(t, time.Hour.Milliseconds(), mythicalChecksOf(*restored).Watchdog.ActiveMillis)
	require.Empty(t, o.lanes.deleted, "restoring the bound never cancels remaining allowance")
	st.now = now.Add(3*time.Hour - time.Millisecond)
	next, _, err := st.enforceTodoWatchdog(t.Context(), *restored)
	require.NoError(t, err)
	require.Nil(t, next)
	st.now = now.Add(3 * time.Hour)
	next, saved, err = st.enforceTodoWatchdog(t.Context(), *restored)
	require.NoError(t, err)
	require.True(t, saved)
	require.Equal(t, "failed: no_proposal", next.RequestOutcome)
	require.Equal(t, "blocked", next.State)
	require.Contains(t, o.lanes.deleted, item.WorkspaceID)
}
