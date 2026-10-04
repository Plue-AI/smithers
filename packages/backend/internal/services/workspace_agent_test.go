package services

import (
	"github.com/smithersai/smithers/packages/backend/sandbox"
	"github.com/stretchr/testify/require"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestPgUUIDFromString(t *testing.T) {
	t.Parallel()
	assert.True(t, pgUUIDFromString("0f8fad5b-d9cb-469f-a165-70867728950e").Valid)
	assert.False(t, pgUUIDFromString("nope").Valid)
	assert.Equal(t, "0f8fad5b-d9cb-469f-a165-70867728950e", UUIDString(pgUUIDFromString("0f8fad5b-d9cb-469f-a165-70867728950e")))
}

func TestBuildForkBookmarkSwitchCommand_StopsInheritedReporter(t *testing.T) {
	t.Parallel()
	cmd := buildForkBookmarkSwitchCommand("smithers_tok", "feature")
	assert.Contains(t, cmd, "systemctl stop smithers-workspace-head.service")
	assert.Contains(t, cmd, "jj -R '/workspace' new 'feature'")
}

func splitLines(s string) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	if start < len(s) {
		out = append(out, s[start:])
	}
	return out
}

func hasSuffixLine(lines []string, want string) bool {
	for _, line := range lines {
		if len(line) >= len(want) && line[len(line)-len(want):] == want {
			return true
		}
	}
	return false
}

func TestMergeEgressSecrets_RunBindingsWin(t *testing.T) {
	t.Parallel()
	base := []sandbox.EgressProxySecret{
		{Name: "REPO_TOKEN", Value: "repo", Hosts: []string{"a.example"}},
		{Name: "ANTHROPIC_API_KEY", Value: "repo-key", Hosts: []string{"api.anthropic.com"}},
	}
	run := []sandbox.EgressProxySecret{
		{Name: "ANTHROPIC_API_KEY", Value: "run-key", Hosts: []string{"api.anthropic.com"}},
		{Name: "SMITHERS_CACHE_TOKEN", Value: "cache", Hosts: []string{"api.example"}},
	}
	merged := mergeEgressSecrets(base, run)
	require.Len(t, merged, 3)
	byName := map[string]string{}
	for _, secret := range merged {
		byName[secret.Name] = secret.Value
	}
	assert.Equal(t, "run-key", byName["ANTHROPIC_API_KEY"], "the run's binding replaces the repository's")
	assert.Equal(t, "repo", byName["REPO_TOKEN"])
	assert.Equal(t, "cache", byName["SMITHERS_CACHE_TOKEN"])
}
