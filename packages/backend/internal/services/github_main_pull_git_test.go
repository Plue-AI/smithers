package services

import (
	"bytes"
	"context"
	"crypto/rand"
	"fmt"
	"io"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// gitBackedRepoHost is repo-host's git surface over a real bare repository,
// using git's own stateless RPC, so the transfer is exercised end to end.
type gitBackedRepoHost struct {
	dir  string
	home string
	// locked runs when a push takes the repository lock (takeRepositoryLock).
	locked func()
}

func newGitBackedRepoHost(t *testing.T, dir string) *gitBackedRepoHost {
	t.Helper()
	return &gitBackedRepoHost{dir: dir, home: t.TempDir()}
}

func (h *gitBackedRepoHost) rpc(ctx context.Context, service string, stdin io.Reader, stdout io.Writer, advertise bool) error {
	var request []byte
	if stdin != nil {
		var err error
		request, err = io.ReadAll(stdin)
		if err != nil {
			return fmt.Errorf("read %s request: %w", service, err)
		}
	}
	args := []string{service, "--stateless-rpc"}
	if advertise {
		args = append(args, "--advertise-refs")
	}
	cmd := exec.CommandContext(ctx, "git", append(args, h.dir)...)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+os.DevNull, "HOME="+h.home)
	cmd.WaitDelay = 5 * time.Second
	cmd.Stdin, cmd.Stdout = bytes.NewReader(request), stdout
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s: %w: %s", service, err, stderr.String())
	}
	return nil
}

func (h *gitBackedRepoHost) InfoRefs(ctx context.Context, _, _, service string, stdout io.Writer) (string, error) {
	header := "# service=" + service + "\n"
	_, _ = fmt.Fprintf(stdout, "%04x%s0000", len(header)+4, header)
	return "application/x-" + service + "-advertisement", h.rpc(ctx, strings.TrimPrefix(service, "git-"), nil, stdout, true)
}

func (h *gitBackedRepoHost) ProxyUploadPack(ctx context.Context, _, _ string, stdin io.Reader, stdout io.Writer) error {
	return h.rpc(ctx, "upload-pack", stdin, stdout, false)
}

func (h *gitBackedRepoHost) ProxyReceivePack(ctx context.Context, _, _ string, stdin io.Reader, stdout io.Writer, meta ...repohost.ReceivePackMetadata) error {
	if err := takeRepositoryLock(ctx, h.locked, stdin, meta); err != nil {
		return err
	}
	return h.rpc(ctx, "receive-pack", stdin, stdout, false)
}

func (h *gitBackedRepoHost) ListBookmarks(context.Context, string, string, string, int) ([]repohost.Bookmark, string, error) {
	out, err := exec.Command("git", "--git-dir", h.dir, "for-each-ref", "--format=%(refname:strip=2) %(objectname)", "refs/heads").Output()
	if err != nil {
		return nil, "", err
	}
	var bookmarks []repohost.Bookmark
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if name, commit, ok := strings.Cut(line, " "); ok {
			bookmarks = append(bookmarks, repohost.Bookmark{Name: name, TargetCommitID: commit})
		}
	}
	return bookmarks, "", nil
}

type gitFixture struct {
	t    *testing.T
	root string
	work string
}

func (f *gitFixture) git(dir string, args ...string) string {
	f.t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+os.DevNull,
		"GIT_AUTHOR_NAME=Fixture", "GIT_AUTHOR_EMAIL=fixture@example.test", "GIT_COMMITTER_NAME=Fixture",
		"GIT_COMMITTER_EMAIL=fixture@example.test", "GIT_AUTHOR_DATE=2026-01-01T00:00:00Z", "GIT_COMMITTER_DATE=2026-01-01T00:00:00Z")
	out, err := cmd.CombinedOutput()
	require.NoError(f.t, err, "git %v: %s", args, out)
	return strings.TrimSpace(string(out))
}

func (f *gitFixture) commit(message, file, content string) string {
	f.t.Helper()
	require.NoError(f.t, os.WriteFile(filepath.Join(f.work, file), []byte(content), 0o600))
	f.git(f.work, "add", "-A")
	f.git(f.work, "commit", "-q", "-m", message)
	return f.git(f.work, "rev-parse", "HEAD")
}

func (f *gitFixture) bare(name string) string {
	dir := filepath.Join(f.root, name)
	f.git(f.root, "init", "-q", "--bare", "--initial-branch=main", dir)
	f.git(dir, "config", "http.receivepack", "false")
	return dir
}

// TestGitHubMainPullTransfersThroughRealGit fast-forwards a Smithers bare
// repository to a GitHub tip that merges a branch forked before Smithers'
// base, through the bridge, with plain git.
func TestGitHubMainPullTransfersThroughRealGit(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	root := t.TempDir()
	f := &gitFixture{t: t, root: root, work: filepath.Join(root, "work")}
	f.git(root, "init", "-q", "--initial-branch=main", f.work)
	a := f.commit("a", "a.txt", "a")
	b := f.commit("b", "b.txt", "b")
	f.git(f.work, "checkout", "-q", "-b", "side", a)
	d := f.commit("d", "d.txt", "d")
	f.git(f.work, "checkout", "-q", "main")
	c := f.commit("c", "c.txt", "c")
	f.git(f.work, "merge", "-q", "--no-ff", "-m", "merge side", d)
	merge := f.git(f.work, "rev-parse", "HEAD")
	f.git(f.work, "checkout", "-q", "-b", "landing", b)
	landing := f.commit("landing", "l.txt", "l")
	f.git(f.work, "checkout", "-q", "-b", "diverged", b)
	diverged := f.commit("diverged", "x.txt", "x")

	github := f.bare("github.git")
	f.git(f.work, "push", "-q", github, merge+":refs/heads/main", "side")
	smithers := f.bare("smithers.git")
	f.git(f.work, "push", "-q", smithers, b+":refs/heads/main", landing+":refs/heads/smithers/landing-7")
	_ = c

	backend := &cgi.Handler{Path: mustLookPath(t, "git"), Args: []string{"http-backend"}, Dir: root,
		Env: []string{"GIT_PROJECT_ROOT=" + root, "GIT_HTTP_EXPORT_ALL=1", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=" + os.DevNull}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if user, password, ok := r.BasicAuth(); !ok || user != "x-access-token" || password != "ghs_fixture" || !strings.HasPrefix(r.URL.Path, "/smithersai/smithers.git/") {
			w.Header().Set("WWW-Authenticate", `Basic realm="github"`)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		r.URL.Path = "/github.git/" + strings.TrimPrefix(r.URL.Path, "/smithersai/smithers.git/")
		if r.Body != nil {
			body, _ := io.ReadAll(r.Body)
			r.Body, r.ContentLength, r.TransferEncoding = io.NopCloser(bytes.NewReader(body)), int64(len(body)), nil
		}
		backend.ServeHTTP(w, r)
	}))
	defer server.Close()

	store := newFakeMainPullStore()
	host := newGitBackedRepoHost(t, smithers)
	service := NewGitHubMainPullService(store, host, &fixtureTokens{}, nil)
	service.gitHubGitBaseURL = func() string { return server.URL }
	service.readPolicy = func(context.Context, string, string, string, string) (string, error) { return "pull", nil }
	hooks := filepath.Join(root, "hostile-hooks")
	require.NoError(t, os.MkdirAll(hooks, 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(hooks, "pre-receive"), []byte("#!/bin/sh\nexit 1\n"), 0o700))
	globalConfig := filepath.Join(root, "hostile.gitconfig")
	require.NoError(t, os.WriteFile(globalConfig, []byte("[core]\n\thooksPath = "+hooks+"\n"), 0o600))
	t.Setenv("GIT_CONFIG_GLOBAL", globalConfig)

	_, err := service.Request(context.Background(), 19)
	require.NoError(t, err)
	require.NoError(t, service.PollOnce(context.Background()))
	row, err := store.GetGithubMainPull(context.Background(), 19)
	require.NoError(t, err)
	require.Equal(t, "synced", row.State, row.LastError)
	assert.Equal(t, merge, f.git(smithers, "rev-parse", "refs/heads/main"))
	assert.Equal(t, landing, f.git(smithers, "rev-parse", "refs/heads/smithers/landing-7"), "landing branches are preserved")
	assert.Equal(t, "", f.git(smithers, "for-each-ref", "refs/heads/side"), "no other GitHub branch is copied")
	f.git(smithers, "fsck", "--connectivity-only", "--no-dangling")

	// Divergence: Smithers main gains a commit GitHub never had.
	f.git(f.work, "push", "-q", "--force", smithers, diverged+":refs/heads/main")
	f.git(f.work, "checkout", "-q", "main")
	next := f.commit("e", "e.txt", "e")
	f.git(f.work, "push", "-q", github, next+":refs/heads/main")
	_, err = service.Request(context.Background(), 19)
	require.NoError(t, err)
	require.NoError(t, service.PollOnce(context.Background()))
	row, err = store.GetGithubMainPull(context.Background(), 19)
	require.NoError(t, err)
	assert.Equal(t, "failed", row.State)
	assert.Contains(t, row.LastError, "diverged")
	assert.Equal(t, diverged, f.git(smithers, "rev-parse", "refs/heads/main"), "a diverged main is never overwritten")
	assert.NotContains(t, row.LastError, "ghs_fixture")
}

type fixtureTokens struct{}

func (fixtureTokens) CreateGitHubInstallationTokenForRepositoryOwner(context.Context, int64, int64, string, string, map[string]string) (GitHubInstallationToken, error) {
	return GitHubInstallationToken{Token: "ghs_fixture"}, nil
}

func mustLookPath(t *testing.T, name string) string {
	t.Helper()
	path, err := exec.LookPath(name)
	require.NoError(t, err)
	return path
}

// TestGitHubMainPullPushesAPackLargerThanThePostBuffer pulls a GitHub commit
// whose pack exceeds git's 1 MiB http.postBuffer. git then probes the
// receive-pack endpoint with a lone flush packet before sending the pack; the
// bridge refused that probe with 403, so smithersai/smithers never pulled
// (github_main_pulls.last_error "RPC failed; HTTP 403", 201 attempts).
func TestGitHubMainPullPushesAPackLargerThanThePostBuffer(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	root := t.TempDir()
	f := &gitFixture{t: t, root: root, work: filepath.Join(root, "work")}
	f.git(root, "init", "-q", "--initial-branch=main", f.work)
	base := f.commit("base", "a.txt", "a")
	large := make([]byte, 2<<20)
	_, err := rand.Read(large)
	require.NoError(t, err)
	tip := f.commit("large", "large.bin", string(large))

	github := f.bare("github.git")
	f.git(f.work, "push", "-q", github, tip+":refs/heads/main")
	smithers := f.bare("smithers.git")
	f.git(f.work, "push", "-q", smithers, base+":refs/heads/main")

	backend := &cgi.Handler{Path: mustLookPath(t, "git"), Args: []string{"http-backend"}, Dir: root,
		Env: []string{"GIT_PROJECT_ROOT=" + root, "GIT_HTTP_EXPORT_ALL=1", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=" + os.DevNull}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.URL.Path = "/github.git/" + strings.TrimPrefix(r.URL.Path, "/smithersai/smithers.git/")
		backend.ServeHTTP(w, r)
	}))
	defer server.Close()

	store := newFakeMainPullStore()
	service := NewGitHubMainPullService(store, newGitBackedRepoHost(t, smithers), &fixtureTokens{}, nil)
	service.gitHubGitBaseURL = func() string { return server.URL }
	service.readPolicy = func(context.Context, string, string, string, string) (string, error) { return "pull", nil }

	_, err = service.Request(context.Background(), 19)
	require.NoError(t, err)
	require.NoError(t, service.PollOnce(context.Background()))
	row, err := store.GetGithubMainPull(context.Background(), 19)
	require.NoError(t, err)
	require.Equal(t, "synced", row.State, row.LastError)
	assert.Equal(t, tip, f.git(smithers, "rev-parse", "refs/heads/main"))
}

func (h *gitBackedRepoHost) GetBookmark(ctx context.Context, owner, repo, name string) (repohost.Bookmark, error) {
	items, _, err := h.ListBookmarks(ctx, owner, repo, "", 100)
	if err != nil {
		return repohost.Bookmark{}, err
	}
	for _, bookmark := range items {
		if bookmark.Name == name {
			return bookmark, nil
		}
	}
	return repohost.Bookmark{}, &repohost.StatusError{StatusCode: 404, Code: "bookmark_not_found"}
}
