package repohostserver

import (
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// #2253: a person's mirror clone holds the refs they may write plus the
// read-only mythical stack and workspace refs, never another user's refs,
// jj's pins or the case-collision backups. A `git push --mirror` from that
// clone lands, and never touches what it cannot see. A mirror push from a
// source without the control-plane refs is refused as a whole; the documented
// refspec pushes its branches and tags instead.
func TestMirrorCloneAndPushSeeOnlyTheViewersRefs(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
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
		r.Header.Set("X-Smithers-Pusher-Id", "42")
		f.srv.Handler().ServeHTTP(w, r)
	}))
	defer proxy.Close()
	remote := proxy.URL + "/demo.git"
	git := func(ok bool, args ...string) string {
		t.Helper()
		out, err := exec.Command("git", args...).CombinedOutput()
		if ok {
			require.NoError(t, err, "git %v: %s", args, out)
		} else {
			require.Error(t, err, "git %v: %s", args, out)
		}
		return string(out)
	}
	own := repohost.UserRef(42, "head")
	other := repohost.UserRef(43, "head")
	workspace := repohost.BranchHeadRef("0b7e3c9e-4d2f-4a51-9c8e-1f2a3b4c5d6e")
	backup := repohost.RefCaseCollisionBackup("t", 0, "refs/heads/Main")
	pin := "refs/jj/keep/" + f.base
	for _, ref := range []string{own, other, workspace, backup, pin, repohost.MythicalBookmarkRef} {
		git(true, "--git-dir", f.repo.gitDir, "update-ref", ref, f.base)
	}
	server := func() map[string]string { return f.repo.refs() }

	mirror := filepath.Join(t.TempDir(), "mirror.git")
	git(true, "clone", "--quiet", "--mirror", remote, mirror)
	cloned := git(true, "--git-dir", mirror, "for-each-ref", "--format=%(refname)")
	for _, ref := range []string{"refs/heads/main", own, workspace, repohost.MythicalBookmarkRef} {
		require.Contains(t, cloned, ref+"\n")
	}
	for _, ref := range []string{other, backup, pin} {
		require.NotContains(t, cloned, ref)
	}

	tip := f.commit("mirror work", func(dir string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "src", "m.go"), []byte("package m\n"), 0o644))
	})
	git(true, "-C", f.clientDir, "push", "--quiet", mirror, "HEAD:refs/heads/main")
	git(true, "--git-dir", mirror, "push", "--mirror", remote)
	require.Equal(t, tip, server()["refs/heads/main"], "the mirror push landed")
	for _, ref := range []string{own, other, workspace, backup, pin, repohost.MythicalBookmarkRef} {
		require.Equal(t, f.base, server()[ref], "the mirror push changed %s", ref)
	}

	// A source with branches only: --mirror would delete the stack and the
	// workspace ref, so the push is refused and changes nothing.
	source := filepath.Join(t.TempDir(), "source.git")
	git(true, "init", "--quiet", "--bare", source)
	next := f.commit("source work", func(dir string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "src", "n.go"), []byte("package n\n"), 0o644))
	})
	git(true, "-C", f.clientDir, "push", "--quiet", source, "HEAD:refs/heads/main")
	git(false, "--git-dir", source, "push", "--mirror", remote)
	require.Equal(t, tip, server()["refs/heads/main"])
	require.Equal(t, f.base, server()[repohost.MythicalBookmarkRef])

	git(true, "--git-dir", source, "push", "--prune", remote,
		"refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*", "^"+repohost.MythicalBookmarkRef)
	require.Equal(t, next, server()["refs/heads/main"], "the documented refspec landed")
	for _, ref := range []string{own, other, workspace, backup, pin, repohost.MythicalBookmarkRef} {
		require.Equal(t, f.base, server()[ref], "the refspec push changed %s", ref)
	}
}

// A workspace credential writes no user ref and sees none, even with its
// user's pusher id.
func TestRefViewerIgnoresWorkspaceCredentials(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-Smithers-Pusher-Id", "42")
	require.Equal(t, int64(42), refViewer(req))
	req.Header.Set("X-Smithers-Workspace-Id", "0b7e3c9e-4d2f-4a51-9c8e-1f2a3b4c5d6e")
	require.Equal(t, int64(0), refViewer(req))
	require.Equal(t, []string{repohost.JJRefPrefix, repohost.RefCaseCollisionPrefix, repohost.UserRefPrefix}, hiddenRefs(0))
}
