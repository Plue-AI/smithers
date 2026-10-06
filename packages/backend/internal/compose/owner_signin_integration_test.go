package compose

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"html"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/auth"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

type ownerOAuthCredentials struct{ client, secret string }

func (c ownerOAuthCredentials) OAuthClient(context.Context) (string, string, error) {
	return c.client, c.secret, nil
}

func TestOwnerSignInHTTPPostgres(t *testing.T) {
	// saved is the origin as the owner typed it; the browser sends origin, the
	// same origin in lower case (macOS names the Mac Williams-Mac-mini.local).
	for _, tc := range []struct {
		saved, origin string
		first         int
	}{
		{"http://localhost:4000", "http://localhost:4000", 0},
		{"http://localhost:4000", "http://localhost:4000", 1},
		{"http://lan-a:4000", "http://lan-a:4000", 0},
		{"http://lan-a:4000", "http://lan-a:4000", 1},
		{"https://box.example", "https://box.example", 0},
		{"https://box.example", "https://box.example", 1},
		{"http://Williams-Mac-mini.local:4000", "http://williams-mac-mini.local:4000", 0},
		{"http://Williams-Mac-mini.local:4000", "http://williams-mac-mini.local:4000", 1},
	} {
		first := tc.first
		origin := tc.origin
		t.Run(tc.saved+[]string{"/C-first", "/B-first"}[first], func(t *testing.T) {
			var logs syncBuffer
			previousLogger := slog.Default()
			slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
			t.Cleanup(func() { slog.SetDefault(previousLogger) })
			pool, _ := postgresfixture.NewProductDatabase(t)
			q := db.New(pool)
			ctx := t.Context()
			// The external provider is an HTTP fixture; identity, state and session storage are real.
			seed, err := githubfake.LocalSeed()
			require.NoError(t, err)
			provider, err := githubfake.New(seed)
			require.NoError(t, err)
			manifest := url.Values{"manifest": {`{"redirect_url":"` + origin + `/setup/github/callback","callback_urls":["` + origin + `/api/auth/github/callback"]}`}}
			response, err := http.PostForm(provider.URL+"/settings/apps/new", manifest)
			require.NoError(t, err)
			response.Body.Close()
			response, err = http.Post(provider.URL+"/app-manifests/"+seed.ConversionCode+"/conversions", "application/json", nil)
			require.NoError(t, err)
			response.Body.Close()
			defer provider.Close()
			setup := &services.InstallSetupSessions{Pool: pool}
			var output bytes.Buffer
			require.NoError(t, setup.Mint(ctx, []string{origin}, &output))
			// Exercise the service's real socket authority across the composed
			// OAuth claim, rather than calling Claim directly in a helper test.
			root, err := os.MkdirTemp("/tmp", "ins08-") // macOS Unix sockets have a short path limit.
			require.NoError(t, err)
			t.Cleanup(func() { require.NoError(t, os.RemoveAll(root)) })
			closeHandoff, err := services.StartInstallSetupHandoff(ctx, root, setup.Emit)
			require.NoError(t, err)
			t.Cleanup(func() { require.NoError(t, closeHandoff()) })
			transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, "unix", filepath.Join(root, "run/host.sock"))
			}}
			t.Cleanup(transport.CloseIdleConnections)
			handoffClient := &http.Client{Transport: transport, Timeout: 5 * time.Second}
			readHandoff := func(status int) string {
				response, err := handoffClient.Get("http://localhost/setup-urls")
				require.NoError(t, err)
				defer response.Body.Close()
				body, err := io.ReadAll(response.Body)
				require.NoError(t, err)
				require.Equal(t, status, response.StatusCode)
				require.Equal(t, "no-store", response.Header.Get("Cache-Control"))
				return string(body)
			}
			require.Equal(t, output.String(), readHandoff(200))
			require.Equal(t, output.String(), readHandoff(200), "repeat service start must replay without rotating")
			var mint struct {
				URLs []string `json:"setup_urls"`
			}
			require.NoError(t, json.Unmarshal(output.Bytes(), &mint))
			u, err := url.Parse(mint.URLs[0])
			require.NoError(t, err)
			var credential string
			cfg := config.AuthConfig{Mode: "selfhost", SessionSecret: "test-secret", SessionCookieName: "session", SessionDuration: "24h"}
			svc := services.NewAuthService(q, cfg, nil, auth.NewGitHubClient(ownerOAuthCredentials{seed.ClientID, seed.ClientSecret}, "", provider.URL, provider.URL))
			// Configuration names localhost, as the bundle's does: the sign-in
			// still returns to the address the browser started it from.
			cfg.GitHubRedirectURL = "http://localhost:4000/api/auth/github/callback"
			svc.InstallSetup = setup
			svc.Members = &services.Members{Pool: pool}
			t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", provider.URL)
			handler := &routes.AuthHandler{Service: svc, AuthConfig: cfg, Origins: middleware.FixedOrigins(tc.saved), InstallSetup: setup}
			installConfig := testConfigAllFlagsOn()
			installConfig.Auth = cfg
			installConfig.Server.PublicURL = origin
			installConfig.Server.AllowedOrigins = []string{tc.saved}
			router := buildRouterCompat(
				installConfig, q, pool,
				&routes.RepoHandler{}, handler, &routes.UserHandler{TokenService: svc, ProfileService: services.NewUserService(q)}, &routes.SSHKeyHandler{}, &routes.LabelHandler{},
				&routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{},
				nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}},
				nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
				nil, nil, nil, nil, nil, nil,
				&routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil,
				routerExtras{GitHubAppSetup: &routes.GitHubAppSetupHandler{Sessions: setup, Owners: q, Origins: middleware.FixedOrigins(tc.saved)}},
			)
			wrongExchange := httptest.NewRecorder()
			wrongRequest := httptest.NewRequest(http.MethodGet, origin+"/setup?token=wrong-token", nil)
			wrongRequest.RemoteAddr = "127.0.0.1:1234"
			router.ServeHTTP(wrongExchange, wrongRequest)
			require.Equal(t, http.StatusUnauthorized, wrongExchange.Code)
			require.Empty(t, wrongExchange.Result().Cookies())
			var ownersBeforeClaim int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM self_host_owners`).Scan(&ownersBeforeClaim))
			require.Zero(t, ownersBeforeClaim)
			exchangeRequest := httptest.NewRequest(http.MethodGet, origin+"/setup?token="+url.QueryEscape(u.Query().Get("token")), nil)
			exchangeRequest.RemoteAddr = "127.0.0.1:1234"
			exchange := httptest.NewRecorder()
			router.ServeHTTP(exchange, exchangeRequest)
			require.Equal(t, http.StatusSeeOther, exchange.Code, exchange.Body.String())
			require.Equal(t, "/", exchange.Header().Get("Location"), "the token leaves the browser URL")
			for _, cookie := range exchange.Result().Cookies() {
				if cookie.Name == routes.GitHubAppSetupSessionCookie {
					credential = cookie.Value
					require.True(t, cookie.HttpOnly)
				}
			}
			require.NotEmpty(t, credential)
			for _, route := range []string{"status", "bootstrap", "login", "token", "password"} {
				method := http.MethodPost
				if route == "status" {
					method = http.MethodGet
				}
				deleted := httptest.NewRecorder()
				request := httptest.NewRequest(method, origin+"/api/auth/local/"+route, strings.NewReader("{}"))
				request.Header.Set("Content-Type", "application/json")
				request.RemoteAddr = "127.0.0.1:1234"
				router.ServeHTTP(deleted, request)
				require.Equal(t, http.StatusNotFound, deleted.Code, route)
			}
			request := func(path string, cookies ...*http.Cookie) *http.Request {
				r := httptest.NewRequest("GET", origin+path, nil)
				r.RemoteAddr = "127.0.0.1:1234"
				for _, cookie := range cookies {
					r.AddCookie(cookie)
				}
				return r
			}
			denied := httptest.NewRecorder()
			router.ServeHTTP(denied, request("/api/auth/github"))
			require.Equal(t, 401, denied.Code)
			prepareCallback := func(session, code string, id int64) *http.Request {
				t.Helper()
				start := httptest.NewRecorder()
				router.ServeHTTP(start, request("/api/auth/github", &http.Cookie{Name: routes.GitHubAppSetupSessionCookie, Value: session}))
				require.Equal(t, 302, start.Code, start.Body.String())
				redirect, err := url.Parse(start.Header().Get("Location"))
				require.NoError(t, err)
				require.Equal(t, origin+"/api/auth/github/callback", redirect.Query().Get("redirect_uri"))
				require.NotContains(t, redirect.String(), u.Query().Get("token"))
				require.NotContains(t, redirect.String(), session)
				cookies := append(start.Result().Cookies(), &http.Cookie{Name: routes.GitHubAppSetupSessionCookie, Value: session})
				response, err := http.Get(redirect.String())
				require.NoError(t, err)
				page, err := io.ReadAll(response.Body)
				response.Body.Close()
				require.NoError(t, err)
				target := html.UnescapeString(strings.Split(strings.Split(string(page), `href="`)[1], `"`)[0])
				callbackURL, err := url.Parse(target)
				require.NoError(t, err)
				provider.SignInAs(code, id)
				query := callbackURL.Query()
				query.Set("code", code)
				callbackURL.RawQuery = query.Encode()
				return request(callbackURL.RequestURI(), cookies...)
			}
			// Two browsers exchange the same printed link before either claims.
			otherExchange := httptest.NewRecorder()
			router.ServeHTTP(otherExchange, request("/setup?token="+url.QueryEscape(u.Query().Get("token"))))
			require.Equal(t, http.StatusSeeOther, otherExchange.Code)
			var otherSession string
			for _, cookie := range otherExchange.Result().Cookies() {
				if cookie.Name == routes.GitHubAppSetupSessionCookie {
					otherSession = cookie.Value
				}
			}
			require.NotEmpty(t, otherSession)
			// Inspect the actual persisted authority, independently of the
			// production digest helper. Neither browser credential is stored raw.
			for _, secret := range []string{u.Query().Get("token"), credential, otherSession} {
				digest := sha256.Sum256([]byte(secret))
				key := "setup.session." + hex.EncodeToString(digest[:])
				if secret == u.Query().Get("token") {
					key = "setup.token"
				}
				var stored string
				require.NoError(t, pool.QueryRow(ctx, "SELECT value::text FROM install_settings WHERE key=$1", key).Scan(&stored))
				require.False(t, strings.Contains(stored, secret), "stored setup authority contains plaintext")
				if key == "setup.token" {
					require.JSONEq(t, `"`+hex.EncodeToString(digest[:])+`"`, stored)
				}
			}

			assertNoPlaintext := func(secrets ...string) {
				t.Helper()
				rows, err := pool.Query(ctx, "SELECT tablename FROM pg_tables WHERE schemaname='public'")
				require.NoError(t, err)
				var tables []string
				for rows.Next() {
					var table string
					require.NoError(t, rows.Scan(&table))
					tables = append(tables, table)
				}
				require.NoError(t, rows.Err())
				rows.Close()
				for _, table := range tables {
					rows, err := pool.Query(ctx, "SELECT row_to_json(r)::text FROM "+pgx.Identifier{"public", table}.Sanitize()+" r")
					require.NoError(t, err)
					for rows.Next() {
						var raw string
						require.NoError(t, rows.Scan(&raw))
						for _, secret := range secrets {
							// Do not put captured credentials or database rows in failure receipts.
							require.False(t, strings.Contains(raw, secret) || strings.Contains(raw, url.QueryEscape(secret)), "plaintext credential in %s", table)
						}
					}
					require.NoError(t, rows.Err())
					rows.Close()
				}
			}
			assertNoPlaintext(u.Query().Get("token"), credential, otherSession)
			require.NotEqual(t, credential, otherSession)
			provider.SetCollaborator(7, "local-owner", "admin")
			provider.SetCollaborator(8, "other-owner", "admin")
			callbacks := []*http.Request{prepareCallback(credential, "owner-a-code", 7), prepareCallback(otherSession, "owner-b-code", 8)}
			results := []*httptest.ResponseRecorder{httptest.NewRecorder(), httptest.NewRecorder()}
			// Queue the real callback transactions behind the same durable lock
			// used by mint/claim. Observe each waiter before admitting the next:
			// goroutine scheduling alone cannot establish which browser won.
			barrier, err := pool.Acquire(ctx)
			require.NoError(t, err)
			defer barrier.Release()
			_, err = barrier.Exec(ctx, "SELECT pg_advisory_lock(3443)")
			require.NoError(t, err)
			defer barrier.Exec(ctx, "SELECT pg_advisory_unlock(3443)")
			var wg sync.WaitGroup
			for position, i := range []int{first, 1 - first} {
				wg.Add(1)
				go func(i int) { defer wg.Done(); router.ServeHTTP(results[i], callbacks[i]) }(i)
				require.Eventually(t, func() bool {
					var waiting int
					err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_locks
						WHERE locktype='advisory' AND objid=3443 AND NOT granted
						AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`).Scan(&waiting)
					return err == nil && waiting == position+1
				}, 10*time.Second, 10*time.Millisecond, "callback must reach the claim lock")
			}
			_, err = barrier.Exec(ctx, "SELECT pg_advisory_unlock(3443)")
			require.NoError(t, err)
			wg.Wait()
			winner, loser := first, 1-first
			result, callback := results[winner], callbacks[winner]
			require.Equal(t, http.StatusFound, result.Code, result.Body.String())
			require.Equal(t, origin+"/", result.Header().Get("Location"))
			require.Equal(t, http.StatusUnauthorized, results[loser].Code, results[loser].Body.String())
			require.Contains(t, results[loser].Body.String(), `"code":"setup_closed"`)
			for _, cookie := range results[loser].Result().Cookies() {
				require.False(t, cookie.Name == "session" && cookie.Value != "" && cookie.MaxAge >= 0, "refusal must not mint a person session")
			}
			var remainingAuthority int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM install_settings WHERE key='setup.token' OR key LIKE 'setup.session.%'`).Scan(&remainingAuthority))
			require.Zero(t, remainingAuthority)
			require.JSONEq(t, `{"error":"setup_closed"}`, readHandoff(401))
			require.JSONEq(t, `{"error":"setup_closed"}`, readHandoff(401), "claim permanently closes repeated service reads")
			var afterClaim bytes.Buffer
			restartedSetup := &services.InstallSetupSessions{Pool: pool}
			require.NoError(t, restartedSetup.Mint(ctx, []string{origin}, &afterClaim))
			require.Empty(t, afterClaim.String(), "service restart after claim emits no setup authority")
			require.ErrorContains(t, restartedSetup.Emit(ctx, &afterClaim), "setup_closed")
			require.Empty(t, afterClaim.String())
			for _, session := range []string{credential, otherSession} {
				closed := httptest.NewRecorder()
				router.ServeHTTP(closed, request("/api/auth/github", &http.Cookie{Name: routes.GitHubAppSetupSessionCookie, Value: session}))
				require.Equal(t, http.StatusUnauthorized, closed.Code)
				require.Contains(t, closed.Body.String(), `"code":"setup_closed"`)
			}
			oldToken := httptest.NewRecorder()
			router.ServeHTTP(oldToken, request("/setup?token="+url.QueryEscape(u.Query().Get("token"))))
			require.Equal(t, http.StatusUnauthorized, oldToken.Code)
			require.Contains(t, oldToken.Body.String(), `"code":"setup_closed"`)
			owner, err := q.GetSelfHostOwner(ctx)
			require.NoError(t, err)
			require.Equal(t, []string{"local-owner", "other-owner"}[winner], owner.Username)
			boundary := identity.NewMemberBoundary(q)
			require.Equal(t, 403, boundary.AuthorizeMember(ctx, owner.ID).Status)
			require.Equal(t, "owner_unverified", string(boundary.AuthorizeMember(ctx, owner.ID).Code))
			require.Nil(t, boundary.AuthorizeMember(identity.WithSetupScope(ctx), owner.ID))
			require.Equal(t, 403, boundary.AuthorizeMember(identity.WithSetupScope(ctx), owner.ID+1).Status)
			var sessions int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM auth_sessions WHERE user_id=$1`, owner.ID).Scan(&sessions))
			require.Equal(t, 1, sessions)
			replay := httptest.NewRecorder()
			router.ServeHTTP(replay, callback)
			require.Equal(t, 401, replay.Code)
			require.Contains(t, replay.Body.String(), `"code":"setup_closed"`)
			for _, secret := range []string{u.Query().Get("token"), credential, otherSession} {
				for _, captured := range []string{logs.String(), wrongExchange.Body.String(), exchange.Body.String(), otherExchange.Body.String(), denied.Body.String(), results[0].Body.String(), results[1].Body.String(), oldToken.Body.String(), replay.Body.String()} {
					require.False(t, strings.Contains(captured, secret) || strings.Contains(captured, url.QueryEscape(secret)), "plaintext setup credential in application logs or HTTP body")
				}
			}
			for _, cookie := range result.Result().Cookies() {
				if cookie.Name == "session" {
					require.Equal(t, origin == "https://box.example", cookie.Secure)
					require.True(t, cookie.HttpOnly)
					require.Empty(t, cookie.Domain)
					assertNoPlaintext(u.Query().Get("token"), credential, otherSession, cookie.Value)
				}
			}
		})
	}
}

// GitHub answers /user/emails 403 when the App lacks the Email addresses
// permission. The browser returns from GitHub to the Setup card, whose sign-in
// step names the refusal, never to a JSON page; a later sign-in clears it.
func TestOwnerSignInRefusalLandsOnSetupCardPostgres(t *testing.T) {
	const origin = "http://localhost:4000"
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	ctx := t.Context()
	seed, err := githubfake.LocalSeed()
	require.NoError(t, err)
	provider, err := githubfake.New(seed)
	require.NoError(t, err)
	defer provider.Close()
	post := func(permissions string) {
		manifest := url.Values{"manifest": {`{"redirect_url":"` + origin + `/setup/github/callback","callback_urls":["` + origin + `/api/auth/github/callback"],"default_permissions":` + permissions + `}`}}
		response, err := http.PostForm(provider.URL+"/settings/apps/new", manifest)
		require.NoError(t, err)
		require.Equal(t, 200, response.StatusCode)
		response.Body.Close()
	}
	post(`{"contents":"write","metadata":"read"}`)
	response, err := http.Post(provider.URL+"/app-manifests/"+seed.ConversionCode+"/conversions", "application/json", nil)
	require.NoError(t, err)
	response.Body.Close()
	setup := &services.InstallSetupSessions{Pool: pool}
	var output bytes.Buffer
	require.NoError(t, setup.Mint(ctx, []string{origin}, &output))
	var mint struct {
		URLs []string `json:"setup_urls"`
	}
	require.NoError(t, json.Unmarshal(output.Bytes(), &mint))
	u, err := url.Parse(mint.URLs[0])
	require.NoError(t, err)
	credential, err := setup.Exchange(ctx, u.Query().Get("token"))
	require.NoError(t, err)
	cfg := config.AuthConfig{Mode: "selfhost", SessionSecret: "test-secret", SessionCookieName: "session", SessionDuration: "24h"}
	svc := services.NewAuthService(q, cfg, nil, auth.NewGitHubClient(ownerOAuthCredentials{seed.ClientID, seed.ClientSecret}, "", provider.URL, provider.URL))
	svc.InstallSetup = setup
	svc.Members = &services.Members{Pool: pool}
	t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", provider.URL)
	handler := &routes.AuthHandler{Service: svc, AuthConfig: cfg, Origins: middleware.FixedOrigins(origin), InstallSetup: setup}
	steps := &services.InstallSetupService{Pool: pool}
	signIn := func(callbackQuery func(url.Values)) *httptest.ResponseRecorder {
		t.Helper()
		session := &http.Cookie{Name: routes.GitHubAppSetupSessionCookie, Value: credential}
		start := httptest.NewRecorder()
		startRequest := httptest.NewRequest("GET", origin+"/api/auth/github", nil)
		startRequest.RemoteAddr = "127.0.0.1:1234"
		startRequest.AddCookie(session)
		handler.GetGitHubOAuthStart(start, startRequest)
		require.Equal(t, 302, start.Code, start.Body.String())
		redirect, err := url.Parse(start.Header().Get("Location"))
		require.NoError(t, err)
		response, err := http.Get(redirect.String())
		require.NoError(t, err)
		page, err := io.ReadAll(response.Body)
		response.Body.Close()
		require.NoError(t, err)
		target, err := url.Parse(html.UnescapeString(strings.Split(strings.Split(string(page), `href="`)[1], `"`)[0]))
		require.NoError(t, err)
		query := target.Query()
		callbackQuery(query)
		callback := httptest.NewRequest("GET", origin+"/api/auth/github/callback?"+query.Encode(), nil)
		callback.RemoteAddr = "127.0.0.1:1234"
		for _, cookie := range append(start.Result().Cookies(), session) {
			callback.AddCookie(cookie)
		}
		result := httptest.NewRecorder()
		handler.GetGitHubOAuthCallback(result, callback)
		return result
	}
	signInStep := func() services.InstallStep {
		t.Helper()
		all, err := steps.Steps(ctx)
		require.NoError(t, err)
		return all[2]
	}

	refused := signIn(func(url.Values) {})
	require.Equal(t, http.StatusSeeOther, refused.Code, refused.Body.String())
	require.Equal(t, "/", refused.Header().Get("Location"))
	step := signInStep()
	require.Equal(t, services.InstallFailed, step.Status)
	require.NotNil(t, step.Error)
	require.Equal(t, "GitHub App needs Email addresses read access", step.Error.Message)
	_, err = q.GetSelfHostOwner(ctx)
	require.ErrorIs(t, err, pgx.ErrNoRows, "a refused sign-in claims nothing")

	// The person cancels on GitHub: GitHub returns an error and no code.
	cancelled := signIn(func(query url.Values) { query.Del("code"); query.Set("error", "access_denied") })
	require.Equal(t, http.StatusSeeOther, cancelled.Code, cancelled.Body.String())
	require.Equal(t, "GitHub sign-in did not complete", signInStep().Error.Message)

	// The owner grants Email addresses on the App and signs in again.
	post(`{"contents":"write","metadata":"read","emails":"read"}`)
	accepted := signIn(func(url.Values) {})
	require.Equal(t, http.StatusFound, accepted.Code, accepted.Body.String())
	step = signInStep()
	require.Equal(t, services.InstallReady, step.Status)
	require.Nil(t, step.Error)

	// After the claim a refusal is not the Setup card's to show.
	_, err = pool.Exec(ctx, `UPDATE install_settings SET value='{"status":"failed","error":{"code":"x","class":"user","message":"stale"}}' WHERE key='setup.step.sign_in'`)
	require.NoError(t, err)
	require.Equal(t, services.InstallReady, signInStep().Status, "an owner is signed in whatever an earlier attempt recorded")
}
