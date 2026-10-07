package services

import (
	"context"
	"errors"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// The stack provider is a test-only contract fake until STK-04/STK-08 land.
// These tests do not qualify production activation or C-J10-07.
type resetFenceFixture struct {
	intent                            GitHubMainResetIntent
	prepared, verified, settled, open int
	failure                           string
}

func (f *resetFenceFixture) WithRepository(ctx context.Context, _ int64, run func(GitHubMainFence) error) error {
	return run(f)
}
func (f *resetFenceFixture) Pending(context.Context) ([]GitHubMainResetIntent, error) {
	if f.prepared > 0 && f.settled == 0 {
		return []GitHubMainResetIntent{f.intent}, nil
	}
	return nil, nil
}
func (f *resetFenceFixture) Prepare(_ context.Context, id, old, new string) (GitHubMainResetIntent, error) {
	if f.failure == "prepare" {
		return GitHubMainResetIntent{}, errors.New("not persisted")
	}
	if old != f.intent.Old || new != f.intent.New || (id != "" && id != f.intent.ID) {
		return GitHubMainResetIntent{}, errors.New("stale attention")
	}
	f.prepared++
	return f.intent, nil
}
func (f *resetFenceFixture) VerifyLocked(context.Context, GitHubMainResetIntent) error {
	f.verified++
	if f.failure == "fence" {
		return errors.New("merge fence")
	}
	return nil
}
func (f *resetFenceFixture) VerifyPull(context.Context, string, string) error { return nil }
func (f *resetFenceFixture) OpenForcePush(_ context.Context, push GitHubMainForcePush) error {
	f.intent.Old, f.intent.New = push.Old, push.New
	f.open++
	return nil
}
func (f *resetFenceFixture) Settle(context.Context, GitHubMainResetIntent) error {
	if f.failure == "settle" {
		return errors.New("crash before settlement")
	}
	if f.settled == 0 {
		f.settled++
	}
	return nil
}
func (f *resetFenceFixture) LeaveOpen(context.Context, GitHubMainResetIntent) error {
	f.open++
	f.prepared = 0
	return nil
}

type resetGitFixture struct {
	*fakeMainPullGit
	lostReply bool
}

func (g *resetGitFixture) Reset(ctx context.Context, dir, bridge, old, new, ref string) error {
	if err := pushThroughBridge(ctx, bridge, ref, old, new); err != nil {
		return err
	}
	if g.lostReply {
		return errors.New("lost write response")
	}
	return nil
}

func TestMainResetFencedTransferAndRecovery(t *testing.T) {
	for _, failure := range []string{"", "prepare", "fence", "settle", "lost_reply", "stale_tip", "third_tip"} {
		t.Run(failure, func(t *testing.T) {
			h := newPullHarness(t)
			h.service.UseInstallPolicy()
			f := &resetFenceFixture{intent: GitHubMainResetIntent{RepositoryID: 19, ID: "force-19", Old: pullOld, New: pullNew}, failure: failure}
			h.service.SetMainSerialization(f)
			g := &resetGitFixture{fakeMainPullGit: h.git, lostReply: failure == "lost_reply"}
			h.service.git = g
			if failure == "stale_tip" {
				h.github = "3333333333333333333333333333333333333333"
			}
			if failure == "third_tip" {
				h.host.bookmarks["main"] = "3333333333333333333333333333333333333333"
			}
			err := h.service.ResetMainAttention(t.Context(), 19, "force-19", pullOld, pullNew)
			if failure == "" {
				require.NoError(t, err)
				require.Equal(t, 1, f.settled)
			} else {
				require.Error(t, err)
			}
			switch failure {
			case "", "settle", "lost_reply":
				require.Equal(t, pullNew, h.host.bookmarkSnapshot("main"))
				require.Equal(t, 1, f.verified)
				f.failure = ""
				restarted := NewGitHubMainPullService(h.store, h.host, &fakeMainPullTokens{}, nil)
				restarted.UseInstallPolicy()
				restarted.SetMainSerialization(f)
				require.NoError(t, restarted.RecoverMainResets(t.Context()))
				require.NoError(t, h.service.RecoverMainResets(t.Context()))
				require.Equal(t, 1, f.settled)
				require.Len(t, h.host.received, 1, "recovery never repeats the write")
			case "third_tip":
				require.Equal(t, "3333333333333333333333333333333333333333", h.host.bookmarkSnapshot("main"))
				require.Empty(t, h.host.received)
				require.Zero(t, f.settled)
				require.Equal(t, 1, f.open)
			default:
				require.Equal(t, pullOld, h.host.bookmarkSnapshot("main"))
				require.Empty(t, h.host.received)
				f.failure = ""
				restarted := NewGitHubMainPullService(h.store, h.host, &fakeMainPullTokens{}, nil)
				restarted.UseInstallPolicy()
				restarted.SetMainSerialization(f)
				require.NoError(t, restarted.RecoverMainResets(t.Context()))
				require.Zero(t, f.settled)
			}
		})
	}
}

func TestMainResetRefusesWithoutProviderAndStaleAttention(t *testing.T) {
	h := newPullHarness(t)
	h.service.UseInstallPolicy()
	require.Error(t, h.service.ResetToGitHub(t.Context(), 19, pullOld, pullNew))
	require.Zero(t, h.git.fetches)
	f := &resetFenceFixture{intent: GitHubMainResetIntent{RepositoryID: 19, ID: "force-19", Old: pullOld, New: pullNew}}
	h.service.SetMainSerialization(f)
	require.Error(t, h.service.ResetMainAttention(t.Context(), 19, "obsolete", pullOld, pullNew))
	require.Zero(t, f.prepared)
	require.Zero(t, h.git.fetches)
}

func TestMainPullStoresForcePushThroughSharedFence(t *testing.T) {
	h := newPullHarness(t)
	qualifyMainPullFixture(h.service)
	h.git.ancestor = false
	f := &resetFenceFixture{}
	h.service.SetMainSerialization(f)
	_, err := h.service.Request(t.Context(), 19)
	require.NoError(t, err)
	require.NoError(t, h.service.PollOnce(t.Context()))
	require.Equal(t, 1, f.open)
	require.Equal(t, pullOld, f.intent.Old)
	require.Equal(t, pullNew, f.intent.New)
	require.Equal(t, pullOld, h.host.bookmarkSnapshot("main"))
	require.Zero(t, h.git.pushes)
}

func TestMainResetTransfersNonAncestorThroughRealGit(t *testing.T) {
	root := t.TempDir()
	f := &gitFixture{t: t, root: root, work: filepath.Join(root, "work")}
	f.git(root, "init", "-q", "--initial-branch=main", f.work)
	base := f.commit("base", "base.txt", "base")
	old := f.commit("mirror", "mirror.txt", "mirror")
	f.git(f.work, "checkout", "-q", "-B", "rewritten", base)
	newTip := f.commit("rewritten", "new.txt", "new")
	mirror := f.bare("mirror.git")
	source := f.bare("github.git")
	f.git(f.work, "push", "-q", mirror, old+":refs/heads/main")
	f.git(f.work, "push", "-q", source, newTip+":refs/heads/main")
	backend := &cgi.Handler{Path: mustLookPath(t, "git"), Args: []string{"http-backend"}, Dir: root, Env: []string{"GIT_PROJECT_ROOT=" + root, "GIT_HTTP_EXPORT_ALL=1", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=" + os.DevNull}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "receive-pack") {
			t.Error("reset tried to write upstream")
			w.WriteHeader(403)
			return
		}
		r.URL.Path = "/github.git/" + strings.TrimPrefix(r.URL.Path, "/smithersai/smithers.git/")
		backend.ServeHTTP(w, r)
	}))
	defer server.Close()
	host := newGitBackedRepoHost(t, mirror)
	store := newFakeMainPullStore()
	service := NewGitHubMainPullService(store, host, &fixtureTokens{}, nil)
	service.UseInstallPolicy()
	service.gitHubGitBaseURL = func() string { return server.URL }
	fence := &resetFenceFixture{intent: GitHubMainResetIntent{RepositoryID: 19, ID: "force-19", Old: old, New: newTip}}
	service.SetMainSerialization(fence)
	require.Equal(t, old, f.git(mirror, "rev-parse", "refs/heads/main"))
	require.NoError(t, service.ResetMainAttention(t.Context(), 19, "force-19", old, newTip))
	require.Equal(t, newTip, f.git(mirror, "rev-parse", "refs/heads/main"))
	require.Equal(t, newTip, f.git(source, "rev-parse", "refs/heads/main"))
	require.Equal(t, 1, fence.verified)
	require.Equal(t, 1, fence.settled)
	// An expected-old lease also refuses a concurrent third mirror tip. Git,
	// independently of the stack's contract fake, enforces this CAS.
	f.git(f.work, "push", "-q", "--force", mirror, base+":refs/heads/main")
	dir := filepath.Join(root, "transfer")
	require.NoError(t, os.Mkdir(dir, 0700))
	git := cliGitHubMainPullGit{}
	_, _, err := git.Fetch(t.Context(), dir, mirror, source, "refs/heads/main")
	require.NoError(t, err)
	require.Error(t, git.Reset(t.Context(), dir, mirror, old, newTip, "refs/heads/main"))
	require.Equal(t, base, f.git(mirror, "rev-parse", "refs/heads/main"))
}
