package repohostserver

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// gitWithEnv runs git like nativeGit but with extra environment, so tests can
// pin committer dates.
func gitWithEnv(t *testing.T, env []string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.invalid",
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.invalid",
		"GIT_TERMINAL_PROMPT=0")
	cmd.Env = append(cmd.Env, env...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// commitChain builds a linear ancestry of `commits` in the bare repository at
// gitDir with one fast-import stream: the first `old` commits carry an old
// committer date, the rest a recent one. It returns the tip commit id.
func commitChain(t *testing.T, gitDir string, commits, old int, oldDate, newDate time.Time) string {
	t.Helper()
	var stream strings.Builder
	for i := 0; i < commits; i++ {
		date := newDate
		if i < old {
			date = oldDate
		}
		stamp := fmt.Sprintf("%d +0000", date.Unix())
		fmt.Fprintf(&stream, "commit refs/heads/main\nmark :%d\n", i+1)
		fmt.Fprintf(&stream, "author T <t@example.invalid> %s\n", stamp)
		fmt.Fprintf(&stream, "committer T <t@example.invalid> %s\n", stamp)
		fmt.Fprintf(&stream, "data %d\ncommit %d\n", len(fmt.Sprintf("commit %d", i)), i)
		if i > 0 {
			fmt.Fprintf(&stream, "from :%d\n", i)
		}
	}
	cmd := exec.Command("git", "--git-dir", gitDir, "fast-import", "--quiet")
	cmd.Stdin = strings.NewReader(stream.String())
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git fast-import: %v: %s", err, out)
	}
	return gitWithEnv(t, nil, "--git-dir", gitDir, "rev-parse", "refs/heads/main")
}

func countChangesRequest(t *testing.T, srv *Server, query url.Values) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/repos/alice%3Ademo/changes/count?"+query.Encode(), nil)
	req.Header.Set("Authorization", validAuth())
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	return rec
}

// The ancestry count is complete past the change feed's old twenty-page walk
// bound (#3000): 2001 commits, of which exactly the recent 501 are inside the
// window, however deep the old ones run.
func TestCountChangesBeyondThePageWalkBound(t *testing.T) {
	t.Parallel()
	srv := newTestServer(t)
	gitDir := filepath.Join(srv.config.StoragePath, "alice", "demo", ".jj", "repo", "store", "git")
	if err := os.MkdirAll(gitDir, 0o755); err != nil {
		t.Fatal(err)
	}
	gitWithEnv(t, nil, "init", "--bare", "--quiet", gitDir)

	const total, old = 2001, 1500
	since := time.Date(2026, 9, 22, 0, 0, 0, 0, time.UTC)
	tip := commitChain(t, gitDir, total, old,
		time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC),
		time.Date(2026, 9, 29, 0, 0, 0, 0, time.UTC))

	rec := countChangesRequest(t, srv, url.Values{"rev": {tip}, "since": {since.Format(time.RFC3339)}})
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d; body=%s", rec.Code, rec.Body.String())
	}
	if body := rec.Body.String(); !strings.Contains(body, `"count":501`) {
		t.Fatalf("expected count 501, got %s", body)
	}

	// A window covering the whole ancestry counts all of it.
	rec = countChangesRequest(t, srv, url.Values{"rev": {tip}, "since": {time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).Format(time.RFC3339)}})
	if body := rec.Body.String(); !strings.Contains(body, `"count":2001`) {
		t.Fatalf("expected count 2001, got %s", body)
	}

	// A window after the newest commit counts none, and it is a real zero.
	rec = countChangesRequest(t, srv, url.Values{"rev": {tip}, "since": {time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC).Format(time.RFC3339)}})
	if body := rec.Body.String(); !strings.Contains(body, `"count":0`) {
		t.Fatalf("expected count 0, got %s", body)
	}
}

func TestCountChangesRejectsBadInput(t *testing.T) {
	t.Parallel()
	srv := newTestServer(t)
	gitDir := filepath.Join(srv.config.StoragePath, "alice", "demo", ".jj", "repo", "store", "git")
	if err := os.MkdirAll(gitDir, 0o755); err != nil {
		t.Fatal(err)
	}
	gitWithEnv(t, nil, "init", "--bare", "--quiet", gitDir)
	since := time.Date(2026, 9, 22, 0, 0, 0, 0, time.UTC).Format(time.RFC3339)
	tip := strings.Repeat("a", 40)

	for name, query := range map[string]url.Values{
		"missing_rev":   {"since": {since}},
		"malformed_rev": {"rev": {"main; rm -rf /"}, "since": {since}},
		"short_rev":     {"rev": {"abcdef1"}, "since": {since}},
		"missing_since": {"rev": {tip}},
		"bad_since":     {"rev": {tip}, "since": {"last week"}},
		// A well-formed commit id the repository does not hold.
		"unknown_rev": {"rev": {tip}, "since": {since}},
	} {
		t.Run(name, func(t *testing.T) {
			rec := countChangesRequest(t, srv, query)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d; body=%s", rec.Code, rec.Body.String())
			}
		})
	}
}
