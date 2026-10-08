package compose

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/stretchr/testify/require"
)

// delegatedLoginHost is what the C-J6-02 source-CLI test reads from
// host.json: the installed composition's origin, the read-only evidence
// listener, B's browser cookies, one-time GitHub consent codes that sign in
// as B, and the fixture TODOs.
type delegatedLoginHost struct {
	Origin    string            `json:"origin"`
	Inspector string            `json:"inspector"`
	Member    string            `json:"member"`
	Cookies   map[string]string `json:"cookies"`
	Codes     []string          `json:"codes"`
	T1        int64             `json:"t1"`
	T2        int64             `json:"t2"`
	T3        int64             `json:"t3"`
	Head      string            `json:"head"`
	Pull      int64             `json:"pull"`
}

// TestDelegatedLoginCLIHarness serves the installed composition (production
// StartWithOptions, real PostgreSQL, the GitHub fake and the native repository
// engine) to packages/smithers/test/DelegatedLogin.integration.test.ts
// (C-J6-02). That test runs the source CLI's `smthrs login --agent`, catalog
// commands and B's browser approval itself. This harness only seeds the fixture
// stack and answers fixed read-only evidence queries until the test writes
// done.
func TestDelegatedLoginCLIHarness(t *testing.T) {
	dir := os.Getenv("SMITHERS_DELEGATED_LOGIN_HARNESS")
	if dir == "" {
		t.Skip("driven by packages/smithers/test/DelegatedLogin.integration.test.ts")
	}
	t.Setenv("SMITHERS_BRANCH_FILES_INTEGRATION", "1")
	r := newRehearsal(t, "SMITHERS_BRANCH_FILES_INTEGRATION", "C-J6-02", "delegated-login-")
	require.True(t, r.setupSource(), r.logs.String())
	require.NoError(t, r.waitStackActive())
	q := db.New(r.pool)
	repository, err := services.InstallRepositoryID(r.ctx, q)
	require.NoError(t, err)

	// B is a maintainer with a browser session; the owner files the TODOs.
	ben, err := r.member("ben", 201, "maintain")
	require.NoError(t, err)
	t1, err := r.file("Reviewed greeting", "Retain the greeting")
	require.NoError(t, err)
	t2, err := r.file("Queued farewell", "Add a farewell")
	require.NoError(t, err)
	t3, err := r.file("Queued retry", "Add retry")
	require.NoError(t, err)

	// T1's PR is written by an external GitHub writer, never by a process on
	// the install; GitHub's fake then makes a real squash object at merge.
	checkout := filepath.Join(r.gitRoot, "seed")
	git := func(args ...string) string {
		t.Helper()
		command := exec.CommandContext(r.ctx, "/usr/bin/git", append([]string{"-C", checkout}, args...)...)
		command.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+os.DevNull,
			"GIT_AUTHOR_NAME=Fixture", "GIT_AUTHOR_EMAIL=fixture@example.test", "GIT_COMMITTER_NAME=Fixture", "GIT_COMMITTER_EMAIL=fixture@example.test")
		output, err := command.CombinedOutput()
		require.NoError(t, err, string(output))
		return strings.TrimSpace(string(output))
	}
	git("switch", "-c", "smithers/delegated-login")
	require.NoError(t, os.WriteFile(filepath.Join(checkout, "greeting.txt"), []byte("Hello\n"), 0600))
	git("add", "greeting.txt")
	git("commit", "-m", "Reviewed greeting")
	head := git("rev-parse", "HEAD")
	git("push", filepath.Join(r.gitRoot, "rehearsal-owner/app.git"), "HEAD:refs/heads/smithers/delegated-login")
	codec, err := webhook.NewSecretCodec("rehearsal-encryption-key")
	require.NoError(t, err)
	connections := services.NewRepoConnectionService(r.pool, services.NewGitHubAppCredentialStore(r.pool, codec))
	access, err := connections.CreateGitHubInstallationToken(r.ctx, r.installationID, services.GitHubTokenScope{AllRepositories: true, Permissions: map[string]string{"pull_requests": "write"}})
	require.NoError(t, err)
	request, err := http.NewRequestWithContext(r.ctx, "POST", r.fake.URL+"/repos/rehearsal-owner/app/pulls", strings.NewReader(`{"title":"Reviewed greeting","head":"smithers/delegated-login","base":"main"}`))
	require.NoError(t, err)
	request.Header.Set("Authorization", "Bearer "+access.Token)
	response, err := r.fake.Client().Do(request)
	require.NoError(t, err)
	require.Equal(t, 201, response.StatusCode)
	var pull struct {
		Number  int64
		HTMLURL string `json:"html_url"`
	}
	require.NoError(t, json.NewDecoder(response.Body).Decode(&pull))
	require.NoError(t, response.Body.Close())
	r.fake.RequireCheck("required/unit")
	r.fake.SetCheck("rehearsal-owner/app", head, "required/unit", "completed", "success")
	_, err = r.pool.Exec(r.ctx, `UPDATE mythical_items SET state='proposed',attempt=1,candidate_head=$2,candidate_verified=true,pr_number=$3,pr_url=$4,pr_state='open',pr_head=$2 WHERE repository_id=$1 AND number=$5`, repository, head, pull.Number, pull.HTMLURL, t1)
	require.NoError(t, err)

	inspector := httptest.NewServer(delegatedLoginInspector(r))
	t.Cleanup(inspector.Close)
	cookies := map[string]string{}
	for _, cookie := range ben.Cookies(mustRehearsalURL(r.origin)) {
		cookies[cookie.Name] = cookie.Value
	}
	require.NotEmpty(t, cookies["smithers_session"], "B has no browser session")
	// Each `smthrs login` consents once on GitHub as B.
	codes := []string{"ben-cli-agent-code", "ben-cli-plain-code"}
	for _, code := range codes {
		r.fake.SignInAs(code, 201)
	}
	host, err := json.Marshal(delegatedLoginHost{Origin: r.origin, Inspector: inspector.URL, Member: "ben", Cookies: cookies, Codes: codes, T1: t1, T2: t2, T3: t3, Head: head, Pull: pull.Number})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(dir, "host.json.tmp"), host, 0600))
	require.NoError(t, os.Rename(filepath.Join(dir, "host.json.tmp"), filepath.Join(dir, "host.json")))
	fmt.Println("DELEGATED_LOGIN_READY", r.origin)
	deadline := time.Now().Add(20 * time.Minute)
	for {
		if _, err := os.Stat(filepath.Join(dir, "done")); err == nil {
			return
		}
		require.True(t, time.Now().Before(deadline), "the CLI test did not finish within 20 minutes")
		select {
		case <-r.ctx.Done():
			t.Fatal("composition stopped before the CLI test finished")
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// delegatedLoginInspector answers fixed read-only queries over the install's
// own rows and the fake's recorded writes. It never mints, writes or reveals a
// credential: a token row is found by its digest and returned without it.
func delegatedLoginInspector(r *rehearsal) http.Handler {
	rows := func(w http.ResponseWriter, sql string, args ...any) {
		var out json.RawMessage
		err := r.pool.QueryRow(r.ctx, `SELECT COALESCE(json_agg(row_to_json(x)),'[]'::json) FROM (`+sql+`) x`, args...).Scan(&out)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(out)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /token", func(w http.ResponseWriter, req *http.Request) {
		rows(w, `SELECT t.id, u.username, t.name, t.scopes, t.system_issued, t.expires_at FROM access_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1`, req.URL.Query().Get("digest"))
	})
	mux.HandleFunc("GET /audit", func(w http.ResponseWriter, req *http.Request) {
		rows(w, `SELECT id, actor_name, action, target_name, metadata FROM audit_log WHERE event_type = 'delegated.request' AND metadata->>'token_id' = $1 ORDER BY id`, req.URL.Query().Get("token"))
	})
	mux.HandleFunc("GET /events", func(w http.ResponseWriter, req *http.Request) {
		rows(w, `SELECT event_type, data FROM product_job_events WHERE event_type = $1 ORDER BY recorded_at, sequence`, req.URL.Query().Get("type"))
	})
	mux.HandleFunc("GET /approvals", func(w http.ResponseWriter, _ *http.Request) {
		rows(w, `SELECT a.id, u.username AS member, a.credential_id, a.command, a.state FROM approvals a JOIN users u ON u.id = a.member_id ORDER BY a.created_at`)
	})
	mux.HandleFunc("GET /github", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(r.fake.Writes())
	})
	return mux
}
