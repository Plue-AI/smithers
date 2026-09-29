package services

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMirrorSyncRefusesTargetAdvanceWithinSourceHistory(t *testing.T) {
	r := newRealMirrorRepos(t)
	r.commit("base")
	r.push(r.source, "HEAD:refs/heads/main")
	r.push(r.target, "HEAD:refs/heads/main")
	intermediate := r.commit("intermediate")
	sourceTip := r.commit("source tip")
	r.push(r.source, "HEAD:refs/heads/main")

	svc := r.service(newFakeGitMirrorSyncStore())
	svc.runGitSync = func(ctx context.Context, sourceURL, targetURL string, changes []gitMirrorRefChange) error {
		require.Len(t, changes, 1)
		r.push(r.target, intermediate+":refs/heads/main")
		return defaultRunGitMirrorPush(ctx, sourceURL, targetURL, changes)
	}

	run := r.sync(svc)
	assert.Equal(t, gitMirrorRunFailed, run.State)
	require.Len(t, run.Refs, 1)
	assert.Equal(t, gitMirrorRefFailed, run.Refs[0].Status)
	assert.Equal(t, sourceTip, run.Refs[0].To)
	assert.Equal(t, intermediate, r.refs(r.target)["refs/heads/main"], "a target update after planning must survive even when it is a source ancestor")
}

func TestMirrorRetryRefusesSourceChangeAfterPlanning(t *testing.T) {
	r := newRealMirrorRepos(t)
	base := r.commit("base")
	r.push(r.source, "HEAD:refs/heads/main")
	r.push(r.target, "HEAD:refs/heads/main")
	planned := r.commit("planned source tip")
	r.push(r.source, "HEAD:refs/heads/main")

	svc := r.service(newFakeGitMirrorSyncStore())
	svc.runGitSync = func(context.Context, string, string, []gitMirrorRefChange) error {
		return errors.New("push interrupted")
	}
	require.Equal(t, gitMirrorRunFailed, r.sync(svc).State)
	assert.Equal(t, base, r.refs(r.target)["refs/heads/main"])

	var moved string
	svc.runGitRefSync = func(ctx context.Context, sourceURL, targetURL, ref, fromRevision, toRevision string) error {
		require.Equal(t, planned, toRevision)
		moved = r.commit("source moved after retry planned")
		r.push(r.source, "HEAD:refs/heads/main")
		return defaultRunGitRefSync(ctx, sourceURL, targetURL, ref, fromRevision, toRevision)
	}

	run := r.retry(svc, "refs/heads/main")
	assert.Equal(t, gitMirrorRunFailed, run.State)
	require.Len(t, run.Refs, 1)
	assert.Equal(t, gitMirrorRefFailed, run.Refs[0].Status)
	assert.Equal(t, moved, r.refs(r.source)["refs/heads/main"])
	assert.Equal(t, base, r.refs(r.target)["refs/heads/main"], "retry must not copy a source revision that was absent from its plan")
}

func TestMirrorSyncDivergenceKeepsEveryTargetRefUnchanged(t *testing.T) {
	r := newRealMirrorRepos(t)
	base := r.commit("base")
	r.push(r.source, "HEAD:refs/heads/main")
	r.push(r.target, "HEAD:refs/heads/main")
	sourceMain := r.commit("source main")
	r.push(r.source, "HEAD:refs/heads/main", "HEAD:refs/heads/z-valid")
	r.git(r.work, "reset", "--hard", base)
	targetMain := r.commit("target main")
	r.push(r.target, "HEAD:refs/heads/main")
	before := r.refs(r.target)

	run := r.sync(r.service(newFakeGitMirrorSyncStore()))
	assert.Equal(t, gitMirrorRunFailed, run.State)
	assert.Equal(t, sourceMain, r.refs(r.source)["refs/heads/z-valid"])
	assert.Equal(t, targetMain, before["refs/heads/main"])
	assert.Equal(t, before, r.refs(r.target), "one refused ref must leave the whole target snapshot unchanged")
}

func TestMirrorSyncRefusesChangedTag(t *testing.T) {
	r := newRealMirrorRepos(t)
	r.commit("base")
	r.git(r.work, "tag", "-a", "v1", "-m", "original release")
	original := r.git(r.work, "rev-parse", "refs/tags/v1")
	r.push(r.source, "refs/tags/v1")
	r.push(r.target, "refs/tags/v1")
	r.commit("later")
	r.git(r.work, "tag", "-fa", "v1", "-m", "changed release")
	changed := r.git(r.work, "rev-parse", "refs/tags/v1")
	r.push(r.source, "refs/tags/v1")
	require.NotEqual(t, original, changed)

	run := r.sync(r.service(newFakeGitMirrorSyncStore()))
	assert.Equal(t, gitMirrorRunFailed, run.State)
	require.Len(t, run.Refs, 1)
	assert.Equal(t, "refs/tags/v1", run.Refs[0].Name)
	assert.Equal(t, gitMirrorRefFailed, run.Refs[0].Status)
	assert.Equal(t, original, r.refs(r.target)["refs/tags/v1"], "an existing target tag must not be rewritten")
}

func TestMirrorSyncRefusesDeletionWhenSourceRefReappears(t *testing.T) {
	r := newRealMirrorRepos(t)
	svc := r.service(newFakeGitMirrorSyncStore())
	r.mirrorFeatureThenDeleteAtSource(svc)
	targetBefore := r.refs(r.target)
	var restored string
	svc.runGitSync = func(ctx context.Context, sourceURL, targetURL string, changes []gitMirrorRefChange) error {
		require.Len(t, changes, 1)
		require.Empty(t, changes[0].to)
		restored = r.commit("source feature restored")
		r.push(r.source, "HEAD:refs/heads/feature")
		return defaultRunGitMirrorPush(ctx, sourceURL, targetURL, changes)
	}

	run := r.sync(svc)
	assert.Equal(t, gitMirrorRunFailed, run.State)
	assert.Equal(t, restored, r.refs(r.source)["refs/heads/feature"])
	assert.Equal(t, targetBefore, r.refs(r.target), "a deletion must stop when the source ref reappears after planning")
}

func TestMirrorSyncRemoteRejectionLeavesValidRefUnchanged(t *testing.T) {
	r := newRealMirrorRepos(t)
	r.commit("base")
	r.push(r.source, "HEAD:refs/heads/main")
	r.push(r.target, "HEAD:refs/heads/main")
	r.commit("next")
	r.push(r.source, "HEAD:refs/heads/main", "HEAD:refs/heads/z-valid")
	before := r.refs(r.target)
	hook := filepath.Join(strings.TrimPrefix(r.target, "file://"), "hooks", "update")
	require.NoError(t, os.WriteFile(hook, []byte("#!/bin/sh\nif [ \"$1\" = refs/heads/main ]; then exit 1; fi\nexit 0\n"), 0o755))

	run := r.sync(r.service(newFakeGitMirrorSyncStore()))
	assert.Equal(t, gitMirrorRunFailed, run.State)
	assert.Equal(t, before, r.refs(r.target), "remote rejection of one ref must leave the whole batch unchanged")
}

func TestMirrorSyncPushLeasesTargetAfterRemoteInspection(t *testing.T) {
	r := newRealMirrorRepos(t)
	r.commit("base")
	r.push(r.source, "HEAD:refs/heads/main")
	r.push(r.target, "HEAD:refs/heads/main")
	intermediate := r.commit("target intermediate")
	sourceTip := r.commit("source tip")
	r.push(r.source, "HEAD:refs/heads/main")

	hooks := t.TempDir()
	marker := filepath.Join(hooks, "pre-push-ran")
	targetDir := strings.TrimPrefix(r.target, "file://")
	r.git(targetDir, "fetch", r.source, sourceTip)
	script := fmt.Sprintf("#!/bin/sh\ngit --git-dir=%q update-ref refs/heads/main %s || exit 1\nprintf ran > %q\n", targetDir, intermediate, marker)
	require.NoError(t, os.WriteFile(filepath.Join(hooks, "pre-push"), []byte(script), 0o755))
	config := filepath.Join(t.TempDir(), "gitconfig")
	require.NoError(t, os.WriteFile(config, []byte(fmt.Sprintf("[core]\n\thooksPath = %s\n", hooks)), 0o600))
	t.Setenv("GIT_CONFIG_GLOBAL", config)

	run := r.sync(r.service(newFakeGitMirrorSyncStore()))
	_, err := os.Stat(marker)
	require.NoError(t, err, "the hook must move the target after Git has inspected the remote")
	assert.Equal(t, gitMirrorRunFailed, run.State)
	assert.Equal(t, sourceTip, r.refs(r.source)["refs/heads/main"])
	assert.Equal(t, intermediate, r.refs(r.target)["refs/heads/main"], "the push must honor its planned target revision after remote inspection")
}

func TestMirrorSyncSourceAheadThenIdempotent(t *testing.T) {
	r := newRealMirrorRepos(t)
	base := r.commit("base")
	r.push(r.source, "HEAD:refs/heads/main")
	r.push(r.target, "HEAD:refs/heads/main")
	ahead := r.commit("source ahead")
	r.push(r.source, "HEAD:refs/heads/main")
	svc := r.service(newFakeGitMirrorSyncStore())

	first := r.sync(svc)
	assert.Equal(t, gitMirrorRunSucceeded, first.State)
	require.Len(t, first.Refs, 1)
	assert.Equal(t, base, first.Refs[0].From)
	assert.Equal(t, ahead, first.Refs[0].To)
	assert.Equal(t, gitMirrorRefSucceeded, first.Refs[0].Status)
	assert.Equal(t, ahead, r.refs(r.target)["refs/heads/main"])

	second := r.sync(svc)
	assert.Equal(t, gitMirrorRunSucceeded, second.State)
	assert.Empty(t, second.Refs)
	assert.Equal(t, ahead, r.refs(r.target)["refs/heads/main"])
}

func TestMirrorSyncRefusesTargetAhead(t *testing.T) {
	r := newRealMirrorRepos(t)
	sourceTip := r.commit("source tip")
	r.push(r.source, "HEAD:refs/heads/main")
	r.push(r.target, "HEAD:refs/heads/main")
	targetTip := r.commit("target ahead")
	r.push(r.target, "HEAD:refs/heads/main")
	before := r.refs(r.target)

	run := r.sync(r.service(newFakeGitMirrorSyncStore()))
	assert.Equal(t, gitMirrorRunFailed, run.State)
	require.Len(t, run.Refs, 1)
	assert.Equal(t, gitMirrorRefFailed, run.Refs[0].Status)
	assert.Equal(t, sourceTip, r.refs(r.source)["refs/heads/main"])
	assert.Equal(t, targetTip, before["refs/heads/main"])
	assert.Equal(t, before, r.refs(r.target))
}
