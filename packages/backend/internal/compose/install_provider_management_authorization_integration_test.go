package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

func TestInstallProviderManagementCommandsPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{"http://example.com"}
	require.NoError(t, f.q.UpsertInstallSetting(f.ctx, db.UpsertInstallSettingParams{Key: "models.chatgpt", Value: []byte("true")}))
	connections := services.NewProviderConnectionService(f.q, nil, nil, services.WithSubscriptionConnectionsEnabled(true))
	router := githubAppSetupComposeRouter(cfg, f.pool, nil, &routes.ProviderConnectionHandler{Service: connections})
	for _, user := range []db.User{f.owner, f.other} {
		sum := sha256.Sum256([]byte("provider-management-" + user.Username))
		_, err := f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: user.ID, Username: user.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
	}
	delegated := f.token(f.owner, "account-agent", "write:repository,write:user,via:codex", true)
	run := f.token(f.owner, "account-run", "write:repository,write:user", true)
	for _, route := range []struct{ method, path, command string }{
		{"GET", "", "secrets.connections"},
		{"GET", "/absent", "secrets.connections"},
		{"POST", "", "secrets.connect"},
		{"PUT", "/order", "secrets.move"},
		{"POST", "/codex/device", "secrets.connect.codex"},
		{"POST", "/codex/device/absent", "secrets.connect.codex"},
		{"DELETE", "/absent", "secrets.revoke"},
		{"POST", "/absent/refresh", "secrets.connect"},
		{"POST", "/absent/grants", "secrets.scope"},
		{"DELETE", "/absent/grants/1", "secrets.scope"},
	} {
		for _, actor := range []struct{ name, token, cookie, code string }{
			{"delegated", delegated, "", "never"},
			{"run", run, "", "permission"},
			{"member", "", "provider-management-" + f.other.Username, "permission"},
		} {
			t.Run(route.method+route.path+"/"+actor.name, func(t *testing.T) {
				req := httptest.NewRequest(route.method, "http://example.com/api/user/provider-connections"+route.path, strings.NewReader(`{}`))
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Origin", "http://example.com")
				req.Header.Set("Smithers-Actor", "person")
				if actor.token != "" {
					req.Header.Set("Authorization", "Bearer "+actor.token)
				} else {
					req.AddCookie(&http.Cookie{Name: "session", Value: actor.cookie})
					req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
					req.Header.Set("X-CSRF-Token", "csrf")
				}
				var decisions []string
				req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
				out := httptest.NewRecorder()
				router.ServeHTTP(out, req)
				require.Equal(t, 403, out.Code, out.Body.String())
				require.Contains(t, out.Body.String(), `"code":"`+actor.code+`"`)
				require.Equal(t, []string{route.command}, decisions)
			})
		}
	}
	t.Run("owner reads actual connections", func(t *testing.T) {
		req := httptest.NewRequest("GET", "http://example.com/api/user/provider-connections", nil)
		req.AddCookie(&http.Cookie{Name: "session", Value: "provider-management-" + f.owner.Username})
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		require.Equal(t, 200, out.Code, out.Body.String())
		require.JSONEq(t, `[]`, out.Body.String())
	})
	var stored int
	require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT count(*) FROM provider_connections`).Scan(&stored))
	require.Zero(t, stored)
}
