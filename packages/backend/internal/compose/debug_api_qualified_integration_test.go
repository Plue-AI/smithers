package compose

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Called only after the bundled C-SEC-02 install has passed setup. This adds
// the playground's production Send door to that check's guest/host canaries;
// it neither substitutes a process runtime nor creates another test install.
func debugAPIQualifiedInvocation(t *testing.T, r *rehearsal, state string, runMSB func(time.Duration, ...string) ([]byte, error), save func(string, []byte)) {
	t.Helper()
	origin, err := url.Parse(r.origin)
	require.NoError(t, err)
	var cookie string
	for _, candidate := range r.jar.Cookies(origin) {
		if candidate.Name == "smithers_session" {
			cookie = candidate.Value
		}
	}
	require.NotEmpty(t, cookie, "qualified install owner session required")
	command := exec.CommandContext(r.ctx, "bun", "e2e/playwright/debug-api/qualified-isolation.ts")
	command.Dir = "../../../../apps/app"
	command.Env = append(os.Environ(), "DEBUG_API_TEST_ORIGIN="+r.origin, "DEBUG_API_TEST_COOKIE="+cookie, "DEBUG_API_TEST_REPOSITORY="+csec02Repository)
	output, err := command.Output()
	// Avoid printing stderr: a failing transport could expose the owner session.
	require.NoError(t, err, "qualified Debug API controller Send")
	var receipt struct {
		RunID         int64 `json:"runId"`
		Status        int   `json:"status"`
		Requests      int   `json:"requests"`
		BeforeConfirm int   `json:"beforeConfirm"`
	}
	require.NoError(t, json.Unmarshal(output, &receipt))
	require.Positive(t, receipt.RunID)
	require.Equal(t, 201, receipt.Status)
	require.Equal(t, 1, receipt.Requests)
	require.Zero(t, receipt.BeforeConfirm)
	var workspace, machine string
	var guest map[string]string
	require.EventuallyWithT(t, func(c *assert.CollectT) {
		require.NoError(c, r.pool.QueryRow(r.ctx, `SELECT workspace_id::text FROM workflow_run_flow_invocations WHERE workflow_run_id=$1`, receipt.RunID).Scan(&workspace))
		raw, err := os.ReadFile(filepath.Join(state, "microvm", "workspaces", workspace, "metadata.json"))
		require.NoError(c, err)
		var metadata struct {
			Machine string `json:"machine"`
		}
		require.NoError(c, json.Unmarshal(raw, &metadata))
		require.NotEmpty(c, metadata.Machine)
		machine = metadata.Machine
		guest, err = csec02ReadGuestMarkers(runMSB, machine)
		require.NoError(c, err)
		require.Contains(c, guest, "debug-api-run")
	}, 15*time.Minute, time.Second, "Debug API invocation must load only in its own machine")
	uid, err := strconv.Atoi(guest["debug-api-run"])
	require.NoError(t, err, "guest uid must be observed")
	require.Positive(t, uid, "repository code must not run as root")
	var run struct {
		Status  string `json:"status"`
		Trigger string `json:"trigger_event"`
	}
	require.EventuallyWithT(t, func(c *assert.CollectT) {
		data, err := r.expect("GET", fmt.Sprintf("/api/repos/%s/runs/%d/status", csec02Repository, receipt.RunID), "", 200)
		require.NoError(c, err)
		require.NoError(c, json.Unmarshal(data, &run))
		require.Equal(c, "success", run.Status)
	}, 10*time.Minute, time.Second, "Debug API queued acknowledgment must reach real completion")
	require.Equal(t, "invoke", run.Trigger)
	var bindings int
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM flow_runtime_host_bindings WHERE workspace_id=$1::uuid AND binding_kind='workflow-invoke' AND binding_id=$2`, workspace, fmt.Sprint(receipt.RunID)).Scan(&bindings))
	require.Equal(t, 1, bindings, "run must bind to its observed guest workspace")
	save("debug-api-invoke.json", mustJSON(t, map[string]any{
		"runId": receipt.RunID, "status": receipt.Status, "requests": receipt.Requests,
		"beforeConfirm": receipt.BeforeConfirm, "workspace": workspace, "machine": machine,
		"guestUid": guest["debug-api-run"], "completedStatus": run.Status, "trigger": run.Trigger,
	}))
	// The enclosing check subsequently asserts sampler, listener and both host
	// marker paths stayed clean throughout this invocation and the TODO runs.
}
