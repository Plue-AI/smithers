package routes

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// These stubs exercise authorization before any network or credential write.
// Real PostgreSQL and githubfake cover the manifest exchange separately.
type setupSessionStub struct{ err error }

func (s setupSessionStub) Exchange(context.Context, string) (string, error) {
	return strings.Repeat("s", 64), s.err
}
func (s setupSessionStub) Validate(_ context.Context, id string) error {
	if id != strings.Repeat("s", 64) {
		return pkgerrors.Unauthorized("invalid session")
	}
	return s.err
}
func (s *githubAppSetupTestService) ResumeInstallation(context.Context) error {
	s.installedCalls++
	return s.err
}

type githubAppSetupTestOwner struct {
	user db.User
	err  error
}

func (o githubAppSetupTestOwner) GetSelfHostOwner(context.Context) (db.User, error) {
	return o.user, o.err
}

type githubAppSetupTestService struct {
	beginCalls, convertCalls, installedCalls int
	request                                  services.GitHubAppManifestRequest
	code, state, browserState                string
	installationID                           int64
	err                                      error
	originError                              error
	originCalls                              int
	origin                                   string
}

func (s *githubAppSetupTestService) ValidateCallbackOrigin(_ context.Context, state, origin string) error {
	s.originCalls++
	s.origin = origin
	return s.originError
}

func (s *githubAppSetupTestService) Begin(_ context.Context, req services.GitHubAppManifestRequest) (services.GitHubAppManifestStart, error) {
	s.beginCalls++
	s.request = req
	return services.GitHubAppManifestStart{State: "browser-state", ActionURL: "https://github.com/settings/apps/new"}, s.err
}
func (s *githubAppSetupTestService) Convert(_ context.Context, code, state, browserState string) (string, error) {
	s.convertCalls++
	s.code, s.state, s.browserState = code, state, browserState
	return "https://github.com/apps/smithers-test/installations/new", s.err
}

func githubAppSetupTestHandler() (*GitHubAppSetupHandler, *githubAppSetupTestService) {
	s := &githubAppSetupTestService{}
	return &GitHubAppSetupHandler{Service: s, Owners: githubAppSetupTestOwner{err: pgx.ErrNoRows}, Sessions: setupSessionStub{}, AllowedOrigins: []string{"http://localhost:4000", "https://factory.example"}}, s
}

func githubAppSetupBeginRequest(origin string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, origin+"/api/install/setup/app", strings.NewReader(`{"owner_login":"smithersai","owner_kind":"org","repository":"smithers","origin":"https://attacker.example"}`))
	r.Header.Set("Content-Type", "application/json")
	r.RemoteAddr = "127.0.0.1:1234"
	return r
}

func TestGitHubAppSetupBeginRequiresSetupTokenBeforeOwner(t *testing.T) {
	for _, origin := range []string{"http://localhost:4000", "https://factory.example"} {
		for _, token := range []string{"", "wrong-token"} {
			t.Run(origin+"/"+token, func(t *testing.T) {
				h, s := githubAppSetupTestHandler()
				r := githubAppSetupBeginRequest(origin)
				r.Header.Set("X-Smithers-Setup-Token", token)
				if r.RemoteAddr == "192.0.2.1:1234" && strings.Contains(r.Host, "localhost") {
					r.RemoteAddr = "127.0.0.1:1234"
				}
				w := httptest.NewRecorder()
				h.Begin(w, r)
				require.Equal(t, http.StatusUnauthorized, w.Code)
				require.Zero(t, s.beginCalls)
				require.Empty(t, w.Result().Cookies())
			})
		}
	}
}

func TestGitHubAppSetupBeginBindsCookieAndTrustedOrigin(t *testing.T) {
	for _, origin := range []string{"http://localhost:4000", "https://factory.example"} {
		t.Run(origin, func(t *testing.T) {
			h, s := githubAppSetupTestHandler()
			r := githubAppSetupBeginRequest(origin)
			r.AddCookie(&http.Cookie{Name: GitHubAppSetupSessionCookie, Value: strings.Repeat("s", 64)})
			r.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
			r.Header.Set("X-CSRF-Token", "csrf")
			origin, ok := h.requestOrigin(r)
			if ok {
				r.Header.Set("Origin", origin)
			}
			if r.RemoteAddr == "192.0.2.1:1234" && strings.Contains(r.Host, "localhost") {
				r.RemoteAddr = "127.0.0.1:1234"
			}
			w := httptest.NewRecorder()
			h.Begin(w, r)
			require.Equal(t, http.StatusOK, w.Code, w.Body.String())
			require.Equal(t, 1, s.beginCalls)
			require.Equal(t, origin, s.request.Origin, "the body cannot choose the callback origin")
			cookies := w.Result().Cookies()
			require.Len(t, cookies, 1)
			require.Equal(t, "smithers_github_app_state", cookies[0].Name)
			require.Equal(t, "browser-state", cookies[0].Value)
			require.Equal(t, "/", cookies[0].Path)
			require.True(t, cookies[0].HttpOnly)
			require.Equal(t, http.SameSiteLaxMode, cookies[0].SameSite)
			require.Equal(t, strings.HasPrefix(origin, "https:"), cookies[0].Secure)
		})
	}
}

func TestGitHubAppSetupBeginRequiresOwnerBrowserSessionAfterOwnerExists(t *testing.T) {
	for _, test := range []struct {
		name string
		auth *middleware.AuthInfo
		want int
	}{
		{"anonymous", nil, http.StatusUnauthorized},
		{"owner without session", &middleware.AuthInfo{User: &db.User{ID: 7}}, http.StatusForbidden},
		{"owner agent account browser", &middleware.AuthInfo{User: &db.User{ID: 7, UserType: "bot"}, SessionHash: "browser"}, http.StatusForbidden},
		{"other member", &middleware.AuthInfo{User: &db.User{ID: 8}, SessionHash: "browser"}, http.StatusForbidden},
		{"owner PAT", &middleware.AuthInfo{User: &db.User{ID: 7}, IsTokenAuth: true, TokenSource: middleware.TokenSourcePersonalAccessToken}, http.StatusForbidden},
		{"owner agent", &middleware.AuthInfo{User: &db.User{ID: 7}, IsTokenAuth: true, TokenSystemIssued: true}, http.StatusForbidden},
		{"owner OAuth token", &middleware.AuthInfo{User: &db.User{ID: 7}, IsTokenAuth: true, TokenSource: middleware.TokenSourceOAuth2AccessToken}, http.StatusForbidden},
		{"owner browser", &middleware.AuthInfo{User: &db.User{ID: 7}, SessionHash: "browser"}, http.StatusOK},
	} {
		t.Run(test.name, func(t *testing.T) {
			h, s := githubAppSetupTestHandler()
			h.Owners = githubAppSetupTestOwner{user: db.User{ID: 7}}
			r := githubAppSetupBeginRequest("http://localhost:4000")
			r.AddCookie(&http.Cookie{Name: GitHubAppSetupSessionCookie, Value: strings.Repeat("s", 64)})
			r.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
			r.Header.Set("X-CSRF-Token", "csrf")
			origin, ok := h.requestOrigin(r)
			if ok {
				r.Header.Set("Origin", origin)
			}
			if test.auth != nil {
				r = r.WithContext(middleware.ContextWithAuthInfo(r.Context(), test.auth))
			}
			if r.RemoteAddr == "192.0.2.1:1234" && strings.Contains(r.Host, "localhost") {
				r.RemoteAddr = "127.0.0.1:1234"
			}
			w := httptest.NewRecorder()
			h.Begin(w, r)
			require.Equal(t, test.want, w.Code, w.Body.String())
			if test.want == http.StatusOK {
				require.Equal(t, 1, s.beginCalls)
			} else {
				require.Zero(t, s.beginCalls)
			}
		})
	}
}

func TestGitHubAppSetupBeginRefusesUntrustedOriginsAndMalformedBody(t *testing.T) {
	for _, test := range []struct {
		name, origin, body string
		want               int
	}{
		{"unconfigured host", "https://attacker.example", `{}`, http.StatusMisdirectedRequest},
		{"invalid JSON", "http://localhost:4000", `{`, http.StatusBadRequest},
		{"trailing JSON", "http://localhost:4000", `{} {}`, http.StatusBadRequest},
	} {
		t.Run(test.name, func(t *testing.T) {
			h, s := githubAppSetupTestHandler()
			r := httptest.NewRequest(http.MethodPost, test.origin+"/api/install/setup/app", strings.NewReader(test.body))
			r.AddCookie(&http.Cookie{Name: GitHubAppSetupSessionCookie, Value: strings.Repeat("s", 64)})
			r.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
			r.Header.Set("X-CSRF-Token", "csrf")
			origin, ok := h.requestOrigin(r)
			if ok {
				r.Header.Set("Origin", origin)
			}
			if r.RemoteAddr == "192.0.2.1:1234" && strings.Contains(r.Host, "localhost") {
				r.RemoteAddr = "127.0.0.1:1234"
			}
			w := httptest.NewRecorder()
			h.Begin(w, r)
			require.Equal(t, test.want, w.Code)
			require.Zero(t, s.beginCalls)
		})
	}
}

func TestGitHubAppSetupBeginFailuresDoNotIssueCookie(t *testing.T) {
	for _, failure := range []error{pkgerrors.BadRequest("invalid owner"), pkgerrors.Conflict("App already exists"), context.Canceled} {
		h, s := githubAppSetupTestHandler()
		s.err = failure
		r := githubAppSetupBeginRequest("http://localhost:4000")
		r.AddCookie(&http.Cookie{Name: GitHubAppSetupSessionCookie, Value: strings.Repeat("s", 64)})
		r.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
		r.Header.Set("X-CSRF-Token", "csrf")
		origin, ok := h.requestOrigin(r)
		if ok {
			r.Header.Set("Origin", origin)
		}
		if r.RemoteAddr == "192.0.2.1:1234" && strings.Contains(r.Host, "localhost") {
			r.RemoteAddr = "127.0.0.1:1234"
		}
		w := httptest.NewRecorder()
		h.Begin(w, r)
		require.GreaterOrEqual(t, w.Code, 400)
		require.Empty(t, w.Result().Cookies())
	}
	h, s := githubAppSetupTestHandler()
	h.Owners = githubAppSetupTestOwner{err: errors.New("database unavailable")}
	r := githubAppSetupBeginRequest("http://localhost:4000")
	r.AddCookie(&http.Cookie{Name: GitHubAppSetupSessionCookie, Value: strings.Repeat("s", 64)})
	r.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
	r.Header.Set("X-CSRF-Token", "csrf")
	origin, ok := h.requestOrigin(r)
	if ok {
		r.Header.Set("Origin", origin)
	}
	if r.RemoteAddr == "192.0.2.1:1234" && strings.Contains(r.Host, "localhost") {
		r.RemoteAddr = "127.0.0.1:1234"
	}
	w := httptest.NewRecorder()
	h.Begin(w, r)
	require.Equal(t, http.StatusInternalServerError, w.Code)
	require.Zero(t, s.beginCalls)
}

func githubAppSetupCallbackRequest(origin, path, query, cookie string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, origin+"/setup/github/"+path+"?"+query, nil)
	if cookie != "" {
		r.AddCookie(&http.Cookie{Name: GitHubAppStateCookie, Value: cookie})
		r.AddCookie(&http.Cookie{Name: GitHubAppSetupSessionCookie, Value: strings.Repeat("s", 64)})
	}
	r.RemoteAddr = "127.0.0.1:1234"
	return r
}

func TestGitHubAppSetupCallbacksRequireBoundCookie(t *testing.T) {
	for _, installed := range []bool{false} {
		for _, test := range []struct{ name, origin, state, cookie, originHeader string }{
			{"missing cookie", "http://localhost:4000", "browser-state", "", ""},
			{"missing state", "http://localhost:4000", "", "browser-state", ""},
			{"foreign state", "http://localhost:4000", "other-state", "browser-state", ""},
			{"unconfigured host", "https://attacker.example", "browser-state", "browser-state", ""},
			{"foreign Origin header", "http://localhost:4000", "browser-state", "browser-state", "https://attacker.example"},
		} {
			t.Run(test.name, func(t *testing.T) {
				h, s := githubAppSetupTestHandler()
				r := githubAppSetupCallbackRequest(test.origin, "callback", "state="+test.state+"&code=code&installation_id=123", test.cookie)
				r.Header.Set("Origin", test.originHeader)
				if r.RemoteAddr == "192.0.2.1:1234" && strings.Contains(r.Host, "localhost") {
					r.RemoteAddr = "127.0.0.1:1234"
				}
				w := httptest.NewRecorder()
				if installed {
					h.Installed(w, r)
				} else {
					h.Callback(w, r)
				}
				if test.origin == "https://attacker.example" {
					require.Equal(t, http.StatusMisdirectedRequest, w.Code)
				} else if test.cookie == "" {
					require.Equal(t, http.StatusUnauthorized, w.Code)
				} else {
					require.Equal(t, http.StatusForbidden, w.Code)
				}
				require.Zero(t, s.convertCalls)
				require.Zero(t, s.installedCalls)
				require.Equal(t, "no-store", w.Header().Get("Cache-Control"))
				require.Equal(t, "no-referrer", w.Header().Get("Referrer-Policy"))
			})
		}
	}
}

func TestGitHubAppSetupCallbackAndInstallationBrowserRoundTrip(t *testing.T) {
	for _, origin := range []string{"http://localhost:4000", "https://factory.example"} {
		t.Run(origin, func(t *testing.T) {
			h, s := githubAppSetupTestHandler()
			h.Owners = githubAppSetupTestOwner{err: pgx.ErrNoRows}
			r := githubAppSetupCallbackRequest(origin, "callback", "code=conversion-code&state=browser-state", "browser-state")
			if r.RemoteAddr == "192.0.2.1:1234" && strings.Contains(r.Host, "localhost") {
				r.RemoteAddr = "127.0.0.1:1234"
			}
			w := httptest.NewRecorder()
			h.Callback(w, r)
			require.Equal(t, http.StatusSeeOther, w.Code)
			require.Equal(t, "https://github.com/apps/smithers-test/installations/new", w.Header().Get("Location"))
			require.Equal(t, "conversion-code", s.code)
			require.Equal(t, "browser-state", s.state)
			require.Equal(t, "browser-state", s.browserState)
			r = githubAppSetupCallbackRequest(origin, "installed", "installation_id=123&state=browser-state", "browser-state")
			w = httptest.NewRecorder()
			h.Installed(w, r)
			require.Equal(t, http.StatusOK, w.Code)
			require.JSONEq(t, `{"installed":true}`, w.Body.String())
			require.EqualValues(t, 0, s.installationID, "redirect id is never authority")
			cookies := w.Result().Cookies()
			require.Len(t, cookies, 1)
			require.Equal(t, GitHubAppStateCookie, cookies[0].Name)
			require.Equal(t, -1, cookies[0].MaxAge)
			require.Equal(t, "/", cookies[0].Path)
			require.True(t, cookies[0].HttpOnly)
			require.Equal(t, strings.HasPrefix(origin, "https:"), cookies[0].Secure)
		})
	}
}

func TestGitHubAppSetupInstallationResumesWithoutConversionState(t *testing.T) {
	for _, raw := range []string{"", "0", "-1", "not-an-id", "123"} {
		h, s := githubAppSetupTestHandler()
		r := githubAppSetupCallbackRequest("http://localhost:4000", "installed", "installation_id="+raw, "")
		r.AddCookie(&http.Cookie{Name: GitHubAppSetupSessionCookie, Value: strings.Repeat("s", 64)})
		r.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
		r.Header.Set("X-CSRF-Token", "csrf")
		origin, ok := h.requestOrigin(r)
		if ok {
			r.Header.Set("Origin", origin)
		}
		w := httptest.NewRecorder()
		h.Installed(w, r)
		require.Equal(t, http.StatusOK, w.Code)
		require.Equal(t, 1, s.installedCalls)
		require.Zero(t, s.convertCalls)
	}
}

func TestGitHubAppSetupCallbackFailuresPreserveRetryCookie(t *testing.T) {
	for _, installed := range []bool{false} {
		h, s := githubAppSetupTestHandler()
		s.err = pkgerrors.Forbidden("used or expired state")
		r := githubAppSetupCallbackRequest("http://localhost:4000", "callback", "code=code&state=browser-state&installation_id=123", "browser-state")
		if r.RemoteAddr == "192.0.2.1:1234" && strings.Contains(r.Host, "localhost") {
			r.RemoteAddr = "127.0.0.1:1234"
		}
		w := httptest.NewRecorder()
		if installed {
			h.Installed(w, r)
		} else {
			h.Callback(w, r)
		}
		require.Equal(t, http.StatusForbidden, w.Code)
		require.Empty(t, w.Result().Cookies())
		require.Empty(t, w.Header().Get("Location"))
	}
}

func TestGitHubAppSetupMissingDependenciesFailClosed(t *testing.T) {
	for _, ownersMissing := range []bool{false, true} {
		h, _ := githubAppSetupTestHandler()
		if ownersMissing {
			h.Owners = nil
		} else {
			h.Service = nil
		}
		r := githubAppSetupBeginRequest("http://localhost:4000")
		r.AddCookie(&http.Cookie{Name: GitHubAppSetupSessionCookie, Value: strings.Repeat("s", 64)})
		r.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
		r.Header.Set("X-CSRF-Token", "csrf")
		origin, ok := h.requestOrigin(r)
		if ok {
			r.Header.Set("Origin", origin)
		}
		if r.RemoteAddr == "192.0.2.1:1234" && strings.Contains(r.Host, "localhost") {
			r.RemoteAddr = "127.0.0.1:1234"
		}
		w := httptest.NewRecorder()
		h.Begin(w, r)
		require.Equal(t, http.StatusInternalServerError, w.Code)
	}
	h, _ := githubAppSetupTestHandler()
	h.Service = nil
	r := githubAppSetupCallbackRequest("http://localhost:4000", "callback", "state=browser-state", "browser-state")
	if r.RemoteAddr == "192.0.2.1:1234" && strings.Contains(r.Host, "localhost") {
		r.RemoteAddr = "127.0.0.1:1234"
	}
	w := httptest.NewRecorder()
	h.Callback(w, r)
	require.Equal(t, http.StatusInternalServerError, w.Code)
}

type githubAppSetupTestCredentials struct {
	credentials                     services.GitHubAppCredentials
	loadError, installURLError      error
	loads                           int
	callbackURLs                    []string
	callbackFixes                   []services.GitHubAppCallbackFix
	callbackError, callbackFixError error
	fixOrigins                      []string
}

func (s *githubAppSetupTestCredentials) CallbackURLs(context.Context) ([]string, error) {
	if s.callbackURLs == nil {
		return []string{}, s.callbackError
	}
	return s.callbackURLs, s.callbackError
}
func (s *githubAppSetupTestCredentials) CallbackFixes(_ context.Context, origins []string) ([]services.GitHubAppCallbackFix, error) {
	s.fixOrigins = origins
	if s.callbackFixes == nil {
		return []services.GitHubAppCallbackFix{}, s.callbackFixError
	}
	return s.callbackFixes, s.callbackFixError
}

func (s *githubAppSetupTestCredentials) Load(context.Context) (services.GitHubAppCredentials, error) {
	s.loads++
	return s.credentials, s.loadError
}
func (s *githubAppSetupTestCredentials) InstallURL(context.Context) (string, error) {
	return "https://github.com/apps/smithers-test/installations/new", s.installURLError
}

func TestGitHubAppSetupStatusRequiresAuthorityBeforeReadingCredentials(t *testing.T) {
	h, _ := githubAppSetupTestHandler()
	r := httptest.NewRequest(http.MethodGet, "http://localhost:4000/api/install", nil)
	if r.RemoteAddr == "192.0.2.1:1234" && strings.Contains(r.Host, "localhost") {
		r.RemoteAddr = "127.0.0.1:1234"
	}
	w := httptest.NewRecorder()
	h.Status(w, r)
	require.Equal(t, http.StatusUnauthorized, w.Code)
	r.AddCookie(&http.Cookie{Name: GitHubAppSetupSessionCookie, Value: strings.Repeat("s", 64)})
	r.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
	r.Header.Set("X-CSRF-Token", "csrf")
	origin, ok := h.requestOrigin(r)
	if ok {
		r.Header.Set("Origin", origin)
	}
	w = httptest.NewRecorder()
	h.Status(w, r)
	require.Equal(t, http.StatusInternalServerError, w.Code)
	s := &githubAppSetupTestCredentials{}
	h.Store = s
	r.Host = "attacker.example"
	w = httptest.NewRecorder()
	h.Status(w, r)
	require.Equal(t, http.StatusMisdirectedRequest, w.Code)
	require.Zero(t, s.loads)
}

func TestGitHubAppSetupStatusMetadataAndFailures(t *testing.T) {
	for _, installed := range []bool{false} {
		h, _ := githubAppSetupTestHandler()
		credentials := services.GitHubAppCredentials{Slug: "smithers-test", PEM: "private key", ClientSecret: "client-secret", WebhookSecret: "webhook-secret"}
		if installed {
			credentials.InstallationID = 123
		}
		h.Store = &githubAppSetupTestCredentials{credentials: credentials}
		r := httptest.NewRequest(http.MethodGet, "http://localhost:4000/api/install", nil)
		r.AddCookie(&http.Cookie{Name: GitHubAppSetupSessionCookie, Value: strings.Repeat("s", 64)})
		r.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
		r.Header.Set("X-CSRF-Token", "csrf")
		origin, ok := h.requestOrigin(r)
		if ok {
			r.Header.Set("Origin", origin)
		}
		if r.RemoteAddr == "192.0.2.1:1234" && strings.Contains(r.Host, "localhost") {
			r.RemoteAddr = "127.0.0.1:1234"
		}
		w := httptest.NewRecorder()
		h.Status(w, r)
		require.Equal(t, http.StatusOK, w.Code)
		require.Contains(t, w.Body.String(), `"configured":true`)
		require.NotContains(t, w.Body.String(), credentials.PEM)
		require.NotContains(t, w.Body.String(), credentials.ClientSecret)
		require.NotContains(t, w.Body.String(), credentials.WebhookSecret)
		require.Equal(t, "no-store", w.Header().Get("Cache-Control"))
	}
	for _, test := range []struct {
		loadError, installError error
		want                    int
	}{
		{services.ErrGitHubAppNotConfigured, nil, http.StatusOK},
		{errors.New("database unavailable"), nil, http.StatusInternalServerError},
		{nil, errors.New("credential unseal failed"), http.StatusInternalServerError},
	} {
		h, _ := githubAppSetupTestHandler()
		h.Store = &githubAppSetupTestCredentials{loadError: test.loadError, installURLError: test.installError}
		r := httptest.NewRequest(http.MethodGet, "http://localhost:4000/api/install", nil)
		r.AddCookie(&http.Cookie{Name: GitHubAppSetupSessionCookie, Value: strings.Repeat("s", 64)})
		r.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
		r.Header.Set("X-CSRF-Token", "csrf")
		origin, ok := h.requestOrigin(r)
		if ok {
			r.Header.Set("Origin", origin)
		}
		if r.RemoteAddr == "192.0.2.1:1234" && strings.Contains(r.Host, "localhost") {
			r.RemoteAddr = "127.0.0.1:1234"
		}
		w := httptest.NewRecorder()
		h.Status(w, r)
		require.Equal(t, test.want, w.Code)
		if test.want == http.StatusOK {
			require.JSONEq(t, `{"github_app":{"configured":false,"installed":false}}`, w.Body.String())
		}
	}
}

func TestGitHubAppSetupProxyOriginRequiresTrustAndExactAllowlist(t *testing.T) {
	for _, test := range []struct {
		name, host, forwardedHost, forwardedProto string
		hops, want                                int
	}{
		{"TLS termination", "factory.example", "", "https", 1, http.StatusOK},
		{"edge host rewrite", "backend.internal", "factory.example", "https", 1, http.StatusOK},
		{"untrusted forwarded origin", "backend.internal", "factory.example", "https", 0, http.StatusMisdirectedRequest},
		{"foreign forwarded host", "backend.internal", "attacker.example", "https", 1, http.StatusMisdirectedRequest},
		{"malformed host path", "backend.internal", "factory.example/path", "https", 1, http.StatusMisdirectedRequest},
		{"ignored forwarded scheme", "factory.example", "", "ftp", 1, http.StatusOK},
	} {
		t.Run(test.name, func(t *testing.T) {
			h, s := githubAppSetupTestHandler()

			r := githubAppSetupBeginRequest("http://" + test.host)
			r.AddCookie(&http.Cookie{Name: GitHubAppSetupSessionCookie, Value: strings.Repeat("s", 64)})
			r.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
			r.Header.Set("X-CSRF-Token", "csrf")
			origin, ok := h.requestOrigin(r)
			if ok {
				r.Header.Set("Origin", origin)
			}
			if test.hops > 0 {
				r.RemoteAddr = "127.0.0.1:1234"
			} else {
				r.RemoteAddr = "192.0.2.1:1234"
			}
			r.Header.Set("X-Forwarded-Proto", test.forwardedProto)
			r.Header.Set("X-Forwarded-Host", test.forwardedHost)
			if origin, ok := h.requestOrigin(r); ok {
				r.Header.Set("Origin", origin)
			}
			if r.RemoteAddr == "192.0.2.1:1234" && strings.Contains(r.Host, "localhost") {
				r.RemoteAddr = "127.0.0.1:1234"
			}
			w := httptest.NewRecorder()
			h.Begin(w, r)
			require.Equal(t, test.want, w.Code, w.Body.String())
			if test.want == http.StatusOK {
				require.Equal(t, "https://factory.example", s.request.Origin)
				require.True(t, w.Result().Cookies()[0].Secure)
				r = githubAppSetupCallbackRequest("http://"+test.host, "installed", "state=browser-state&installation_id=123", "browser-state")
				if test.hops > 0 {
					r.RemoteAddr = "127.0.0.1:1234"
				} else {
					r.RemoteAddr = "192.0.2.1:1234"
				}
				r.Header.Set("X-Forwarded-Proto", test.forwardedProto)
				r.Header.Set("X-Forwarded-Host", test.forwardedHost)
				if origin, ok := h.requestOrigin(r); ok {
					r.Header.Set("Origin", origin)
				}
				w = httptest.NewRecorder()
				h.Installed(w, r)
				require.Equal(t, http.StatusOK, w.Code)
				require.True(t, w.Result().Cookies()[0].Secure)
			} else {
				require.Zero(t, s.beginCalls)
			}
		})
	}
}

func TestGitHubAppSetupCallbackOriginBindingPrecedesExchange(t *testing.T) {
	for _, installed := range []bool{false} {
		h, s := githubAppSetupTestHandler()
		s.originError = pkgerrors.Forbidden("GitHub App setup origin does not match")
		r := githubAppSetupCallbackRequest("https://factory.example", "callback", "code=code&state=browser-state&installation_id=123", "browser-state")
		if r.RemoteAddr == "192.0.2.1:1234" && strings.Contains(r.Host, "localhost") {
			r.RemoteAddr = "127.0.0.1:1234"
		}
		w := httptest.NewRecorder()
		if installed {
			h.Installed(w, r)
		} else {
			h.Callback(w, r)
		}
		require.Equal(t, http.StatusForbidden, w.Code)
		require.Equal(t, 1, s.originCalls)
		require.Equal(t, "https://factory.example", s.origin)
		require.Zero(t, s.convertCalls, "another configured origin must not exchange the code")
		require.Zero(t, s.installedCalls, "another configured origin must not record installation")
	}
}

func TestGitHubAppSetupStatusShowsExactCallbackRegistrationFix(t *testing.T) {
	h, _ := githubAppSetupTestHandler()
	reader := &githubAppSetupTestCredentials{
		credentials:   services.GitHubAppCredentials{Slug: "smithers-test"},
		callbackURLs:  []string{"http://localhost:4000/api/auth/github/callback"},
		callbackFixes: []services.GitHubAppCallbackFix{{SettingsURL: "https://github.com/organizations/smithersai/settings/apps/smithers-test", AddURL: "https://factory.example/api/auth/github/callback"}},
	}
	h.Store = reader
	r := httptest.NewRequest(http.MethodGet, "http://localhost:4000/api/install", nil)
	r.AddCookie(&http.Cookie{Name: GitHubAppSetupSessionCookie, Value: strings.Repeat("s", 64)})
	r.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
	r.Header.Set("X-CSRF-Token", "csrf")
	origin, ok := h.requestOrigin(r)
	if ok {
		r.Header.Set("Origin", origin)
	}
	if r.RemoteAddr == "192.0.2.1:1234" && strings.Contains(r.Host, "localhost") {
		r.RemoteAddr = "127.0.0.1:1234"
	}
	w := httptest.NewRecorder()
	h.Status(w, r)
	require.Equal(t, http.StatusOK, w.Code)
	require.Contains(t, w.Body.String(), `"callback_urls":["http://localhost:4000/api/auth/github/callback"]`)
	require.Contains(t, w.Body.String(), `"callback_fixes":[{"settings_url":"https://github.com/organizations/smithersai/settings/apps/smithers-test","add_url":"https://factory.example/api/auth/github/callback"}]`)
	require.Equal(t, h.AllowedOrigins, reader.fixOrigins, "all configured origins need reconciliation, not just the current listener")
	for _, fixFailure := range []bool{false, true} {
		if fixFailure {
			reader.callbackError = nil
			reader.callbackFixError = errors.New("invalid callback snapshot")
		} else {
			reader.callbackError = errors.New("missing callback snapshot")
		}
		w = httptest.NewRecorder()
		h.Status(w, r)
		require.Equal(t, http.StatusInternalServerError, w.Code)
		require.NotContains(t, w.Body.String(), "configured")
	}
}

func TestGitHubAppSetupOriginAndCSRFBeforeBegin(t *testing.T) {
	// Spec §16.3.3: cookie POSTs need the effective Origin and CSRF token.
	for _, tc := range []struct{ origin, csrf string }{{"", "csrf"}, {"http://localhost:4000", ""}, {"http://localhost:4000", "foreign"}, {"https://evil.example", "csrf"}} {
		h, s := githubAppSetupTestHandler()
		r := githubAppSetupBeginRequest("http://localhost:4000")
		r.AddCookie(&http.Cookie{Name: GitHubAppSetupSessionCookie, Value: strings.Repeat("s", 64)})
		r.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("X-CSRF-Token", tc.csrf)
		w := httptest.NewRecorder()
		h.Begin(w, r)
		require.Equal(t, 403, w.Code)
		require.Zero(t, s.beginCalls)
	}
	h, s := githubAppSetupTestHandler()
	r := githubAppSetupBeginRequest("http://unknown.example")
	w := httptest.NewRecorder()
	h.Begin(w, r)
	require.Equal(t, 421, w.Code, "unknown host is refused before missing authentication")
	require.Contains(t, w.Body.String(), `"code":"unknown_origin"`)
	require.Zero(t, s.beginCalls)
}
