package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/repository"
)

type noOAuthDecrypter struct{}

func (noOAuthDecrypter) DecryptOAuthAccessToken([]byte) (string, error) {
	return "", fmt.Errorf("the fixture source is public")
}

// An install's re-import of a GitHub rewrite of main, through the production
// durable importer, the public Git door and the public import routes: a
// member's replacement ref is refused at the door, one the mirror already
// holds and one GitHub carries change nothing, the import job fails with the
// rewrite visibly on GET /api/github/import/{id}, a retry fails the same way,
// and main stays where it was.
func TestInstallReimportOfAGitHubRewriteFailsVisiblyWithRealRefs(t *testing.T) {
	ffi := strings.TrimSpace(os.Getenv("SMITHERS_FFI_LIBRARY_PATH"))
	if ffi == "" {
		t.Skip("SMITHERS_FFI_LIBRARY_PATH is required for the real repository engine")
	}
	root := t.TempDir()
	git := func(dir string, args ...string) string {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_AUTHOR_NAME=Fixture", "GIT_AUTHOR_EMAIL=fixture@example.test",
			"GIT_COMMITTER_NAME=Fixture", "GIT_COMMITTER_EMAIL=fixture@example.test")
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, "git %v: %s", args, out)
		return strings.TrimSpace(string(out))
	}
	work := filepath.Join(root, "work")
	git(root, "init", "-q", "-b", "main", work)
	commit := func(name string) string {
		require.NoError(t, os.WriteFile(filepath.Join(work, name+".txt"), []byte(name+"\n"), 0o644))
		git(work, "add", "-A")
		git(work, "commit", "-q", "-m", name)
		return git(work, "rev-parse", "HEAD")
	}
	base := commit("base")
	github := filepath.Join(root, "github", "octo", "app.git")
	git(root, "init", "-q", "--bare", "-b", "main", github)
	git(work, "push", "-q", github, base+":refs/heads/main")
	backend := &cgi.Handler{Path: mustGitPath(t), Args: []string{"http-backend"}, Dir: root,
		Env: []string{"GIT_PROJECT_ROOT=" + filepath.Join(root, "github"), "GIT_HTTP_EXPORT_ALL=1", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null"}}
	githubGit := httptest.NewServer(backend)
	t.Cleanup(githubGit.Close)
	githubAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/octo/app" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"private": false, "default_branch": "main", "size": 1})
	}))
	t.Cleanup(githubAPI.Close)
	t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", githubAPI.URL)
	t.Setenv("SMITHERS_GITHUB_GIT_BASE_URL", githubGit.URL)
	t.Setenv("SMITHERS_GITHUB_IMPORT_REFRESH_COOLDOWN", "0s")

	pool := setupProcessWorkspacePool(t)
	queries := db.New(pool)
	user := processWorkspaceCreateUser(t, pool, "import_owner")
	engineConfig := repository.Config{StoragePath: t.TempDir(), AuthToken: "reimport-engine", FFILibraryPath: ffi, InstallMainMirror: true}
	local, err := repository.OpenLocal(engineConfig)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, local.Shutdown(context.Background())) })
	client := local.Client()

	gitHandler := &GitSmartHandler{
		Service: services.NewGitHTTPProxyService(queries, services.NewSSHAuthorizationService(queries), client,
			services.WithGitHTTPInstallMainMirror(client.InstallMainMirror())),
		Metrics: NewSmithersMetrics(),
	}
	router := chi.NewRouter()
	router.Use(middleware.AuthLoader(queries, config.AuthConfig{}))
	router.Get("/{owner}/{repo}/info/refs", gitHandler.InfoRefs)
	router.Post("/{owner}/{repo}/git-upload-pack", gitHandler.UploadPack)
	router.Post("/{owner}/{repo}/git-receive-pack", gitHandler.ReceivePack)
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)

	importer := services.NewGitHubImportService(pool, queries, queries, client, noOAuthDecrypter{}, server.URL,
		services.WithGitHubImportProductProvisioning(pool), services.WithGitHubImportInstallMainMirror(client.InstallMainMirror()))
	importer.EnableDurableWorker()
	workerCtx, stopWorker := context.WithCancel(context.Background())
	workerDone := make(chan struct{})
	go func() { importer.Start(workerCtx); close(workerDone) }()
	t.Cleanup(func() { stopWorker(); <-workerDone })
	imports := &GitHubImportHandler{Service: importer}
	router.With(middleware.RequireAuth).Post("/api/github/import", imports.StartImport)
	router.With(middleware.RequireAuth).Get("/api/github/import/{id}", imports.GetImportJob)
	router.With(middleware.RequireAuth).Post("/api/github/import/{id}/retry", imports.RetryImportJob)
	session := processWorkspaceAuthenticatedClient(t, server, processWorkspaceCreateSessionCookie(t, queries, user))

	call := func(method, path, body string, status int) map[string]any {
		t.Helper()
		req, err := http.NewRequest(method, server.URL+path, bytes.NewBufferString(body))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		res, err := session.Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		var job map[string]any
		require.NoError(t, json.NewDecoder(res.Body).Decode(&job))
		require.Equal(t, status, res.StatusCode, "%s %s: %v", method, path, job)
		return job
	}
	await := func(id, want string) map[string]any {
		t.Helper()
		var job map[string]any
		require.Eventually(t, func() bool {
			job = call(http.MethodGet, "/api/github/import/"+id, "", http.StatusOK)
			return job["status"] == want || job["status"] == "failed" || job["status"] == "ready"
		}, 90*time.Second, 100*time.Millisecond)
		require.Equal(t, want, job["status"], "%v", job)
		return job
	}
	importOnce := func(want string) map[string]any {
		t.Helper()
		job := call(http.MethodPost, "/api/github/import", `{"owner":"octo","repo":"app"}`, http.StatusAccepted)
		return await(job["importJobId"].(string), want)
	}
	main := func() string {
		t.Helper()
		bookmark, found, err := repohost.LookupBookmark(context.Background(), client, user.Username, "app", "main")
		require.NoError(t, err)
		require.True(t, found)
		return bookmark.TargetCommitID
	}

	importOnce("ready")
	require.Equal(t, base, main())
	next := commit("merged on GitHub")
	git(work, "push", "-q", github, next+":refs/heads/main")
	importOnce("ready")
	require.Equal(t, next, main(), "the sync fast-forwards install main")

	// GitHub rewrites main; a replacement naming a child of the mirror's main
	// in the rewrite's place would make plain git read it as a fast-forward.
	git(work, "checkout", "-q", "-b", "rewrite", base)
	rewrite := commit("rewritten on GitHub")
	git(work, "checkout", "-q", "main")
	graft := commit("replacement")
	git(work, "push", "-q", "--force", github, rewrite+":refs/heads/main", graft+":refs/replace/"+rewrite)

	// A member's push of the replacement is refused at the public door; the
	// same replacement planted in the mirror is ignored.
	person := (&installMainHarness{pool: pool, user: processWorkspaceUser{ID: user.ID, Username: user.Username}}).token(t, "write:repository", false)
	push := exec.Command("git", "-c", "http.extraHeader=Authorization: Bearer "+person, "push", "--porcelain",
		server.URL+"/"+user.Username+"/app.git", graft+":refs/replace/"+rewrite, graft+":refs/heads/carrier")
	push.Dir = work
	push.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0")
	out, err := push.CombinedOutput()
	require.Error(t, err, "a member pushed a replacement ref: %s", out)
	assert.Contains(t, string(out), "403")
	_, found, err := repohost.LookupBookmark(context.Background(), client, user.Username, "app", "carrier")
	require.NoError(t, err)
	require.False(t, found, "a refused push wrote one of its refs")
	carrier := exec.Command("git", "-c", "http.extraHeader=Authorization: Bearer "+person, "push", "-q",
		server.URL+"/"+user.Username+"/app.git", graft+":refs/heads/carrier")
	carrier.Dir = work
	carrier.Env = push.Env
	out, err = carrier.CombinedOutput()
	require.NoError(t, err, string(out))
	git(root, "--git-dir", engineConfig.GitBackendPath(user.Username, "app"), "update-ref", "refs/replace/"+rewrite, graft)

	failed := importOnce("failed")
	assert.Contains(t, failed["error"], "GitHub rewrote main", "the refusal is visible on the job: %v", failed)
	assert.Equal(t, next, main(), "a GitHub rewrite reached install main")

	retried := call(http.MethodPost, "/api/github/import/"+failed["importJobId"].(string)+"/retry", "", http.StatusAccepted)
	failedAgain := await(retried["importJobId"].(string), "failed")
	assert.Contains(t, failedAgain["error"], "GitHub rewrote main")
	assert.Equal(t, next, main(), "a retry reached install main")
}

func mustGitPath(t *testing.T) string {
	t.Helper()
	path, err := exec.LookPath("git")
	require.NoError(t, err)
	return path
}
