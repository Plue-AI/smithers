package compose

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"html"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

func githubAppSetupComposeRouter(cfg *config.Config, pool *pgxpool.Pool, h *routes.GitHubAppSetupHandler, extras ...any) http.Handler {
	// Repo/search/Git placeholders are unused by setup requests. The router's
	// broad constructor requires them to mount unrelated routes; setup itself
	// uses real PostgreSQL, AuthLoader, credential store, and githubfake.
	options := []any{routerExtras{GitHubAppSetup: h}}
	options = append(options, extras...)
	userHandler := &routes.UserHandler{}
	for _, extra := range extras {
		if user, ok := extra.(*routes.UserHandler); ok {
			userHandler = user
		}
	}
	return buildRouterCompat(
		cfg, db.New(pool), pool,
		&routes.RepoHandler{}, &routes.AuthHandler{}, userHandler, &routes.SSHKeyHandler{}, &routes.LabelHandler{},
		&routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{},
		nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
		nil, nil, nil, nil, nil, nil,
		&routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil,
		options...,
	)
}

// Two real listeners use the assembled auth, CSRF, and routing chain. Both
// share the product database, as loopback and configured network access do.
func TestGitHubAppSetupAuthorityOnEveryListenerPostgres(t *testing.T) {
	// Literal fixtures from C-GH-01 and spec §5.1.0/§16.2.1, not implementation-derived expectations.
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	codec, err := webhook.NewSecretCodec("setup-listener-install-key")
	require.NoError(t, err)
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	privateKey := string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))
	fake, err := githubfake.New(githubfake.Config{AppID: 42, Slug: "listener-test", OwnerLogin: "acme", OwnerKind: "org", ClientID: "client", ClientSecret: "secret", WebhookSecret: "webhook", PrivateKeyPEM: privateKey, ConversionCode: "manifest-code", Installations: []githubfake.Installation{{ID: 91, Repositories: []githubfake.Repository{{ID: 1, FullName: "acme/app"}}}}})
	require.NoError(t, err)
	t.Cleanup(fake.Close)
	local := httptest.NewUnstartedServer(nil)
	network := httptest.NewUnstartedServer(nil)
	origins := []string{"http://" + local.Listener.Addr().String(), "https://" + network.Listener.Addr().String()}
	store := services.NewGitHubAppCredentialStore(pool, codec)
	sessions := &services.InstallSetupSessions{Pool: pool}
	tokenDigest := sha256.Sum256([]byte("setup-token"))
	tokenValue, _ := json.Marshal(hex.EncodeToString(tokenDigest[:]))
	require.NoError(t, q.UpsertInstallSetting(t.Context(), db.UpsertInstallSettingParams{Key: "setup.token", Value: tokenValue}))
	h := &routes.GitHubAppSetupHandler{Service: services.NewGitHubAppManifestService(pool, store, fake.URL, middleware.FixedOrigins(origins...)), Store: store, Owners: q, Sessions: sessions, Origins: middleware.FixedOrigins(origins...)}
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = origins[0]
	cfg.Server.AllowedOrigins = origins
	var logs bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(old) })
	router := githubAppSetupComposeRouter(cfg, pool, h)
	local.Config.Handler = router
	network.Config.Handler = router
	local.Start()
	network.StartTLS()
	t.Cleanup(local.Close)
	t.Cleanup(network.Close)
	local.Client().CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	network.Client().CheckRedirect = local.Client().CheckRedirect
	ownerLogin := "acme"
	request := func(server *httptest.Server, method, path string, cookies []*http.Cookie, origin bool) (int, []byte, []*http.Cookie) {
		t.Helper()
		var body io.Reader
		if method == "POST" {
			body = strings.NewReader(`{"owner":"` + ownerLogin + `"}`)
		}
		req, err := http.NewRequest(method, server.URL+path, body)
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Smithers-Setup-Token", "setup-token") // raw token is not step authority
		for _, cookie := range cookies {
			req.AddCookie(cookie)
			if cookie.Name == middleware.CSRFCookieName {
				req.Header.Set("X-CSRF-Token", cookie.Value)
			}
		}
		if origin {
			req.Header.Set("Origin", server.URL)
		}
		resp, err := server.Client().Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		data, err := io.ReadAll(resp.Body)
		require.NoError(t, err)
		return resp.StatusCode, data, resp.Cookies()
	}
	var live []*http.Cookie
	var attempt services.GitHubAppManifestStart
	for i, server := range []*httptest.Server{local, network} {
		for _, path := range []string{"/api/install", "/api/install/setup/app"} {
			method := "GET"
			if strings.Contains(path, "setup") {
				method = "POST"
			}
			status, _, _ := request(server, method, path, nil, true)
			require.Equal(t, 401, status)
		}
		status, _, cookies := request(server, "GET", "/setup?token=setup-token", nil, false)
		require.Equal(t, 303, status)
		require.Len(t, cookies, 2)
		require.Equal(t, "/", cookies[0].Path)
		require.Equal(t, http.SameSiteLaxMode, cookies[0].SameSite)
		require.Equal(t, i == 1, cookies[0].Secure)
		status, _, _ = request(server, "GET", "/api/install", cookies, false)
		require.Equal(t, 200, status)

		if i == 0 {
			ownerLogin = "missing-owner"
			status, body, _ := request(server, "POST", "/api/install/setup/app", cookies, true)
			require.Equal(t, 400, status)
			require.JSONEq(t, `{"code":"bad_request","class":"user","message":"GitHub owner not found"}`, string(body))
			require.Empty(t, fake.Writes())
			ownerLogin = "acme"
		}
		status, body, stateCookies := request(server, "POST", "/api/install/setup/app", cookies, true)
		if i == 0 {
			require.Equal(t, 200, status, string(body))
			require.NoError(t, json.Unmarshal(body, &attempt))
			live = append(cookies, stateCookies...)
		} else {
			require.Equal(t, 409, status, string(body))
		}
		status, _, _ = request(server, "POST", "/api/install/setup/github_app", cookies, true)
		require.Equal(t, 404, status)
	}
	require.Empty(t, fake.Writes())
	// The abandoned attempt is visible as retryable before another POST.
	now := time.Now()
	manifestService := h.Service.(*services.GitHubAppManifestService)
	manifestService.Now = func() time.Time { return now }
	h.Setup = &services.InstallSetupService{Pool: pool, Now: func() time.Time { return now }}
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "setup.step.address", Value: []byte(`{"status":"done"}`)}))
	status, body, _ := request(local, "GET", "/api/install", live, false)
	require.Equal(t, 200, status)
	require.Contains(t, string(body), `"id":"app_manifest","state":"running"`)
	status, body, _ = request(local, "POST", "/api/install/setup/app", live[:2], true)
	require.Equal(t, 409, status)
	require.JSONEq(t, `{"code":"conflict","class":"conflict","message":"GitHub App setup is already running or complete"}`, string(body))
	now = now.Add(10 * time.Minute)
	status, body, _ = request(local, "GET", "/api/install", live, false)
	require.Equal(t, 200, status)
	require.Contains(t, string(body), `"id":"app_manifest","state":"pending"`)
	oldState := attempt.State
	before, err := q.GetInstallSetting(ctx, "setup.step.app_manifest")
	require.NoError(t, err)
	status, body, _ = request(local, "GET", "/setup/github/callback?code=manifest-code&state="+oldState, live, false)
	require.Equal(t, 403, status)
	require.JSONEq(t, `{"code":"permission","class":"permission","message":"invalid or expired setup session"}`, string(body))
	after, err := q.GetInstallSetting(ctx, "setup.step.app_manifest")
	require.NoError(t, err)
	require.JSONEq(t, string(before.Value), string(after.Value))
	require.Empty(t, fake.Writes())
	status, body, stateCookies := request(local, "POST", "/api/install/setup/app", live[:2], true)
	require.Equal(t, 200, status, string(body))
	require.NoError(t, json.Unmarshal(body, &attempt))
	require.NotEqual(t, oldState, attempt.State)
	oldCookies := live
	live = append(append([]*http.Cookie(nil), live[:2]...), stateCookies...)
	before, err = q.GetInstallSetting(ctx, "setup.step.app_manifest")
	require.NoError(t, err)
	status, _, _ = request(local, "GET", "/setup/github/callback?code=manifest-code&state="+oldState, oldCookies, false)
	require.Equal(t, 403, status)
	after, err = q.GetInstallSetting(ctx, "setup.step.app_manifest")
	require.NoError(t, err)
	require.JSONEq(t, string(before.Value), string(after.Value))
	require.Empty(t, fake.Writes())
	// Durable session deletion, expiration and claim fence refuse before exchange.
	callback := "/setup/github/callback?code=manifest-code&state=" + attempt.State
	session := live[0].Value
	sessionKey := "setup.session." + services.GitHubAppStateDigest(session)
	_, err = pool.Exec(ctx, `UPDATE install_settings SET value='{"expires_at":"2000-01-01T00:00:00Z"}' WHERE key=$1`, sessionKey)
	require.NoError(t, err)
	status, _, _ = request(local, "GET", callback, live, false)
	require.Equal(t, 401, status)
	require.Empty(t, fake.Writes())
	_, err = pool.Exec(ctx, `UPDATE install_settings SET value=jsonb_build_object('expires_at',now()+interval '24 hours') WHERE key=$1`, sessionKey)
	require.NoError(t, err)
	// A session deleted by the shared claim lifecycle cannot be revived by its cookie.
	_, err = pool.Exec(ctx, `DELETE FROM install_settings WHERE key=$1`, sessionKey)
	require.NoError(t, err)
	status, _, _ = request(local, "GET", callback, live, false)
	require.Equal(t, 401, status)
	require.Empty(t, fake.Writes())
	_, err = pool.Exec(ctx, `INSERT INTO install_settings(key,value) VALUES($1,jsonb_build_object('expires_at',now()+interval '24 hours'))`, sessionKey)
	require.NoError(t, err)
	foreign := append([]*http.Cookie(nil), live...)
	foreign[0] = &http.Cookie{Name: routes.GitHubAppSetupSessionCookie, Value: strings.Repeat("f", 64)}
	status, _, _ = request(local, "GET", callback, foreign, false)
	require.Equal(t, 401, status)
	require.Empty(t, fake.Writes())
	status, _, _ = request(network, "GET", callback, live, false)
	require.Equal(t, 403, status)
	require.Empty(t, fake.Writes())
	// Follow the provider manifest page rather than manufacturing its callback.
	manifest, err := json.Marshal(attempt.Manifest)
	require.NoError(t, err)
	providerPage, err := http.PostForm(fake.URL+"/organizations/acme/settings/apps/new", url.Values{"manifest": {string(manifest)}, "state": {attempt.State}})
	require.NoError(t, err)
	require.Equal(t, 200, providerPage.StatusCode)
	page, err := io.ReadAll(providerPage.Body)
	providerPage.Body.Close()
	require.NoError(t, err)
	target, err := url.Parse(html.UnescapeString(strings.Split(strings.Split(string(page), `href="`)[1], `"`)[0]))
	require.NoError(t, err)
	callback = target.RequestURI()
	// One conversion completes all durable local projections; replay never exchanges.
	status, _, _ = request(local, "GET", callback, live, false)
	require.Equal(t, 303, status)
	require.Len(t, fake.Writes(), 2)
	for _, key := range []string{"setup.step.app_manifest", "setup.projection.app_manifest"} {
		var state string
		require.NoError(t, pool.QueryRow(ctx, `SELECT value->>'status' FROM install_settings WHERE key=$1`, key).Scan(&state))
		require.Equal(t, "done", state)
	}
	status, _, _ = request(local, "GET", callback, live, false)
	require.Equal(t, 409, status)
	require.Len(t, fake.Writes(), 2)
	// Installation uses the committed repository, with no conversion cookie/state,
	// even after the conversion attempt expired and redirect supplied a foreign id.
	_, err = pool.Exec(ctx, `UPDATE github_app_manifest_states SET expires_at=now()-interval '1 second'`)
	require.NoError(t, err)
	status, body, _ = request(local, "GET", "/setup/github/installed?installation_id=999", live[:2], false)
	require.Equal(t, 303, status, string(body))
	loaded, err := store.Load(ctx)
	require.NoError(t, err)
	require.Zero(t, loaded.InstallationID, "repository selection, not App creation, records installation coverage")
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "setup-owner", LowerUsername: "setup-owner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(singleton,user_id) VALUES(TRUE,$1)`, owner.ID)
	require.NoError(t, err)
	status, _, _ = request(local, "GET", callback, live, false)
	require.Equal(t, 401, status)
	require.Len(t, fake.Writes(), 2, "discovery mints no installation token")
	for _, write := range fake.Writes() {
		require.NotContains(t, write.Path, "access_tokens", "discovery mints no installation token")
	}
	require.NotContains(t, logs.String(), attempt.State)
	require.NotContains(t, logs.String(), "manifest-code")
	require.NotContains(t, logs.String(), "setup-token")
}

func TestGitHubAppSetupRejectsUnusedTokenCORSPreflight(t *testing.T) {
	cfg := testConfigAllFlagsOn()
	cfg.Server.AllowedOrigins = []string{"https://setup.example"}
	router := githubAppSetupComposeRouter(cfg, nil, &routes.GitHubAppSetupHandler{})
	r := httptest.NewRequest(http.MethodOptions, "http://localhost:4000/api/install/setup/app", nil)
	r.Header.Set("Origin", "https://setup.example")
	r.Header.Set("Access-Control-Request-Method", http.MethodPost)
	r.Header.Set("Access-Control-Request-Headers", "Content-Type, X-Smithers-Setup-Token")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, r)
	require.Equal(t, http.StatusOK, w.Code)
	require.Empty(t, w.Header().Get("Access-Control-Allow-Origin"))
	require.Empty(t, w.Header().Get("Access-Control-Allow-Headers"))
}

func TestGitHubAppLegacyEnvironmentIgnoredByCompositionPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	codec, err := webhook.NewSecretCodec("legacy-env-install-key")
	require.NoError(t, err)
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	pemKey := string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))
	const installationID int64 = 900104987
	fake, err := githubfake.New(githubfake.Config{AppID: 54104, Slug: "stored-team", OwnerLogin: "acme", OwnerKind: "org", PrivateKeyPEM: pemKey, ClientID: "stored-client", ClientSecret: "stored-client-secret", WebhookSecret: "stored-webhook-secret", Installations: []githubfake.Installation{{ID: installationID}}})
	require.NoError(t, err)
	t.Cleanup(fake.Close)
	for name, value := range map[string]string{
		"SMITHERS_GITHUB_APP_ID": "999999", "SMITHERS_GITHUB_APP_PRIVATE_KEY": "invalid-legacy-private-key",
		"SMITHERS_GITHUB_APP_INSTALL_URL": "https://legacy.invalid/install", "SMITHERS_GITHUB_APP_PERMISSIONS_URL": "https://legacy.invalid/permissions",
		"SMITHERS_WEBHOOK_GITHUB_APP_SECRET": "legacy-webhook-secret", "SMITHERS_GITHUB_APP_API_BASE_URL": fake.URL,
		"SMITHERS_AUTH_GITHUB_CLIENT_ID": "legacy-oauth-client", "SMITHERS_AUTH_GITHUB_CLIENT_SECRET": "legacy-oauth-secret",
	} {
		t.Setenv(name, value)
	}
	store := services.NewGitHubAppCredentialStore(pool, codec)
	_, oauthClient, err := buildAuthProviders(config.AuthConfig{GitHubRedirectURL: "http://localhost:4000/api/auth/github/callback"}, store, nil)
	require.NoError(t, err)
	require.NotNil(t, oauthClient)
	_, err = oauthClient.AuthorizationURL(ctx, "before-setup")
	require.ErrorIs(t, err, services.ErrGitHubAppNotConfigured, "legacy OAuth env must not enable an unconfigured install")
	require.NoError(t, store.Save(ctx, services.GitHubAppCredentials{ID: 54104, Slug: "stored-team", OwnerLogin: "acme", OwnerKind: "org", PEM: pemKey, ClientID: "stored-client", ClientSecret: "stored-client-secret", WebhookSecret: "stored-webhook-secret", InstallationID: installationID}))
	authorizationURL, err := oauthClient.AuthorizationURL(ctx, "after-setup")
	require.NoError(t, err, "the existing composed OAuth client must reload newly created App credentials")
	parsedAuthorization, err := url.Parse(authorizationURL)
	require.NoError(t, err)
	require.Equal(t, "stored-client", parsedAuthorization.Query().Get("client_id"))
	require.Equal(t, "after-setup", parsedAuthorization.Query().Get("state"))
	require.NotContains(t, authorizationURL, "legacy")
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "stored-app-owner", LowerUsername: "stored-app-owner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(singleton,user_id) VALUES(TRUE,$1)`, owner.ID)
	require.NoError(t, err)
	persistedOwner, err := q.GetSelfHostOwner(ctx)
	require.NoError(t, err)
	require.Equal(t, owner.ID, persistedOwner.ID)
	const session = "stored-app-owner-browser-session"
	sessionHash := sha256.Sum256([]byte(session))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{SessionKey: hex.EncodeToString(sessionHash[:]), UserID: owner.ID, Username: owner.Username, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	require.NoError(t, store.SaveCallbackURLs(ctx, []string{origin + "/api/auth/github/callback", "http://localhost:4000/api/auth/github/callback"}))
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Server.PublicURL, cfg.Server.AllowedOrigins = "selfhost", origin, []string{origin}
	h := &routes.GitHubAppSetupHandler{Store: store, Owners: q, Origins: middleware.FixedOrigins(origin)}
	server.Config.Handler = githubAppSetupComposeRouter(cfg, pool, h, &routes.GitHubWebhookHandler{Service: services.NewGitHubWebhookService(pool, store)})
	server.Start()
	t.Cleanup(server.Close)
	statusRequest := func() []byte {
		req, err := http.NewRequest(http.MethodGet, server.URL+"/api/install", nil)
		require.NoError(t, err)
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: session})
		resp, err := server.Client().Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		require.NoError(t, err)
		require.Equal(t, http.StatusOK, resp.StatusCode, string(body))
		return body
	}
	body := statusRequest()
	require.Contains(t, string(body), `"install_url":"https://github.com/apps/stored-team/installations/new"`)
	require.Contains(t, string(body), `"callback_fixes":[]`)
	require.NotContains(t, string(body), "legacy")
	// Changing configured access origins reports the exact manual registration
	// without silently claiming GitHub was updated or rewriting the snapshot.
	h.Origins = middleware.FixedOrigins(origin, "https://added.example:8443")
	body = statusRequest()
	require.Contains(t, string(body), `"callback_fixes":[{"settings_url":"https://github.com/organizations/acme/settings/apps/stored-team","add_url":"https://added.example:8443/api/auth/github/callback"}]`)
	recorded, err := store.CallbackURLs(ctx)
	require.NoError(t, err)
	require.Equal(t, []string{origin + "/api/auth/github/callback", "http://localhost:4000/api/auth/github/callback"}, recorded)
	caller := services.NewRepoConnectionService(pool, store)
	status, err := caller.GetGitHubAppStatus(ctx, persistedOwner.ID, "acme", "app")
	require.NoError(t, err)
	require.True(t, status.GitHubAppConfigured)
	require.Equal(t, "https://github.com/apps/stored-team/installations/new", status.InstallURL)
	token, err := caller.CreateGitHubInstallationToken(ctx, installationID, services.GitHubTokenScope{RepositoryIDs: []int64{1001}, Permissions: map[string]string{"contents": "read"}})
	require.NoError(t, err, "fake verifies JWT App ID and signature against the stored App")
	require.NotEmpty(t, token.Token)
	require.Len(t, fake.Writes(), 1)
	require.Equal(t, http.StatusCreated, fake.Writes()[0].Status)
	require.Equal(t, "/app/installations/900104987/access_tokens", fake.Writes()[0].Path)
	payload := []byte(`{"action":"created","installation":{"id":900104987,"repository_selection":"selected","account":{"login":"acme","type":"Organization"}},"repositories":[{"id":1001,"name":"app","full_name":"acme/app","private":true,"owner":{"login":"acme"}}]}`)
	for _, secret := range []string{"legacy-webhook-secret", "stored-webhook-secret"} {
		mac := hmac.New(sha256.New, []byte(secret))
		_, err := mac.Write(payload)
		require.NoError(t, err)
		req, err := http.NewRequest(http.MethodPost, server.URL+"/webhooks/github", bytes.NewReader(payload))
		require.NoError(t, err)
		req.Header.Set("X-GitHub-Event", "installation")
		req.Header.Set("X-GitHub-Delivery", uuid.NewString())
		req.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
		resp, err := server.Client().Do(req)
		require.NoError(t, err)
		resp.Body.Close()
		want := http.StatusOK
		if secret == "legacy-webhook-secret" {
			want = http.StatusUnauthorized
		}
		require.Equal(t, want, resp.StatusCode, secret)
	}
	var fullName string
	require.NoError(t, pool.QueryRow(ctx, `SELECT owner_login || '/' || repo_name FROM github_app_installation_repositories WHERE installation_id=$1`, installationID).Scan(&fullName))
	require.Equal(t, "acme/app", fullName, "accepted stored-secret delivery persisted real installation mapping")
}

func TestGitHubAppSetupOriginUsesSocketPeerThroughRouterPostgres(t *testing.T) {
	// §16.3.3: production RealIP must not change forwarding authority.
	cfg := testConfigAllFlagsOn()
	cfg.Server.TrustedProxyHops = 1
	cfg.Server.AllowedOrigins = []string{"https://box.example"}
	pool, _ := postgresfixture.NewProductDatabase(t)
	router := githubAppSetupComposeRouter(cfg, pool, &routes.GitHubAppSetupHandler{Origins: middleware.FixedOrigins(cfg.Server.AllowedOrigins...)})
	r := httptest.NewRequest(http.MethodGet, "http://backend.internal/api/install", nil)
	r.RemoteAddr = "192.0.2.1:1234"
	r.Header.Set("X-Forwarded-For", "127.0.0.1, 192.0.2.9")
	r.Header.Set("X-Forwarded-Host", "box.example")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, r)
	require.Equal(t, http.StatusMisdirectedRequest, w.Code)
	require.Contains(t, w.Body.String(), "unknown_origin")
}

type fetchedWebhookSecret struct{}

func (fetchedWebhookSecret) WebhookSecret(context.Context) (string, error) {
	return "fetched-test-secret", nil
}

// The served signed-webhook route changes the hosted cache as before. On an
// install the same delivery only wakes the existing reconciler, whose missing
// qualification prevents GitHub reads and product/cache changes.
func TestGitHubFetchedInstallWebhookBoundary(t *testing.T) {
	for _, install := range []bool{false, true} {
		name := "hosted"
		if install {
			name = "install"
		}
		t.Run(name, func(t *testing.T) {
			pool, _ := postgresfixture.NewProductDatabase(t)
			q := db.New(pool)
			ctx := context.Background()
			synced := services.NewGitHubSyncedRepoService(q)
			row, err := synced.EnrollGitHubRepo(ctx, services.EnrollGitHubRepoInput{Owner: "factory", Repo: "app", InstallationID: 12, GitHubRepositoryID: 99})
			require.NoError(t, err)
			var calls atomic.Int32
			notified := make(chan error, 1)
			if install {
				synced = services.NewGitHubSyncedRepoService(q, services.WithGitHubSyncedRepoSyncNotify(func(_ int64, err error) {
					select {
					case notified <- err:
					default:
					}
				}))
				require.NoError(t, synced.ConfigureInstallSync(pool))
				synced.SetConditionalFetcherFactory(func(db.GithubSyncedRepo) services.GitHubSyncedRepoConditionalFetcher {
					return func(context.Context, string, url.Values, string) (services.GitHubSyncedRepoConditionalPage, error) {
						calls.Add(1)
						return services.GitHubSyncedRepoConditionalPage{Body: json.RawMessage(`[]`)}, nil
					}
				})
				workerCtx, cancel := context.WithCancel(ctx)
				done := make(chan struct{})
				go func() { defer close(done); synced.StartReconciler(workerCtx) }()
				t.Cleanup(func() {
					cancel()
					select {
					case <-done:
					case <-time.After(5 * time.Second):
						t.Error("reconciler did not stop")
					}
				})
				select {
				case err := <-notified:
					require.Error(t, err, "initial polling stays dark")
				case <-time.After(5 * time.Second):
					t.Fatal("initial reconcile did not run")
				}
			}
			service := services.NewGitHubWebhookService(pool, fetchedWebhookSecret{}, services.WithGitHubWebhookSyncedRepos(synced))
			cfg := testConfigAllFlagsOn()
			cfg.Server.PublicURL = "https://factory.example"
			cfg.Server.AllowedOrigins = []string{"https://factory.example"}
			if install {
				cfg.Auth.Mode = "selfhost"
			}
			router := githubAppSetupComposeRouter(cfg, pool, &routes.GitHubAppSetupHandler{}, &routes.GitHubWebhookHandler{Service: service})
			payload := []byte(`{"action":"opened","repository":{"id":99,"name":"app","owner":{"login":"factory"}},"issue":{"id":1001,"number":1,"state":"open","title":"Webhook text","updated_at":"2026-10-05T10:00:00Z"}}`)
			mac := hmac.New(sha256.New, []byte("fetched-test-secret"))
			_, err = mac.Write(payload)
			require.NoError(t, err)
			request := httptest.NewRequest(http.MethodPost, "https://factory.example/webhooks/github", bytes.NewReader(payload))
			request.Header.Set("X-GitHub-Delivery", uuid.NewString())
			request.Header.Set("X-GitHub-Event", "issues")
			request.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			require.Equal(t, http.StatusOK, response.Code, response.Body.String())
			if install {
				select {
				case err := <-notified:
					require.Error(t, err)
				case <-time.After(5 * time.Second):
					t.Fatal("signed delivery did not wake reconciler")
				}
			}
			var count int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM github_synced_issues WHERE synced_repo_id=$1`, row.ID).Scan(&count))
			if install {
				require.Zero(t, count)
			} else {
				require.Equal(t, 1, count)
			}
			require.Zero(t, calls.Load())
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='github.fetched.consume'`).Scan(&count))
			require.Zero(t, count)
		})
	}
}

func TestGitHubAppManualFallbackThroughInstallRouterPostgres(t *testing.T) {
	for _, origin := range []string{"http://localhost:4000", "http://lan-a:4000"} {
		t.Run(origin, func(t *testing.T) {
			pool, _ := postgresfixture.NewProductDatabase(t)
			q := db.New(pool)
			codec, err := webhook.NewSecretCodec("manual-fallback-install-key")
			require.NoError(t, err)
			key, err := rsa.GenerateKey(rand.Reader, 2048)
			require.NoError(t, err)
			privateKey := string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))
			fake, err := githubfake.New(githubfake.Config{AppID: 42, Slug: "manual-app", OwnerLogin: "acme", OwnerKind: "org", ClientID: "client", ClientSecret: "secret", WebhookSecret: "webhook", PrivateKeyPEM: privateKey})
			require.NoError(t, err)
			t.Cleanup(fake.Close)
			origins := []string{"http://localhost:4000", "http://lan-a:4000"}
			store := services.NewGitHubAppCredentialStore(pool, codec)
			sessions := &services.InstallSetupSessions{Pool: pool}
			digest := sha256.Sum256([]byte("manual-token"))
			value, _ := json.Marshal(hex.EncodeToString(digest[:]))
			require.NoError(t, q.UpsertInstallSetting(t.Context(), db.UpsertInstallSettingParams{Key: "setup.token", Value: value}))
			session, err := sessions.Exchange(t.Context(), "manual-token")
			require.NoError(t, err)
			h := &routes.GitHubAppSetupHandler{Service: services.NewGitHubAppManifestService(pool, store, fake.URL, middleware.FixedOrigins(origins...)), Store: store, Owners: q, Sessions: sessions, Origins: middleware.FixedOrigins(origins...)}
			cfg := testConfigAllFlagsOn()
			cfg.Auth.Mode = "selfhost"
			cfg.Server.PublicURL = origins[0]
			cfg.Server.AllowedOrigins = origins
			router := githubAppSetupComposeRouter(cfg, pool, h)
			input := map[string]any{"app_id": 42, "slug": "manual-app", "pem": privateKey, "client_id": "client", "client_secret": "manual-client-secret", "webhook_secret": "manual-webhook-secret", "callbacks_confirmed": []string{"http://localhost:4000/api/auth/github/callback", "http://lan-a:4000/api/auth/github/callback"}}
			post := func(body map[string]any, path string) *httptest.ResponseRecorder {
				raw, err := json.Marshal(body)
				require.NoError(t, err)
				req := httptest.NewRequest("POST", origin+path, bytes.NewReader(raw))
				// Match the socket peer to the listener: remote clients cannot
				// claim localhost through their Host or Origin headers.
				req.RemoteAddr = "192.0.2.1:12345"
				if origin == "http://localhost:4000" {
					req.RemoteAddr = "127.0.0.1:12345"
				}
				req.Header.Set("Origin", origin)
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("X-CSRF-Token", "csrf")
				req.AddCookie(&http.Cookie{Name: routes.GitHubAppSetupSessionCookie, Value: session})
				req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
				w := httptest.NewRecorder()
				router.ServeHTTP(w, req)
				require.NotContains(t, w.Body.String(), privateKey)
				require.NotContains(t, w.Body.String(), "manual-client-secret")
				require.NotContains(t, w.Body.String(), "manual-webhook-secret")
				return w
			}
			require.Equal(t, 409, post(input, "/api/install/setup/app").Code)
			require.NoError(t, q.UpsertInstallSetting(t.Context(), db.UpsertInstallSettingParams{Key: "setup.step.address", Value: []byte(`{"status":"done"}`)}))
			for _, field := range []string{"app_id", "slug", "pem", "client_id", "client_secret", "webhook_secret", "callbacks_confirmed"} {
				saved := input[field]
				delete(input, field)
				w := post(input, "/api/install/setup/app")
				require.Equal(t, 400, w.Code, w.Body.String())
				require.Contains(t, w.Body.String(), field)
				input[field] = saved
				_, err := store.Load(t.Context())
				require.ErrorIs(t, err, services.ErrGitHubAppNotConfigured)
			}
			input["callbacks_confirmed"] = []string{"http://localhost:4000/api/auth/github/callback"}
			require.Equal(t, 400, post(input, "/api/install/setup/app").Code)
			input["callbacks_confirmed"] = []string{"http://lan-a:4000/api/auth/github/callback"}
			require.Equal(t, 400, post(input, "/api/install/setup/app").Code)
			input["callbacks_confirmed"] = []string{"http://localhost:4000/api/auth/github/callback", "http://lan-a:4000/api/auth/github/callback"}
			input["slug"] = "foreign-app"
			require.Equal(t, 400, post(input, "/api/install/setup/app").Code)
			input["slug"] = "manual-app"
			require.Equal(t, 404, post(input, "/api/install/setup/github_app").Code)
			w := post(input, "/api/install/setup/app")
			require.Equal(t, 200, w.Code, w.Body.String())
			restarted := services.NewGitHubAppCredentialStore(pool, codec)
			c, err := restarted.Load(t.Context())
			require.NoError(t, err)
			require.Equal(t, "manual-app", c.Slug)
			require.EqualValues(t, 42, c.ID)
			for _, key := range []string{"setup.step.app_manifest", "setup.projection.app_manifest"} {
				row, err := q.GetInstallSetting(t.Context(), key)
				require.NoError(t, err)
				require.JSONEq(t, `{"status":"done"}`, string(row.Value))
			}
			require.Equal(t, 409, post(input, "/api/install/setup/app").Code)
		})
	}
}

func TestPlueEnvAppCompositionValidatesAtFirstTokenCaller(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	privateKey := string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))
	fake, err := githubfake.New(githubfake.Config{AppID: 42, Slug: "canonical-plue", OwnerLogin: "acme", OwnerKind: "org", PrivateKeyPEM: privateKey, Installations: []githubfake.Installation{{ID: 914401, Repositories: []githubfake.Repository{{ID: 1001, FullName: "acme/app"}}}}})
	require.NoError(t, err)
	t.Cleanup(fake.Close)
	var identities atomic.Int32
	status := http.StatusServiceUnavailable
	identityOverride := ""
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/app" {
			identities.Add(1)
			if status != 200 {
				w.WriteHeader(status)
				return
			}
			if identityOverride != "" {
				_, _ = w.Write([]byte(identityOverride))
				return
			}
		}
		req, err := http.NewRequestWithContext(r.Context(), r.Method, fake.URL+r.URL.RequestURI(), r.Body)
		require.NoError(t, err)
		req.Header = r.Header.Clone()
		response, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer response.Body.Close()
		w.WriteHeader(response.StatusCode)
		_, _ = io.Copy(w, response.Body)
	}))
	t.Cleanup(proxy.Close)
	t.Setenv("SMITHERS_GITHUB_APP_ID", "42")
	t.Setenv("SMITHERS_GITHUB_APP_PRIVATE_KEY", privateKey)
	t.Setenv("SMITHERS_GITHUB_APP_SLUG", "poisoned")
	t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", proxy.URL)
	source, err := selectGitHubAppCredentials(false, true, nil)
	require.NoError(t, err)
	caller := services.NewRepoConnectionService(nil, source)
	require.Zero(t, identities.Load(), "Plue composition must boot with GitHub unavailable")
	scope := services.GitHubTokenScope{RepositoryIDs: []int64{1001}, Permissions: map[string]string{"contents": "read"}}
	_, err = caller.CreateGitHubInstallationToken(t.Context(), 914401, scope)
	require.Error(t, err)
	require.Empty(t, fake.Writes())
	status = 200
	for _, invalid := range []string{`{"id":99,"slug":"canonical-plue","owner":{"login":"acme","type":"Organization"}}`, `{"id":42,"owner":{"login":"acme","type":"Organization"}}`} {
		identityOverride = invalid
		_, err = caller.CreateGitHubInstallationToken(t.Context(), 914401, scope)
		require.Error(t, err)
		require.Empty(t, fake.Writes())
	}
	identityOverride = ""
	token, err := caller.CreateGitHubInstallationToken(t.Context(), 914401, scope)
	require.NoError(t, err)
	require.NotEmpty(t, token.Token)
	slug, err := source.Slug(t.Context())
	require.NoError(t, err)
	require.Equal(t, "canonical-plue", slug)
	_, err = caller.CreateGitHubInstallationToken(t.Context(), 914401, scope)
	require.NoError(t, err)
	require.EqualValues(t, 4, identities.Load())
	restarted, err := selectGitHubAppCredentials(false, true, nil)
	require.NoError(t, err)
	require.EqualValues(t, 4, identities.Load())
	_, err = services.NewRepoConnectionService(nil, restarted).CreateGitHubInstallationToken(t.Context(), 914401, scope)
	require.NoError(t, err)
	require.EqualValues(t, 5, identities.Load())
}
