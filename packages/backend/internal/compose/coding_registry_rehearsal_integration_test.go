package compose

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Real browser relay, packaged native coding host and registry archive. This
// trusted-process rehearsal proves source/state separation, not Mac isolation.
func TestCodingCatalogArchiveKeepsAuthorizedSourceThroughInstall(t *testing.T) {
	if os.Getenv("SMITHERS_CODING_REGISTRY_REHEARSAL") != "1" {
		t.Skip("enable packaged-host registry rehearsal explicitly")
	}
	t.Setenv("SMITHERS_FEATURE_FLAGS_FLOW_LOAD", "true")
	r := newRehearsal(t, "SMITHERS_CODING_REGISTRY_REHEARSAL", "C-DUR-01", "registry-source-", 25)
	require.True(t, r.install("Install through Machine ready"))
	_, err := r.pushGitHubMain("Publish an ordinary registry probe", map[string]string{"flows/probe/flow.ts": `import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
export default Flow.make("probe", { description: "Archive source control", capabilities: [], payload: {}, success: Schema.String,
 body: () => Node.succeed("approved") })
`})
	require.NoError(t, err)
	var workspace, recorded string
	var last string
	ok := assert.Eventually(t, func() bool {
		if err := r.pool.QueryRow(r.ctx, `SELECT h.workspace_id,h.source_revision FROM flow_runtime_host_bindings h
JOIN flow_loads l ON l.workspace_id::text=h.workspace_id::text WHERE h.state='running' ORDER BY h.updated_at DESC LIMIT 1`).Scan(&workspace, &recorded); err != nil {
			last = err.Error()
			return false
		}
		request, _ := json.Marshal(map[string]any{"repo": "rehearsal-owner/app", "workspaceId": workspace,
			"procedure": "List", "payload": map[string]string{"_tag": "flows"}})
		status, response, err := r.keyed("POST", "/api/workflow/rpc", string(request), "registry-source-list")
		last = fmt.Sprintf("HTTP %d %s; %v", status, response, err)
		return err == nil && status == 200 && strings.Contains(string(response), `"flowId":"probe"`) &&
			strings.Contains(string(response), `"description":"Archive source control"`)
	}, 2*time.Minute, 100*time.Millisecond)
	require.True(t, ok, "real catalog did not serve probe: %s", last)
	observed, err := r.processRuntime.ResolveWorkspaceSourceRevision(r.ctx, workspace)
	require.NoError(t, err)
	require.Equal(t, recorded, observed, "catalog snapshot publication must not move its authorized source")
	t.Logf("browser catalog served probe; recorded and observed source=%s", recorded)
}
