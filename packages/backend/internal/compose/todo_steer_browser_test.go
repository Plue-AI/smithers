package compose

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// Supplemental C-J3-05/C-J7-01 browser proof on the composed install and real
// coding host. The reference spec additionally exercises Ben's Claude Code
// skill and actual provider requests; microVM isolation stays in C-SEC-02.
func TestTodoSteerBrowserComposedInstall(t *testing.T) {
	const enable = "SMITHERS_TODO_STEER_BROWSER"
	if os.Getenv(enable) != "1" {
		t.Skip("enable with " + enable + "=1")
	}
	_, source, _, _ := runtime.Caller(0)
	root := filepath.Clean(filepath.Join(filepath.Dir(source), "../../../.."))
	app := filepath.Join(root, "apps/app")
	spa := filepath.Join(app, "dist")
	require.FileExists(t, filepath.Join(spa, "index.html"))
	t.Setenv("SMITHERS_REHEARSAL_SPA_DIR", spa)
	t.Setenv("TRACE_MESSAGES", "1")
	r := newRehearsal(t, enable, "C-J3-05", "steer-browser-")
	require.True(t, r.install("install"))
	n, err := r.file("Retry delivery", "[ASK] [FILE retry.ts] Add retries to webhook delivery in retry.ts")
	require.NoError(t, err)
	require.EqualValues(t, 1, n)
	_, err = r.waitTodoWithin(n, 3*time.Minute, "needs_you")
	require.NoError(t, err)
	ben, err := r.member("ben", 201, "write")
	require.NoError(t, err)
	origin, err := url.Parse(r.origin)
	require.NoError(t, err)
	cookies := func(jar http.CookieJar) []map[string]string {
		out := []map[string]string{}
		for _, cookie := range jar.Cookies(origin) {
			out = append(out, map[string]string{"name": cookie.Name, "value": cookie.Value})
		}
		return out
	}
	host := filepath.Join(t.TempDir(), "host.json")
	raw, err := json.Marshal(map[string]any{"origin": r.origin, "repository": "rehearsal-owner/app", "database": os.Getenv("SMITHERS_DATABASE_URL"), "evidence": r.evidence,
		"members": map[string]any{"Will": cookies(r.jar), "Ben": cookies(ben)}})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(host, raw, 0600))
	cmd := exec.CommandContext(t.Context(), filepath.Join(app, "node_modules/.bin/playwright"), "test", "--config", "playwright.real.config.ts", "e2e/real/todo-steer.spec.ts")
	cmd.Dir = app
	environment := slices.DeleteFunc(os.Environ(), func(variable string) bool {
		return strings.HasPrefix(variable, "SMITHERS_REAL_") || strings.HasPrefix(variable, "SMITHERS_JOURNEY") || strings.HasPrefix(variable, "CI=")
	})
	cmd.Env = append(environment, "SMITHERS_REAL_BASE_URL="+r.origin, "SMITHERS_REAL_E2E_HOST=local", "SMITHERS_REAL_AUTH_KIND=owner-session",
		"SMITHERS_JOURNEY=todo-steer.spec.ts", "SMITHERS_JOURNEY_COMPOSED_HOST="+host, "SMITHERS_REAL_TEST_GREP=journey-todo-steer",
		"SMITHERS_REAL_E2E_REVISION="+reviewSteerCommit(t, root), "SMITHERS_REAL_E2E_REPORT="+filepath.Join(r.evidence, "results.json"), "SMITHERS_REAL_E2E_ARTIFACTS="+filepath.Join(r.evidence, "artifacts"))
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	require.NoError(t, cmd.Run())
	turns, err := r.modelTurns()
	require.NoError(t, err)
	for _, turn := range turns {
		text := turnText(turn)
		if turn["kind"] == "chat" && strings.Contains(text, "Use the existing retry helper") {
			require.Contains(t, text, "use the existing retry helper", "first post-answer request carries browser steer")
			require.Contains(t, text, "keep the max at 5", "first post-answer request carries amendment")
			return
		}
	}
	t.Fatal("no post-answer model request")
}
