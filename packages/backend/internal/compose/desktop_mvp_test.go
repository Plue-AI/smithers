package compose

import (
	"github.com/stretchr/testify/require"
	"strings"
	"testing"
)

func TestWorkspaceDesktopRoutesRetired(t *testing.T) {
	routes := servedAPIRoutes(t)
	var workspace, terminal, files bool
	for _, route := range routes {
		require.NotContains(t, route.path, "/desktop")
		if strings.Contains(route.path, "/workspaces") {
			workspace = true
		}
		if strings.Contains(route.path, "/sessions") {
			terminal = true
		}
		if strings.Contains(route.path, "/files") {
			files = true
		}
	}
	require.True(t, workspace)
	require.True(t, terminal)
	require.True(t, files)
}
