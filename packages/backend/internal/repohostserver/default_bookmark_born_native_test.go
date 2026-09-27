package repohostserver

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostffi"
)

// nativeRepoHost is a repo-host backed by the real smithers-ffi library, with
// a git remote that stands in for the API's smart-HTTP proxy.
type nativeRepoHost struct {
	t      *testing.T
	srv    *Server
	remote string
	// headers are the viewer headers the stand-in proxy adds to every git
	// request, as the API does for the credential it authenticated.
	headers http.Header
}

func newNativeRepoHost(t *testing.T) *nativeRepoHost {
	t.Helper()
	library := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	if library == "" {
		t.Skip("set SMITHERS_FFI_LIBRARY_PATH to the built smithers-ffi library")
	}
	native := repohostffi.New(library)
	require.NoError(t, native.Load())
	srv, err := NewWithFFI(Config{StoragePath: t.TempDir(), AuthToken: testAuthToken}, native)
	require.NoError(t, err)
	h := &nativeRepoHost{t: t, srv: srv, headers: http.Header{}}
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/info/refs"):
			r.URL.Path = "/repos/alice/demo/git/info-refs"
		case strings.HasSuffix(r.URL.Path, "/git-upload-pack"):
			r.URL.Path = "/repos/alice/demo/git/upload-pack"
		case strings.HasSuffix(r.URL.Path, "/git-receive-pack"):
			r.URL.Path = "/repos/alice/demo/git/receive-pack"
		default:
			http.NotFound(w, r)
			return
		}
		r.RequestURI = ""
		r.Header.Set("Authorization", validAuth())
		for name, values := range h.headers {
			r.Header[name] = values
		}
		srv.Handler().ServeHTTP(w, r)
	}))
	t.Cleanup(proxy.Close)
	h.remote = proxy.URL + "/demo.git"
	return h
}

// api calls a repo-host JSON endpoint and returns the status and body.
func (h *nativeRepoHost) api(method, path string, body any) (int, string) {
	h.t.Helper()
	var reader bytes.Buffer
	if body != nil {
		require.NoError(h.t, json.NewEncoder(&reader).Encode(body))
	}
	req := httptest.NewRequest(method, path, &reader)
	req.Header.Set("Authorization", validAuth())
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.srv.Handler().ServeHTTP(rec, req)
	return rec.Code, rec.Body.String()
}

func (h *nativeRepoHost) gitDir() string { return h.srv.config.GitBackendPath("alice", "demo") }

// git runs git with a fixed identity; it fails the test unless ok matches.
func nativeGit(t *testing.T, ok bool, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.invalid",
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.invalid", "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.CombinedOutput()
	if ok {
		require.NoError(t, err, "git %v: %s", args, out)
	} else {
		require.Error(t, err, "git %v succeeded: %s", args, out)
	}
	return strings.TrimSpace(string(out))
}

// initRepo creates alice/demo with default bookmark main and no commits, and
// a client clone with one commit on feature pushed through the remote.
func (h *nativeRepoHost) initRepo() (client string) {
	h.t.Helper()
	code, body := h.api(http.MethodPost, "/repos/init", map[string]any{"owner": "alice", "repo": "demo", "default_bookmark": "main"})
	require.Equal(h.t, http.StatusCreated, code, body)
	client = filepath.Join(h.t.TempDir(), "client")
	nativeGit(h.t, true, "init", "--quiet", "--initial-branch=feature", client)
	require.NoError(h.t, os.WriteFile(filepath.Join(client, "a.txt"), []byte("a\n"), 0o644))
	nativeGit(h.t, true, "-C", client, "add", "a.txt")
	nativeGit(h.t, true, "-C", client, "commit", "--quiet", "-m", "a")
	nativeGit(h.t, true, "-C", client, "push", "--quiet", h.remote, "HEAD:refs/heads/feature")
	return client
}

func (h *nativeRepoHost) bookmark(name string) repohost.Bookmark {
	h.t.Helper()
	code, body := h.api(http.MethodGet, "/repos/"+url.PathEscape("alice:demo")+"/bookmarks/"+name, nil)
	require.Equal(h.t, http.StatusOK, code, body)
	var bookmark repohost.Bookmark
	require.NoError(h.t, json.Unmarshal([]byte(body), &bookmark))
	return bookmark
}

// A default bookmark created by a write inside repo-host (here the bookmark
// API; landings and imports release the same lock) is born before the write
// returns, so once it is lost, even before any push, a push cannot recreate
// it.
func TestDefaultBookmarkCreatedInsideRepoHostCannotBeRecreatedByPush(t *testing.T) {
	h := newNativeRepoHost(t)
	client := h.initRepo()
	feature := h.bookmark("feature")

	id := "/repos/" + url.PathEscape("alice:demo")
	code, body := h.api(http.MethodPost, id+"/bookmarks", map[string]any{"name": "main", "target_change_id": feature.TargetChangeID})
	require.Equal(t, http.StatusCreated, code, body)
	require.True(t, defaultBookmarkBorn(h.gitDir(), "main"), "the bookmark write did not record the default")

	// Lost outside every push (repo-host itself refuses to delete it).
	nativeGit(t, true, "--git-dir", h.gitDir(), "update-ref", "-d", "refs/heads/main")
	code, body = h.api(http.MethodPost, "/repos/alice/demo/git/import-refs", nil)
	require.Equal(t, http.StatusOK, code, body)

	out := nativeGit(t, false, "-C", client, "push", h.remote, "HEAD:refs/heads/main")
	require.Contains(t, out, "403")
	_, err := exec.Command("git", "--git-dir", h.gitDir(), "rev-parse", "--verify", "--quiet", "refs/heads/main").Output()
	require.Error(t, err, "the push recreated main")
}

// Repositories whose default exists when repo-host starts are marked born by
// the startup backfill, before any request touches them.
func TestDefaultBookmarkBornBackfill(t *testing.T) {
	h := newNativeRepoHost(t)
	h.initRepo()
	nativeGit(t, true, "--git-dir", h.gitDir(), "update-ref", "refs/heads/main", "refs/heads/feature")
	_ = os.Remove(filepath.Join(h.gitDir(), defaultBookmarkBornFile))
	require.False(t, defaultBookmarkBorn(h.gitDir(), "main"))
	h.srv.sweepAllRepositories(context.Background())
	require.True(t, defaultBookmarkBorn(h.gitDir(), "main"))
}
