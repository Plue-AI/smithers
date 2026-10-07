package compose

import (
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestInstallPublicStatusRemainsCredentialIndependent(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Auth.SessionCookieName = "selfhost", "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	router := githubAppSetupComposeRouter(cfg, f.pool, nil)
	require.Equal(t, "public", middleware.InstallMemberCommand("GET", "/api/status"))
	for _, kind := range []string{"none", "dead cookie", "unknown bearer"} {
		t.Run(kind, func(t *testing.T) {
			req := httptest.NewRequest("GET", "http://example.com/api/status", nil)
			if kind == "dead cookie" {
				req.AddCookie(&http.Cookie{Name: "session", Value: "expired-status-cookie"})
			}
			if kind == "unknown bearer" {
				req.Header.Set("Authorization", "Bearer smithers_dead")
			}
			decisions := 0
			req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(string) { decisions++ }))
			out := httptest.NewRecorder()
			router.ServeHTTP(out, req)
			require.Equal(t, 200, out.Code, out.Body.String())
			require.Contains(t, out.Body.String(), `"status":"degraded"`)
			require.Contains(t, out.Body.String(), `"canary"`)
			require.Equal(t, "no-store", out.Header().Get("Cache-Control"))
			require.Empty(t, out.Header().Values("Set-Cookie"))
			require.Zero(t, decisions)
			require.NotContains(t, out.Body.String(), f.owner.Username)
		})
	}
}
