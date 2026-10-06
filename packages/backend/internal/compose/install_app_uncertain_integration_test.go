package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// Consumed conversion state survives both an ambiguous response and a crash
// before the callback can mark failure. Neither may create a replacement App.
func TestInstallAppUncertainConversionCannotRestartPostgres(t *testing.T) {
	for _, crash := range []bool{false, true} {
		name := "ambiguous response"
		if crash {
			name = "consumed before process loss"
		}
		t.Run(name, func(t *testing.T) {
			pool, _ := postgresfixture.NewProductDatabase(t)
			ctx := context.Background()
			q := db.New(pool)
			codec, err := webhook.NewSecretCodec("uncertain-app-install-key")
			require.NoError(t, err)
			var calls atomic.Int32
			fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/users/acme" {
					_, _ = w.Write([]byte(`{"type":"Organization"}`))
					return
				}
				if r.Method == "POST" {
					calls.Add(1)
				}
				w.WriteHeader(http.StatusBadGateway)
			}))
			defer fake.Close()
			origins := middleware.FixedOrigins("http://localhost:4000")
			store := services.NewGitHubAppCredentialStore(pool, codec)
			sessions := &services.InstallSetupSessions{Pool: pool}
			digest := sha256.Sum256([]byte("uncertain-setup-token"))
			value, _ := json.Marshal(hex.EncodeToString(digest[:]))
			require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "setup.token", Value: value}))
			session, err := sessions.Exchange(ctx, "uncertain-setup-token")
			require.NoError(t, err)
			require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "setup.step.address", Value: []byte(`{"status":"done"}`)}))
			now := time.Now()
			newRouter := func() http.Handler {
				service := services.NewGitHubAppManifestService(pool, store, fake.URL, origins)
				service.Now = func() time.Time { return now }
				h := &routes.GitHubAppSetupHandler{Service: service, Store: store, Owners: q, Sessions: sessions, Origins: origins, Setup: &services.InstallSetupService{Pool: pool, Now: func() time.Time { return now }}}
				cfg := testConfigAllFlagsOn()
				cfg.Auth.Mode = "selfhost"
				cfg.Server.PublicURL = "http://localhost:4000"
				return githubAppSetupComposeRouter(cfg, pool, h)
			}
			router := newRouter()
			request := func(method, path string, cookies []*http.Cookie) *httptest.ResponseRecorder {
				r := httptest.NewRequest(method, "http://localhost:4000"+path, strings.NewReader(`{"owner":"acme"}`))
				r.RemoteAddr = "127.0.0.1:12345"
				r.Header.Set("Origin", "http://localhost:4000")
				r.Header.Set("Content-Type", "application/json")
				r.Header.Set("X-CSRF-Token", "csrf")
				r.AddCookie(&http.Cookie{Name: routes.GitHubAppSetupSessionCookie, Value: session})
				r.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
				for _, c := range cookies {
					r.AddCookie(c)
				}
				w := httptest.NewRecorder()
				router.ServeHTTP(w, r)
				return w
			}
			w := request("POST", "/api/install/setup/app", nil)
			require.Equal(t, 200, w.Code, w.Body.String())
			var start struct {
				State string `json:"state"`
			}
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &start))
			cookies := w.Result().Cookies()
			if crash {
				_, err := q.ConsumeGithubAppManifestState(ctx, db.ConsumeGithubAppManifestStateParams{Digest: services.GitHubAppStateDigest(start.State), SetupSessionDigest: services.GitHubAppStateDigest(session), Origin: "http://localhost:4000"})
				require.NoError(t, err)
			} else {
				w = request("GET", "/setup/github/callback?code=uncertain-code&state="+start.State, cookies)
				require.GreaterOrEqual(t, w.Code, 400, w.Body.String())
				require.EqualValues(t, 1, calls.Load())
			}
			now = now.Add(11 * time.Minute)
			router = newRouter() // New composition reads only durable state.
			before, err := q.GetInstallSetting(ctx, "setup.step.app_manifest")
			require.NoError(t, err)
			w = request("GET", "/api/install", nil)
			require.Equal(t, 200, w.Code, w.Body.String())
			require.Contains(t, w.Body.String(), `"id":"app_manifest","state":"failed"`)
			require.Contains(t, w.Body.String(), `"code":"outcome_unknown"`)
			w = request("POST", "/api/install/setup/app", nil)
			require.Equal(t, 409, w.Code, w.Body.String())
			require.JSONEq(t, `{"code":"conflict","class":"conflict","message":"Recover the existing GitHub App credentials"}`, w.Body.String())
			after, err := q.GetInstallSetting(ctx, "setup.step.app_manifest")
			require.NoError(t, err)
			require.JSONEq(t, string(before.Value), string(after.Value))
			var count int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM github_app_manifest_states`).Scan(&count))
			require.Equal(t, 1, count)
			_, err = store.Load(ctx)
			require.ErrorIs(t, err, services.ErrGitHubAppNotConfigured)
			if crash {
				require.Zero(t, calls.Load())
			} else {
				require.EqualValues(t, 1, calls.Load())
			}
		})
	}
}
