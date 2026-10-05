package compose

import (
	"bytes"
	"context"
	"encoding/json"
	"html"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

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
	for _, tc := range []struct{ saved, origin string }{
		{"http://localhost:4000", "http://localhost:4000"},
		{"http://lan-a:4000", "http://lan-a:4000"},
		{"https://box.example", "https://box.example"},
		{"http://Williams-Mac-mini.local:4000", "http://williams-mac-mini.local:4000"},
	} {
		origin := tc.origin
		t.Run(tc.saved, func(t *testing.T) {
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
			// Configuration names localhost, as the bundle's does: the sign-in
			// still returns to the address the browser started it from.
			cfg.GitHubRedirectURL = "http://localhost:4000/api/auth/github/callback"
			svc.InstallSetup = setup
			handler := &routes.AuthHandler{Service: svc, AuthConfig: cfg, Origins: middleware.FixedOrigins(tc.saved), InstallSetup: setup}
			request := func(path string, cookies ...*http.Cookie) *http.Request {
				r := httptest.NewRequest("GET", origin+path, nil)
				r.RemoteAddr = "127.0.0.1:1234"
				for _, cookie := range cookies {
					r.AddCookie(cookie)
				}
				return r
			}
			denied := httptest.NewRecorder()
			handler.GetGitHubOAuthStart(denied, request("/api/auth/github"))
			require.Equal(t, 401, denied.Code)
			start := httptest.NewRecorder()
			handler.GetGitHubOAuthStart(start, request("/api/auth/github", &http.Cookie{Name: routes.GitHubAppSetupSessionCookie, Value: credential}))
			require.Equal(t, 302, start.Code)
			redirect, err := url.Parse(start.Header().Get("Location"))
			require.NoError(t, err)
			require.Equal(t, origin+"/api/auth/github/callback", redirect.Query().Get("redirect_uri"))
			cookies := start.Result().Cookies()
			cookies = append(cookies, &http.Cookie{Name: routes.GitHubAppSetupSessionCookie, Value: credential})
			response, err = http.Get(redirect.String())
			require.NoError(t, err)
			page, err := io.ReadAll(response.Body)
			response.Body.Close()
			require.NoError(t, err)
			target := html.UnescapeString(strings.Split(strings.Split(string(page), `href="`)[1], `"`)[0])
			callbackURL, err := url.Parse(target)
			require.NoError(t, err)
			callback := request(callbackURL.RequestURI(), cookies...)
			result := httptest.NewRecorder()
			handler.GetGitHubOAuthCallback(result, callback)
			require.Equal(t, 302, result.Code, result.Body.String())
			require.Equal(t, origin+"/", result.Header().Get("Location"), "the sign-in returns to the origin that started it")
			owner, err := q.GetSelfHostOwner(ctx)
			require.NoError(t, err)
			require.Equal(t, "local-owner", owner.Username)
			boundary := identity.NewMemberBoundary(q)
			require.Equal(t, 403, boundary.AuthorizeMember(ctx, owner.ID).Status)
			require.Equal(t, "owner_unverified", string(boundary.AuthorizeMember(ctx, owner.ID).Code))
			require.Nil(t, boundary.AuthorizeMember(identity.WithSetupScope(ctx), owner.ID))
			require.Equal(t, 403, boundary.AuthorizeMember(identity.WithSetupScope(ctx), owner.ID+1).Status)
			var sessions int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM auth_sessions WHERE user_id=$1`, owner.ID).Scan(&sessions))
			require.Equal(t, 1, sessions)
			replay := httptest.NewRecorder()
			handler.GetGitHubOAuthCallback(replay, callback)
			require.Equal(t, 401, replay.Code)
			require.Contains(t, replay.Body.String(), `"code":"setup_closed"`)
			for _, cookie := range result.Result().Cookies() {
				if cookie.Name == "session" {
					require.Equal(t, origin == "https://box.example", cookie.Secure)
					require.True(t, cookie.HttpOnly)
					require.Empty(t, cookie.Domain)
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
