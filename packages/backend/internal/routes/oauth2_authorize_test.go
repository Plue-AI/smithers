package routes

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// pkceS256 returns the RFC 7636 S256 code_challenge for a given verifier.
func pkceS256(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// authorizeTestRig wires a minimal OAuth2Handler with stub dependencies
// suitable for exercising the end-to-end authorize flow in-process.
type authorizeTestRig struct {
	handler *OAuth2Handler
	service *mockOAuth2RouteService
	// fixedCode is the auth code the mocked Authorize returns when invoked.
	// Tests can inspect what Authorize was called with via capturedAuthorize.
	fixedCode         string
	capturedAuthorize *capturedAuthorizeCall
}

type capturedAuthorizeCall struct {
	mu                  sync.Mutex
	called              bool
	userID              int64
	clientID            string
	redirectURI         string
	scope               string
	codeChallenge       string
	codeChallengeMethod string
	// callerScopes is the exact slice the handler handed to the service:
	// nil means "session caller, unrestricted"; a non-nil empty slice means
	// "token caller with no scopes, grant nothing".
	callerScopes []string
}

func (c *capturedAuthorizeCall) Called() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.called
}

func newAuthorizeTestRig(t *testing.T) *authorizeTestRig {
	t.Helper()
	captured := &capturedAuthorizeCall{}

	registeredApp := services.OAuth2ApplicationResponse{
		ID:       41,
		ClientID: services.FirstPartyClientID,
		Name:     "smithers first-party apps",
		RedirectURIs: []string{
			"smithers://oauth2/callback",
			"smithers://auth/callback",
			"http://127.0.0.1/callback",
		},
		Scopes:       []string{"read:user"},
		Confidential: false,
	}

	svc := &mockOAuth2RouteService{
		getApplicationByClientIDFn: func(_ context.Context, clientID string) (services.OAuth2ApplicationResponse, error) {
			if clientID != services.FirstPartyClientID {
				return services.OAuth2ApplicationResponse{}, pkgerrors.NotFound("oauth2 application not found")
			}
			return registeredApp, nil
		},
		isValidRegisteredRedirectURIFn: func(_ context.Context, clientID, redirectURI string) (bool, error) {
			if clientID != services.FirstPartyClientID {
				return false, pkgerrors.NotFound("oauth2 application not found")
			}
			// Direct match against registered list.
			for _, r := range registeredApp.RedirectURIs {
				if r == redirectURI {
					return true, nil
				}
			}
			// Loopback port-agnostic match (RFC 8252 §7.3). Only for
			// http://127.0.0.1/callback (IPv4) here for simplicity in the
			// test harness.
			u, err := url.Parse(redirectURI)
			if err != nil {
				return false, nil
			}
			if u.Scheme == "http" && u.Hostname() == "127.0.0.1" && u.Path == "/callback" && u.RawQuery == "" {
				return true, nil
			}
			return false, nil
		},
		authorizeFn: func(_ context.Context, userID int64, clientID, redirectURI, scope, codeChallenge, codeChallengeMethod string, callerScopes []string) (services.OAuth2AuthorizeResult, error) {
			captured.mu.Lock()
			captured.called = true
			captured.userID = userID
			captured.clientID = clientID
			captured.redirectURI = redirectURI
			captured.scope = scope
			captured.codeChallenge = codeChallenge
			captured.codeChallengeMethod = codeChallengeMethod
			captured.callerScopes = callerScopes
			captured.mu.Unlock()
			return services.OAuth2AuthorizeResult{
				Code:        "auth-code-xyz",
				RedirectURI: redirectURI,
			}, nil
		},
	}

	rig := &authorizeTestRig{
		service:           svc,
		fixedCode:         "auth-code-xyz",
		capturedAuthorize: captured,
	}
	rig.handler = &OAuth2Handler{
		Service:      svc,
		Metrics:      NewSmithersMetrics(),
		CookieSecure: true,
	}
	return rig
}

// newAuthorizeReq builds a GET /api/oauth2/authorize request with the given
// query params. If user is non-nil, it is attached to the context as an
// authenticated session user.
func newAuthorizeReq(t *testing.T, params url.Values, user *db.User) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/oauth2/authorize?"+params.Encode(), nil)
	if user != nil {
		ctx := middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{User: user})
		req = req.WithContext(ctx)
	}
	return req
}

// newTokenAuthorizeReq builds the same GET as newAuthorizeReq but
// authenticated by a personal access token whose stored scopes string is
// rawScopes (restriction entries such as repo:/agent-session:/path:/workspace:
// live only there; ParseTokenScopes drops them).
func newTokenAuthorizeReq(t *testing.T, params url.Values, user *db.User, rawScopes string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/oauth2/authorize?"+params.Encode(), nil)
	info := &middleware.AuthInfo{
		User:        user,
		IsTokenAuth: true,
		TokenSource: middleware.TokenSourcePersonalAccessToken,
		RawScopes:   rawScopes,
		Scopes:      middleware.ParseTokenScopes(rawScopes),
	}
	return req.WithContext(middleware.ContextWithAuthInfo(req.Context(), info))
}

// tokenAuthorizeParams returns a valid first-party authorize request that
// asks for the scope the rig's registered app allows.
func tokenAuthorizeParams() url.Values {
	params := url.Values{}
	params.Set("response_type", "code")
	params.Set("client_id", services.FirstPartyClientID)
	params.Set("redirect_uri", "http://127.0.0.1/callback")
	params.Set("scope", "read:user")
	params.Set("state", "opaque-state-123")
	params.Set("code_challenge", pkceS256("test-code-verifier-long-enough-to-pass"))
	params.Set("code_challenge_method", "S256")
	return params
}

// approveAuthorizeConsent replays the consent form rendered by GetAuthorize
// for a session-authenticated user: it extracts the single-use CSRF nonce
// cookie from the GET response and submits the approving POST as the same
// user (the form echoes the nonce, so cookie.Value doubles as csrf_token).
func approveAuthorizeConsent(t *testing.T, h *OAuth2Handler, getRec *httptest.ResponseRecorder, params url.Values, user *db.User) *httptest.ResponseRecorder {
	t.Helper()
	csrf := cookieByName(getRec.Result().Cookies(), oauth2AuthorizeCSRFCookie)
	require.NotNil(t, csrf, "consent page must set the CSRF nonce cookie")

	form := url.Values{}
	for key, values := range params {
		form[key] = values
	}
	form.Set("csrf_token", csrf.Value)
	form.Set("decision", "approve")

	req := httptest.NewRequest(http.MethodPost, "/api/oauth2/authorize", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.AddCookie(csrf)
	req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{User: user}))
	rec := httptest.NewRecorder()
	h.PostAuthorizeDecision(rec, req)
	return rec
}

// TestOAuth2Authorize_ValidRoundTrip_IssuesCodeBoundToRedirectURI covers the
// happy path: authenticated user, valid PKCE S256, registered
// redirect_uri → CSRF-bound consent page on GET, then the approving POST
// 302s with code + state echoed and the underlying service call carries PKCE
// params through. The GET itself must never mint a code (login CSRF).
func TestOAuth2Authorize_ValidRoundTrip_IssuesCodeBoundToRedirectURI(t *testing.T) {
	t.Parallel()
	rig := newAuthorizeTestRig(t)

	verifier := "test-code-verifier-long-enough-to-pass"
	params := url.Values{}
	params.Set("response_type", "code")
	params.Set("client_id", services.FirstPartyClientID)
	params.Set("redirect_uri", "smithers://oauth2/callback")
	params.Set("scope", "read:user")
	params.Set("state", "opaque-state-123")
	params.Set("code_challenge", pkceS256(verifier))
	params.Set("code_challenge_method", "S256")

	user := &db.User{ID: 42, Username: "alice"}
	req := newAuthorizeReq(t, params, user)
	getRec := httptest.NewRecorder()
	rig.handler.GetAuthorize(getRec, req)

	require.Equal(t, http.StatusOK, getRec.Code, "expected consent page; body=%s", getRec.Body.String())
	assert.Contains(t, getRec.Header().Get("Content-Type"), "text/html")
	assert.False(t, rig.capturedAuthorize.Called(), "a bare GET must never mint a code")

	rec := approveAuthorizeConsent(t, rig.handler, getRec, params, user)

	require.Equal(t, http.StatusFound, rec.Code, "expected 302 redirect; body=%s", rec.Body.String())
	loc := rec.Header().Get("Location")
	require.NotEmpty(t, loc)

	parsed, err := url.Parse(loc)
	require.NoError(t, err)
	assert.Equal(t, "smithers", parsed.Scheme)
	assert.Equal(t, "oauth2", parsed.Host)
	assert.Equal(t, "/callback", parsed.Path)
	assert.Equal(t, "auth-code-xyz", parsed.Query().Get("code"))
	assert.Equal(t, "opaque-state-123", parsed.Query().Get("state"))

	// PKCE params reached the service unchanged.
	require.True(t, rig.capturedAuthorize.Called())
	assert.Equal(t, "S256", rig.capturedAuthorize.codeChallengeMethod)
	assert.Equal(t, pkceS256(verifier), rig.capturedAuthorize.codeChallenge)
	assert.Equal(t, int64(42), rig.capturedAuthorize.userID)
}

// TestOAuth2Authorize_UnauthenticatedRedirectsToUpstreamIdP covers the browser
// detour: no session → cookie stashed + 302 to /api/auth/github.
func TestOAuth2Authorize_UnauthenticatedRedirectsToUpstreamIdP(t *testing.T) {
	t.Parallel()
	rig := newAuthorizeTestRig(t)

	params := url.Values{}
	params.Set("response_type", "code")
	params.Set("client_id", services.FirstPartyClientID)
	params.Set("redirect_uri", "smithers://oauth2/callback")
	params.Set("state", "opaque-state-123")
	params.Set("code_challenge", pkceS256("verifier"))
	params.Set("code_challenge_method", "S256")

	req := newAuthorizeReq(t, params, nil)
	rec := httptest.NewRecorder()
	rig.handler.GetAuthorize(rec, req)

	require.Equal(t, http.StatusFound, rec.Code)
	assert.Equal(t, "/api/auth/github", rec.Header().Get("Location"))

	var pendingCookie *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == oauth2PendingAuthorizeCookie {
			pendingCookie = c
			break
		}
	}
	require.NotNil(t, pendingCookie, "expected pending-authorize cookie to be set")
	assert.True(t, pendingCookie.HttpOnly)
	assert.True(t, pendingCookie.Secure, "configured secure cookies must remain secure behind a TLS-terminating proxy")
	assert.Equal(t, http.SameSiteLaxMode, pendingCookie.SameSite)
	assert.Contains(t, pendingCookie.Value, "/api/oauth2/authorize")

	// The service must NOT have been asked to mint a code.
	assert.False(t, rig.capturedAuthorize.Called())
}

func TestOAuth2Authorize_UnauthenticatedRedirectsToConfiguredUpstreamPath(t *testing.T) {
	t.Parallel()
	rig := newAuthorizeTestRig(t)
	rig.handler.UpstreamAuthorizePath = "/api/auth/auth0/authorize"

	params := url.Values{}
	params.Set("response_type", "code")
	params.Set("client_id", services.FirstPartyClientID)
	params.Set("redirect_uri", "smithers://oauth2/callback")
	params.Set("state", "opaque-state-123")
	params.Set("code_challenge", pkceS256("verifier"))
	params.Set("code_challenge_method", "S256")

	req := newAuthorizeReq(t, params, nil)
	rec := httptest.NewRecorder()
	rig.handler.GetAuthorize(rec, req)

	require.Equal(t, http.StatusFound, rec.Code)
	assert.Equal(t, "/api/auth/auth0/authorize", rec.Header().Get("Location"))
	assert.False(t, rig.capturedAuthorize.Called())
}

// TestOAuth2Authorize_BrowserRoundTrip_ThroughGitHubCallback exercises the
// browser-native flow across both handlers:
//  1. unauthenticated /oauth2/authorize request,
//  2. upstream /auth/github kickoff,
//  3. /auth/github/callback resume redirect,
//  4. final /oauth2/authorize code redirect.
func TestOAuth2Authorize_BrowserRoundTrip_ThroughGitHubCallback(t *testing.T) {
	t.Parallel()

	rig := newAuthorizeTestRig(t)

	var capturedStateVerifier string
	authHandler := AuthHandler{
		Service: mockAuthService{
			startGitHubOAuthFn: func(_ context.Context, stateVerifier string) (string, error) {
				capturedStateVerifier = stateVerifier
				return "https://idp.example/authorize?state=idp-state", nil
			},
			completeGitHubFn: func(_ context.Context, code, state, stateVerifier string) (services.OAuthCallbackResult, error) {
				assert.Equal(t, "idp-code", code)
				assert.Equal(t, "idp-state", state)
				assert.Equal(t, capturedStateVerifier, stateVerifier)
				return services.OAuthCallbackResult{
					User:       db.User{ID: 42, Username: "alice", LowerUsername: "alice", IsActive: true},
					SessionKey: "session-key-42",
					ExpiresAt:  time.Now().UTC().Add(time.Hour),
				}, nil
			},
		},
		AuthConfig: defaultRouteAuthConfig(),
	}

	params := url.Values{}
	params.Set("response_type", "code")
	params.Set("client_id", services.FirstPartyClientID)
	params.Set("redirect_uri", "smithers://oauth2/callback")
	params.Set("state", "opaque-state-123")
	params.Set("code_challenge", pkceS256("verifier"))
	params.Set("code_challenge_method", "S256")

	// Step 1: browser lands on /api/oauth2/authorize unauthenticated.
	req1 := newAuthorizeReq(t, params, nil)
	rec1 := httptest.NewRecorder()
	rig.handler.GetAuthorize(rec1, req1)
	require.Equal(t, http.StatusFound, rec1.Code)
	assert.Equal(t, "/api/auth/github", rec1.Header().Get("Location"))

	pendingCookie := cookieByName(rec1.Result().Cookies(), oauth2PendingAuthorizeCookie)
	require.NotNil(t, pendingCookie, "pending authorize cookie must be set")

	// Step 2: /api/auth/github sets oauth state and redirects to IdP.
	req2 := httptest.NewRequest(http.MethodGet, "/api/auth/github", nil)
	req2.AddCookie(pendingCookie)
	rec2 := httptest.NewRecorder()
	authHandler.GetGitHubOAuthStart(rec2, req2)
	require.Equal(t, http.StatusFound, rec2.Code)
	assert.Equal(t, "https://idp.example/authorize?state=idp-state", rec2.Header().Get("Location"))
	oauthStateCookie := cookieByName(rec2.Result().Cookies(), oauthStateCookieName)
	require.NotNil(t, oauthStateCookie, "oauth state cookie must be set")
	require.NotEmpty(t, capturedStateVerifier)

	// Step 3: upstream callback creates session and redirects back to authorize.
	req3 := httptest.NewRequest(http.MethodGet, "/api/auth/github/callback?code=idp-code&state=idp-state", nil)
	req3.AddCookie(oauthStateCookie)
	req3.AddCookie(pendingCookie)
	rec3 := httptest.NewRecorder()
	authHandler.GetGitHubOAuthCallback(rec3, req3)
	require.Equal(t, http.StatusFound, rec3.Code)
	resumeLocation := rec3.Header().Get("Location")
	assert.Contains(t, resumeLocation, "/api/oauth2/authorize?")
	clearedPending := cookieByName(rec3.Result().Cookies(), oauth2PendingAuthorizeCookie)
	require.NotNil(t, clearedPending)
	assert.Equal(t, "", clearedPending.Value)
	assert.Equal(t, -1, clearedPending.MaxAge)
	assert.True(t, clearedPending.Secure)

	// Step 4: resumed authorize request with authenticated session user
	// renders the CSRF-bound consent page (no code on a bare GET).
	resumeURL, err := url.Parse(resumeLocation)
	require.NoError(t, err)
	sessionUser := &db.User{ID: 42, Username: "alice", LowerUsername: "alice", IsActive: true}
	req4 := newAuthorizeReq(t, resumeURL.Query(), sessionUser)
	rec4 := httptest.NewRecorder()
	rig.handler.GetAuthorize(rec4, req4)
	require.Equal(t, http.StatusOK, rec4.Code, "body=%s", rec4.Body.String())
	assert.True(t, cookieByName(rec4.Result().Cookies(), oauth2AuthorizeCSRFCookie).Secure)

	// Step 5: the user approves; the POST mints the code.
	rec5 := approveAuthorizeConsent(t, rig.handler, rec4, resumeURL.Query(), sessionUser)
	require.Equal(t, http.StatusFound, rec5.Code)

	finalLocation := rec5.Header().Get("Location")
	finalURL, err := url.Parse(finalLocation)
	require.NoError(t, err)
	assert.Equal(t, "smithers", finalURL.Scheme)
	assert.Equal(t, "oauth2", finalURL.Host)
	assert.Equal(t, "/callback", finalURL.Path)
	assert.Equal(t, "auth-code-xyz", finalURL.Query().Get("code"))
	assert.Equal(t, "opaque-state-123", finalURL.Query().Get("state"))
}

// TestOAuth2Authorize_WrongRedirectURI_Rejected covers the redirect_uri
// binding: a URI not in the registered client's list must be rejected with
// 400, and the server MUST NOT redirect to the supplied URI (RFC 6749
// §4.1.2.1 — open-redirect protection).
func TestOAuth2Authorize_WrongRedirectURI_Rejected(t *testing.T) {
	t.Parallel()
	rig := newAuthorizeTestRig(t)

	params := url.Values{}
	params.Set("response_type", "code")
	params.Set("client_id", services.FirstPartyClientID)
	// Attacker-controlled URI not in the registered list.
	params.Set("redirect_uri", "https://evil.example.com/steal")
	params.Set("state", "opaque-state-123")
	params.Set("code_challenge", pkceS256("verifier"))
	params.Set("code_challenge_method", "S256")

	req := newAuthorizeReq(t, params, &db.User{ID: 42, Username: "alice"})
	rec := httptest.NewRecorder()
	rig.handler.GetAuthorize(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
	assert.NotContains(t, rec.Header().Get("Location"), "evil.example.com",
		"server must NOT 302 to an unregistered redirect_uri")
	assert.False(t, rig.capturedAuthorize.Called())
}

// TestOAuth2Authorize_LoopbackPortVariantAccepted covers RFC 8252 §7.3 — a
// registered http://127.0.0.1/callback entry matches any ephemeral port at
// runtime. This is required for the macOS desktop loopback flow.
func TestOAuth2Authorize_LoopbackPortVariantAccepted(t *testing.T) {
	t.Parallel()
	rig := newAuthorizeTestRig(t)

	params := url.Values{}
	params.Set("response_type", "code")
	params.Set("client_id", services.FirstPartyClientID)
	// Ephemeral port chosen at runtime — matches the registered
	// http://127.0.0.1/callback by port-agnostic comparison.
	params.Set("redirect_uri", "http://127.0.0.1:54321/callback")
	params.Set("state", "opaque-state-123")
	params.Set("code_challenge", pkceS256("verifier"))
	params.Set("code_challenge_method", "S256")

	user := &db.User{ID: 42, Username: "alice"}
	req := newAuthorizeReq(t, params, user)
	getRec := httptest.NewRecorder()
	rig.handler.GetAuthorize(getRec, req)
	require.Equal(t, http.StatusOK, getRec.Code, "body=%s", getRec.Body.String())

	rec := approveAuthorizeConsent(t, rig.handler, getRec, params, user)

	require.Equal(t, http.StatusFound, rec.Code, "body=%s", rec.Body.String())
	loc := rec.Header().Get("Location")
	parsed, err := url.Parse(loc)
	require.NoError(t, err)
	assert.Equal(t, "127.0.0.1:54321", parsed.Host)
	assert.Equal(t, "auth-code-xyz", parsed.Query().Get("code"))
}

// TestOAuth2Authorize_MissingStateRejected enforces RFC 8252 §8.9 state param.
func TestOAuth2Authorize_MissingStateRejected(t *testing.T) {
	t.Parallel()
	rig := newAuthorizeTestRig(t)

	params := url.Values{}
	params.Set("response_type", "code")
	params.Set("client_id", services.FirstPartyClientID)
	params.Set("redirect_uri", "smithers://oauth2/callback")
	// state deliberately omitted.
	params.Set("code_challenge", pkceS256("verifier"))
	params.Set("code_challenge_method", "S256")

	req := newAuthorizeReq(t, params, &db.User{ID: 42})
	rec := httptest.NewRecorder()
	rig.handler.GetAuthorize(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), "state")
}

// TestOAuth2Authorize_MissingPKCE_Rejected ensures a caller cannot bypass
// PKCE by omitting the challenge. Public clients MUST use PKCE (RFC 7636).
func TestOAuth2Authorize_MissingPKCE_Rejected(t *testing.T) {
	t.Parallel()
	rig := newAuthorizeTestRig(t)

	params := url.Values{}
	params.Set("response_type", "code")
	params.Set("client_id", services.FirstPartyClientID)
	params.Set("redirect_uri", "smithers://oauth2/callback")
	params.Set("state", "opaque-state-123")
	// code_challenge deliberately omitted.

	req := newAuthorizeReq(t, params, &db.User{ID: 42})
	rec := httptest.NewRecorder()
	rig.handler.GetAuthorize(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
	body, _ := io.ReadAll(rec.Body)
	assert.Contains(t, string(body), "code_challenge")
}

// TestOAuth2Authorize_RejectsNonS256PKCE locks in that "plain" PKCE is refused
// upstream of the service layer, before any code is minted (RFC 8252 §6.1.2).
func TestOAuth2Authorize_RejectsNonS256PKCE(t *testing.T) {
	t.Parallel()
	rig := newAuthorizeTestRig(t)

	params := url.Values{}
	params.Set("response_type", "code")
	params.Set("client_id", services.FirstPartyClientID)
	params.Set("redirect_uri", "smithers://oauth2/callback")
	params.Set("state", "opaque-state-123")
	params.Set("code_challenge", "plain-challenge")
	params.Set("code_challenge_method", "plain")

	req := newAuthorizeReq(t, params, &db.User{ID: 42})
	rec := httptest.NewRecorder()
	rig.handler.GetAuthorize(rec, req)

	require.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, rec.Body.String(), "S256")
	assert.False(t, rig.capturedAuthorize.Called())
}

// TestOAuth2Authorize_UnknownClientID_Rejected ensures we don't leak anything
// about unknown client_ids beyond a generic error.
func TestOAuth2Authorize_UnknownClientID_Rejected(t *testing.T) {
	t.Parallel()
	rig := newAuthorizeTestRig(t)

	params := url.Values{}
	params.Set("response_type", "code")
	params.Set("client_id", "nonexistent-client")
	params.Set("redirect_uri", "https://evil.example/callback")
	params.Set("state", "x")
	params.Set("code_challenge", pkceS256("v"))
	params.Set("code_challenge_method", "S256")

	req := newAuthorizeReq(t, params, &db.User{ID: 1})
	rec := httptest.NewRecorder()
	rig.handler.GetAuthorize(rec, req)

	// Either BadRequest or NotFound; the key property is NO redirect to the
	// attacker-supplied URI.
	assert.True(t, rec.Code >= 400 && rec.Code < 500)
	assert.NotContains(t, rec.Header().Get("Location"), "evil.example")
}

// TestOAuth2Authorize_ResponseTypeMustBeCode guards against implicit-flow
// confusion. Only authorization-code grant is supported.
func TestOAuth2Authorize_ResponseTypeMustBeCode(t *testing.T) {
	t.Parallel()
	rig := newAuthorizeTestRig(t)

	params := url.Values{}
	params.Set("response_type", "token")
	params.Set("client_id", services.FirstPartyClientID)
	params.Set("redirect_uri", "smithers://oauth2/callback")
	params.Set("state", "x")
	params.Set("code_challenge", pkceS256("v"))
	params.Set("code_challenge_method", "S256")

	req := newAuthorizeReq(t, params, &db.User{ID: 1})
	rec := httptest.NewRecorder()
	rig.handler.GetAuthorize(rec, req)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Contains(t, strings.ToLower(rec.Body.String()), "response_type")
}

func TestOAuth2Authorize_ThirdPartyClient_DeniedWithoutConsent(t *testing.T) {
	t.Parallel()
	const attackerClientID = "attacker_client_deadbeef"
	captured := &capturedAuthorizeCall{}
	svc := &mockOAuth2RouteService{
		getApplicationByClientIDFn: func(_ context.Context, clientID string) (services.OAuth2ApplicationResponse, error) {
			return services.OAuth2ApplicationResponse{ID: 99, ClientID: clientID, RedirectURIs: []string{"https://attacker.example/cb"}, Scopes: []string{"read:user"}, Confidential: false}, nil
		},
		isValidRegisteredRedirectURIFn: func(_ context.Context, _, _ string) (bool, error) { return true, nil },
		authorizeFn: func(_ context.Context, userID int64, clientID, redirectURI, scope, cc, ccm string, _ []string) (services.OAuth2AuthorizeResult, error) {
			captured.mu.Lock()
			captured.called = true
			captured.mu.Unlock()
			return services.OAuth2AuthorizeResult{Code: "should-not-happen", RedirectURI: redirectURI}, nil
		},
	}
	handler := &OAuth2Handler{Service: svc, Metrics: NewSmithersMetrics()}

	verifier := "test-code-verifier-long-enough-to-pass"
	params := url.Values{}
	params.Set("response_type", "code")
	params.Set("client_id", attackerClientID)
	params.Set("redirect_uri", "https://attacker.example/cb")
	params.Set("scope", "read:user")
	params.Set("state", "opaque-state-123")
	params.Set("code_challenge", pkceS256(verifier))
	params.Set("code_challenge_method", "S256")

	req := newAuthorizeReq(t, params, &db.User{ID: 42, Username: "victim"})
	rec := httptest.NewRecorder()
	handler.GetAuthorize(rec, req)

	require.Equal(t, http.StatusForbidden, rec.Code, "third-party client must be denied; body=%s", rec.Body.String())
	assert.Empty(t, rec.Header().Get("Location"), "no redirect (and therefore no code) may be issued to a third-party client")
	assert.False(t, captured.Called(), "Authorize must not be called for a non-first-party client")
}

// TestOAuth2Authorize_ResourceBoundToken_RefusedBeforeService locks in that a
// token carrying any resource binding (repository, agent session, path
// allowlist, workspace) is refused at the handler, before the service is ever
// asked to mint a code. The service only intersects permission scope names;
// it has no notion of the binding, so letting the call through would launder
// a repository-bound per-run token into an unbound first-party grant.
func TestOAuth2Authorize_ResourceBoundToken_RefusedBeforeService(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"repo":          "read:user,write:repository,repo:123",
		"agent-session": "read:user,write:repository,agent-session:sess-1",
		"path":          "read:user,write:repository," + middleware.PathRestrictionScopes([]string{"src/app"})[0],
		"workspace":     "read:user,write:repository," + middleware.WorkspaceRestrictionScope("ws-1"),
	}
	for name, rawScopes := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			rig := newAuthorizeTestRig(t)

			req := newTokenAuthorizeReq(t, tokenAuthorizeParams(), &db.User{ID: 42, Username: "agent"}, rawScopes)
			rec := httptest.NewRecorder()
			rig.handler.GetAuthorize(rec, req)

			require.Equal(t, http.StatusForbidden, rec.Code, "body=%s", rec.Body.String())
			assert.Contains(t, rec.Body.String(), "resource-restricted tokens cannot authorize oauth2 grants")
			assert.Empty(t, rec.Header().Get("Location"))
			assert.False(t, rig.capturedAuthorize.Called(), "the service must not be asked to mint a code for a resource-bound token")
		})
	}
}

// TestOAuth2Authorize_TokenWithoutScopes_PassesEmptyCallerScopes pins the
// nil-vs-empty contract with the service: a token caller whose scopes string
// parses to nothing must be represented as a NON-nil empty slice (the service
// then refuses every requested scope), never as nil (which the service reads
// as an unrestricted session caller).
func TestOAuth2Authorize_TokenWithoutScopes_PassesEmptyCallerScopes(t *testing.T) {
	t.Parallel()
	rig := newAuthorizeTestRig(t)

	req := newTokenAuthorizeReq(t, tokenAuthorizeParams(), &db.User{ID: 42, Username: "agent"}, "")
	rec := httptest.NewRecorder()
	rig.handler.GetAuthorize(rec, req)

	require.True(t, rig.capturedAuthorize.Called())
	rig.capturedAuthorize.mu.Lock()
	callerScopes := rig.capturedAuthorize.callerScopes
	rig.capturedAuthorize.mu.Unlock()
	require.NotNil(t, callerScopes, "a token caller with no scopes must be passed as an empty slice, not nil (nil = session, unrestricted)")
	assert.Empty(t, callerScopes)
}

// TestOAuth2Authorize_UnrestrictedToken_PassesParsedScopes is the control: an
// ordinary PAT is still issued its code directly on GET and its parsed scopes
// reach the service for intersection.
func TestOAuth2Authorize_UnrestrictedToken_PassesParsedScopes(t *testing.T) {
	t.Parallel()
	rig := newAuthorizeTestRig(t)

	req := newTokenAuthorizeReq(t, tokenAuthorizeParams(), &db.User{ID: 42, Username: "alice"}, "read:user")
	rec := httptest.NewRecorder()
	rig.handler.GetAuthorize(rec, req)

	require.Equal(t, http.StatusFound, rec.Code, "body=%s", rec.Body.String())
	require.True(t, rig.capturedAuthorize.Called())
	rig.capturedAuthorize.mu.Lock()
	callerScopes := rig.capturedAuthorize.callerScopes
	rig.capturedAuthorize.mu.Unlock()
	assert.Equal(t, []string{"read:user"}, callerScopes)
}

// TestOAuth2Authorize_SessionCaller_PassesNilCallerScopes keeps the session
// path unchanged: the approving POST hands the service nil (unrestricted).
func TestOAuth2Authorize_SessionCaller_PassesNilCallerScopes(t *testing.T) {
	t.Parallel()
	rig := newAuthorizeTestRig(t)
	params := tokenAuthorizeParams()
	user := &db.User{ID: 42, Username: "alice"}

	getRec := httptest.NewRecorder()
	rig.handler.GetAuthorize(getRec, newAuthorizeReq(t, params, user))
	require.Equal(t, http.StatusOK, getRec.Code, "body=%s", getRec.Body.String())

	rec := approveAuthorizeConsent(t, rig.handler, getRec, params, user)
	require.Equal(t, http.StatusFound, rec.Code, "body=%s", rec.Body.String())
	require.True(t, rig.capturedAuthorize.Called())
	rig.capturedAuthorize.mu.Lock()
	callerScopes := rig.capturedAuthorize.callerScopes
	rig.capturedAuthorize.mu.Unlock()
	assert.Nil(t, callerScopes, "session callers stay unrestricted (nil)")
}
