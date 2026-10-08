package compose

import (
	"encoding/json"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestRebaseNowBrowserRehearsal(t *testing.T) {
	if os.Getenv("SMITHERS_REBASE_BROWSER") != "1" {
		t.Skip("requires the served app and real browser")
	}
	t.Setenv("SMITHERS_REBASE_REHEARSAL", "1")
	t.Setenv("SMITHERS_REBASE_BROWSER_PRESS", "1")
	testRebaseNowRehearsal(t, true)
}

func (r *rehearsal) pressRebaseInBrowser(n int64) error {
	origin, err := url.Parse(r.origin)
	if err != nil {
		return err
	}
	cookies := []map[string]string{}
	for _, cookie := range r.jar.Cookies(origin) {
		cookies = append(cookies, map[string]string{"name": cookie.Name, "value": cookie.Value})
	}
	host := filepath.Join(r.t.TempDir(), "composed-host.json")
	descriptor, err := json.Marshal(map[string]any{"origin": r.origin, "repository": "rehearsal-owner/app", "todo": n, "cookies": cookies})
	if err != nil {
		return err
	}
	if err = os.WriteFile(host, descriptor, 0600); err != nil {
		return err
	}
	app := filepath.Join(r.root, "apps/app")
	require.FileExists(r.t, filepath.Join(app, "dist/index.html"))
	playwright := exec.CommandContext(r.t.Context(), filepath.Join(app, "node_modules/.bin/playwright"), "test", "--config", "playwright.real.config.ts", "e2e/real/github-j10/rebase-now.spec.ts")
	playwright.Dir = app
	environment := slices.DeleteFunc(os.Environ(), func(variable string) bool {
		return strings.HasPrefix(variable, "SMITHERS_REAL_") || strings.HasPrefix(variable, "SMITHERS_JOURNEY") || strings.HasPrefix(variable, "CI=")
	})
	playwright.Env = append(environment, "SMITHERS_REAL_BASE_URL="+r.origin, "SMITHERS_REAL_E2E_HOST=local", "SMITHERS_REAL_AUTH_KIND=owner-session", "SMITHERS_REAL_E2E_REVISION="+reviewSteerCommit(r.t, r.root), "SMITHERS_JOURNEY_COMPOSED_HOST="+host, "SMITHERS_REAL_TEST_GREP=journey-rebase-now", "SMITHERS_REAL_E2E_REPORT="+filepath.Join(r.evidence, "browser-results.json"), "SMITHERS_REAL_E2E_ARTIFACTS="+filepath.Join(r.evidence, "browser-artifacts"))
	playwright.Stdout, playwright.Stderr = os.Stdout, os.Stderr
	return playwright.Run()
}
