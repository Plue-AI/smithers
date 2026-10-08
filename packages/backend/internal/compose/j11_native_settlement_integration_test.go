package compose

import (
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// An owner merge closes the native retained parent from its committed child
// result. The archive is served by the composed router after actual settlement.
func TestJ11NativeMergedSettlement(t *testing.T) {
	if os.Getenv("SMITHERS_J11_NATIVE_SETTLEMENT") != "1" {
		t.Skip("enable native merged-run qualification")
	}
	t.Setenv("SMITHERS_FEATURE_FLAGS_FLOW_LOAD", "true")
	r := newRehearsal(t, "SMITHERS_J11_NATIVE_SETTLEMENT", "C-J11-01", "j11-settlement-")
	require.True(t, r.install("Install"))
	source, err := os.ReadFile(filepath.Join(r.root, "flows/todo/flow.ts"))
	require.NoError(t, err)
	activateMonitorOverride(t, r, string(source))
	n, err := r.file("Retained native run", "[FILE settled.md] Add a greeting to settled.md")
	require.NoError(t, err)
	card, err := r.waitTodoWithin(n, 8*time.Minute, "in_review")
	require.NoError(t, err)
	require.NotNil(t, card.Run)
	require.NotNil(t, card.Branch)
	require.NoError(t, r.merge(n, card.PR.Head))
	require.NoError(t, r.waitMerged(n, card.PR.Number, card.PR.Head))
	waitMonitorRootSettlement(t, r, card.Run.ID)
	var retained int
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM run_archives WHERE run_id=$1 AND status='completed'`, card.Run.ID).Scan(&retained))
	require.Equal(t, 1, retained)
	request, err := http.NewRequestWithContext(r.ctx, "GET", r.origin+"/api/runs/"+url.PathEscape(card.Branch.ID+":"+card.Run.ID)+"/trace", nil)
	require.NoError(t, err)
	response, err := (&http.Client{Jar: r.jar, Timeout: 45 * time.Second}).Do(request)
	require.NoError(t, err)
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 32<<20))
	require.NoError(t, err)
	require.Equal(t, 200, response.StatusCode, string(raw))
	require.Contains(t, string(raw), `"state":"done"`)
	require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "native-merged-run.json"), raw, 0600))
}

// A review candidate is available before its overridable TODO root settles.
// Qualification reads the native terminal checkpoint, not the candidate state.
func waitMonitorRootSettlement(t *testing.T, r *rehearsal, id string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Minute)
	var status string
	for time.Now().Before(deadline) {
		err := r.pool.QueryRow(r.ctx, `SELECT external_receipt->'run'->>'status' FROM product_job_dispatches WHERE external_receipt->>'runId'=$1 AND status IN ('done','failed','cancelled') ORDER BY updated_at DESC LIMIT 1`, id).Scan(&status)
		if err == nil && (status == "completed" || status == "failed" || status == "cancelled" || status == "interrupted") {
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Fatalf("native root %s never settled: %s", id, status)
}
