package repohostserver

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// Repo-host is the last line behind the API's push doors: a push the API
// attributed to an agent run never moves the default bookmark (the one
// HEAD names, which the owner sets), whatever the API let through.
func TestReceivePackRefusesAgentRunDefaultBookmark(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	require.NoError(t, setGitDefaultBookmark(context.Background(), f.repo.gitDir, "main"))
	tip := f.commit("agent work", func(dir string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "agent.txt"), []byte("agent\n"), 0o644))
	})

	rec := postReceivePack(t, f, f.pushBody(f.base, tip, "refs/heads/main"), repohost.PusherCredentialHeader, string(middleware.CredentialAgentRun))
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	assert.Equal(t, f.base, f.repo.refs()["refs/heads/main"], "an agent run moved the default bookmark")

	create := f.pushBody(f.base, tip, "refs/heads/feature")
	copy(create[4:44], laneZeroOID) // the pack is the same; the command creates the bookmark
	rec = postReceivePack(t, f, create, repohost.PusherCredentialHeader, string(middleware.CredentialAgentRun))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, tip, f.repo.refs()["refs/heads/feature"])

	rec = postReceivePack(t, f, f.pushBody(f.base, tip, "refs/heads/main"), repohost.PusherCredentialHeader, string(middleware.CredentialSync))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, tip, f.repo.refs()["refs/heads/main"], "the sync credential copies GitHub's default branch")
}

// The default bookmark is the owner's persisted choice even while jj export
// has detached Git HEAD.
func TestReceivePackAgentRunDefaultBookmarkSurvivesDetachedHead(t *testing.T) {
	f := newLaneHTTPFixture(t, nil)
	require.NoError(t, setGitDefaultBookmark(context.Background(), f.repo.gitDir, "main"))
	require.NoError(t, os.WriteFile(filepath.Join(f.repo.gitDir, "HEAD"), []byte(f.base+"\n"), 0o644))
	tip := f.commit("agent work", func(dir string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "agent.txt"), []byte("agent\n"), 0o644))
	})

	rec := postReceivePack(t, f, f.pushBody(f.base, tip, "refs/heads/main"), repohost.PusherCredentialHeader, string(middleware.CredentialAgentRun))
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
}

func TestPushHookPayloadsCarryPusherCredential(t *testing.T) {
	headers := http.Header{}
	headers.Set("X-Smithers-Pusher-Id", "7")
	headers.Set(repohost.PusherCredentialHeader, string(middleware.CredentialSync))
	payloads := pushHookPayloadsFromRefDiff(map[string]string{}, map[string]string{"refs/heads/main": "abc"}, "alice", "demo", pushHookSenderFromHeaders(headers))
	require.Len(t, payloads, 1)
	assert.Equal(t, middleware.CredentialSync, payloads[0].PusherCredential)
}
