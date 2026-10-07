package services

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestInstallFlowRunRefusalsPrecedeMachineLookup(t *testing.T) {
	for _, tc := range []struct {
		name, key, workspace, code string
		status                     int
	}{
		{"merge", "request", "", "reserved_name", 403},
		{"stack.propose", "request", "", "reserved_name", 403},
		{"flow-load", "request", "", "reserved_name", 403},
		{"todo", "request", "", "invalid_flow_run", 400},
		{"review", "request", "", "review_requires_pr", 403},
		{"../merge", "request", "", "invalid_flow_run", 400},
		{"", "request", "", "invalid_flow_run", 400},
		{"canary", "", "", "invalid_flow_run", 400},
		{"canary", " request", "", "invalid_flow_run", 400},
		{"canary", strings.Repeat("a", 256), "", "invalid_flow_run", 400},
		{"canary", "request", "not-a-machine", "invalid_flow_run", 400},
		// Exact names: case and suffixes do not inherit system authority.
		{"Merge", "request", "11111111-1111-4111-8111-111111111111", "flows_unavailable", 503},
		{"merge/x", "request", "11111111-1111-4111-8111-111111111111", "flows_unavailable", 503},
	} {
		t.Run(tc.name+"/"+tc.code, func(t *testing.T) {
			var service *InstallFlowRuns // Any database or runtime access would panic.
			receipt, err := service.Request(t.Context(), 1, 2, InstallFlowRunInput{Name: tc.name, WorkspaceID: tc.workspace}, tc.key)
			var failure *TodoControlError
			require.ErrorAs(t, err, &failure)
			require.Equal(t, tc.code, failure.Code)
			require.Equal(t, tc.status, failure.Status)
			require.Empty(t, receipt.OperationID)
		})
	}
}
