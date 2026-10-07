package compose

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

func TestPresenceRuntimeRetainsStepAndAttributedFileThroughInstall(t *testing.T) {
	f := presenceInstall(t)
	reader := f.dial(t)
	sendPresenceFrame(t, reader, fmt.Sprintf(`{"t":"sub","id":1,"topic":"branch:%s"}`, f.row.ID))
	readPresenceFrame(t, reader)
	update := flowdispatch.ProjectionUpdate{State: jobs.StateRunning, Checkpoint: flowdispatch.RuntimeCheckpoint{
		Target: flowruntime.Target{TenantID: fmt.Sprintf("repository:%d", f.row.RepositoryID), PrincipalID: fmt.Sprintf("user:%d", f.user.ID), WorkspaceID: f.row.ID, BindingKind: "mythical-item"},
		RunID:  "coding-run", FlowID: "todo", Run: &flowruntime.Run{RunID: "coding-run", FlowID: "todo", Status: "running"},
	}, Events: []flowruntime.Event{{Kind: "control.engine.event", Payload: json.RawMessage(`{"version":1,"eventType":"flows.engine.node-scheduled","executionId":"coding-run","payload":{"nodeId":"implement-node","action":"Implement","attempt":1}}`)}}}
	require.NoError(t, f.p.ProjectFlowRuntime(t.Context(), update))
	assertWhere := func(expected string) {
		var card struct {
			Presence []struct{ Where json.RawMessage }
		}
		frame := readPresenceFrame(t, reader)
		require.NoError(t, json.Unmarshal(frame.Data, &card))
		require.Len(t, card.Presence, 1)
		require.JSONEq(t, expected, string(card.Presence[0].Where))
	}
	assertWhere(`{"kind":"step","label":"Implement"}`)
	update.Events = nil
	require.NoError(t, f.p.ProjectFlowRuntime(t.Context(), update))
	// A no-event poll renews the existing step without publishing a branch move.
	for _, lease := range f.roster(t) {
		require.JSONEq(t, `{"kind":"step","label":"Implement"}`, string(lease.Where))
	}
	// This is the admitted daemon's existing roster operation, with its own lease.
	_, slug, err := installRepository(t.Context(), f.p.queries)
	require.NoError(t, err)
	_, err = f.p.call(t.Context(), f.row, slug, "Branch.Announce", map[string]any{
		"participantId": "run:coding-run", "sessionId": "daemon:fixture:1", "displayName": "coding", "kind": "agent", "agentKind": "coding", "runId": "coding-run", "for_member": fmt.Sprintf("member:%d", f.user.ID), "where": map[string]any{"kind": "file", "path": "retry.ts"}, "cursor": nil,
	})
	require.NoError(t, err)
	assertWhere(`{"kind":"file","path":"retry.ts"}`)
	require.NoError(t, f.p.ProjectFlowRuntime(t.Context(), update))
	for _, lease := range f.roster(t) {
		require.JSONEq(t, `{"kind":"file","path":"retry.ts"}`, string(lease.Where))
	}
	// A different run's location must not be borrowed by this run's heartbeat.
	require.NoError(t, f.p.runHeartbeat(t.Context(), f.row.RepositoryID, f.user.ID, f.row.ID, "other-run", "reviewer", true))
	leases := f.roster(t)
	found := false
	for _, lease := range leases {
		if lease.ParticipantID == "run:other-run" {
			found = true
			require.JSONEq(t, `{"kind":"branch"}`, string(lease.Where))
		}
	}
	require.True(t, found)
}

func TestPresenceScheduledStepIgnoresUntrustedOrMalformedFacts(t *testing.T) {
	for _, event := range []flowruntime.Event{
		{Kind: "message", Payload: json.RawMessage(`{"version":1,"eventType":"flows.engine.node-scheduled","executionId":"run","payload":{"nodeId":"x","action":"Spoof","attempt":1}}`)},
		{Kind: "control.engine.event", Payload: json.RawMessage(`{"version":2,"eventType":"flows.engine.node-scheduled","executionId":"run","payload":{"nodeId":"x","action":"Spoof","attempt":1}}`)},
		{Kind: "control.engine.event", Payload: json.RawMessage(`{"version":1,"eventType":"flows.engine.node-scheduled","executionId":"run","payload":{"nodeId":"x","action":"Spoof","attempt":0}}`)},
		{Kind: "control.engine.event", Payload: json.RawMessage(`{"version":1,"eventType":"flows.engine.node-settled","executionId":"run","payload":{"nodeId":"x","action":"Spoof","attempt":1}}`)},
		{Kind: "control.engine.event", Payload: json.RawMessage(`{`)},
	} {
		require.Empty(t, scheduledPresenceStep([]flowruntime.Event{event}))
	}
}

func TestPresenceScheduledStepKeepsLastNativeSchedule(t *testing.T) {
	events := []flowruntime.Event{
		{Kind: "control.engine.event", Payload: json.RawMessage(`{"version":1,"eventType":"flows.engine.node-scheduled","executionId":"run","payload":{"nodeId":"1","action":"Implement","attempt":1}}`)},
		{Kind: "control.engine.event", Payload: json.RawMessage(`{"version":1,"eventType":"flows.engine.node-scheduled","executionId":"run","payload":{"nodeId":"2","action":"Verify","attempt":1}}`)},
	}
	require.Equal(t, "Verify", scheduledPresenceStep(events))
}
