package services

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/sandbox"
)

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

func TestAgentWorkspaceName(t *testing.T) {
	t.Parallel()
	assert.Equal(t, "agent-0f8fad5b", agentWorkspaceName("0f8fad5b-d9cb-469f-a165-70867728950e", ""))
	assert.Equal(t, "agent-0f8fad5b Fix the flaky test", agentWorkspaceName("0f8fad5b-d9cb-469f-a165-70867728950e", "  Fix the flaky test "))
	long := agentWorkspaceName("0f8fad5b-d9cb-469f-a165-70867728950e", "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz")
	assert.LessOrEqual(t, len(long), len("agent-0f8fad5b ")+48)
}

func TestPgUUIDFromString(t *testing.T) {
	t.Parallel()
	assert.True(t, pgUUIDFromString("0f8fad5b-d9cb-469f-a165-70867728950e").Valid)
	assert.False(t, pgUUIDFromString("nope").Valid)
	assert.Equal(t, "0f8fad5b-d9cb-469f-a165-70867728950e", UUIDString(pgUUIDFromString("0f8fad5b-d9cb-469f-a165-70867728950e")))
}

func TestBuildAgentForkContinueCommand_KeepsWorkingCopyAndStopsReporter(t *testing.T) {
	t.Parallel()
	cmd := buildAgentForkContinueCommand("smithers_tok")
	lines := splitLines(cmd)
	assert.Equal(t, "set -euo pipefail", lines[0])
	assert.Contains(t, cmd, "systemctl stop smithers-workspace-head.service")
	assert.Contains(t, cmd, "export GIT_CONFIG_VALUE_0='Authorization: Bearer smithers_tok'")
	assert.Contains(t, cmd, "git -C '/workspace' fetch origin")
	assert.Contains(t, cmd, "jj -R '/workspace' git import")
	assert.True(t, hasSuffixLine(lines, "jj -R '/workspace' new"), "the agent starts its own change on top of the inherited working copy")
	assert.NotContains(t, cmd, "bookmark set", "a same-bookmark fork must not reset the human's working copy")
}

func TestBuildForkBookmarkSwitchCommand_StopsInheritedReporter(t *testing.T) {
	t.Parallel()
	cmd := buildForkBookmarkSwitchCommand("smithers_tok", "feature")
	assert.Contains(t, cmd, "systemctl stop smithers-workspace-head.service")
	assert.Contains(t, cmd, "jj -R '/workspace' new 'feature'")
}

func TestBuildAgentMemberCloneCommand(t *testing.T) {
	t.Parallel()
	cmd := buildAgentMemberCloneCommand([]sandbox.GitRepositorySpec{
		{Repo: "https://x-access-token:tok@git.example/acme/lib", Path: "/workspace/acme/lib", Rev: "deadbeef"},
		{Repo: "", Path: "/skipped"},
	})
	assert.Contains(t, cmd, "install -d -o 'agent' -g 'agent' '/workspace/acme/lib'")
	assert.Contains(t, cmd, "git clone --quiet --depth 200 'https://x-access-token:tok@git.example/acme/lib' '/workspace/acme/lib'")
	assert.Contains(t, cmd, "git -C '/workspace/acme/lib' checkout --quiet --detach 'deadbeef'")
	assert.NotContains(t, cmd, "/skipped")
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
