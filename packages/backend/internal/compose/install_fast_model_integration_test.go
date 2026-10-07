package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/modelhost"
	"github.com/stretchr/testify/require"
)

// C-FM-01: real install HTTP authorization, PKCE handoff/exchange, sealed
// PostgreSQL settings, public projection and deletion. No real gateway writes.
func TestInstallFastModelSignInPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	codec, err := webhook.NewSecretCodec("fast-install-fixture")
	require.NoError(t, err)
	var exchanges atomic.Int32
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/api/fast-model/exchange", r.URL.Path)
		var body map[string]string
		require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
		require.Equal(t, "one-time-code", body["code"])
		challenge := sha256.Sum256([]byte(body["code_verifier"]))
		require.NotEqual(t, [32]byte{}, challenge)
		exchanges.Add(1)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"credential":"install-private-credential","remaining":123,"reset_at":"2026-10-08T00:00:00Z"}`)
	}))
	defer gateway.Close()
	t.Setenv("SMITHERS_FAST_MODEL_GATEWAY", gateway.URL)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Auth.SessionCookieName = "selfhost", "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	setup := &services.InstallSetupService{Pool: f.pool}
	require.NoError(t, setup.Initialize(f.ctx))
	router := githubAppSetupComposeRouter(cfg, f.pool, &routes.GitHubAppSetupHandler{Setup: setup, Owners: f.q, Roster: f.q})
	mountModelPublic(router.(chi.Router), modelhost.OwnerModels{Pool: f.pool, Codec: codec}, f.q, cfg)
	for _, user := range []db.User{f.owner, f.other} {
		sum := sha256.Sum256([]byte("fast-session-" + user.Username))
		_, err := f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: user.ID, Username: user.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
	}
	call := func(method, path, who, token string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, cfg.Server.PublicURL+path, nil)
		req.Header.Set("Origin", cfg.Server.PublicURL)
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		} else {
			req.AddCookie(&http.Cookie{Name: "session", Value: "fast-session-" + who})
			req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
			req.Header.Set("X-CSRF-Token", "csrf")
		}
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		return out
	}
	owner := f.owner.Username
	for _, path := range []string{"/api/model/fast/sign-in", "/api/model/fast"} {
		method := "POST"
		if path == "/api/model/fast" {
			method = "DELETE"
		}
		require.Equal(t, 403, call(method, path, f.other.Username, "").Code)
		for _, token := range []string{f.token(f.owner, "fast-machine-"+method, "write:user,write:repository", true), f.token(f.owner, "fast-flow-"+method, "write:user,write:repository,via:codex", true)} {
			require.Equal(t, 403, call(method, path, "", token).Code)
		}
	}
	res := call("POST", "/api/model/fast/sign-in", owner, "")
	require.Equal(t, 200, res.Code, res.Body.String())
	var handoff map[string]string
	require.NoError(t, json.Unmarshal(res.Body.Bytes(), &handoff))
	target, err := url.Parse(handoff["url"])
	require.NoError(t, err)
	require.Equal(t, "S256", target.Query().Get("code_challenge_method"))
	require.Equal(t, "http://example.com/api/model/fast/return", target.Query().Get("redirect_uri"))
	state := target.Query().Get("state")
	require.Equal(t, 400, call("GET", "/api/model/fast/return?code=one-time-code&state=wrong", owner, "").Code)
	res = call("GET", "/api/model/fast/return?code=one-time-code&state="+state, owner, "")
	require.Equal(t, 303, res.Code, res.Body.String())
	require.NotContains(t, res.Body.String(), "install-private-credential")
	require.Equal(t, int32(1), exchanges.Load())
	require.Equal(t, 400, call("GET", "/api/model/fast/return?code=one-time-code&state="+state, owner, "").Code)
	require.Equal(t, int32(1), exchanges.Load())
	var sealed bool
	var stored string
	require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT sealed,value::text FROM install_settings WHERE key=$1`, services.FastModelCredentialKey).Scan(&sealed, &stored))
	require.True(t, sealed)
	require.NotContains(t, stored, "install-private-credential")
	access := services.InstallFastModelAccess{Pool: f.pool, Codec: codec}
	credential, err := access.Credential(f.ctx)
	require.NoError(t, err)
	require.Equal(t, "install-private-credential", credential)
	res = call("GET", "/api/install", owner, "")
	require.Equal(t, 200, res.Code, res.Body.String())
	require.NotContains(t, res.Body.String(), "install-private-credential")
	require.Contains(t, res.Body.String(), `"remaining":123`)
	require.Contains(t, res.Body.String(), `"source":"Smithers"`)
	res = call("GET", "/api/model/catalog", owner, "")
	require.Equal(t, 200, res.Code)
	require.NotContains(t, res.Body.String(), "install-private-credential")
	require.NotContains(t, res.Body.String(), services.FastModelCredentialKey)
	for _, path := range []string{"/api/model/fast/credential", "/api/install/settings/" + services.FastModelCredentialKey} {
		res = call("GET", path, owner, "")
		require.NotContains(t, res.Body.String(), "install-private-credential")
		require.NotEqual(t, 200, res.Code)
	}
	res = call("DELETE", "/api/model/fast", owner, "")
	require.Equal(t, 200, res.Code, res.Body.String())
	credential, err = access.Credential(f.ctx)
	require.NoError(t, err)
	require.Empty(t, credential)
	status, err := access.Status(f.ctx)
	require.NoError(t, err)
	require.False(t, status.SignedIn)
	// Cancelling a browser handoff deletes its sealed PKCE verifier too.
	res = call("POST", "/api/model/fast/sign-in", owner, "")
	require.Equal(t, 200, res.Code)
	require.Equal(t, 200, call("DELETE", "/api/model/fast", owner, "").Code)
	var n int
	require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT count(*) FROM install_settings WHERE key IN ('models.smithers.credential','models.smithers.pending','models.smithers.status')`).Scan(&n))
	require.Zero(t, n)
	require.False(t, strings.Contains(stored, state))
}
