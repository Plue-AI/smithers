package services

import (
	"context"
	"errors"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// realMirrorGitTimeout bounds every git command and mirror run these tests
// start: a stuck subprocess fails its test with the command that stuck instead
// of stalling the package until Go's test timeout (#3100).
const realMirrorGitTimeout = 2 * time.Minute

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
	ctx, cancel := context.WithTimeout(context.Background(), realMirrorGitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.WaitDelay = 5 * time.Second
	cmd.Env = append(cmd.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1", "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.CombinedOutput()
	require.NoError(r.t, ctx.Err(), "git %s did not finish within %s: %s", strings.Join(args, " "), realMirrorGitTimeout, out)
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
	ctx, cancel := context.WithTimeout(context.Background(), realMirrorGitTimeout)
	defer cancel()
	refs, err := defaultListRemoteRefs(ctx, remote)
	require.NoError(r.t, err)
	return refs
}

func (r *realMirrorRepos) service(store GitMirrorSyncQuerier) *GitMirrorSyncService {
	svc := synchronousGitMirrorService(store)
	svc.resolveRemotes = func(context.Context, int64, int64, string, string) (gitMirrorRemotes, error) {
		return gitMirrorRemotes{sourceURL: r.source, targetURL: r.target}, nil
	}
	svc.launch = func(name string, fn func()) {
		done := make(chan struct{})
		go func() {
			defer close(done)
			fn()
		}()
		select {
		case <-done:
		case <-time.After(realMirrorGitTimeout):
			r.t.Fatalf("%s did not finish within %s", name, realMirrorGitTimeout)
		}
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

func (r *realMirrorRepos) retry(svc *GitMirrorSyncService, ref string) GitMirrorSyncRunResult {
	r.t.Helper()
	runID, err := svc.RetryMirrorRef(context.Background(), 7, 101, "alice", "demo", ref)
	require.NoError(r.t, err)
	run, err := svc.GetMirrorSyncRun(context.Background(), 101, runID)
	require.NoError(r.t, err)
	return run
}

// mirrorFeatureThenDeleteAtSource syncs refs/heads/feature to GitHub, then
// deletes it on Smithers, so the next sync plans a prune of the returned SHA.
func (r *realMirrorRepos) mirrorFeatureThenDeleteAtSource(svc *GitMirrorSyncService) string {
	r.t.Helper()
	r.commit("main")
	r.push(r.source, "HEAD:refs/heads/main")
	feature := r.commit("feature")
	r.push(r.source, "HEAD:refs/heads/feature")
	require.Equal(r.t, gitMirrorRunSucceeded, r.sync(svc).State)
	require.Equal(r.t, feature, r.refs(r.target)["refs/heads/feature"])
	r.git(r.work, "push", r.source, ":refs/heads/feature")
	return feature
}

// advanceTargetFeature adds a GitHub commit on top of the target feature.
func (r *realMirrorRepos) advanceTargetFeature() string {
	r.t.Helper()
	r.git(r.work, "fetch", r.target, "refs/heads/feature")
	r.git(r.work, "checkout", "-q", "--detach", "FETCH_HEAD")
	moved := r.commit("github commit")
	r.push(r.target, "HEAD:refs/heads/feature")
	return moved
}

func TestMirrorRetryNeverPrunesAfterARefusal(t *testing.T) {
	r := newRealMirrorRepos(t)
	base := r.commit("main")
	r.push(r.source, "HEAD:refs/heads/main")
	r.push(r.target, "HEAD:refs/heads/main")
	github := r.commit("github feature")
	r.push(r.target, "HEAD:refs/heads/feature")
	r.git(r.work, "reset", "--hard", base)
	r.commit("smithers feature")
	r.push(r.source, "HEAD:refs/heads/feature")
	svc := r.service(newFakeGitMirrorSyncStore())

	require.Equal(t, gitMirrorRunFailed, r.sync(svc).State, "a diverged update is refused")
	r.git(r.work, "push", r.source, ":refs/heads/feature")
	for attempt := 1; attempt <= 2; attempt++ {
		run := r.retry(svc, "refs/heads/feature")
		assert.Equal(t, gitMirrorRunFailed, run.State, "retry %d", attempt)
		assert.Equal(t, github, r.refs(r.target)["refs/heads/feature"], "retry %d deleted a branch this mirror never wrote", attempt)
	}
}

func TestMirrorRetryRefusesPruneAfterTargetMoves(t *testing.T) {
	r := newRealMirrorRepos(t)
	svc := r.service(newFakeGitMirrorSyncStore())
	r.mirrorFeatureThenDeleteAtSource(svc)
	svc.runGitSync = func(context.Context, string, string, []gitMirrorRefChange) error {
		return errors.New("push interrupted")
	}
	require.Equal(t, gitMirrorRunFailed, r.sync(svc).State)
	moved := r.advanceTargetFeature()
	svc.runGitSync = defaultRunGitMirrorPush

	for attempt := 1; attempt <= 2; attempt++ {
		run := r.retry(svc, "refs/heads/feature")
		assert.Equal(t, gitMirrorRunFailed, run.State, "retry %d", attempt)
		assert.Equal(t, moved, r.refs(r.target)["refs/heads/feature"], "retry %d", attempt)
	}
}

func TestMirrorRetryRepeatsAnInterruptedPrune(t *testing.T) {
	r := newRealMirrorRepos(t)
	svc := r.service(newFakeGitMirrorSyncStore())
	feature := r.mirrorFeatureThenDeleteAtSource(svc)
	svc.runGitSync = func(context.Context, string, string, []gitMirrorRefChange) error {
		return errors.New("push interrupted")
	}
	require.Equal(t, gitMirrorRunFailed, r.sync(svc).State)
	require.Equal(t, feature, r.refs(r.target)["refs/heads/feature"])

	run := r.retry(svc, "refs/heads/feature")

	assert.Equal(t, gitMirrorRunSucceeded, run.State)
	assert.NotContains(t, r.refs(r.target), "refs/heads/feature")
}

func TestMirrorSyncPruneLeasesThePlannedRevision(t *testing.T) {
	r := newRealMirrorRepos(t)
	svc := r.service(newFakeGitMirrorSyncStore())
	r.mirrorFeatureThenDeleteAtSource(svc)
	var moved string
	svc.runGitSync = func(ctx context.Context, sourceURL, targetURL string, changes []gitMirrorRefChange) error {
		moved = r.advanceTargetFeature()
		return defaultRunGitMirrorPush(ctx, sourceURL, targetURL, changes)
	}

	run := r.sync(svc)

	assert.Equal(t, gitMirrorRunFailed, run.State)
	require.Len(t, run.Refs, 1)
	assert.Equal(t, gitMirrorRefFailed, run.Refs[0].Status)
	assert.Equal(t, moved, r.refs(r.target)["refs/heads/feature"], "a GitHub commit pushed after planning survives")
}

func TestMirrorRetryPruneLeasesThePlannedRevision(t *testing.T) {
	r := newRealMirrorRepos(t)
	svc := r.service(newFakeGitMirrorSyncStore())
	r.mirrorFeatureThenDeleteAtSource(svc)
	svc.runGitSync = func(context.Context, string, string, []gitMirrorRefChange) error {
		return errors.New("push interrupted")
	}
	require.Equal(t, gitMirrorRunFailed, r.sync(svc).State)
	var moved string
	svc.runGitRefSync = func(ctx context.Context, sourceURL, targetURL, ref, fromRevision, toRevision string) error {
		moved = r.advanceTargetFeature()
		return defaultRunGitRefSync(ctx, sourceURL, targetURL, ref, fromRevision, toRevision)
	}

	run := r.retry(svc, "refs/heads/feature")

	assert.Equal(t, gitMirrorRunFailed, run.State)
	assert.Equal(t, moved, r.refs(r.target)["refs/heads/feature"], "a GitHub commit pushed after planning survives")
}

func TestMirrorSyncPrunesAfterAFailedUpdate(t *testing.T) {
	r := newRealMirrorRepos(t)
	svc := r.service(newFakeGitMirrorSyncStore())
	r.commit("main")
	r.push(r.source, "HEAD:refs/heads/main")
	written := r.commit("feature")
	r.push(r.source, "HEAD:refs/heads/feature")
	require.Equal(t, gitMirrorRunSucceeded, r.sync(svc).State)

	r.commit("feature update")
	r.push(r.source, "HEAD:refs/heads/feature")
	svc.runGitSync = func(context.Context, string, string, []gitMirrorRefChange) error {
		return errors.New("github rejected the update")
	}
	require.Equal(t, gitMirrorRunFailed, r.sync(svc).State)
	require.Equal(t, written, r.refs(r.target)["refs/heads/feature"])
	svc.runGitSync = defaultRunGitMirrorPush

	r.git(r.work, "push", r.source, ":refs/heads/feature")
	run := r.sync(svc)

	assert.Equal(t, gitMirrorRunSucceeded, run.State)
	assert.NotContains(t, r.refs(r.target), "refs/heads/feature", "a failed update does not revoke the earlier verified write")
}
