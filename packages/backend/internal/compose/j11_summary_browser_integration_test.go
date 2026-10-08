package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/stretchr/testify/require"
)

type rehearsalSummaryModel struct{ url string }

func (m rehearsalSummaryModel) RunModelStream(ctx context.Context, grant ports.ModelStreamGrant) (io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(ctx, "POST", m.url, strings.NewReader(string(grant.Request)))
	if err != nil {
		return nil, err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode != 200 {
		res.Body.Close()
		return nil, fmt.Errorf("model unavailable: %d", res.StatusCode)
	}
	return res.Body, nil
}

// Only the model endpoint is controlled. Native execution, inspection leases,
// archive revisions, durable workers, websocket transport and card are real.
func newRehearsalSummaryModel(t *testing.T, evidence string) ports.ModelStreamHost {
	var blocked atomic.Bool
	blocked.Store(true)
	var failures atomic.Int64
	var successes atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/block" {
			blocked.Store(true)
			w.WriteHeader(204)
			return
		}
		if r.URL.Path == "/unblock" {
			blocked.Store(false)
			w.WriteHeader(204)
			return
		}
		if r.URL.Path == "/calls" {
			fmt.Fprintf(w, `{"failed":%d,"succeeded":%d}`, failures.Load(), successes.Load())
			return
		}
		if blocked.Load() {
			failures.Add(1)
			http.Error(w, "model unavailable", 503)
			return
		}
		var request struct{ Messages []struct{ Content string } }
		if json.NewDecoder(r.Body).Decode(&request) != nil || len(request.Messages) != 1 {
			http.Error(w, "bad model request", 400)
			return
		}
		var phase int
		if _, err := fmt.Sscanf(request.Messages[0].Content, "Phase %d\n", &phase); err != nil {
			http.Error(w, "bad phase", 400)
			return
		}
		_, data, _ := strings.Cut(request.Messages[0].Content, "\n")
		var content struct{ Cells map[string]string }
		if json.Unmarshal([]byte(data), &content) != nil {
			http.Error(w, "bad cells", 400)
			return
		}
		result := map[string]string{fmt.Sprintf("phase:%d", phase): "Recorded checks summarized"}
		for cell := range content.Cells {
			result["cell:"+cell] = "Recorded action explained"
		}
		successes.Add(1)
		text, _ := json.Marshal(result)
		frame, _ := json.Marshal(map[string]any{"type": "delta", "kind": "text", "text": string(text)})
		fmt.Fprintf(w, "%s\n{\"type\":\"done\"}\n", frame)
	}))
	t.Cleanup(server.Close)
	require.NoError(t, os.WriteFile(filepath.Join(evidence, "summary-model-origin"), []byte(server.URL), 0600))
	return rehearsalSummaryModel{server.URL}
}

func TestJ11NativeSummaryBrowser(t *testing.T) {
	if os.Getenv("SMITHERS_J11_SUMMARY_BROWSER") != "1" {
		t.Skip("enable native summary browser qualification")
	}
	spa, err := filepath.Abs("../../../../apps/app/dist")
	require.NoError(t, err)
	t.Setenv("SMITHERS_REHEARSAL_SPA_DIR", spa)
	t.Setenv("SMITHERS_FEATURE_FLAGS_FLOW_LOAD", "true")
	r := newRehearsal(t, "SMITHERS_J11_SUMMARY_BROWSER", "C-J11-01", "j11-summary-")
	require.True(t, r.install("Install"))
	source, err := os.ReadFile(filepath.Join(r.root, "flows/test/fixtures/rehearsal-monitor/retry/flows/todo/flow.ts"))
	require.NoError(t, err)
	active := os.Getenv("SMITHERS_J11_SUMMARY_ACTIVE") == "1"
	if active {
		source = []byte(strings.Replace(string(source), `Effect.fail("Recorded retry probe")`, `Effect.sleep("30 seconds").pipe(Effect.andThen(Effect.fail("Recorded retry probe")))`, 1))
	}
	activateMonitorOverride(t, r, string(source))
	modelOrigin, err := os.ReadFile(filepath.Join(r.evidence, "summary-model-origin"))
	require.NoError(t, err)
	client := &http.Client{Jar: r.jar, Timeout: 45 * time.Second}
	probeDuration := func(id string) float64 {
		response, err := client.Get(r.origin + "/api/runs/" + url.PathEscape(id))
		require.NoError(t, err)
		defer response.Body.Close()
		require.Equal(t, 200, response.StatusCode)
		var monitor struct {
			Attempts []struct {
				Steps []struct {
					Label string
					Took  float64 `json:"took_s"`
				}
			}
		}
		require.NoError(t, json.NewDecoder(response.Body).Decode(&monitor))
		for _, attempt := range monitor.Attempts {
			for _, step := range attempt.Steps {
				if step.Label == "monitor/retry-probe" {
					return step.Took
				}
			}
		}
		t.Fatal("native probe missing")
		return 0
	}
	var baseline float64
	if active {
		response, err := client.Post(string(modelOrigin)+"/unblock", "", nil)
		require.NoError(t, err)
		response.Body.Close()
		number, err := r.file("Uninspected baseline", "[RETRY] Record a native failure")
		require.NoError(t, err)
		card, err := r.waitTodoWithin(number, 3*time.Minute, "failed")
		require.NoError(t, err)
		waitMonitorRootSettlement(t, r, card.Run.ID)
		baseline = probeDuration(card.Branch.ID + ":" + card.Run.ID)
		require.Greater(t, baseline, 29.0)
		response, err = client.Post(string(modelOrigin)+"/block", "", nil)
		require.NoError(t, err)
		response.Body.Close()
	}
	n, err := r.file("Native summaries", "[RETRY] Record a native failure")
	require.NoError(t, err)
	state := "failed"
	if active {
		state = "working"
	}
	card, err := r.waitTodoWithin(n, 3*time.Minute, state)
	require.NoError(t, err)
	if !active {
		waitMonitorRootSettlement(t, r, card.Run.ID)
	}
	var count int
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_requests WHERE operation='run.summary'`).Scan(&count))
	require.Zero(t, count, "uninspected runs must never admit a summary")
	cookies, err := json.Marshal(r.jar.Cookies(mustRehearsalURL(r.origin)))
	require.NoError(t, err)
	command := exec.CommandContext(r.ctx, "pnpm", "exec", "playwright", "test", "--config", "e2e/real/j11.config.ts", "C-J11-01.spec.ts", "--grep", "native inspection backfills")
	command.Dir = filepath.Join(r.root, "apps/app")
	command.Env = append(os.Environ(), "SMITHERS_J11_OUTPUT_DIR="+filepath.Join(r.evidence, "browser"), "SMITHERS_J11_ORIGIN="+r.origin, "SMITHERS_J11_COOKIES="+string(cookies), "SMITHERS_J11_SUMMARY_MODEL="+string(modelOrigin), "SMITHERS_J11_SUMMARY_RUN="+card.Branch.ID+":"+card.Run.ID)
	output, err := command.CombinedOutput()
	t.Log(string(output))
	require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "browser-summary.log"), output, 0600))
	require.NoError(t, err)
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_requests WHERE operation='run.summary' AND state='completed'`).Scan(&count))
	require.Positive(t, count)
	if active {
		waitMonitorRootSettlement(t, r, card.Run.ID)
		duration := probeDuration(card.Branch.ID + ":" + card.Run.ID)
		require.LessOrEqual(t, duration, baseline+2, "blocked summarization must not delay the native step")
		require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "native-step-timing.json"), []byte(fmt.Sprintf(`{"baseline_s":%f,"blocked_s":%f}`, baseline, duration)), 0600))
		response, err := client.Get(string(modelOrigin) + "/calls")
		require.NoError(t, err)
		var before struct{ Succeeded int64 }
		require.NoError(t, json.NewDecoder(response.Body).Decode(&before))
		response.Body.Close()
		number, err := r.file("Uninspected native run", "[RETRY] Record a native failure")
		require.NoError(t, err)
		other, err := r.waitTodoWithin(number, 3*time.Minute, "failed")
		require.NoError(t, err)
		waitMonitorRootSettlement(t, r, other.Run.ID)
		require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT count(*) FROM product_job_requests WHERE operation='run.summary' AND payload->>'RunID'=$1`, other.Branch.ID+":"+other.Run.ID).Scan(&count))
		require.Zero(t, count, "uninspected run must not admit summary jobs")
		response, err = client.Get(string(modelOrigin) + "/calls")
		require.NoError(t, err)
		var after struct{ Succeeded int64 }
		require.NoError(t, json.NewDecoder(response.Body).Decode(&after))
		response.Body.Close()
		require.Equal(t, before.Succeeded, after.Succeeded, "uninspected run must not call summary model")
	}
}
