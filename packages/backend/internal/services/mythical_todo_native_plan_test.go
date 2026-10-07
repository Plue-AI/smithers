package services

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

func nativePlanEvent(run string, sequence int64, title string) flowruntime.Event {
	return flowruntime.Event{RunID: run, Sequence: sequence, Kind: "control.engine.event", Payload: json.RawMessage(fmt.Sprintf(`{
 "version":1,"executionId":"prepared-child","generation":0,"sequence":42,"eventType":"flows.engine.run-decision",
 "payload":{"decision":"transitioned","status":"completed",
 "executionFact":{"version":1,"baseline":"created","observation":{"executionId":"prepared-child","flowName":"coding/PreparePlan","status":"completed"}},
 "state":{"version":1,"flowName":"coding/PreparePlan","result":{"_tag":"Complete","exit":{"_tag":"Success","value":{
 "changes":[{"title":%q,"atoms":[{"changeId":null,"message":"Add greeting"}],"checks":[]}]}}}}}}`, title))}
}

func nativeRouteEvent(run string, sequence int64, route string) flowruntime.Event {
	return flowruntime.Event{RunID: run, Sequence: sequence, Kind: "control.engine.event", Payload: json.RawMessage(fmt.Sprintf(`{
 "version":1,"executionId":"route-child","generation":0,"sequence":8,"eventType":"flows.engine.run-decision",
 "payload":{"decision":"transitioned","status":"completed",
 "executionFact":{"version":1,"baseline":"created","observation":{"executionId":"route-child","flowName":"factory/Todo","status":"completed"}},
 "state":{"version":1,"flowName":"factory/Todo","result":{"_tag":"Complete","exit":{"_tag":"Success","value":{"route":%q,"feedback":"untrusted context"}}}}}}`, route))}
}

func TestTodoRetainsNativeRouteAcrossTypedFailure(t *testing.T) {
	o, session := newTodoAdmission(t)
	o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
	id := uuidString(o.fileTodo(session, "typed-fault-route").ID)
	o.wake()
	launch := o.launcher.last("todo")
	update := flowdispatch.ProjectionUpdate{State: jobs.StateWaiting, Checkpoint: flowdispatch.RuntimeCheckpoint{
		Projection: launch.Projection, FlowID: "todo", RunID: "route-run", ExecutionDigest: todoPinOne,
		Run: &flowruntime.Run{RunID: "route-run", Status: "running"}}}
	project := func(events ...flowruntime.Event) {
		t.Helper()
		update.Events = events
		require.NoError(t, o.service.ProjectFlowRuntime(t.Context(), update))
	}
	project(nativeRouteEvent("route-run", 10, "bug"), nativePlanEvent("route-run", 20, "Prepared"))
	require.Equal(t, "bug", mythicalChecksOf(o.byID(id)).Route)
	// Replaying an old page, a foreign run or a malformed route cannot replace
	// the decision that belongs to this attempt, even after a later plan.
	project(nativeRouteEvent("route-run", 5, "close"), nativeRouteEvent("foreign-run", 30, "feature"), nativeRouteEvent("route-run", 30, "invented"))
	require.Equal(t, "bug", mythicalChecksOf(o.byID(id)).Route)
	output := `{"_tag":"/harness/HarnessError","code":"read_only_cap","message":"No edits made"}`
	update.Checkpoint.Run = &flowruntime.Run{RunID: "route-run", Status: "failed", FinalOutput: &output}
	project()
	require.Equal(t, "bug", mythicalChecksOf(o.byID(id)).Route, "a typed failure without a route field retains the native route receipt")
}

func TestTodoRecoversNativePlanBeforeCandidate(t *testing.T) {
	o, session := newTodoAdmission(t)
	o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
	id := uuidString(o.fileTodo(session, "native-plan").ID)
	o.wake()
	launch := o.launcher.last("todo")
	update := flowdispatch.ProjectionUpdate{State: jobs.StateWaiting, Checkpoint: flowdispatch.RuntimeCheckpoint{
		Projection: launch.Projection, FlowID: "todo", RunID: "planning-run", ExecutionDigest: todoPinOne,
		Run: &flowruntime.Run{RunID: "planning-run", Status: "running"}}}
	project := func(events ...flowruntime.Event) {
		t.Helper()
		update.Events = events
		require.NoError(t, o.service.ProjectFlowRuntime(t.Context(), update))
	}
	project(nativeRouteEvent("planning-run", 5, "bug"), nativePlanEvent("planning-run", 10, "First preparation"))
	require.Contains(t, string(o.byID(id).Plan), "First preparation")
	project(nativePlanEvent("planning-run", 20, "Feedback preparation"))
	latest := o.byID(id)
	require.Empty(t, latest.CandidateHead, "no candidate has ever supplied a plan")
	require.Equal(t, "bug", mythicalChecksOf(latest).Route)
	require.Contains(t, string(latest.Plan), "Feedback preparation")
	require.EqualValues(t, 20, mythicalChecksOf(latest).PlanReceipt.Cursor.Sequence)
	// Read back persisted position and repeat an old page plus the exact
	// current page, as after process replacement or a lost acknowledgement.
	project(nativePlanEvent("planning-run", 10, "First preparation"), nativePlanEvent("planning-run", 20, "Feedback preparation"))
	require.Equal(t, latest, o.byID(id), "replay must not rewrite the durable item")
	for _, corrupt := range []func(*flowdispatch.ProjectionUpdate){
		func(u *flowdispatch.ProjectionUpdate) { u.Events[0].RunID = "foreign-run" },
		func(u *flowdispatch.ProjectionUpdate) { u.Checkpoint.ExecutionDigest = strings.Repeat("f", 64) },
		func(u *flowdispatch.ProjectionUpdate) {
			u.Checkpoint.RunID = "other-run"
			u.Checkpoint.Run = &flowruntime.Run{RunID: "other-run"}
		},
		func(u *flowdispatch.ProjectionUpdate) {
			u.Checkpoint.Projection = json.RawMessage(strings.Replace(string(u.Checkpoint.Projection), `"phase":"todo"`, `"phase":"verify"`, 1))
		},
	} {
		bad := update
		bad.Events = []flowruntime.Event{nativePlanEvent("planning-run", 30, "Must not replace")}
		corrupt(&bad)
		require.NoError(t, o.service.ProjectFlowRuntime(t.Context(), bad))
		require.JSONEq(t, string(latest.Plan), string(o.byID(id).Plan))
	}
	projectTodoPlanFailure(t, o, "planning-run")
	o.wake()
	for attempt := 1; attempt < mythicalAttempts; attempt++ {
		o.wake()
		require.JSONEq(t, string(latest.Plan), string(o.byID(id).Plan))
		runID := fmt.Sprintf("later-run-%d", attempt)
		if attempt == 1 {
			// A fresh host can reuse the old run ID. Its early journal position
			// still replaces the old attempt's later position.
			runID = "planning-run"
			fresh := update
			fresh.Checkpoint.Projection = o.launcher.last("todo").Projection
			fresh.Checkpoint.RunID = runID
			fresh.Checkpoint.Run = &flowruntime.Run{RunID: runID, Status: "running"}
			fresh.Events = []flowruntime.Event{nativeRouteEvent(runID, 0, "feature"), nativePlanEvent(runID, 1, "New attempt preparation")}
			require.NoError(t, o.service.ProjectFlowRuntime(t.Context(), fresh))
			latest = o.byID(id)
			require.Contains(t, string(latest.Plan), "New attempt preparation")
			require.EqualValues(t, 1, mythicalChecksOf(latest).PlanReceipt.Cursor.Sequence)
			require.Equal(t, latest.Attempt, mythicalChecksOf(latest).PlanReceipt.Attempt)
			require.Equal(t, "feature", mythicalChecksOf(latest).Route)
			require.Equal(t, latest.Attempt, mythicalChecksOf(latest).RouteReceipt.Attempt)
			project(nativeRouteEvent("planning-run", 99, "close"), nativePlanEvent("planning-run", 100, "Late old attempt"))
			require.Equal(t, latest, o.byID(id))
		}
		projectTodoPlanFailure(t, o, runID)
		o.wake()
	}
	o.wake()
	require.True(t, mythicalChecksOf(o.byID(id)).VeryHard)
	feedback := decodeJSON(t, o.launcher.last("todo").Payload)["feedback"].(string)
	require.Contains(t, feedback, "Continue the previous plan")
	require.Contains(t, feedback, "New attempt preparation")
	require.Contains(t, feedback, "<untrusted-plan>")
}

func TestTodoNativePlanRequiresCommittedPreparation(t *testing.T) {
	event := nativePlanEvent("run", 1, "Prepared")
	require.Contains(t, string(todoNativePlan(event)), "Prepared")
	for _, replacement := range [][2]string{
		{`"version":1`, `"version":2`},
		{`"generation":0`, `"generation":-1`},
		{`"generation":0`, `"other":0`},
		{`"sequence":42`, `"sequence":-1`},
		{`"sequence":42`, `"other":42`},
		{`"executionId":"prepared-child"`, `"executionId":"foreign"`},
		{`"flows.engine.run-decision"`, `"flows.engine.node-settled"`},
		{`"transitioned"`, `"observed"`},
		{`"status":"completed"`, `"status":"failed"`},
		{`"baseline":"created"`, `"baseline":"unknown"`},
		{`"flowName":"coding/PreparePlan"`, `"flowName":"coding/PrepareRequest"`},
		{`"_tag":"Complete"`, `"_tag":"Continue"`},
		{`"_tag":"Success"`, `"_tag":"Failure"`},
		{`"changes"`, `"missingChanges"`},
	} {
		t.Run(replacement[1], func(t *testing.T) {
			bad := event
			bad.Payload = json.RawMessage(strings.Replace(string(event.Payload), replacement[0], replacement[1], 1))
			require.Nil(t, todoNativePlan(bad))
		})
	}
	for _, data := range []string{"null", "{", "[]"} {
		bad := event
		bad.Payload = json.RawMessage(data)
		require.Nil(t, todoNativePlan(bad))
	}
	require.Nil(t, todoNativePlan(nativePlanEvent("run", 1, strings.Repeat("x", 1<<20))))
	event.Kind = "flows.engine.node-settled"
	require.Nil(t, todoNativePlan(event))
}

func TestTodoPlanCursorOrdersPartialAndLegacyPages(t *testing.T) {
	offset := func(n int64) *int64 { return &n }
	cursors := []flowruntime.EventCursor{{Sequence: 0, Offset: offset(0)}, {Sequence: 0, Offset: offset(1)}, {Sequence: 0}, {Sequence: 1, Offset: offset(0)}, {Sequence: 1}}
	for i, before := range cursors {
		for j, after := range cursors {
			require.Equal(t, j > i, todoPlanAfter(after, before))
		}
	}
}
