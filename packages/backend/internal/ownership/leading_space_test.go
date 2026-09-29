package ownership

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestLeadingSpaceDirectoryLoadsItsOwnPolicy(t *testing.T) {
	dirs := []string{" secret", "protected", "secret ", "\tsecret", "\u00a0secret", "   "}
	loader := mapLoader{"OWNERS": "agents: auto-land\n"}
	for _, dir := range dirs {
		loader[dir+"/OWNERS"] = "alice\nagents: deny\n"
	}
	for _, dir := range dirs {
		t.Run(dir, func(t *testing.T) {
			file := dir + "/file.go"
			tree, err := LoadTree(context.Background(), loader, "revision", []string{file})
			require.NoError(t, err)
			require.Contains(t, tree.Files, dir, "the actual directory's OWNERS must be loaded")
			resolved := tree.Resolve(file)
			require.Equal(t, file, resolved.Path)
			require.Equal(t, PolicyDeny, resolved.AgentPolicy)
			require.Equal(t, "alice", resolved.Owners[0].Login)
		})
	}
}

func TestTrailingWhitespaceInFilenameIsPreserved(t *testing.T) {
	for _, file := range []string{"protected/file.go ", "protected/file.go\t", "protected/file.go\u00a0"} {
		tree, err := LoadTree(context.Background(), mapLoader{"protected/OWNERS": "alice\nagents: deny\n"}, "revision", []string{file})
		require.NoError(t, err)
		resolved := tree.Resolve(file)
		require.Equal(t, file, resolved.Path)
		require.Equal(t, PolicyDeny, resolved.AgentPolicy)
	}
}

func TestMatchPreservesLeadingSpaceForOwnershipPatterns(t *testing.T) {
	require.False(t, Match("secret/**", " secret/file.go"))
	require.True(t, Match("./ secret/**", " secret/file.go"))
	require.True(t, Match("secret/**", "secret/file.go"))
}
