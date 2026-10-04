package ssh

import (
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestParseWorkspaceLogins(t *testing.T) {
	token := "abcdefghijklmnopqrstuvwxyz012345"
	want := WorkspaceAccess{SandboxID: "msb_1234-abcd", User: "developer", Token: token}

	got, ok := parseWorkspacePublicKeyLogin("msb_1234-abcd+developer:" + token)
	require.True(t, ok)
	assert.Equal(t, want, got)

	got, ok = parseWorkspacePasswordLogin("msb_1234-abcd+developer", token)
	require.True(t, ok)
	assert.Equal(t, want, got)

	for _, login := range []string{
		"bad/path+developer:" + token,
		"msb_1234+../../root:" + token,
		"msb_1234+developer:short",
		"msb_1234+developer:" + token + " whitespace",
	} {
		_, ok := parseWorkspacePublicKeyLogin(login)
		assert.False(t, ok, login)
	}
}

func TestResolveBranchName(t *testing.T) {
	branches := []string{"scratch/ben/retry-webhooks", "scratch/maya/retry-webhooks", "smithers/retry-webhooks", "scratch/maya/draft"}
	for _, tc := range []struct{ login, want string }{
		{"retry-webhooks", "smithers/retry-webhooks"},
		{"smithers/retry-webhooks", "smithers/retry-webhooks"},
		{"scratch/ben/retry-webhooks", "scratch/ben/retry-webhooks"},
		{"draft", "scratch/maya/draft"},
	} {
		got, err := ResolveBranchName(tc.login, branches)
		require.NoError(t, err)
		assert.Equal(t, tc.want, got)
	}
	for _, login := range []string{"", "main", "missing", "../draft", "scratch//draft", "scratch/maya/../draft", "sandbox+maya", "sandbox+maya:abcdefghijklmnopqrstuvwxyz", "draft\n", "-oProxyCommand=evil", "DRAFT", "rétry", "draft;id"} {
		_, err := ResolveBranchName(login, branches)
		require.ErrorIs(t, err, ErrWorkspaceAccessDenied, login)
	}
	_, err := ResolveBranchName("retry-webhooks", []string{"scratch/maya/retry-webhooks", "scratch/ben/retry-webhooks", "scratch/maya/retry-webhooks"})
	require.EqualError(t, err, "ambiguous branch: scratch/ben/retry-webhooks, scratch/maya/retry-webhooks")
	got, err := ResolveBranchName("draft", []string{"scratch/maya/draft", "scratch/maya/draft"})
	require.NoError(t, err)
	assert.Equal(t, "scratch/maya/draft", got)
	// The legacy composition never recognizes bare branch names as grants.
	_, ok := parseWorkspacePublicKeyLogin("retry-webhooks")
	assert.False(t, ok)
	_, ok = parseWorkspacePasswordLogin("retry-webhooks", "abcdefghijklmnopqrstuvwxyz")
	assert.False(t, ok)
}
