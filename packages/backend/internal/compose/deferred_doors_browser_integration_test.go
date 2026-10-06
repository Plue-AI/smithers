package compose

import (
	"encoding/json"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// This opt-in browser journey uses the production install composition and
// owner OAuth session, real PostgreSQL/native repository engine and model host.
// GitHub and the external model provider are loopback fixtures. It launches no
// coding run and makes no microVM qualification claim.
func TestDeferredDoorsBrowser(t *testing.T) {
	r := newRehearsal(t, "SMITHERS_DEFERRED_DOORS_BROWSER", "C-CUT-01", "deferred-")
	html, err := os.ReadFile(filepath.Join(os.Getenv("SMITHERS_DEFERRED_SPA_DIR"), "index.html"))
	require.NoError(t, err)
	sha := os.Getenv("SMITHERS_REAL_E2E_BUILD_SHA")
	require.NotEmpty(t, sha)
	require.True(t, strings.Contains(string(html), `name="smithers-build-sha" content="`+sha+`"`), "the browser receipt must match the built app's SHA")
	r.stepBudget = 2 * time.Minute
	require.True(t, r.setupSource())
	origin := os.Getenv("SMITHERS_DEFERRED_PROVIDER_ORIGIN")
	require.NotEmpty(t, origin)
	var cookie string
	for _, c := range r.jar.Cookies(mustRehearsalURL(r.origin)) {
		if c.Name == "smithers_session" {
			cookie = c.Value
		}
	}
	require.NotEmpty(t, cookie)
	envelope, err := json.Marshal(map[string]string{"username": "rehearsal-owner", "sessionCookie": cookie})
	require.NoError(t, err)
	cmd := exec.CommandContext(r.ctx, "pnpm", "exec", "playwright", "test", "--config", "playwright.real.config.ts", "e2e/real/mvp-deferred-doors.spec.ts", "--workers", "1")
	cmd.Dir = filepath.Join(r.root, "apps/app")
	journal, err := url.JoinPath(origin, "__journal")
	require.NoError(t, err)
	cmd.Env = append(os.Environ(), "SMITHERS_REAL_BASE_URL="+r.origin,
		"SMITHERS_REAL_APP_PATH=/", "SMITHERS_REAL_E2E_HOST=local",
		"SMITHERS_REAL_AUTH_KIND=owner-session", "SMITHERS_REAL_AUTH_ENVIRONMENT=SMITHERS_DEFERRED_OWNER", "SMITHERS_DEFERRED_OWNER="+string(envelope),
		"SMITHERS_DEFERRED_PROVIDER_JOURNAL_URL="+journal,
		"SMITHERS_REAL_E2E_ARTIFACTS="+filepath.Join(r.evidence, "browser"),
		"SMITHERS_REAL_E2E_REPORT="+filepath.Join(r.evidence, "browser.json"),
		"SMITHERS_REAL_E2E_RESULTS="+filepath.Join(r.evidence, "evidence.json"),
		"SMITHERS_REAL_E2E_BUILD_SHA="+os.Getenv("SMITHERS_REAL_E2E_BUILD_SHA"))
	output, err := cmd.CombinedOutput()
	require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "playwright.log"), output, 0600))
	require.NoError(t, err, string(output))
}
