package compose

import (
	"encoding/json"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
	"testing"
	"time"
)

func TestBranchPresenceModelMachineAndSSH(t *testing.T) {
	for _, tc := range []struct{ status, state string }{
		{"releasing", "releasing"}, {"running", "awake"}, {"suspended", "asleep"}, {"stopped", "asleep"},
		{"starting", "waking"}, {"pending", "waking"}, {"failed", "failed"},
		{"deleted", "closed"}, {"", "closed"},
	} {
		t.Run(tc.status, func(t *testing.T) {
			// The stack's lane bookmark is internal: the card shows the TODO's
			// branch, and SSH logs in to it by its slug (spec §8.10.1).
			model := branchPresenceModel(db.Workspace{ID: "branch-2", TargetBookmark: "mythical", Status: tc.status}, "smithers/retry-webhooks", []any{}, "")
			require.Equal(t, "branch-2", model["id"])
			require.Equal(t, "smithers/retry-webhooks", model["name"])
			require.Equal(t, tc.state, model["machine"].(map[string]any)["state"])
			require.Equal(t, "ssh -p 2222 retry-webhooks@localhost", model["ssh_line"])
			if tc.status == "failed" {
				require.Equal(t, map[string]any{"class": "infra", "code": "machine_failed", "message": "Machine failed"}, model["machine"].(map[string]any)["error"])
			}
		})
	}
	for _, tc := range []struct{ origin, host string }{
		{"https://factory.example:8443", "factory.example"}, {"http://localhost:4000", "localhost"},
		{"", "localhost"}, {":invalid", "localhost"},
	} {
		model := branchPresenceModel(db.Workspace{ID: "scratch-1", TargetBookmark: "scratch/alice/retry", Status: "suspended"}, "scratch/alice/retry", []any{}, tc.origin)
		require.Equal(t, "scratch/alice/retry", model["name"])
		require.Equal(t, "ssh -p 2222 scratch/alice/retry@"+tc.host, model["ssh_line"])
	}
}

func TestBranchItemProjection(t *testing.T) {
	raw := json.RawMessage(`{"id":"b2","name":"smithers/renamed","machine":{"state":"asleep"}}`)
	todos := []map[string]any{
		{"n": 1, "title": "Wrong branch", "branch": map[string]any{"id": "b1", "name": "smithers/renamed"}},
		{"n": 2, "title": "Retry webhooks", "state": "working", "place": 3, "steps": []map[string]any{{"label": "Plan", "state": "done"}, {"label": "Code", "state": "current"}}, "branch": map[string]any{"id": "b2"}, "rebase_pending": map[string]any{"onto": "main"}},
	}
	projected, err := branchItemProjection(raw, todos)
	require.NoError(t, err)
	require.JSONEq(t, `{"id":"b2","name":"smithers/renamed","machine":{"state":"asleep"},"item":{"n":2,"title":"Retry webhooks","state":"working","place":3,"step":"Code"},"rebase":{"state":"pending","onto":"main"}}`, string(projected))
	todos[1]["state"] = "merged"
	delete(todos[1], "place")
	delete(todos[1], "rebase_pending")
	projected, err = branchItemProjection(projected, todos)
	require.NoError(t, err)
	require.JSONEq(t, `{"id":"b2","name":"smithers/renamed","machine":{"state":"asleep"},"item":{"n":2,"title":"Retry webhooks","state":"merged","place":0,"step":"Code"}}`, string(projected))
	projected, err = branchItemProjection(raw, todos[:1])
	require.NoError(t, err)
	require.JSONEq(t, string(raw), string(projected))
	_, err = branchItemProjection(json.RawMessage(`invalid`), todos)
	require.Error(t, err)
}

func TestPresenceHostRestartWindow(t *testing.T) {
	start := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	now := start
	presence := &branchPresence{startedAt: start, now: func() time.Time { return now }}
	require.True(t, presence.startupUnknown())
	now = start.Add(29900 * time.Millisecond)
	require.True(t, presence.startupUnknown())
	now = start.Add(30 * time.Second)
	require.False(t, presence.startupUnknown())
}
