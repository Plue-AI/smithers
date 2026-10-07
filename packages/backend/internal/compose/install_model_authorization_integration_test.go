package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/modelhost"
	"github.com/stretchr/testify/require"
)

func TestInstallModelAuthorizationPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Auth.SessionCookieName = "selfhost", "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	router := githubAppSetupComposeRouter(cfg, f.pool, nil, routes.NewSmithersMetrics())
	mountModelPublic(router.(chi.Router), modelhost.OwnerModels{Pool: f.pool}, f.q, cfg)
	for _, user := range []db.User{f.owner, f.other} {
		sum := sha256.Sum256([]byte("model-authority-" + user.Username))
		_, err := f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: user.ID, Username: user.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
	}
	delegated := f.token(f.owner, "model-agent", "write:repository,write:user,via:codex", true)
	run := f.token(f.owner, "model-run", "write:repository,write:user", true)
	for _, route := range []struct{ method, path, command, body string }{
		{"GET", "/api/install/metrics", "install.read", ""},
		{"POST", "/api/model/credential", "settings.model-key", `{}`},
		{"GET", "/api/model/credential/receipt?id=private", "settings.model-key", ""},
		{"PUT", "/api/model/default", "settings.model.set", `{"model":null}`},
		{"POST", "/api/model/test", "model.test", `{}`},
		{"PUT", "/api/agents/reviewer/model", "agent.model", `{}`},
	} {
		for _, actor := range []struct{ name, token, cookie, code string }{
			{"delegated", delegated, "", "never"},
			{"run", run, "", "permission"},
			{"member", "", "model-authority-" + f.other.Username, "permission"},
		} {
			t.Run(route.command+route.path+"/"+actor.name, func(t *testing.T) {
				req := httptest.NewRequest(route.method, cfg.Server.PublicURL+route.path, strings.NewReader(route.body))
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Origin", cfg.Server.PublicURL)
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
				require.Contains(t, out.Body.String(), `"class":"`+actor.code+`"`)
				require.Equal(t, []string{route.command}, decisions)
			})
		}
	}
	var effects int
	require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM owner_model_defaults) + (SELECT count(*) FROM owner_model_credentials) + (SELECT count(*) FROM owner_model_credential_receipts)`).Scan(&effects))
	require.Zero(t, effects)
	// The owner's real default mutation is admitted once, before persistence.
	_, err := f.pool.Exec(f.ctx, `INSERT INTO owner_model_defaults(user_id,model) VALUES($1,'{"modelId":"prior"}')`, f.owner.ID)
	require.NoError(t, err)
	req := httptest.NewRequest("PUT", cfg.Server.PublicURL+"/api/model/default", strings.NewReader(`{"model":null}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", cfg.Server.PublicURL)
	req.AddCookie(&http.Cookie{Name: "session", Value: "model-authority-" + f.owner.Username})
	req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
	req.Header.Set("X-CSRF-Token", "csrf")
	var decisions []string
	req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
	out := httptest.NewRecorder()
	router.ServeHTTP(out, req)
	require.Equal(t, 200, out.Code, out.Body.String())
	require.Equal(t, []string{"settings.model.set"}, decisions)
	require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT count(*) FROM owner_model_defaults WHERE user_id=$1`, f.owner.ID).Scan(&effects))
	require.Zero(t, effects)
	for _, authenticated := range []bool{false, true} {
		req := httptest.NewRequest("GET", cfg.Server.PublicURL+"/api/install/metrics", nil)
		if authenticated {
			req.AddCookie(&http.Cookie{Name: "session", Value: "model-authority-" + f.owner.Username})
		}
		var decisions []string
		req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		if authenticated {
			require.Equal(t, 200, out.Code, out.Body.String())
			require.Equal(t, []string{"install.read"}, decisions)
			require.Contains(t, out.Body.String(), `"metrics":`)
		} else {
			require.Equal(t, 401, out.Code, out.Body.String())
			require.Empty(t, decisions)
		}
	}
}
