package compose

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestServerRouterRetiresPairMarketplaceAndOAuthHosting(t *testing.T) {
	served := servedAPIRoutes(t)
	retained := map[string]bool{
		"get /api/oauth2/authorize":   false,
		"post /api/oauth2/token":      false,
		"post /api/oauth2/revoke":     false,
		"post /api/oauth2/revoke-all": false,
		"post /api/app-timelines":     false,
	}
	for _, route := range served {
		for _, prefix := range []string{"/api/pair-sessions", "/api/share", "/api/oauth2/applications"} {
			require.False(t, strings.HasPrefix(route.path, prefix), "retired route %s %s", route.method, route.path)
		}
		key := route.method + " " + route.path
		if _, ok := retained[key]; ok {
			retained[key] = true
		}
	}
	for route, found := range retained {
		require.True(t, found, "retained route %s", route)
	}
	router := allFlagsRouterForTest()
	for _, path := range []string{"/api/pair-sessions", "/api/pair-sessions/old-session/queue", "/api/pair-sessions/old-session/draft", "/api/share/listings", "/api/share/my/listings", "/api/oauth2/applications", "/api/oauth2/applications/1"} {
		for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete} {
			req := httptest.NewRequest(method, path, nil)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			require.Equal(t, http.StatusNotFound, rec.Code, "%s %s: %s", method, path, rec.Body.String())
		}
	}
}
