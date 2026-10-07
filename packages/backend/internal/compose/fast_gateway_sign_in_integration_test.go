package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/modelhost"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

func TestFastGatewayPKCEInstallToHostedCompletionPostgres(t *testing.T) {
	gatewayPool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(gatewayPool)
	user, err := q.CreateUser(ctx, db.CreateUserParams{Username: "signed-in-owner", LowerUsername: "signed-in-owner"})
	require.NoError(t, err)
	session := "hosted-sign-in-session"
	hash := sha256.Sum256([]byte(session))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: user.ID, Username: user.Username, SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	const platform = "pkce-cerebras-platform-key-private"
	var upstreamCalls atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls.Add(1)
		require.Equal(t, "Bearer "+platform, r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"hello"}}],"usage":{"prompt_tokens":8,"completion_tokens":2}}`))
	}))
	defer upstream.Close()
	gateway := &modelproxy.FastGateway{Quota: credits.FastQuota{DB: gatewayPool, DailyTokens: 5000}, Keys: modelproxy.StaticKeys{modelproxy.ProviderCerebras: platform}, Upstream: upstream.URL}
	cfg := testConfigAllFlagsOn()
	cfg.Auth.SessionCookieName = "session"
	hosted := httptest.NewServer(githubAppSetupComposeRouter(cfg, gatewayPool, nil, routerExtras{FastGateway: gateway}))
	defer hosted.Close()
	t.Setenv("SMITHERS_FAST_MODEL_GATEWAY", hosted.URL)
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	codec, err := webhook.NewSecretCodec("install-pkce-sealing-key")
	require.NoError(t, err)
	installCfg := testConfigAllFlagsOn()
	installCfg.Auth.Mode, installCfg.Auth.SessionCookieName = "selfhost", "session"
	installCfg.Server.PublicURL = "http://example.com"
	installCfg.Server.AllowedOrigins = []string{installCfg.Server.PublicURL}
	setup := &services.InstallSetupService{Pool: f.pool}
	require.NoError(t, setup.Initialize(ctx))
	installRouter := githubAppSetupComposeRouter(installCfg, f.pool, &routes.GitHubAppSetupHandler{Setup: setup, Owners: f.q, Roster: f.q})
	mountModelPublic(installRouter.(chi.Router), modelhost.OwnerModels{Pool: f.pool, Codec: codec}, f.q, installCfg)
	installSession := "install-owner-sign-in-session"
	hash = sha256.Sum256([]byte(installSession))
	_, err = f.q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: f.owner.ID, Username: f.owner.Username, SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	installCall := func(method, path string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, installCfg.Server.PublicURL+path, nil)
		r.Header.Set("Origin", installCfg.Server.PublicURL)
		r.AddCookie(&http.Cookie{Name: "session", Value: installSession})
		r.AddCookie(&http.Cookie{Name: "__csrf", Value: "install-csrf"})
		r.Header.Set("X-CSRF-Token", "install-csrf")
		w := httptest.NewRecorder()
		installRouter.ServeHTTP(w, r)
		require.NotContains(t, w.Body.String(), platform)
		return w
	}
	client := hosted.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	access := services.InstallFastModelAccess{Pool: f.pool, Codec: codec, Gateway: hosted.URL}
	signIn := func(badVerifier bool) (string, string) {
		res := installCall("POST", "/api/model/fast/sign-in")
		require.Equal(t, 200, res.Code, res.Body.String())
		var handoff map[string]string
		require.NoError(t, json.Unmarshal(res.Body.Bytes(), &handoff))
		target, err := url.Parse(handoff["url"])
		require.NoError(t, err)
		// An unsigned browser reaches the real Smithers login, never a credential.
		req, err := http.NewRequest("GET", target.String(), nil)
		require.NoError(t, err)
		response, err := client.Do(req)
		require.NoError(t, err)
		require.Equal(t, 303, response.StatusCode)
		require.Contains(t, response.Header.Get("Location"), "/api/auth/github?")
		response.Body.Close()
		req, err = http.NewRequest("GET", target.String(), nil)
		require.NoError(t, err)
		req.AddCookie(&http.Cookie{Name: "session", Value: session})
		response, err = client.Do(req)
		require.NoError(t, err)
		require.Equal(t, 200, response.StatusCode)
		var consent *http.Cookie
		for _, cookie := range response.Cookies() {
			if cookie.Name == fastConsentCookie {
				consent = cookie
			}
		}
		require.NotNil(t, consent)
		response.Body.Close()
		form := target.Query()
		form.Set("csrf_token", consent.Value)
		approve := func(withCookie bool) *http.Response {
			r, err := http.NewRequest("POST", hosted.URL+"/api/fast-model/sign-in", strings.NewReader(form.Encode()))
			require.NoError(t, err)
			r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
			r.AddCookie(&http.Cookie{Name: "session", Value: session})
			if withCookie {
				r.AddCookie(consent)
			}
			out, err := client.Do(r)
			require.NoError(t, err)
			return out
		}
		response = approve(false)
		require.Equal(t, 403, response.StatusCode)
		response.Body.Close()
		response = approve(true)
		require.Equal(t, 303, response.StatusCode)
		callback, err := url.Parse(response.Header.Get("Location"))
		require.NoError(t, err)
		response.Body.Close()
		require.Equal(t, target.Query().Get("state"), callback.Query().Get("state"))
		if badVerifier {
			body := `{"code":"` + callback.Query().Get("code") + `","code_verifier":"` + strings.Repeat("x", 43) + `","redirect_uri":"` + target.Query().Get("redirect_uri") + `"}`
			out, err := client.Post(hosted.URL+"/api/fast-model/exchange", "application/json", strings.NewReader(body))
			require.NoError(t, err)
			require.Equal(t, 400, out.StatusCode)
			out.Body.Close()
		}
		completed := installCall("GET", callback.RequestURI())
		require.Equal(t, 303, completed.Code, completed.Body.String())
		require.NotContains(t, completed.Body.String(), "smf_")
		credential, err := access.Credential(ctx)
		require.NoError(t, err)
		require.NotEmpty(t, credential)
		replay := installCall("GET", callback.RequestURI())
		require.Equal(t, 400, replay.Code)
		var stored string
		require.NoError(t, f.pool.QueryRow(ctx, `SELECT value::text FROM install_settings WHERE key=$1 AND sealed`, services.FastModelCredentialKey).Scan(&stored))
		require.NotContains(t, stored, credential)
		return target.Query().Get("install_id"), credential
	}
	install, credential := signIn(true)
	req, err := http.NewRequest("POST", access.InferenceURL(), strings.NewReader(`{"model":"gpt-oss-120b","max_completion_tokens":10,"messages":[{"role":"user","content":"hello"}]}`))
	require.NoError(t, err)
	req.Header.Set("Authorization", "Bearer "+credential)
	completion, err := client.Do(req)
	require.NoError(t, err)
	require.Equal(t, 200, completion.StatusCode)
	completion.Body.Close()
	require.EqualValues(t, 1, upstreamCalls.Load())
	left, err := gateway.Quota.Remaining(ctx, install, credential)
	require.NoError(t, err)
	require.EqualValues(t, 4990, left)
	signedOut := installCall("DELETE", "/api/model/fast")
	require.Equal(t, 200, signedOut.Code)
	empty, err := access.Credential(ctx)
	require.NoError(t, err)
	require.Empty(t, empty)
	sameInstall, rotated := signIn(false)
	require.Equal(t, install, sameInstall)
	require.NotEqual(t, credential, rotated)
	require.ErrorIs(t, gateway.Quota.Verify(ctx, install, credential), credits.ErrInstallCredential)
	left, err = gateway.Quota.Remaining(ctx, install, rotated)
	require.NoError(t, err)
	require.EqualValues(t, 4990, left, "sign-out/sign-in preserves the install's spent daily quota")
	var ordinaryTokens int64
	require.NoError(t, gatewayPool.QueryRow(ctx, `SELECT count(*) FROM oauth2_access_tokens`).Scan(&ordinaryTokens))
	require.Zero(t, ordinaryTokens, "fast-model sign-in never issues a user API token")
}
