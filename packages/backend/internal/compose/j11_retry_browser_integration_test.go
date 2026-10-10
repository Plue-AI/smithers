package compose

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// Ordinary Retry keeps its pinned version after a newer Active source loads.
func TestJ11NativeRetryBrowser(t *testing.T) {
	if os.Getenv("SMITHERS_J11_RETRY_BROWSER") != "1" {
		t.Skip("enable native Retry browser qualification")
	}
	spa, err := filepath.Abs("../../../../apps/app/dist")
	require.NoError(t, err)
	t.Setenv("SMITHERS_REHEARSAL_SPA_DIR", spa)
	t.Setenv("SMITHERS_FEATURE_FLAGS_FLOW_LOAD", "true")
	r := newRehearsal(t, "SMITHERS_J11_RETRY_BROWSER", "C-J11-01", "j11-retry-")
	require.True(t, r.install("Install"))
	retrySource, err := os.ReadFile(filepath.Join(r.root, "flows/test/fixtures/rehearsal-monitor-retry-todo-source.ts"))
	require.NoError(t, err)
	activateMonitorOverride(t, r, string(retrySource))
	retry, err := r.file("Native Retry", "[RETRY] Record a native failure")
	require.NoError(t, err)
	retryCard, err := r.waitTodoWithin(retry, 3*time.Minute, "failed")
	require.NoError(t, err)
	require.NotNil(t, retryCard.Run)
	require.NotNil(t, retryCard.FlowVersion)
	_, newer := activateMonitorOverride(t, r, strings.ReplaceAll(string(retrySource), `implementationVersion: "1"`, `implementationVersion: "2"`))
	require.NotEqual(t, retryCard.FlowVersion.Digest, newer, "Retry must keep the failed attempt's pin after Active changes")

	cookies, err := json.Marshal(r.jar.Cookies(mustRehearsalURL(r.origin)))
	require.NoError(t, err)
	command := exec.CommandContext(r.ctx, "pnpm", "exec", "playwright", "test", "--config", "e2e/real/j11.config.ts", "C-J11-04.spec.ts", "--grep", "native Retry")
	command.Dir = filepath.Join(r.root, "apps/app")
	command.Env = append(os.Environ(), "SMITHERS_J11_OUTPUT_DIR="+filepath.Join(r.evidence, "browser"), "SMITHERS_J11_ORIGIN="+r.origin, "SMITHERS_J11_COOKIES="+string(cookies), "SMITHERS_J11_RETRY_N="+strconv.FormatInt(retry, 10), "SMITHERS_J11_RETRY_RUN="+retryCard.Branch.ID+":"+retryCard.Run.ID)
	output, err := command.CombinedOutput()
	t.Log(string(output))
	_ = os.WriteFile(filepath.Join(r.evidence, "browser-retry.log"), output, 0600)
	require.NoError(t, err)
}

func activateMonitorOverride(t *testing.T, r *rehearsal, source string) (string, string) {
	t.Helper()
	commit, err := r.pushGitHubMain("Install monitor TODO override", map[string]string{"flows/todo/flow.ts": source})
	require.NoError(t, err)
	deadline := time.Now().Add(3 * time.Minute)
	for time.Now().Before(deadline) {
		var status, digest, loadError string
		var active bool
		err = r.pool.QueryRow(r.ctx, `SELECT status,digest,is_active,load_error FROM workflow_definitions WHERE name='todo' AND source_commit=$1 ORDER BY id DESC LIMIT 1`, commit).Scan(&status, &digest, &active, &loadError)
		if err == nil && status == "failed" {
			t.Fatalf("monitor source validation: %s", loadError)
		}
		if err == nil && status == "loaded" && active {
			return commit, digest
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Fatal(fmt.Sprintf("monitor source never became Active at %s: %v", commit, err))
	return "", ""
}
