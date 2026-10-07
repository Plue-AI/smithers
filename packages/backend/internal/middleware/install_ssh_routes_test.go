package middleware

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestInstallSSHMemberCommandRoutes(t *testing.T) {
	require.Equal(t, "ssh", InstallMemberCommand(http.MethodGet, "/api/ssh"))
	require.Equal(t, "ssh", InstallMemberCommand(http.MethodGet, "/api/repos/maya/demo/workspaces/box/ssh"))
	require.Equal(t, "ssh", InstallMemberCommand(http.MethodGet, "/api/repos/maya/demo/workspace/sessions/terminal/ssh"))
	require.Empty(t, InstallMemberCommand(http.MethodPost, "/api/ssh"))
	require.Empty(t, InstallMemberCommand(http.MethodGet, "/api/ssh/extra"))
}
