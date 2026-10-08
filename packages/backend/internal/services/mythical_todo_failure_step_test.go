package services

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestTodoFailureStepBoundNativeEvidence(t *testing.T) {
	const payload = `{"version":1,"executionId":"native-child","eventType":"flows.engine.node-settled","payload":{"nodeId":"node-s4","action":"s4","outcome":"failed","stepKeyDigests":["key-s4"],"result":{"preview":"{\"_tag\":\"coding/Error\",\"code\":\"invalid_request\",\"message\":\"fixture\"}","truncated":false}}}`
	event := flowruntime.Event{Kind: "control.engine.event", RunID: "run-1", Sequence: 4, Payload: json.RawMessage(payload)}
	makeItem := func() db.MythicalItem {
		return db.MythicalItem{Source: "todo", State: "blocked", Attempt: 1, RequestRunID: "run-1", Checks: mythicalChecks{RunLaunched: true, RunAttached: true, Fault: &mythicalFault{Class: "user", Tag: "coding/Error/invalid_request", Kind: "stopped"}}.encode()}
	}
	project := func(item *db.MythicalItem, event flowruntime.Event) {
		projectTodoFailureStep(item, mythicalProjection{Phase: "todo"}, flowdispatch.ProjectionUpdate{Checkpoint: flowdispatch.RuntimeCheckpoint{RunID: "run-1"}, Events: []flowruntime.Event{event}})
	}
	item := makeItem()
	project(&item, event)
	require.Equal(t, "s4", todoFailure(item)["step"])
	before := item
	project(&item, event)
	require.Equal(t, before, item, "replay is idempotent")
	older := event
	older.Sequence = 3
	older.Payload = json.RawMessage(strings.Replace(payload, `"action":"s4"`, `"action":"s3"`, 1))
	project(&item, older)
	require.Equal(t, before, item, "older events cannot replace the retained failure")
	for _, c := range []struct{ name, from, to string }{
		{"wrapper without dispatch", `["key-s4"]`, `[]`},
		{"successful action", `"outcome":"failed"`, `"outcome":"built"`},
		{"truncated error", `"truncated":false`, `"truncated":true`},
		{"unknown envelope", `"version":1`, `"version":2`},
		{"missing execution", `"native-child"`, `""`},
		{"missing node", `"node-s4"`, `""`},
		{"missing action", `"action":"s4"`, `"action":""`},
		{"wrong event", `"flows.engine.node-settled"`, `"flows.engine.node-scheduled"`},
	} {
		t.Run(c.name, func(t *testing.T) {
			item := makeItem()
			changed := event
			changed.Payload = json.RawMessage(strings.Replace(payload, c.from, c.to, 1))
			project(&item, changed)
			require.Nil(t, mythicalChecksOf(item).FailureStep)
			require.Equal(t, "stopped", todoFailure(item)["step"])
		})
	}
	for _, mode := range []string{"other-run", "prior-attempt", "different-error", "never-attached"} {
		t.Run(mode, func(t *testing.T) {
			next := before
			checks := mythicalChecksOf(next)
			switch mode {
			case "other-run":
				next.RequestRunID = "run-2"
			case "prior-attempt":
				next.Attempt = 2
			case "different-error":
				checks.Fault.Tag = "coding/Error/source_changed"
			case "never-attached":
				checks.RunAttached = false
			}
			next.Checks = checks.encode()
			require.NotEqual(t, "s4", todoFailure(next)["step"])
		})
	}
	foreign := event
	foreign.RunID = "foreign"
	item = makeItem()
	project(&item, foreign)
	require.Nil(t, mythicalChecksOf(item).FailureStep)
}
