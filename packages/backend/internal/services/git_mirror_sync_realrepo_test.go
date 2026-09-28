package services

import (
	"context"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// realMirrorRepos is a Smithers source and a GitHub target, both real bare
// repositories reached over file:// URLs, plus a scratch clone for commits.
type realMirrorRepos struct {
	t      *testing.T
	source string
	target string
	work   string
}

func newRealMirrorRepos(t *testing.T) *realMirrorRepos {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	r := &realMirrorRepos{
		t:      t,
		source: "file://" + filepath.Join(dir, "source.git"),
		target: "file://" + filepath.Join(dir, "target.git"),
		work:   filepath.Join(dir, "work"),
	}
	r.git("", "init", "--bare", filepath.Join(dir, "source.git"))
	r.git("", "init", "--bare", filepath.Join(dir, "target.git"))
	r.git("", "init", r.work)
	r.git(r.work, "config", "user.email", "mirror@test.invalid")
	r.git(r.work, "config", "user.name", "Mirror Test")
	r.git(r.work, "config", "commit.gpgsign", "false")
	r.git(r.work, "config", "tag.gpgsign", "false")
	return r
}

func (r *realMirrorRepos) git(dir string, args ...string) string {
	r.t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(cmd.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
	out, err := cmd.CombinedOutput()
	require.NoError(r.t, err, "git %s: %s", strings.Join(args, " "), out)
	return strings.TrimSpace(string(out))
}

// commit adds an empty commit on the scratch HEAD and returns its SHA.
func (r *realMirrorRepos) commit(message string) string {
	r.t.Helper()
	r.git(r.work, "commit", "--allow-empty", "-m", message)
	return r.git(r.work, "rev-parse", "HEAD")
}

func (r *realMirrorRepos) push(remote string, refspecs ...string) {
	r.t.Helper()
	r.git(r.work, append([]string{"push", "--force", remote}, refspecs...)...)
}

func (r *realMirrorRepos) refs(remote string) map[string]string {
	r.t.Helper()
	refs, err := defaultListRemoteRefs(context.Background(), remote)
	require.NoError(r.t, err)
	return refs
}

func (r *realMirrorRepos) service(store GitMirrorSyncQuerier) *GitMirrorSyncService {
	svc := synchronousGitMirrorService(store)
	svc.resolveRemotes = func(context.Context, int64, int64, string, string) (gitMirrorRemotes, error) {
		return gitMirrorRemotes{sourceURL: r.source, targetURL: r.target}, nil
	}
	return svc
}

func (r *realMirrorRepos) sync(svc *GitMirrorSyncService) GitMirrorSyncRunResult {
	r.t.Helper()
	runID, err := svc.StartMirrorSync(context.Background(), 7, 101, "alice", "demo")
	require.NoError(r.t, err)
	run, err := svc.GetMirrorSyncRun(context.Background(), 101, runID)
	require.NoError(r.t, err)
	return run
}

func TestMirrorSyncKeepsGitHubOnlyRefs(t *testing.T) {
	r := newRealMirrorRepos(t)
	main := r.commit("main")
	r.push(r.source, "HEAD:refs/heads/main")
	r.push(r.target, "HEAD:refs/heads/main")
	contributor := r.commit("contributor")
	r.git(r.work, "tag", "-a", "v1-github", "-m", "cut on GitHub")
	release := r.git(r.work, "rev-parse", "refs/tags/v1-github")
	r.push(r.target, "HEAD:refs/heads/contributor", "refs/tags/v1-github")

	store := newFakeGitMirrorSyncStore()
	run := r.sync(r.service(store))

	assert.Equal(t, gitMirrorRunSucceeded, run.State)
	assert.Empty(t, run.Refs, "GitHub-only refs are not changes")
	target := r.refs(r.target)
	assert.Equal(t, main, target["refs/heads/main"])
	assert.Equal(t, contributor, target["refs/heads/contributor"])
	assert.Equal(t, release, target["refs/tags/v1-github"])
}

func TestMirrorSyncPrunesOnlyBranchesItMirrored(t *testing.T) {
	r := newRealMirrorRepos(t)
	r.commit("main")
	r.push(r.source, "HEAD:refs/heads/main")
	feature := r.commit("feature")
	r.git(r.work, "tag", "-a", "v1", "-m", "release")
	r.push(r.source, "HEAD:refs/heads/feature", "refs/tags/v1")
	store := newFakeGitMirrorSyncStore()
	svc := r.service(store)

	first := r.sync(svc)
	require.Equal(t, gitMirrorRunSucceeded, first.State)
	require.Equal(t, feature, r.refs(r.target)["refs/heads/feature"])

	r.git(r.work, "push", r.source, ":refs/heads/feature", ":refs/tags/v1")
	second := r.sync(svc)

	assert.Equal(t, gitMirrorRunSucceeded, second.State)
	assert.Equal(t, []GitMirrorSyncRefResult{{
		Name: "refs/heads/feature", From: feature, To: "", Status: gitMirrorRefSucceeded,
	}}, second.Refs)
	target := r.refs(r.target)
	assert.NotContains(t, target, "refs/heads/feature")
	assert.Contains(t, target, "refs/heads/main")
	assert.Contains(t, target, "refs/tags/v1", "tags are never pruned")
}

func TestMirrorSyncRefusesDivergedRef(t *testing.T) {
	r := newRealMirrorRepos(t)
	base := r.commit("base")
	r.push(r.source, "HEAD:refs/heads/main")
	r.push(r.target, "HEAD:refs/heads/main")
	sourceMain := r.commit("smithers side")
	r.push(r.source, "HEAD:refs/heads/main")
	r.git(r.work, "reset", "--hard", base)
	targetMain := r.commit("github side")
	r.push(r.target, "HEAD:refs/heads/main")

	store := newFakeGitMirrorSyncStore()
	run := r.sync(r.service(store))

	assert.Equal(t, gitMirrorRunFailed, run.State)
	require.Len(t, run.Refs, 1)
	assert.Equal(t, "refs/heads/main", run.Refs[0].Name)
	assert.Equal(t, gitMirrorRefFailed, run.Refs[0].Status)
	assert.Equal(t, sourceMain, r.refs(r.source)["refs/heads/main"])
	assert.Equal(t, targetMain, r.refs(r.target)["refs/heads/main"])
}
