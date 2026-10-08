package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"github.com/go-chi/chi/v5"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/stretchr/testify/require"
)

func TestUnmappedInstallRouteRefusesSessionsAndTokens(t *testing.T) {
	for _, credential := range []struct {
		name string
		info *middleware.AuthInfo
	}{
		{"session", &middleware.AuthInfo{User: &db.User{ID: 1}}},
		{"delegated", &middleware.AuthInfo{User: &db.User{ID: 1}, IsTokenAuth: true, TokenSystemIssued: true, RawScopes: "repo,user,via:codex"}},
		{"run", &middleware.AuthInfo{User: &db.User{ID: 1}, IsTokenAuth: true, TokenSystemIssued: true, RawScopes: "write:repository"}},
		{"machine", &middleware.AuthInfo{User: &db.User{ID: 1}, IsTokenAuth: true, TokenSystemIssued: true, RawScopes: "write:repository,workspace:11111111-1111-4111-8111-111111111111"}},
	} {
		t.Run(credential.name, func(t *testing.T) {
			effects := 0
			handler := memberCommands(nil)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { effects++ }))
			for _, path := range []string{"/api/future-command", "/api/repos/maya/demo/landings/1/land/append"} {
				req := httptest.NewRequest(http.MethodPut, path, nil)
				req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), credential.info))
				out := httptest.NewRecorder()
				handler.ServeHTTP(out, req)
				require.Equal(t, http.StatusForbidden, out.Code, out.Body.String())
				require.Contains(t, out.Body.String(), `"class":"permission"`)
				require.Contains(t, out.Body.String(), `"code":"permission"`)
			}
			require.Zero(t, effects)
		})
	}
}

// A newly mounted door cannot acquire the install owner's authority by omission.
func TestInstallUnmappedLiveSessionPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Auth.SessionCookieName = "selfhost", "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	cookie := "unmapped-owner"
	digest := sha256.Sum256([]byte(cookie))
	_, err := f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: f.owner.ID, Username: f.owner.Username, SessionKey: hex.EncodeToString(digest[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	router := githubAppSetupComposeRouter(cfg, f.pool, nil).(chi.Router)
	effects := 0
	router.With(authLoader(f.q, cfg.Auth), memberCommands(f.q)).Post("/api/future-command", func(http.ResponseWriter, *http.Request) { effects++ })
	require.Empty(t, middleware.InstallMemberCommand(http.MethodPost, "/api/future-command"), "new routes must fail the coverage audit")
	for _, path := range []string{"/api/future-command", "/api/repos/gate-owner/app/landings/1/land/append"} {
		method := http.MethodPost
		if strings.Contains(path, "/land/append") {
			method = http.MethodPut
		}
		req := httptest.NewRequest(method, "http://example.com"+path, strings.NewReader(`{}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", cfg.Server.PublicURL)
		req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
		req.Header.Set("X-CSRF-Token", "csrf")
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		require.Equal(t, 403, out.Code, out.Body.String())
		require.Contains(t, out.Body.String(), `"code":"permission"`)
	}
	require.Zero(t, effects)
}
