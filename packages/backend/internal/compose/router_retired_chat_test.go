package compose

import (
	"net/http"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
)

// Inspect the real composed router, not a hand-built route fixture. Provider
// endpoints must disappear while native conversations and core sync stay live.
func TestServerRouter_RetiredChatIntegrations(t *testing.T) {
	paths := map[string]bool{}
	require.NoError(t, chi.Walk(defaultRouter(nil).(chi.Routes), func(method, path string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		paths[method+" "+path] = true
		require.False(t, strings.HasPrefix(path, "/api/repos/{owner}/{repo}/issues/sync"), path)
		require.False(t, strings.HasPrefix(path, "/api/repos/{owner}/{repo}/issues/{number}/sync"), path)
		return nil
	}))
	for _, retained := range []string{
		"POST /api/repos/{owner}/{repo}/issues/{number}/comments",
		"GET /api/repos/{owner}/{repo}/issues/{number}/comments",
		"GET /api/repos/{owner}/{repo}/issues/{number}/comments/{comment}/reactions",
		"PUT /api/repos/{owner}/{repo}/issues/{number}/comments/{comment}/reactions",
		"GET /api/repos/{owner}/{repo}/issues/state-events",
		"POST /api/repos/{owner}/{repo}/sync",
		"GET /api/integrations/mcp",
		"GET /api/integrations/skills",
	} {
		require.True(t, paths[retained], "retained route missing: %s", retained)
	}
}
