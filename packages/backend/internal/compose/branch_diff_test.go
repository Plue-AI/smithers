package compose

import (
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestTODOBranchDiffInstallComposition(t *testing.T) {
	for _, mode := range []string{config.AuthModeSelfHosted, config.AuthModeMultitenant} {
		t.Run(mode, func(t *testing.T) {
			cfg := testConfigAllFlagsOn()
			cfg.Auth.Mode = mode
			served := map[string]servedRoute{}
			walkServedRoutes(t, openAPIConformanceRouter(cfg), served)
			_, mounted := served["get /api/branches/{b}/diff"]
			require.Equal(t, mode == config.AuthModeSelfHosted, mounted)
		})
	}
}
