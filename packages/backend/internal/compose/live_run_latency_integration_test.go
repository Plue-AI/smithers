package compose

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"testing"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

// The external producer is deterministic; SQLite, Control, gateway folds,
// PostgreSQL admission/authorization, install WebSocket and browser LiveChannel
// are real. The reference Mac's scheduling qualification remains separate.
type journalLatencyHost struct {
	browserFlowDispatcher
	origin string
}

func (h journalLatencyHost) CallRPC(ctx context.Context, _ flowruntime.Target, procedure string, body json.RawMessage) (json.RawMessage, error) {
	if procedure != "Projection.Snapshot" {
		return nil, fmt.Errorf("unexpected mutation %s", procedure)
	}
	req, err := http.NewRequestWithContext(ctx, "POST", h.origin+"/snapshot", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if response.StatusCode != 200 {
		return nil, fmt.Errorf("host %d: %s", response.StatusCode, raw)
	}
	return raw, err
}

func liveJournalLatency(t *testing.T) (string, error) {
	t.Helper()
	f := presenceInstall(t)
	command := exec.CommandContext(t.Context(), "node", "--experimental-strip-types", "testdata/live/journal-host.mjs")
	command.Stderr = os.Stderr
	stdout, err := command.StdoutPipe()
	if err != nil {
		return "", err
	}
	if err := command.Start(); err != nil {
		return "", err
	}
	defer func() { _ = command.Process.Kill(); _ = command.Wait() }()
	scanner := bufio.NewScanner(stdout)
	if !scanner.Scan() {
		return "", fmt.Errorf("journal host failed to start: %v", scanner.Err())
	}
	var host struct {
		Origin string `json:"origin"`
		RunID  string `json:"runId"`
	}
	if err := json.Unmarshal(scanner.Bytes(), &host); err != nil {
		return "", err
	}
	f.p.dispatcher = journalLatencyHost{origin: host.Origin}
	store, err := jobs.NewStore(f.pool)
	if err != nil {
		return "", err
	}
	target := flowruntime.Target{TenantID: fmt.Sprintf("repository:%d", f.row.RepositoryID), PrincipalID: fmt.Sprintf("user:%d", f.user.ID), WorkspaceID: f.row.ID, BindingKind: "mythical-item", BindingID: "latency"}
	receipt, err := store.Admit(t.Context(), jobs.Admission{Scope: jobs.Scope{TenantID: target.TenantID, PrincipalID: target.PrincipalID}, Operation: flowdispatch.OperationLaunch, RequestID: "latency", Payload: json.RawMessage(`{}`), AuthorizationContext: json.RawMessage(`{}`), EffectPolicy: jobs.EffectReconcile, EffectKey: "latency"})
	if err != nil {
		return "", err
	}
	checkpoint, err := json.Marshal(flowdispatch.RuntimeCheckpoint{Version: 1, Target: target, RunID: host.RunID})
	if err != nil {
		return "", err
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE product_job_dispatches SET external_receipt=$2 WHERE operation_id=$1`, receipt.OperationID, checkpoint); err != nil {
		return "", err
	}
	browser := exec.CommandContext(t.Context(), "bun", "testdata/live/journal-latency-client.mjs", f.origin, f.cookie, host.Origin, host.RunID)
	result, err := browser.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("browser latency: %w: %s", err, result)
	}
	var measured struct {
		Changes int `json:"changes"`
		P95     int `json:"p95_ms"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(result), &measured); err != nil {
		return "", err
	}
	if measured.Changes < 50 || measured.P95 > 1000 {
		return "", fmt.Errorf("latency budget: %s", result)
	}
	return string(bytes.TrimSpace(result)), nil
}
func TestLiveRunJournalAppendLatency(t *testing.T) {
	result, err := liveJournalLatency(t)
	require.NoError(t, err)
	t.Log(result)
}
