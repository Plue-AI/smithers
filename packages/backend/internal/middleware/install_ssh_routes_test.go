package middleware

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestInstallSSHMemberCommandRoutes(t *testing.T) {
	require.Equal(t, "branch.read", InstallMemberCommand(http.MethodGet, "/api/ssh"))
	require.Empty(t, InstallMemberCommand(http.MethodPost, "/api/ssh"))
	require.Empty(t, InstallMemberCommand(http.MethodGet, "/api/ssh/extra"))
}
