package compose

import (
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestGitHubSyncInstallComposition(t *testing.T) {
	for _, mode := range []string{config.AuthModeSelfHosted, config.AuthModeMultitenant} {
		t.Run(mode, func(t *testing.T) {
			cfg := testConfigAllFlagsOn()
			cfg.Auth.Mode = mode
			served := map[string]servedRoute{}
			walkServedRoutes(t, openAPIConformanceRouter(cfg), served)
			for _, method := range []string{"get", "post"} {
				route, mounted := served[method+" /api/github/sync"]
				require.Equal(t, mode == config.AuthModeSelfHosted, mounted)
				if mode == config.AuthModeSelfHosted {
					require.True(t, route.authed, "a signed-in person reads and retries the sync")
					_, legacy := served[method+" /api/repos/{owner}/{repo}/github/main-pull"]
					require.False(t, legacy)
				}
			}
		})
	}
}
