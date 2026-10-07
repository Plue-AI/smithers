package compose

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// /runs reads the actual dispatch inventory through the full single-owner
// install. The provider and GitHub peers are scripted; no browser API, Live
// snapshot or monitor response is synthesized. Empty inventories stay empty.
func TestCatalogRunsBrowserInstallInventory(t *testing.T) {
	if os.Getenv("SMITHERS_CATALOG_RUNS_BROWSER") != "1" {
		t.Skip("enable the composed native browser journey")
	}
	spa, err := filepath.Abs("../../../../apps/app/dist")
	require.NoError(t, err)
	t.Setenv("SMITHERS_REHEARSAL_SPA_DIR", spa)
	t.Setenv("SMITHERS_FEATURE_FLAGS_FLOW_LOAD", "true")
	r := newRehearsal(t, "SMITHERS_CATALOG_RUNS_BROWSER", "C-CAT-01", "catalog-runs-")
	require.True(t, r.install("Install through Machine ready"))
	require.NoError(t, r.waitStackActive())
	cookies, err := json.Marshal(r.jar.Cookies(mustRehearsalURL(r.origin)))
	require.NoError(t, err)
	command := exec.CommandContext(r.ctx, "bun", "e2e/real/catalog-runs.browser.ts")
	command.Dir = filepath.Join(r.root, "apps/app")
	command.Env = append(os.Environ(), "SMITHERS_CATALOG_ORIGIN="+r.origin, "SMITHERS_CATALOG_COOKIES="+string(cookies))
	output, err := command.CombinedOutput()
	t.Log(string(output))
	require.NoError(t, err)
}
