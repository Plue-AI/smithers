package compose

import (
	"context"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/stretchr/testify/require"
	"net/http"
	"net/http/httptest"
	"testing"
)

func browserOriginRouter(cfg *config.Config, authService routes.AuthService) http.Handler {
	return buildRouterCompat(
		cfg,
		nil,
		nil, // pool
		&routes.RepoHandler{},
		&routes.AuthHandler{Service: authService, AuthConfig: cfg.Auth, PublicOrigin: cfg.Server.PublicURL},
		&routes.UserHandler{},
		&routes.SSHKeyHandler{},
		&routes.LabelHandler{},

		&routes.OrgHandler{},
		&routes.LandingHandler{},
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{},
		nil, // wikiService
		&routes.GitSmartHandler{},
		nil, // adminRunnerHandler
		nil, // adminUserHandler
		nil, // adminOrgHandler
		nil, // adminSystemHealthHandler
		nil, // adminGitHubAppHandler
		nil, // adminAuditHandler
		nil, // webhookHandler
		nil, // secretHandler
		nil, // variableHandler
		nil, // commitStatusHandler
		nil,
		nil, // jjVCSHandler
		nil, // agentInternalHandler
		nil, // agentSessionHandler
		nil, // agentSessionStreamHandler
		nil, // pushHookHandler
		nil, // workflowHandler
		nil, // workspaceHandler
		nil, // workspaceInternalHandler
		nil, // workspaceTerminalHandler
		nil, // telemetryHandler
		nil, // featureFlagHandler
		nil, // oauth2Handler
		nil, // smithersMetrics
	)
}

func TestRouterCanonicalBrowserAuthOrigin(t *testing.T) {
	cfg := testConfigAllFlagsOn()
	cfg.Auth.GitHubRedirectURL = "https://app.example/api/auth/github/callback"
	server := httptest.NewServer(browserOriginRouter(cfg, &mockRouterAuthService{}))
	defer server.Close()
	client := server.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	for _, path := range []string{"/api/auth/github?return_to=%2Fowner%2Frepo", "/api/auth/github/cli?callback_port=41523", "/api/oauth2/authorize?client_id=fixture&state=bound"} {
		t.Run(path, func(t *testing.T) {
			response, err := client.Get(server.URL + path)
			require.NoError(t, err)
			defer response.Body.Close()
			require.Equal(t, http.StatusFound, response.StatusCode)
			require.Equal(t, "https://app.example"+path, response.Header.Get("Location"))
			require.Empty(t, response.Cookies(), "host-only state must be placed only after reaching the callback origin")
		})
	}
}

func TestRouterBrowserAuthOriginAcrossTLSProxy(t *testing.T) {
	cfg := testConfigAllFlagsOn()
	cfg.Auth.GitHubRedirectURL = "https://app.example/api/auth/github/callback"
	cfg.Auth.CookieSecure = true
	server := httptest.NewServer(browserOriginRouter(cfg, &mockRouterAuthService{}))
	defer server.Close()
	client := server.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	path := "/api/auth/github?return_to=%2Fowner%2Frepo%2F%3Ftab%3Dissues"

	request := func(host, path string, cookies ...*http.Cookie) *http.Response {
		t.Helper()
		req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL+path, nil)
		require.NoError(t, err)
		req.Host = host
		req.Header.Set("X-Forwarded-Proto", "https")
		for _, cookie := range cookies {
			if cookie.MaxAge >= 0 {
				req.AddCookie(cookie)
			}
		}
		response, err := client.Do(req)
		require.NoError(t, err)
		t.Cleanup(func() { response.Body.Close() })
		return response
	}

	fromAPI := request("api.example", path)
	require.Equal(t, http.StatusFound, fromAPI.StatusCode)
	require.Equal(t, "https://app.example"+path, fromAPI.Header.Get("Location"))
	require.Empty(t, fromAPI.Cookies(), "the API host must not receive OAuth state")

	onBrowserOrigin := request("app.example", path)
	require.Equal(t, http.StatusFound, onBrowserOrigin.StatusCode)
	require.Equal(t, "https://example.com/oauth", onBrowserOrigin.Header.Get("Location"), "a TLS proxy must reach the OAuth start")
	var state, returnTo *http.Cookie
	for _, cookie := range onBrowserOrigin.Cookies() {
		require.Empty(t, cookie.Domain, "OAuth cookies must stay on the callback host")
		switch cookie.Name {
		case "smithers_oauth_state":
			state = cookie
		case "smithers_return_to":
			returnTo = cookie
		}
	}
	require.NotNil(t, state)
	require.NotNil(t, returnTo)
	require.True(t, state.Secure, "state cookie must honor CookieSecure")
	require.True(t, returnTo.Secure, "return cookie must honor CookieSecure")

	callback := request("app.example", "/api/auth/github/callback?code=fixture&state=fixture", state, returnTo)
	require.Equal(t, http.StatusFound, callback.StatusCode)
	require.Equal(t, "/owner/repo/?tab=issues", callback.Header.Get("Location"))
	var session *http.Cookie
	for _, cookie := range callback.Cookies() {
		if cookie.Name == "smithers_session" {
			session = cookie
		}
	}
	require.NotNil(t, session)
	require.Empty(t, session.Domain)
	require.True(t, session.Secure, "session cookie must honor CookieSecure")
}
