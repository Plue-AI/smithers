package repohostserver

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const laneZeroOID = "0000000000000000000000000000000000000000"

// laneHTTPFixture drives the receive-pack route end to end: a real jj store
// on the server side, a real git clone on the client side, a real pack built
// by git pack-objects, and the request posted through srv.Handler(). Only the
// jj FFI is a mock; it records the git refs it would have imported.
type laneHTTPFixture struct {
	t         *testing.T
	srv       *Server
	repo      *nativeLaneRepo
	clientDir string
	base      string

	mu      sync.Mutex
	imports []map[string]string
}

func newLaneHTTPFixture(t *testing.T, importErr error) *laneHTTPFixture {
	t.Helper()
	requireNativeLaneTools(t)
	f := &laneHTTPFixture{t: t}
	mock := &mockFFI{importGitRefsFn: func(storePath string) error {
		refs, err := listGitRefs(context.Background(), filepath.Join(storePath, ".jj", "repo", "store", "git"))
		require.NoError(t, err)
		f.mu.Lock()
		f.imports = append(f.imports, refs)
		f.mu.Unlock()
		return importErr
	}}
	f.srv = newTestServerWithMock(t, mock)

	root := f.srv.config.RepoPath("alice", "demo")
	require.NoError(t, os.MkdirAll(filepath.Dir(root), 0o755))
	if out, err := exec.Command("jj", "git", "init", "--no-colocate", root).CombinedOutput(); err != nil {
		t.Fatalf("jj git init: %v: %s", err, out)
	}
	f.repo = &nativeLaneRepo{t: t, root: root, gitDir: f.srv.config.GitBackendPath("alice", "demo")}
	before := f.repo.seed()
	f.base = before["refs/heads/main"]
	require.NotEmpty(t, f.base)

	f.clientDir = filepath.Join(t.TempDir(), "client")
	if out, err := exec.Command("git", "clone", "-q", "-b", "main", f.repo.gitDir, f.clientDir).CombinedOutput(); err != nil {
		t.Fatalf("git clone: %v: %s", err, out)
	}
	return f
}

func (f *laneHTTPFixture) git(args ...string) string {
	f.t.Helper()
	cmd := exec.Command("git", append([]string{"-C", f.clientDir, "-c", "user.name=Lane Agent", "-c", "user.email=agent@example.invalid"}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		f.t.Fatalf("git %v: %v: %s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// commit applies mutate to the client working tree, commits everything, and
// returns the new commit id.
func (f *laneHTTPFixture) commit(message string, mutate func(dir string)) string {
	f.t.Helper()
	mutate(f.clientDir)
	f.git("add", "-A")
	f.git("commit", "-q", "-m", message)
	return f.git("rev-parse", "HEAD")
}

// pushBody builds a stateless receive-pack request: one ref command and a
// thin pack holding everything reachable from newOID but not oldOID.
func (f *laneHTTPFixture) pushBody(oldOID, newOID, ref string) []byte {
	f.t.Helper()
	var body bytes.Buffer
	line := fmt.Sprintf("%s %s %s\x00report-status\n", oldOID, newOID, ref)
	fmt.Fprintf(&body, "%04x%s0000", len(line)+4, line)
	if newOID == laneZeroOID {
		return body.Bytes()
	}
	cmd := exec.Command("git", "-C", f.clientDir, "pack-objects", "--revs", "--stdout", "-q")
	revs := newOID + "\n"
	if oldOID != laneZeroOID {
		revs += "^" + oldOID + "\n"
	}
	cmd.Stdin = strings.NewReader(revs)
	pack, err := cmd.Output()
	require.NoError(f.t, err)
	body.Write(pack)
	return body.Bytes()
}

func (f *laneHTTPFixture) push(ctx context.Context, body []byte, allowed []string) *httptest.ResponseRecorder {
	f.t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/repos/alice/demo/git/receive-pack", bytes.NewReader(body)).WithContext(ctx)
	req.Header.Set("Authorization", validAuth())
	req.Header.Set("Content-Type", "application/x-git-receive-pack-request")
	req.Header.Set("Accept", "application/x-git-receive-pack-result")
	encoded, err := json.Marshal(allowed)
	require.NoError(f.t, err)
	req.Header.Set("X-Smithers-Allowed-Paths", base64.RawURLEncoding.EncodeToString(encoded))
	rec := httptest.NewRecorder()
	f.srv.Handler().ServeHTTP(rec, req)
	return rec
}

func (f *laneHTTPFixture) importedRefs() []map[string]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]map[string]string(nil), f.imports...)
}

func TestReceivePackPathLaneAuthorizedPushSucceeds(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	tip := f.commit("in lane", func(dir string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "src", "b.go"), []byte("package b\n"), 0o644))
	})

	rec := f.push(context.Background(), f.pushBody(f.base, tip, "refs/heads/main"), laneSrcOnly)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), "unpack ok")
	assert.Equal(t, tip, f.repo.refs()["refs/heads/main"])
	imports := f.importedRefs()
	require.Len(t, imports, 1)
	assert.Equal(t, tip, imports[0]["refs/heads/main"], "jj imports the authorized ref")
}

func TestReceivePackPathLaneForbiddenDeleteIsRejectedBeforeImport(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	tip := f.commit("delete the key", func(dir string) {
		require.NoError(t, os.Remove(filepath.Join(dir, "secret", "key.txt")))
	})

	rec := f.push(context.Background(), f.pushBody(f.base, tip, "refs/heads/main"), laneSrcOnly)
	assert.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), "secret/key.txt")
	assert.Equal(t, f.base, f.repo.refs()["refs/heads/main"], "forbidden push must not stay published")
	for _, refs := range f.importedRefs() {
		assert.NotEqual(t, tip, refs["refs/heads/main"], "jj must never import the forbidden ref")
	}
	assert.Empty(t, f.importedRefs(), "a rejected push imports nothing into jj")
}

func TestReceivePackPathLaneCancelledAfterGitPublishesRestoresRefs(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	tip := f.commit("rewrite the key", func(dir string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "secret", "key.txt"), []byte("unauthorized replacement\n"), 0o644))
	})

	// The client goes away the moment git starts applying the push: git
	// itself runs to completion on a detached context (as it does when the
	// pack is already fully buffered), but everything after it sees a
	// cancelled request context.
	requestCtx, cancelRequest := context.WithCancel(context.Background())
	defer cancelRequest()
	previous := streamGitCommandContext
	streamGitCommandContext = func(_ context.Context, name string, args ...string) *exec.Cmd {
		cancelRequest()
		return exec.CommandContext(context.Background(), name, args...)
	}
	t.Cleanup(func() { streamGitCommandContext = previous })

	rec := f.push(requestCtx, f.pushBody(f.base, tip, "refs/heads/main"), laneSrcOnly)
	assert.NotEqual(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	assert.Equal(t, f.base, f.repo.refs()["refs/heads/main"], "refs must be restored even though the request was cancelled")
	assert.Empty(t, f.importedRefs(), "jj must never see the unauthorized ref")
}

func TestReceivePackPathLaneImportFailureRestoresRefs(t *testing.T) {
	f := newLaneHTTPFixture(t, assertError("import failed"))
	tip := f.commit("in lane", func(dir string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "src", "a.go"), []byte("package a // edited\n"), 0o644))
	})

	rec := f.push(context.Background(), f.pushBody(f.base, tip, "refs/heads/main"), laneSrcOnly)
	assert.Equal(t, http.StatusInternalServerError, rec.Code, rec.Body.String())
	assert.Equal(t, f.base, f.repo.refs()["refs/heads/main"], "Git refs roll back when jj cannot import")
	require.Len(t, f.importedRefs(), 1)
}
