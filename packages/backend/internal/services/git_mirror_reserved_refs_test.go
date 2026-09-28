package services

import (
	"bytes"
	"compress/zlib"
	"context"
	"crypto/sha1"
	"fmt"
	"io"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestGitMirrorReservedSmithersRefsAreNeverRetried(t *testing.T) {
	for _, ref := range []string{
		"refs/smithers/workspaces/owned/head",
		"refs/smithers/workspaces/owned/sources/0123456789abcdef",
	} {
		t.Run(ref, func(t *testing.T) {
			q, service := mirrorCredentialFixture(t)
			q.refs[ref] = db.GithubMirrorSyncRefResult{Name: ref, Status: gitMirrorRefFailed}
			_, err := service.RetryMirrorRef(context.Background(), 7, 19, "native", "copy", ref)
			require.Error(t, err)
			assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))
			assert.Empty(t, q.created, "reserved refs are refused before minting credentials")
			assert.Zero(t, q.run.ID, "reserved refs are refused before creating a run")
		})
	}
}

// Build disposable bare Git objects directly. These fixtures have no relation
// to the checkout's version-control state and use no user Git configuration.
func mirrorFixtureObject(t *testing.T, repository, kind, body string) string {
	t.Helper()
	raw := []byte(fmt.Sprintf("%s %d\x00%s", kind, len(body), body))
	hash := fmt.Sprintf("%x", sha1.Sum(raw))
	var encoded bytes.Buffer
	writer := zlib.NewWriter(&encoded)
	_, err := writer.Write(raw)
	require.NoError(t, err)
	require.NoError(t, writer.Close())
	dir := filepath.Join(repository, "objects", hash[:2])
	require.NoError(t, os.MkdirAll(dir, 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(dir, hash[2:]), encoded.Bytes(), 0o600))
	return hash
}

func mirrorFixtureRef(t *testing.T, repository, name, hash string) {
	t.Helper()
	path := filepath.Join(repository, filepath.FromSlash(name))
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o700))
	require.NoError(t, os.WriteFile(path, []byte(hash+"\n"), 0o600))
}

func TestGitMirrorReservedRefsStayPrivateThroughActualHTTPTransport(t *testing.T) {
	git, err := exec.LookPath("git")
	require.NoError(t, err, "the Git HTTP fixture needs git http-backend")
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	root := t.TempDir()
	source, target := filepath.Join(root, "source.git"), filepath.Join(root, "target.git")
	commits := make(map[string]string)
	for _, repository := range []string{source, target} {
		require.NoError(t, os.MkdirAll(filepath.Join(repository, "refs", "heads"), 0o700))
		require.NoError(t, os.WriteFile(filepath.Join(repository, "HEAD"), []byte("ref: refs/heads/main\n"), 0o600))
		require.NoError(t, os.WriteFile(filepath.Join(repository, "config"), []byte("[core]\n bare = true\n[http]\n receivepack = true\n[receive]\n unpackLimit = 10000\n[gc]\n auto = 0\n"), 0o600))
		tree := mirrorFixtureObject(t, repository, "tree", "")
		for _, name := range []string{"base", "public", "note", "custom", "private-head", "private-source"} {
			if repository == target && name != "base" {
				continue
			}
			parent := ""
			if name != "base" {
				parent = "parent " + commits["base"] + "\n"
			}
			commits[name] = mirrorFixtureObject(t, repository, "commit", "tree "+tree+"\n"+parent+"author Fixture <fixture@example.test> 1 +0000\ncommitter Fixture <fixture@example.test> 1 +0000\n\n"+name+"\n")
		}
	}
	workspaceHead := "refs/smithers/workspaces/owned/head"
	retainedSource := "refs/smithers/workspaces/owned/sources/" + commits["private-source"]
	sourceRefs := map[string]string{
		"refs/heads/main": commits["public"], "refs/tags/v1": commits["public"],
		"refs/notes/review": commits["note"], "refs/custom/keep": commits["custom"],
		"refs/notes/existing": commits["base"], "refs/custom/existing": commits["base"],
		"refs/smithers-user/published": commits["custom"],
		workspaceHead:                  commits["private-head"], retainedSource: commits["private-source"],
		"refs/jj/keep/source": commits["private-source"], "refs/pull/1/head": commits["private-head"],
	}
	for name, hash := range sourceRefs {
		mirrorFixtureRef(t, source, name, hash)
	}
	protectedTarget := map[string]string{
		workspaceHead: commits["base"], "refs/smithers/workspaces/target-only/head": commits["base"],
		"refs/jj/keep/target-only": commits["base"], "refs/pull/2/head": commits["base"],
	}
	for name, hash := range protectedTarget {
		mirrorFixtureRef(t, target, name, hash)
	}
	for _, name := range []string{"refs/heads/main", "refs/notes/existing", "refs/custom/existing", "refs/custom/obsolete"} {
		mirrorFixtureRef(t, target, name, commits["base"])
	}
	backend := &cgi.Handler{Path: git, Args: []string{"http-backend"}, Dir: root, Env: []string{
		"GIT_PROJECT_ROOT=" + root, "GIT_HTTP_EXPORT_ALL=1", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=" + os.DevNull,
	}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		expected := "source-fixture-token"
		if strings.HasPrefix(request.URL.Path, "/target.git/") {
			expected = "target-fixture-token"
		} else if !strings.HasPrefix(request.URL.Path, "/source.git/") {
			http.NotFound(w, request)
			return
		}
		username, password, ok := request.BasicAuth()
		if !ok || username != "x-access-token" || password != expected {
			w.Header().Set("WWW-Authenticate", `Basic realm="mirror fixture"`)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		// git may stream receive-pack using chunked HTTP; CGI requires a
		// known body length. Buffer only this bounded disposable fixture.
		if request.Body != nil {
			body, readErr := io.ReadAll(io.LimitReader(request.Body, (1<<20)+1))
			if readErr != nil || len(body) > 1<<20 {
				http.Error(w, "invalid fixture body", http.StatusBadRequest)
				return
			}
			request.Body = io.NopCloser(bytes.NewReader(body))
			request.ContentLength = int64(len(body))
			request.TransferEncoding = nil
		}
		backend.ServeHTTP(w, request)
	}))
	defer server.Close()
	remote := func(path, token string) string {
		endpoint, parseErr := url.Parse(server.URL + path)
		require.NoError(t, parseErr)
		endpoint.User = url.UserPassword("x-access-token", token)
		return endpoint.String()
	}
	sourceURL, targetURL := remote("/source.git", "source-fixture-token"), remote("/target.git", "target-fixture-token")
	q := newFakeGitMirrorSyncStore()
	service := NewGitMirrorSyncService(q)
	service.resolveRemotes = func(context.Context, int64, int64, string, string) (gitMirrorRemotes, error) {
		return gitMirrorRemotes{sourceURL: sourceURL, targetURL: targetURL}, nil
	}
	service.launch = func(_ string, run func()) { run() }
	_, err = service.StartMirrorSync(context.Background(), 7, 19, "native", "copy")
	require.NoError(t, err)
	require.Equal(t, gitMirrorRunSucceeded, q.run.State, "actual transfer and post-transfer verification must complete: %+v", q.refs)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	actual, err := defaultListRemoteRefs(ctx, targetURL)
	require.NoError(t, err)
	expected := map[string]string{}
	for name, hash := range protectedTarget {
		expected[name] = hash
	}
	expected["refs/custom/obsolete"] = commits["base"]
	for _, name := range []string{"refs/heads/main", "refs/tags/v1", "refs/notes/review", "refs/custom/keep", "refs/smithers-user/published"} {
		expected[name] = sourceRefs[name]
		require.Contains(t, q.refs, name)
	}
	for _, name := range []string{"refs/notes/existing", "refs/custom/existing"} {
		expected[name] = sourceRefs[name]
		assert.NotContains(t, q.refs, name, "unchanged user refs need no update")
	}
	assert.Equal(t, expected, actual, "private refs are neither copied, updated nor pruned; user namespaces still mirror")
	assert.NotContains(t, q.refs, "refs/custom/obsolete", "a target-only ref this mirror never wrote is not pruned")
	for name := range q.refs {
		assert.False(t, strings.HasPrefix(name, "refs/smithers/"), "reserved refs must not enter verification receipts")
	}
	// This small receive pack must be unpacked to loose objects. Prove that
	// first so absence below cannot accidentally hide a private packed object.
	packs, err := filepath.Glob(filepath.Join(target, "objects", "pack", "*.pack"))
	require.NoError(t, err)
	require.Empty(t, packs)
	public := commits["public"]
	_, err = os.Stat(filepath.Join(target, "objects", public[:2], public[2:]))
	require.NoError(t, err, "the public commit was actually transferred")
	for _, name := range []string{"private-head", "private-source"} {
		hash := commits[name]
		_, err := os.Stat(filepath.Join(target, "objects", hash[:2], hash[2:]))
		assert.True(t, os.IsNotExist(err), "unreviewed private source objects must not be sent to the target")
	}
}
