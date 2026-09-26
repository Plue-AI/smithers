package compose

import (
	"net/http"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
)

// Credential APIs remain supported for third-party clients even when the web
// application has no management screen. Retired product routes must stay absent.
func TestServerRouter_RetiredProductFeatures(t *testing.T) {
	router := defaultRouter(nil).(chi.Routes)
	paths := map[string]bool{}
	require.NoError(t, chi.Walk(router, func(method, path string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		paths[method+" "+path] = true
		for _, retired := range []string{"/releases", "/milestones", "/file-drafts", "/pinned", "/stargazers", "/starred", "/subscriptions"} {
			require.NotContains(t, path, retired)
		}
		require.False(t, strings.HasSuffix(path, "/subscription"))
		require.False(t, strings.HasSuffix(path, "/pin"))
		require.NotContains(t, path, "/issues/{number}/dependencies")
		require.NotContains(t, path, "/issues/{number}/artifacts")
		if strings.Contains(path, "/reactions") {
			require.True(t, strings.HasSuffix(path, "/issues/{number}/comments/{comment}/reactions"), "only scoped message reactions are supported")
		}
		require.NotEqual(t, "/api/user/avatar", path)
		// Anonymous sandboxes booted a VM for any signed-out caller and had
		// no client once ../multi retired.
		require.False(t, strings.HasPrefix(path, "/api/public/sandboxes"), "anonymous sandbox route mounted: %s %s", method, path)
		return nil
	}))
	for _, retained := range []string{"POST /api/user/tokens", "POST /api/user/keys", "POST /api/repos/{owner}/{repo}/issues", "GET /api/repos/{owner}/{repo}/issues/{number}"} {
		require.True(t, paths[retained], "retained API missing: %s", retained)
	}
}
