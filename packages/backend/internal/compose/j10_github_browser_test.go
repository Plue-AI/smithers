package compose

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// The C-J10-01 and C-J10-05 automation (apps/app/e2e/real/github-j10/
// pr-shape.spec.ts and merge-on-github.spec.ts) against the composed install:
// the production router, the packaged coding host on the trusted-process
// runtime with the scripted model, so every TODO reaches GitHub through the
// packaged stack.candidate and stack.propose dispatch, real PostgreSQL, the
// GitHub fake (people act through its own controls, never the App's token)
// and the built app (apps/app/dist). Opt-in; it launches Chromium:
//
//	SMITHERS_J10_BROWSER=1 go test ./internal/compose -run 'TestJ10(PRShape|MergeOnGitHub)Browser' -count=1 -timeout 45m
//
// The reference host runs the same specs against github.com (§16.3.1).

func TestJ10PRShapeBrowser(t *testing.T) {
	runJ10Browser(t, "C-J10-01", "pr-shape.spec.ts", "journey-github-pr-shape", false)
}

// merge-on-github.spec.ts is also a reference-host journey spec; the run
// names it and selects only the whole-journey scenario.
func TestJ10MergeOnGitHubBrowser(t *testing.T) {
	runJ10Browser(t, "C-J10-05", "merge-on-github.spec.ts", "journey-github-merge-on-github", true)
}

// A jj wrapper script ahead of the real binary on PATH is skipped: copied
// into a workspace it would find itself first and exec itself forever.
func TestRehearsalJJBinarySkipsWrapperScripts(t *testing.T) {
	wrapper, real, none := t.TempDir(), t.TempDir(), t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(wrapper, "jj"), []byte("#!/bin/sh\nexec jj \"$@\"\n"), 0700))
	require.NoError(t, os.WriteFile(filepath.Join(real, "jj"), []byte("\xcf\xfa\xed\xfe binary"), 0700))
	require.NoError(t, os.WriteFile(filepath.Join(none, "jj"), []byte("not executable"), 0600))
	found, err := rehearsalJJBinary(strings.Join([]string{none, wrapper, real}, string(os.PathListSeparator)))
	require.NoError(t, err)
	require.Equal(t, filepath.Join(real, "jj"), found)
	_, err = rehearsalJJBinary(strings.Join([]string{none, wrapper}, string(os.PathListSeparator)))
	require.Error(t, err)
}

// j10BrowserHost is what the specs read from SMITHERS_J10_COMPOSED_HOST.
type j10BrowserHost struct {
	Origin     string `json:"origin"`
	Repository string `json:"repository"`
	Database   string `json:"database"`
	Commit     string `json:"commit"`
	GitHub     struct {
		URL string `json:"url"`
		Git string `json:"git"`
	} `json:"github"`
	Members map[string]j10BrowserMember `json:"members"`
}

type j10BrowserMember struct {
	Login   string              `json:"login"`
	Cookies []map[string]string `json:"cookies"`
}

func runJ10Browser(t *testing.T, check, spec, scenario string, journey bool) {
	if os.Getenv("SMITHERS_J10_BROWSER") != "1" {
		t.Skip("set SMITHERS_J10_BROWSER=1 for the composed C-J10-01 and C-J10-05 browser journeys")
	}
	// Public repositories support drafts: later TODOs open as drafts.
	t.Setenv("REHEARSAL_PUBLIC_REPOSITORY", "1")
	_, source, _, _ := runtime.Caller(0)
	root := filepath.Clean(filepath.Join(filepath.Dir(source), "../../../.."))
	app := filepath.Join(root, "apps/app")
	if os.Getenv("SMITHERS_REHEARSAL_SPA_DIR") == "" {
		t.Setenv("SMITHERS_REHEARSAL_SPA_DIR", filepath.Join(app, "dist"))
	}
	if _, err := os.Stat(filepath.Join(os.Getenv("SMITHERS_REHEARSAL_SPA_DIR"), "index.html")); err != nil {
		t.Fatalf("build the app first (pnpm --dir apps/app build): %v", err)
	}
	r := newRehearsal(t, "SMITHERS_J10_BROWSER", check, "j10b-")
	if !r.install("0 Install through Machine ready") {
		t.FailNow()
	}
	var ben http.CookieJar
	require.True(t, r.step("0b Ben signs in", "POST /api/members; GitHub sign-in", "maintainer Ben signed in", "T-ACC-02", func() error {
		var err error
		ben, err = r.member("ben", 201, "maintain")
		return err
	}))
	cookies := func(jar http.CookieJar) []map[string]string {
		out := []map[string]string{}
		for _, cookie := range jar.Cookies(mustRehearsalURL(r.origin)) {
			out = append(out, map[string]string{"name": cookie.Name, "value": cookie.Value})
		}
		require.NotEmpty(t, out)
		return out
	}
	commit, _ := exec.Command("/usr/bin/git", "-C", root, "rev-parse", "HEAD").Output()
	host := j10BrowserHost{Origin: r.origin, Repository: "rehearsal-owner/app", Database: r.pool.Config().ConnString(), Commit: strings.TrimSpace(string(commit)),
		Members: map[string]j10BrowserMember{"Owner": {Login: "rehearsal-owner", Cookies: cookies(r.jar)}, "Ben": {Login: "ben", Cookies: cookies(ben)}}}
	host.GitHub.URL, host.GitHub.Git = r.fake.URL, filepath.Join(r.gitRoot, "rehearsal-owner/app.git")
	data, err := json.Marshal(host)
	require.NoError(t, err)
	hostFile := filepath.Join(t.TempDir(), "host.json")
	require.NoError(t, os.WriteFile(hostFile, data, 0600))
	evidence := filepath.Join(r.evidence, "playwright")
	playwright := exec.CommandContext(r.ctx, filepath.Join(app, "node_modules/.bin/playwright"), "test", "--config", "playwright.real.config.ts", "e2e/real/github-j10/"+spec)
	playwright.Dir = app
	environment := slices.DeleteFunc(os.Environ(), func(variable string) bool {
		return strings.HasPrefix(variable, "SMITHERS_REAL_") || strings.HasPrefix(variable, "SMITHERS_JOURNEY") || strings.HasPrefix(variable, "CI=")
	})
	playwright.Env = append(environment, "SMITHERS_REAL_BASE_URL="+r.origin, "SMITHERS_REAL_E2E_HOST=local", "SMITHERS_REAL_AUTH_KIND=owner-session",
		"SMITHERS_J10_COMPOSED_HOST="+hostFile, "SMITHERS_REAL_E2E_REVISION="+host.Commit, "SMITHERS_REAL_TEST_GREP=@real-scenario:"+regexp.QuoteMeta(scenario)+`(?:\s|$)`,
		"SMITHERS_REAL_E2E_REPORT="+filepath.Join(evidence, "results.json"), "SMITHERS_REAL_E2E_ARTIFACTS="+filepath.Join(evidence, "artifacts"))
	if journey {
		// The real-tier config admits a named journey spec on a composed host.
		playwright.Env = append(playwright.Env, "SMITHERS_JOURNEY=github-j10/"+spec, "SMITHERS_JOURNEY_COMPOSED_HOST="+hostFile)
	}
	playwright.Stdout, playwright.Stderr = os.Stdout, os.Stderr
	began := time.Now()
	err = playwright.Run()
	r.step("1 "+spec, "playwright e2e/real/github-j10/"+spec, "the spec passes against the composed install", "T-GH-03", func() error {
		r.actual = "playwright exited after " + time.Since(began).Round(time.Second).String() + "; evidence " + evidence
		return err
	})
}
