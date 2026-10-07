package compose

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
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

// reviewSteerEnable opts in to the C-J10-02 browser journey.
const reviewSteerEnable = "SMITHERS_REVIEW_STEER_BROWSER"

// reviewSteerText is the spec's literal review comment (STEER in
// apps/app/e2e/real/github-j10/review-steer.spec.ts); reviewOutsiderText is
// Dana's conversation comment.
const (
	reviewSteerText    = "Use the existing backoff helper"
	reviewOutsiderText = "Outsider note on the retry change"
)

// TestReviewSteerJourneyComposedInstall runs the C-J10-02 browser journey
// (apps/app/e2e/real/github-j10/review-steer.spec.ts) against the composed
// install the J10 rehearsal walks: the production router and workers, real
// PostgreSQL, the GitHub fake (people act through its own controls, never the
// App's token), the packaged coding host on the trusted-process runtime and
// the scripted coding model. Opt-in, because it runs a TODO to In review and
// launches Chromium over the built app:
//
//	pnpm --dir apps/app build
//	SMITHERS_REVIEW_STEER_BROWSER=1 go test ./internal/compose -run TestReviewSteerJourneyComposedInstall -count=1 -timeout 60m
//
// The spec asks for step 4's host restart through the descriptor's restart
// files; the driver recomposes the install behind the same listener. The
// microVM guest (C-SEC-02), a real model's fix and real GitHub stay with the
// reference host.
func TestReviewSteerJourneyComposedInstall(t *testing.T) {
	if os.Getenv(reviewSteerEnable) != "1" {
		t.Skip("enable explicitly with " + reviewSteerEnable + "=1")
	}
	_, source, _, _ := runtime.Caller(0)
	root := filepath.Clean(filepath.Join(filepath.Dir(source), "../../../.."))
	app := filepath.Join(root, "apps/app")
	spa := os.Getenv("SMITHERS_REHEARSAL_SPA_DIR")
	if spa == "" {
		spa = filepath.Join(app, "dist")
	}
	require.FileExists(t, filepath.Join(spa, "index.html"), "build the app first: pnpm --dir apps/app build")
	t.Setenv("SMITHERS_REHEARSAL_SPA_DIR", spa)
	// The model trace keeps each turn's messages: the run's receipt of the steer is read from it.
	t.Setenv("TRACE_MESSAGES", "1")
	r := newRehearsal(t, reviewSteerEnable, "C-J10-02", "rs-")
	const repo = "rehearsal-owner/app"
	if !r.install("0 Install through Machine ready") {
		return
	}
	var ben, alice http.CookieJar
	if !r.step("0b Members", "POST /api/members ×2; GitHub sign-in", "maintainer Ben and member Alice signed in; Dana reads the repository and is no member", "T-ACC-02", func() error {
		var err error
		if ben, err = r.member("ben", 201, "maintain"); err != nil {
			return err
		}
		alice, err = r.member("alice", 202, "write")
		r.fake.SetCollaborator(203, "dana", "read")
		return err
	}) {
		return
	}
	var n int64
	if !r.step("0c T in review", "POST /api/todos; GET /api/todos/{n}; GitHub fake PR", "In review with one open PR whose head adds src/retry.ts", "T-STK-01, T-GH-03", func() error {
		var err error
		if n, err = r.file("Retry webhooks", "[PR] [FILE src/retry.ts] Retry failed webhook deliveries."); err != nil {
			return err
		}
		v, err := r.waitTodoWithin(n, 10*time.Minute, "in_review")
		if err != nil {
			return err
		}
		pull, err := r.checkPull(v.PR.Number, v.PR.Head)
		if err != nil {
			return err
		}
		if files, err := r.prFiles(pull); err != nil || !slices.Contains(files, "src/retry.ts") {
			return fmt.Errorf("T%d's PR #%d changes %v (%v), want src/retry.ts", n, pull.Number, files, err)
		}
		r.actual = fmt.Sprintf("T%d in review; PR #%d at %s", n, pull.Number, short7(pull.Head.SHA))
		return nil
	}) {
		return
	}

	origin, err := url.Parse(r.origin)
	require.NoError(t, err)
	cookies := func(jar http.CookieJar) []map[string]string {
		session := []map[string]string{}
		for _, cookie := range jar.Cookies(origin) {
			session = append(session, map[string]string{"name": cookie.Name, "value": cookie.Value})
		}
		return session
	}
	database := os.Getenv("SMITHERS_DATABASE_URL")
	require.NotEmpty(t, database)
	dir := t.TempDir()
	host := filepath.Join(dir, "composed-host.json")
	restart, restarted := host+".restart", host+".restarted"
	commit := reviewSteerCommit(t, root)
	descriptor, err := json.Marshal(map[string]any{
		"origin": r.origin, "repository": repo, "commit": commit,
		"members": map[string]any{"Will": cookies(r.jar), "Ben": cookies(ben), "Alice": cookies(alice)},
		"github":  map[string]any{"url": r.fake.URL, "logins": map[string]string{"owner": "rehearsal-owner", "alice": "alice", "dana": "dana"}},
		// The scripted edit appends one line to [FILE src/retry.ts]: line 1 is on the PR's head.
		"todo": n, "line": 1,
		"restart": map[string]string{"request": restart, "done": restarted},
	})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(host, descriptor, 0o600))

	playwright := exec.CommandContext(t.Context(), filepath.Join(app, "node_modules/.bin/playwright"), "test", "--config", "playwright.real.config.ts", "e2e/real/github-j10/review-steer.spec.ts")
	playwright.Dir = app
	environment := slices.DeleteFunc(os.Environ(), func(variable string) bool {
		return strings.HasPrefix(variable, "SMITHERS_REAL_") || strings.HasPrefix(variable, "SMITHERS_JOURNEY") || strings.HasPrefix(variable, "CI=")
	})
	playwright.Env = append(environment, "SMITHERS_REAL_BASE_URL="+r.origin, "SMITHERS_REAL_E2E_HOST=local", "SMITHERS_REAL_AUTH_KIND=owner-session",
		"SMITHERS_JOURNEY=review-steer.spec.ts", "SMITHERS_JOURNEY_COMPOSED_HOST="+host, "SMITHERS_JOURNEY_DATABASE_URL="+database,
		"SMITHERS_REAL_TEST_GREP="+regexp.QuoteMeta("journey-review-steer")+`(?:\s|$)`, "SMITHERS_REAL_E2E_REVISION="+commit,
		"SMITHERS_REAL_E2E_REPORT="+filepath.Join(r.evidence, "results.json"), "SMITHERS_REAL_E2E_ARTIFACTS="+filepath.Join(r.evidence, "artifacts"))
	playwright.Stdout, playwright.Stderr = os.Stdout, os.Stderr
	require.NoError(t, playwright.Start())
	exited := make(chan error, 1)
	go func() { exited <- playwright.Wait() }()
	// Step 4: the spec writes a nonce to restart; the install restarts and
	// the nonce is answered in restarted.
	for running := true; running; {
		select {
		case err = <-exited:
			running = false
		case <-time.After(250 * time.Millisecond):
			nonce, readErr := os.ReadFile(restart)
			if readErr != nil {
				continue
			}
			require.NoError(t, os.Remove(restart))
			r.restartBackend()
			require.NoError(t, os.WriteFile(restarted+".tmp", nonce, 0o600))
			require.NoError(t, os.Rename(restarted+".tmp", restarted))
		}
	}
	require.NoError(t, err, "review-steer.spec.ts against the composed install; evidence %s", r.evidence)

	// The coding run itself received Alice's steer and never Dana's comment:
	// the scripted model's trace holds each turn's messages.
	trace, err := os.ReadFile(filepath.Join(r.evidence, "model-turns.jsonl"))
	require.NoError(t, err)
	require.Contains(t, string(trace), reviewSteerText, "no coding turn carried Alice's steer")
	require.NotContains(t, string(trace), reviewOutsiderText, "an outsider's comment reached the coding run")
	t.Logf("C-J10-02 passed against the composed install; evidence %s", r.evidence)
}

// reviewSteerCommit names the checkout under test; the real-tier evidence
// reporter refuses a run without an exact revision.
func reviewSteerCommit(t *testing.T, root string) string {
	output, err := exec.Command("jj", "--ignore-working-copy", "-R", root, "log", "-r", "@-", "--no-graph", "-T", "commit_id").Output()
	require.NoError(t, err, "read the checkout's revision")
	commit := strings.TrimSpace(string(output))
	require.Regexp(t, `^[0-9a-f]{40}$`, commit)
	return commit
}
