package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

func TestFastGatewayBrowserSignInPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	owner, err := q.CreateUser(t.Context(), db.CreateUserParams{Username: "signin-owner", LowerUsername: "signin-owner"})
	require.NoError(t, err)
	hash := sha256.Sum256([]byte("gateway-owner-session"))
	_, err = q.CreateAuthSession(t.Context(), db.CreateAuthSessionParams{UserID: owner.ID, Username: owner.Username, SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	gateway := &modelproxy.FastGateway{Quota: credits.FastQuota{DB: pool, DailyTokens: 100000}, Keys: modelproxy.StaticKeys{modelproxy.ProviderCerebras: "platform-key"}}
	router := githubAppSetupComposeRouter(cfg, pool, nil, routerExtras{FastGateway: gateway})
	server := httptest.NewServer(router)
	defer server.Close()
	codec, err := webhook.NewSecretCodec("sign-in-fixture-seal")
	require.NoError(t, err)
	access := services.InstallFastModelAccess{Pool: pool, Codec: codec, Gateway: server.URL}
	handoff, err := access.Begin(t.Context(), owner.ID, "http://mini.local/api/model/fast/return")
	require.NoError(t, err)
	target, err := url.Parse(handoff)
	require.NoError(t, err)
	call := func(method, path, body string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, cfg.Server.PublicURL+path, strings.NewReader(body))
		r.Header.Set("Origin", cfg.Server.PublicURL)
		if method == "POST" {
			r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		}
		for _, cookie := range cookies {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	session := &http.Cookie{Name: "session", Value: "gateway-owner-session"}
	path := target.RequestURI()
	res := call("GET", path, "")
	require.Equal(t, 303, res.Code, res.Body.String())
	require.True(t, strings.HasPrefix(res.Header().Get("Location"), "/api/auth/github?return_to="))
	res = call("GET", path, "", session)
	require.Equal(t, 200, res.Code, res.Body.String())
	require.Contains(t, res.Body.String(), "Sign in to Smithers")
	require.NotContains(t, res.Body.String(), "smf_")
	var consent *http.Cookie
	for _, cookie := range res.Result().Cookies() {
		if cookie.Name == fastConsentCookie {
			consent = cookie
		}
	}
	require.NotNil(t, consent)
	input := target.Query()
	input.Set("csrf_token", "wrong")
	res = call("POST", "/api/fast-model/sign-in", input.Encode(), session, consent)
	require.Equal(t, 403, res.Code)
	input.Set("csrf_token", consent.Value)
	res = call("POST", "/api/fast-model/sign-in", input.Encode(), session, consent)
	require.Equal(t, 303, res.Code, res.Body.String())
	returned, err := url.Parse(res.Header().Get("Location"))
	require.NoError(t, err)
	require.Equal(t, "mini.local", returned.Host)
	require.Equal(t, target.Query().Get("state"), returned.Query().Get("state"))
	require.NotContains(t, res.Body.String(), "smf_")
	// Browser-origin requests cannot exchange the one-time code for a secret.
	req := httptest.NewRequest("POST", cfg.Server.PublicURL+"/api/fast-model/exchange", strings.NewReader(`{}`))
	req.Header.Set("Origin", "http://mini.local")
	out := httptest.NewRecorder()
	router.ServeHTTP(out, req)
	require.Equal(t, 403, out.Code)
	require.NoError(t, access.Complete(t.Context(), owner.ID, returned.Query().Get("state"), returned.Query().Get("code")))
	credential, err := access.Credential(t.Context())
	require.NoError(t, err)
	require.True(t, strings.HasPrefix(credential, "smf_"))
	install, err := access.InstallID(t.Context())
	require.NoError(t, err)
	require.NoError(t, gateway.Quota.Verify(t.Context(), install, credential))
	require.Error(t, gateway.Quota.Verify(t.Context(), "00000000-0000-0000-0000-000000000001", credential))
	status, err := access.Status(t.Context())
	require.NoError(t, err)
	require.EqualValues(t, 100000, *status.Remaining)
	var leases int
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM oauth2_authorization_codes c JOIN oauth2_applications a ON a.id=c.app_id WHERE a.client_id='smithers_fast_model_installs' AND c.used_at IS NULL`).Scan(&leases))
	require.Zero(t, leases)
	require.NoError(t, access.SignOut(t.Context()))
	credential, err = access.Credential(t.Context())
	require.NoError(t, err)
	require.Empty(t, credential)
}

func TestInstallFastModelSignOutCancelsExchangingCredentialPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	owner, err := q.CreateUser(t.Context(), db.CreateUserParams{Username: "cancel-owner", LowerUsername: "cancel-owner"})
	require.NoError(t, err)
	started, release := make(chan struct{}), make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		close(started)
		<-release
		_ = json.NewEncoder(w).Encode(map[string]string{"credential": "must-not-return"})
	}))
	defer server.Close()
	codec, err := webhook.NewSecretCodec("cancel-fixture")
	require.NoError(t, err)
	access := services.InstallFastModelAccess{Pool: pool, Codec: codec, Gateway: server.URL}
	handoff, err := access.Begin(t.Context(), owner.ID, "http://mini.local/api/model/fast/return")
	require.NoError(t, err)
	target, err := url.Parse(handoff)
	require.NoError(t, err)
	done := make(chan error, 1)
	go func() { done <- access.Complete(t.Context(), owner.ID, target.Query().Get("state"), "code") }()
	<-started
	require.NoError(t, access.SignOut(t.Context()))
	close(release)
	require.ErrorContains(t, <-done, "cancelled")
	credential, err := access.Credential(t.Context())
	require.NoError(t, err)
	require.Empty(t, credential)
}
