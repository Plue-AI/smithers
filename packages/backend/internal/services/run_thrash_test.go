package services

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

func thrashNativeEvent(run string, seq int64, flow, value string) flowruntime.Event {
	preview, _ := json.Marshal(value)
	return flowruntime.Event{RunID: run, Sequence: seq, Kind: "control.engine.event", Payload: json.RawMessage(fmt.Sprintf(`{"version":1,"executionId":"child-%d","generation":0,"sequence":1,"eventType":"flows.engine.node-settled","payload":{"nodeId":"node-%d","action":%q,"outcome":"built","attempts":1,"result":{"preview":%s,"bytes":100,"truncated":false}}}`, seq, seq, flow, preview))}

}
func TestRunThrashRules(t *testing.T) {
	tests := []struct {
		name     string
		ids      []string
		messages []string
		edit     []string
		passed   bool
		want     int
	}{
		{name: "third failure", ids: []string{"unit", "unit", "unit"}, want: 3},
		{name: "different checks", ids: []string{"a", "b", "c"}, want: 1},
		{name: "normalized signatures", ids: []string{"", "", ""}, messages: []string{"bad /tmp/a.ts:12 value 1", "bad /tmp/b.ts:98 value 2", "bad /tmp/c.ts:7 value 9"}, want: 3},
		{name: "named edit", ids: []string{"unit", "unit", "unit"}, edit: []string{"src/retry.ts"}, want: 0},
		{name: "unrelated edit", ids: []string{"unit", "unit", "unit"}, edit: []string{"src/other.ts"}, want: 3},
		{name: "pass clears", ids: []string{"unit", "unit", "unit"}, passed: true, want: 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			d := runThrash{}
			for i, id := range tt.ids {
				message := "failed src/retry.ts:42"
				if tt.messages != nil {
					message = tt.messages[i]
				}
				d.check(id, message, "failed")
			}
			d.edit(tt.edit)
			if tt.passed {
				d.check("unit", "", "passed")
			}
			count := 0
			for _, f := range d.Failures {
				count = max(count, f.Count)
			}
			require.Equal(t, tt.want, count)
		})
	}
}

// Production fenced projection -> durable storage -> the real TODO card seam.
func TestTodoNativeThrashProjectionAndReplay(t *testing.T) {
	o, session := newTodoAdmission(t)
	o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
	id := uuidString(o.fileTodo(session, "native-thrash").ID)
	o.wake()
	launch := o.launcher.last("todo")
	update := flowdispatch.ProjectionUpdate{State: jobs.StateWaiting, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: launch.Projection, FlowID: "todo", RunID: "thrash-run", ExecutionDigest: todoPinOne, Run: &flowruntime.Run{RunID: "thrash-run", Status: "running"}}}
	project := func(events ...flowruntime.Event) {
		t.Helper()
		update.Events = events
		require.NoError(t, o.service.ProjectFlowRuntime(t.Context(), update))
	}
	event := func(n int64) flowruntime.Event {
		return thrashNativeEvent("thrash-run", n, "coding/check-command", `{"checkId":"unit","status":"failed","findings":[{"message":"bad src/retry.ts:42","output":""}]}`)
	}
	for n := int64(1); n <= 3; n++ {
		project(event(n))
	}
	item := o.byID(id)
	require.Equal(t, 3, mythicalChecksOf(item).Thrash.Failures[0].Count)
	card, err := o.service.Todo(session, o.repoID, item.Number.Int64)
	require.NoError(t, err)
	require.Equal(t, []any{map[string]any{"tone": "thrash", "text": "Thrashing: unit failed 3×"}}, card["run"].(map[string]any)["indicators"])
	project(event(1), event(2), event(3))
	require.Equal(t, item, o.byID(id), "replay writes nothing")
	foreign := event(4)
	foreign.RunID = "another-run"
	project(foreign)
	require.Equal(t, item, o.byID(id))
	project(thrashNativeEvent("thrash-run", 4, "coding/edit-atom", `{"writes":["src/other.ts"]}`))
	require.Len(t, mythicalChecksOf(o.byID(id)).Thrash.Failures, 1)
	project(thrashNativeEvent("thrash-run", 5, "coding/edit-atom", `{"writes":["src/retry.ts"]}`))
	item = o.byID(id)
	require.Empty(t, mythicalChecksOf(item).Thrash.Failures)
	card, err = o.service.Todo(session, o.repoID, item.Number.Int64)
	require.NoError(t, err)
	require.Empty(t, card["run"].(map[string]any)["indicators"])
}

func TestRunThrashExecutedNativeNodesOnly(t *testing.T) {
	event := thrashNativeEvent("run", 1, "coding/check-command", `{"checkId":"unit","status":"failed"}`)
	require.JSONEq(t, `{"checkId":"unit","status":"failed"}`, string(thrashNodeResult(event, "coding/check-command")))
	for _, mutation := range []func(map[string]any){
		func(e map[string]any) { e["version"] = 2 },
		func(e map[string]any) { e["executionId"] = "" },
		func(e map[string]any) { e["payload"].(map[string]any)["outcome"] = "clean" },
		func(e map[string]any) { e["payload"].(map[string]any)["outcome"] = "failed" },
		func(e map[string]any) { e["payload"].(map[string]any)["nodeId"] = "" },
		func(e map[string]any) { e["payload"].(map[string]any)["result"].(map[string]any)["truncated"] = true },
		func(e map[string]any) { e["payload"].(map[string]any)["result"].(map[string]any)["preview"] = "{" },
	} {
		var envelope map[string]any
		require.NoError(t, json.Unmarshal(event.Payload, &envelope))
		mutation(envelope)
		broken := event
		broken.Payload, _ = json.Marshal(envelope)
		require.Nil(t, thrashNodeResult(broken, "coding/check-command"))
	}
}

func TestRunThrashAttemptBoundaryAndEditBetweenFailures(t *testing.T) {
	d := runThrash{}
	d.check("unit", "bad src/retry.ts:1", "failed")
	d.check("unit", "bad src/retry.ts:2", "failed")
	d.edit([]string{"/checkout/src/retry.ts"})
	d.check("unit", "bad src/retry.ts:3", "failed")
	require.Equal(t, 1, d.Failures[0].Count)
	item := db.MythicalItem{Source: "todo", Attempt: 1, RequestRunID: "run", Checks: []byte(`{"todo":true}`)}
	update := flowdispatch.ProjectionUpdate{Checkpoint: flowdispatch.RuntimeCheckpoint{RunID: "run"}}
	for n := int64(1); n <= 2; n++ {
		update.Events = []flowruntime.Event{thrashNativeEvent("run", n, "coding/check-command", `{"checkId":"unit","status":"failed"}`)}
		projectTodoThrash(&item, update)
	}
	require.Equal(t, 2, mythicalChecksOf(item).Thrash.Failures[0].Count)
	item.Attempt = 2
	update.Events = []flowruntime.Event{thrashNativeEvent("run", 3, "coding/check-command", `{"checkId":"unit","status":"failed"}`)}
	projectTodoThrash(&item, update)
	require.Equal(t, 1, mythicalChecksOf(item).Thrash.Failures[0].Count)
}

func FuzzRunThrashDeterministic(f *testing.F) {
	f.Add("unit", "bad /tmp/retry.ts:42", uint8(3))
	f.Fuzz(func(t *testing.T, id, message string, n uint8) {
		if len(id) > 1024 || len(message) > 8192 {
			t.Skip()
		}
		fold := func() []byte {
			d := runThrash{}
			for i := uint8(0); i < min(n, 10); i++ {
				d.check(id, message, "failed")
			}
			raw, err := json.Marshal(d)
			require.NoError(t, err)
			return raw
		}
		require.Equal(t, fold(), fold())
	})
}
