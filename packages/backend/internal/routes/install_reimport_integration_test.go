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
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
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

// reimportHarness is a GitHub fixture repository (smart HTTP and a REST stub
// whose default branch the test sets) beside the production durable
// importer, the public Git door and the public import routes, over the real
// repository engine with the install main policy on or off.
type reimportHarness struct {
	t             *testing.T
	root, work    string
	github        string
	engine        repository.Config
	client        *repohost.Client
	pool          *pgxpool.Pool
	user          processWorkspaceUser
	server        *httptest.Server
	session       *http.Client
	defaultBranch atomic.Value
}

func newReimportHarness(t *testing.T, install bool) *reimportHarness {
	t.Helper()
	ffi := strings.TrimSpace(os.Getenv("SMITHERS_FFI_LIBRARY_PATH"))
	if ffi == "" {
		t.Skip("SMITHERS_FFI_LIBRARY_PATH is required for the real repository engine")
	}
	h := &reimportHarness{t: t, root: t.TempDir()}
	h.defaultBranch.Store("main")
	h.work = filepath.Join(h.root, "work")
	h.git(h.root, "init", "-q", "-b", "main", h.work)
	h.github = filepath.Join(h.root, "github", "octo", "app.git")
	h.git(h.root, "init", "-q", "--bare", "-b", "main", h.github)
	backend := &cgi.Handler{Path: mustGitPath(t), Args: []string{"http-backend"}, Dir: h.root,
		Env: []string{"GIT_PROJECT_ROOT=" + filepath.Join(h.root, "github"), "GIT_HTTP_EXPORT_ALL=1", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null"}}
	githubGit := httptest.NewServer(backend)
	t.Cleanup(githubGit.Close)
	githubAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/octo/app" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"private": false, "default_branch": h.defaultBranch.Load(), "size": 1})
	}))
	t.Cleanup(githubAPI.Close)
	t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", githubAPI.URL)
	t.Setenv("SMITHERS_GITHUB_GIT_BASE_URL", githubGit.URL)
	t.Setenv("SMITHERS_GITHUB_IMPORT_REFRESH_COOLDOWN", "0s")

	h.pool = setupProcessWorkspacePool(t)
	queries := db.New(h.pool)
	h.user = processWorkspaceCreateUser(t, h.pool, "import_owner")
	h.engine = repository.Config{StoragePath: t.TempDir(), AuthToken: "reimport-engine", FFILibraryPath: ffi, InstallMainMirror: install}
	local, err := repository.OpenLocal(h.engine)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, local.Shutdown(context.Background())) })
	h.client = local.Client()
	require.Equal(t, install, h.client.InstallMainMirror())

	gitHandler := &GitSmartHandler{
		Service: services.NewGitHTTPProxyService(queries, services.NewSSHAuthorizationService(queries), h.client,
			services.WithGitHTTPInstallMainMirror(h.client.InstallMainMirror())),
		Metrics: NewSmithersMetrics(),
	}
	router := chi.NewRouter()
	router.Use(middleware.AuthLoader(queries, config.AuthConfig{}))
	router.Get("/{owner}/{repo}/info/refs", gitHandler.InfoRefs)
	router.Post("/{owner}/{repo}/git-upload-pack", gitHandler.UploadPack)
	router.Post("/{owner}/{repo}/git-receive-pack", gitHandler.ReceivePack)
	h.server = httptest.NewServer(router)
	t.Cleanup(h.server.Close)

	importer := services.NewGitHubImportService(h.pool, queries, queries, h.client, noOAuthDecrypter{}, h.server.URL,
		services.WithGitHubImportProductProvisioning(h.pool), services.WithGitHubImportInstallMainMirror(h.client.InstallMainMirror()))
	importer.EnableDurableWorker()
	workerCtx, stopWorker := context.WithCancel(context.Background())
	workerDone := make(chan struct{})
	go func() { importer.Start(workerCtx); close(workerDone) }()
	t.Cleanup(func() { stopWorker(); <-workerDone })
	imports := &GitHubImportHandler{Service: importer}
	router.With(middleware.RequireAuth).Post("/api/github/import", imports.StartImport)
	router.With(middleware.RequireAuth).Get("/api/github/import/{id}", imports.GetImportJob)
	router.With(middleware.RequireAuth).Post("/api/github/import/{id}/retry", imports.RetryImportJob)
	h.session = processWorkspaceAuthenticatedClient(t, h.server, processWorkspaceCreateSessionCookie(t, queries, h.user))
	return h
}

func (h *reimportHarness) git(dir string, args ...string) string {
	h.t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_AUTHOR_NAME=Fixture", "GIT_AUTHOR_EMAIL=fixture@example.test",
		"GIT_COMMITTER_NAME=Fixture", "GIT_COMMITTER_EMAIL=fixture@example.test")
	out, err := cmd.CombinedOutput()
	require.NoError(h.t, err, "git %v: %s", args, out)
	return strings.TrimSpace(string(out))
}

// commit adds a file named name to the work repository and returns the commit.
func (h *reimportHarness) commit(name string) string {
	h.t.Helper()
	require.NoError(h.t, os.WriteFile(filepath.Join(h.work, name+".txt"), []byte(name+"\n"), 0o644))
	h.git(h.work, "add", "-A")
	h.git(h.work, "commit", "-q", "-m", name)
	return h.git(h.work, "rev-parse", "HEAD")
}

func (h *reimportHarness) call(method, path, body string, status int) map[string]any {
	h.t.Helper()
	req, err := http.NewRequest(method, h.server.URL+path, bytes.NewBufferString(body))
	require.NoError(h.t, err)
	req.Header.Set("Content-Type", "application/json")
	res, err := h.session.Do(req)
	require.NoError(h.t, err)
	defer res.Body.Close()
	var job map[string]any
	require.NoError(h.t, json.NewDecoder(res.Body).Decode(&job))
	require.Equal(h.t, status, res.StatusCode, "%s %s: %v", method, path, job)
	return job
}

// await polls GET /api/github/import/{id} until the job settles.
func (h *reimportHarness) await(id, want string) map[string]any {
	h.t.Helper()
	var job map[string]any
	require.Eventually(h.t, func() bool {
		job = h.call(http.MethodGet, "/api/github/import/"+id, "", http.StatusOK)
		return job["status"] == want || job["status"] == "failed" || job["status"] == "ready"
	}, 90*time.Second, 100*time.Millisecond)
	require.Equal(h.t, want, job["status"], "%v", job)
	return job
}

func (h *reimportHarness) importOnce(want string) map[string]any {
	h.t.Helper()
	job := h.call(http.MethodPost, "/api/github/import", `{"owner":"octo","repo":"app"}`, http.StatusAccepted)
	return h.await(job["importJobId"].(string), want)
}

func (h *reimportHarness) retry(failed map[string]any, want string) map[string]any {
	h.t.Helper()
	retried := h.call(http.MethodPost, "/api/github/import/"+failed["importJobId"].(string)+"/retry", "", http.StatusAccepted)
	return h.await(retried["importJobId"].(string), want)
}

func (h *reimportHarness) bookmark(name string) string {
	h.t.Helper()
	bookmark, found, err := repohost.LookupBookmark(context.Background(), h.client, h.user.Username, "app", name)
	require.NoError(h.t, err)
	if !found {
		return ""
	}
	return bookmark.TargetCommitID
}

// mirrorRefs lists the mirror's git refs under prefix.
func (h *reimportHarness) mirrorRefs(prefix string) string {
	h.t.Helper()
	return h.git(h.root, "--git-dir", h.engine.GitBackendPath(h.user.Username, "app"), "for-each-ref", "--format=%(refname)", prefix)
}

// An install's re-import of a GitHub rewrite of main, through the production
// durable importer, the public Git door and the public import routes: a
// member's replacement ref is refused at the door, one the mirror already
// holds and one GitHub carries change nothing, the import job fails with the
// rewrite visibly on GET /api/github/import/{id}, a retry fails the same way,
// and main stays where it was.
func TestInstallReimportOfAGitHubRewriteFailsVisiblyWithRealRefs(t *testing.T) {
	h := newReimportHarness(t, true)
	base := h.commit("base")
	h.git(h.work, "push", "-q", h.github, base+":refs/heads/main")

	h.importOnce("ready")
	require.Equal(t, base, h.bookmark("main"))
	next := h.commit("merged on GitHub")
	h.git(h.work, "push", "-q", h.github, next+":refs/heads/main")
	h.importOnce("ready")
	require.Equal(t, next, h.bookmark("main"), "the sync fast-forwards install main")

	// GitHub rewrites main; a replacement naming a child of the mirror's main
	// in the rewrite's place would make plain git read it as a fast-forward.
	h.git(h.work, "checkout", "-q", "-b", "rewrite", base)
	rewrite := h.commit("rewritten on GitHub")
	h.git(h.work, "checkout", "-q", "main")
	graft := h.commit("replacement")
	h.git(h.work, "push", "-q", "--force", h.github, rewrite+":refs/heads/main", graft+":refs/replace/"+rewrite)

	// A member's push of the replacement is refused at the public door; the
	// same replacement planted in the mirror is ignored.
	person := (&installMainHarness{pool: h.pool, user: h.user}).token(t, "write:repository", false)
	push := exec.Command("git", "-c", "http.extraHeader=Authorization: Bearer "+person, "push", "--porcelain",
		h.server.URL+"/"+h.user.Username+"/app.git", graft+":refs/replace/"+rewrite, graft+":refs/heads/carrier")
	push.Dir = h.work
	push.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0")
	out, err := push.CombinedOutput()
	require.Error(t, err, "a member pushed a replacement ref: %s", out)
	assert.Contains(t, string(out), "403")
	require.Empty(t, h.bookmark("carrier"), "a refused push wrote one of its refs")
	carrier := exec.Command("git", "-c", "http.extraHeader=Authorization: Bearer "+person, "push", "-q",
		h.server.URL+"/"+h.user.Username+"/app.git", graft+":refs/heads/carrier")
	carrier.Dir = h.work
	carrier.Env = push.Env
	out, err = carrier.CombinedOutput()
	require.NoError(t, err, string(out))
	h.git(h.root, "--git-dir", h.engine.GitBackendPath(h.user.Username, "app"), "update-ref", "refs/replace/"+rewrite, graft)

	failed := h.importOnce("failed")
	assert.Contains(t, failed["error"], "GitHub rewrote main", "the refusal is visible on the job: %v", failed)
	assert.Equal(t, next, h.bookmark("main"), "a GitHub rewrite reached install main")

	failedAgain := h.retry(failed, "failed")
	assert.Contains(t, failedAgain["error"], "GitHub rewrote main")
	assert.Equal(t, next, h.bookmark("main"), "a retry reached install main")
}

// An install's first import of a GitHub repository that carries a
// replacement ref publishes the mirror without refs/replace/*: the install
// refuses that namespace at every receive, so the import drops it from its
// clone before the staged push. A hosted import still copies it.
func TestInstallFreshImportDropsGitHubReplacementRefs(t *testing.T) {
	for _, install := range []bool{true, false} {
		t.Run(map[bool]string{true: "install", false: "hosted"}[install], func(t *testing.T) {
			h := newReimportHarness(t, install)
			base := h.commit("base")
			replaced := h.commit("replaced")
			h.git(h.work, "push", "-q", h.github, base+":refs/heads/main", base+":refs/replace/"+replaced)

			h.importOnce("ready")
			assert.Equal(t, base, h.bookmark("main"))
			if install {
				assert.Empty(t, h.mirrorRefs("refs/replace/"), "the install's mirror holds GitHub's replacement ref")
				return
			}
			assert.Equal(t, "refs/replace/"+replaced, h.mirrorRefs("refs/replace/"))
		})
	}
}

// Spec §16.2: an install binds only a repository whose GitHub default
// branch is main, and that holds after setup. When GitHub's default changes
// to trunk, the next import fails with default_branch_not_main, visibly on
// GET /api/github/import/{id}, before it fetches anything, a retry fails the
// same way, and main stays where it was though GitHub's main moved. Hosted
// imports follow GitHub's default.
func TestInstallImportRefusesAGitHubDefaultBranchChange(t *testing.T) {
	for _, install := range []bool{true, false} {
		t.Run(map[bool]string{true: "install", false: "hosted"}[install], func(t *testing.T) {
			h := newReimportHarness(t, install)
			base := h.commit("base")
			h.git(h.work, "push", "-q", h.github, base+":refs/heads/main")
			h.importOnce("ready")
			require.Equal(t, base, h.bookmark("main"))

			next := h.commit("merged on GitHub")
			h.git(h.work, "push", "-q", h.github, next+":refs/heads/main", next+":refs/heads/trunk")
			h.defaultBranch.Store("trunk")
			if !install {
				h.importOnce("ready")
				assert.Equal(t, next, h.bookmark("main"))
				assert.Equal(t, next, h.bookmark("trunk"))
				return
			}
			failed := h.importOnce("failed")
			assert.Contains(t, failed["error"], "default_branch_not_main", "the refusal is visible on the job: %v", failed)
			assert.Equal(t, base, h.bookmark("main"), "the refused import refreshed main")
			assert.Empty(t, h.bookmark("trunk"), "the refused import fetched GitHub's refs")
			failedAgain := h.retry(failed, "failed")
			assert.Contains(t, failedAgain["error"], "default_branch_not_main")
			assert.Equal(t, base, h.bookmark("main"))
		})
	}
}

func mustGitPath(t *testing.T) string {
	t.Helper()
	path, err := exec.LookPath("git")
	require.NoError(t, err)
	return path
}
