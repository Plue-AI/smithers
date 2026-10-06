package compose

import (
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestBranchPresenceModelMachineAndSSH(t *testing.T) {
	for _, tc := range []struct{ status, state string }{
		{"running", "awake"}, {"suspended", "asleep"}, {"stopped", "asleep"},
		{"starting", "waking"}, {"pending", "waking"}, {"failed", "failed"},
		{"deleted", "closed"}, {"", "closed"},
	} {
		t.Run(tc.status, func(t *testing.T) {
			model := branchPresenceModel(db.Workspace{ID: "branch-2", TargetBookmark: "smithers/retry-webhooks", Status: tc.status}, []any{}, "")
			require.Equal(t, "branch-2", model["id"])
			require.Equal(t, "smithers/retry-webhooks", model["name"])
			require.Equal(t, tc.state, model["machine"].(map[string]any)["state"])
			require.Equal(t, "ssh -p 2222 smithers/retry-webhooks@localhost", model["ssh_line"])
			if tc.status == "failed" {
				require.Equal(t, map[string]any{"class": "infra", "code": "machine_failed", "message": "Machine failed"}, model["machine"].(map[string]any)["error"])
			}
		})
	}
	for _, tc := range []struct{ origin, host string }{
		{"https://factory.example:8443", "factory.example"}, {"http://localhost:4000", "localhost"},
		{"", "localhost"}, {":invalid", "localhost"},
	} {
		model := branchPresenceModel(db.Workspace{ID: "scratch-1", TargetBookmark: "scratch/alice/retry", Status: "suspended"}, []any{}, tc.origin)
		require.Equal(t, "ssh -p 2222 scratch/alice/retry@"+tc.host, model["ssh_line"])
	}
}
