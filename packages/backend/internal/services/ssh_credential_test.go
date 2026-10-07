package services

import (
	"github.com/stretchr/testify/require"
	"testing"
)

func TestSSHCredentialRetainsDelegationAcrossRenewalAndRevokes(t *testing.T) {
	tokens, files := &fakeTerminalTokens{}, &fakeSessionFiles{}
	credential := &terminalCredential{tokens: tokens, writer: files, workspaceID: "branch", sessionID: "ssh-session", userID: 7, repositoryID: 3, url: "http://127.0.0.1:47400", via: "ssh"}
	t.Cleanup(credential.Close)
	require.NoError(t, credential.AcquireCredential(t.Context()))
	require.Equal(t, "read:repository,read:user,repo:3,via:ssh,branch:branch,profile:terminal_s1,terminal-session:ssh-session", tokens.live[1].Scopes)
	require.Equal(t, "http://127.0.0.1:47400", credential.environment()["SMITHERS_URL"])
	original, exists := files.token("ssh-session")
	require.True(t, exists)
	credential.mu.Lock()
	err := credential.issueLocked(t.Context())
	credential.mu.Unlock()
	require.NoError(t, err)
	require.Equal(t, []int64{2}, tokens.liveIDs())
	require.Equal(t, "read:repository,read:user,repo:3,via:ssh,branch:branch,profile:terminal_s1,terminal-session:ssh-session", tokens.live[2].Scopes)
	replacement, exists := files.token("ssh-session")
	require.True(t, exists)
	require.NotEqual(t, original, replacement)
	credential.Close()
	require.Empty(t, tokens.liveIDs())
	_, exists = files.token("ssh-session")
	require.False(t, exists)
	require.ErrorIs(t, credential.AcquireCredential(t.Context()), errTerminalClosed)
}
