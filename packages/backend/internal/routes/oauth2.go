package routes

import (
	"context"
	"crypto/subtle"
	"html/template"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// OAuth2Service defines the interface for first-party OAuth2 authentication operations.
type OAuth2Service interface {
	AuthorizeGrant(ctx context.Context, in services.OAuth2AuthorizeInput) (services.OAuth2AuthorizeResult, error)
	ExchangeCode(ctx context.Context, clientID, clientSecret, code, redirectURI, codeVerifier string) (services.OAuth2TokenResponse, error)
	RefreshToken(ctx context.Context, clientID, clientSecret, refreshToken string) (services.OAuth2TokenResponse, error)
	RevokeToken(ctx context.Context, clientID, clientSecret, token string) error
	GetApplicationByClientID(ctx context.Context, clientID string) (services.OAuth2ApplicationResponse, error)
	IsValidRegisteredRedirectURI(ctx context.Context, clientID, redirectURI string) (bool, error)
	RevokeAllByAppAndUser(ctx context.Context, appID, userID int64) error
}

// OAuth2Handler handles first-party OAuth2 authorization endpoints.
type OAuth2Handler struct {
	Service      OAuth2Service
	AuditService *services.AuditService
	Metrics      *SmithersMetrics
	// CookieSecure is configuration-derived because production TLS terminates
	// at the ingress and therefore r.TLS is nil inside the API pod.
	CookieSecure             bool
	DevAutoAuthorizeUserID   int64
	DevAutoAuthorizeClientID string
	// UpstreamAuthorizePath is the browser login endpoint used when an
	// unauthenticated caller hits /api/oauth2/authorize. If empty, defaults
	// to /api/auth/github.
	UpstreamAuthorizePath string
}

// authorizeRequest is the expected query parameters for the authorize endpoint.
type authorizeRequest struct {
	ResponseType        string `json:"response_type"`
	ClientID            string `json:"client_id"`
	RedirectURI         string `json:"redirect_uri"`
	Scope               string `json:"scope"`
	State               string `json:"state"`
	CodeChallenge       string `json:"code_challenge"`
	CodeChallengeMethod string `json:"code_challenge_method"`
}

// oauth2PendingAuthorizeCookie names the short-lived cookie that carries a
// pending /api/oauth2/authorize request URL across the upstream IdP login
// detour. It is set by GetAuthorize when the caller has no session, read by
// GetGitHubOAuthCallback (auth.go) after the session is established, and
// then cleared. HttpOnly + SameSite=Lax so it survives the upstream IdP
// redirect but is not readable from JavaScript.
const oauth2PendingAuthorizeCookie = "smithers_oauth2_pending_authorize"

// oauth2PendingAuthorizeTTL limits how long a pending authorize URL can
// sit before the user must restart the flow. RFC 6749 §10.12 recommends
// tying the authorize request to a short-lived anti-forgery token.
const oauth2PendingAuthorizeTTL = 10 * time.Minute

// GetAuthorize handles the OAuth2 authorization endpoint (RFC 6749 §4.1.1,
// RFC 7636 PKCE, RFC 8252 native app guidance).
// GET /api/oauth2/authorize
//
// This is a browser-native flow:
//   - If the caller is unauthenticated, we stash the sanitized authorize
//     URL in a short-lived signed cookie and redirect to the upstream IdP
//     login (`/api/auth/github` by default). After the session is
//     established, the corresponding OAuth callback handler (auth.go) resumes
//     us by 302ing back to this URL.
//   - If session-authenticated, we render a CSRF-bound
//     consent page. The authorization code is only minted by the POST
//     confirmation (PostAuthorizeDecision below) — never on a bare GET.
//     Session cookies ride along on top-level SameSite=Lax navigations, so
//     issuing a code directly here would let an attacker-crafted link mint
//     a grant bound to attacker-chosen state + PKCE values (login CSRF).
//   - Token-authenticated callers (PAT / first-party token) get the code
//     directly: header-borne credentials are never attached by the browser
//     to a cross-site navigation, so there is no CSRF vector to confirm
//     away. OAuth2 access tokens are refused with 403 to prevent re-grants.
//     Resource-bound tokens (repository / agent-session / path / workspace
//     restricted) are also refused because a grant would drop the binding.
//
// Trust boundary: the route is PUBLIC (RequireAuth removed) because a
// mobile/browser flow cannot authenticate before it reaches this handler.
// Caveat: the authorize endpoint is still protected by
//   - rate-limit middleware (AuthRateLimit — the strict 5/min "auth"
//     scope; note the interactive GitHub/Auth0 start+callback routes use
//     the separate, looser "auth_interactive" scope),
//   - PKCE S256 enforcement (required for ALL clients here),
//   - strict registered-redirect-URI matching (RFC 8252 §8.1),
//   - and the fact that the code itself requires client_id + matching
//     code_verifier at the token endpoint before it can be redeemed.
//
// Per RFC 6749 §4.1.2.1, we MUST NOT redirect errors to an unvalidated
// redirect_uri. We validate client_id and redirect_uri FIRST and return
// JSON errors for those failures. Only AFTER validation do we redirect
// downstream errors (e.g. invalid scope) back to the client.
func (h *OAuth2Handler) GetAuthorize(w http.ResponseWriter, r *http.Request) {
	req := authorizeRequest{
		ResponseType:        r.URL.Query().Get("response_type"),
		ClientID:            strings.TrimSpace(r.URL.Query().Get("client_id")),
		RedirectURI:         strings.TrimSpace(r.URL.Query().Get("redirect_uri")),
		Scope:               r.URL.Query().Get("scope"),
		State:               r.URL.Query().Get("state"),
		CodeChallenge:       strings.TrimSpace(r.URL.Query().Get("code_challenge")),
		CodeChallengeMethod: strings.TrimSpace(r.URL.Query().Get("code_challenge_method")),
	}
	if !h.validateAuthorizeRequest(w, r, req) {
		return
	}

	// === Phase 2: if unauthenticated, stash the authorize URL and detour
	// to the upstream IdP login.
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		if h.devAutoAuthorizeAllowed(r) {
			// E2E-only shortcut (SMITHERS_ENABLE_E2E_TEST_ROUTES): mint
			// directly as the configured dev user.
			h.issueAuthorizeCodeAndRedirect(w, r, req, h.DevAutoAuthorizeUserID, nil)
			return
		}
		h.startUpstreamIDPDetour(w, r)
		return
	}

	// === Phase 2b: enforce first-party auth context.
	// Third-party OAuth2 access tokens MUST NOT be used to mint new
	// authorization codes (token→code re-grant). Only browser sessions and
	// first-party tokens are permitted at the authorize endpoint. This prevents
	// a stolen third-party token from being used to silently authorize
	// additional OAuth2 apps.
	//
	// Resource-bound tokens (repo:/agent-session:/path:/workspace: entries in
	// the stored scopes string) are refused as well. The service intersects
	// permission scope names only; it has no representation of the binding,
	// so a per-run sandbox token confined to one repository would otherwise
	// mint a first-party grant carrying plain write:repository across every
	// repository the user owns, refreshable beyond the originating task.
	authInfo := middleware.AuthInfoFromContext(r.Context())
	// callerScopes is the service's restriction signal: nil means a session
	// caller (unrestricted); a non-nil slice bounds the grant to exactly
	// those scopes. A token whose scopes string parses to nothing must
	// therefore be a non-nil EMPTY slice, so the service refuses every
	// requested scope instead of reading nil as "session, unrestricted".
	var callerScopes []string
	isTokenAuth := authInfo != nil && authInfo.IsTokenAuth
	if isTokenAuth {
		if authInfo.TokenSystemIssued {
			errors.WriteError(w, errors.Forbidden("system-issued tokens cannot authorize oauth2 grants"))
			return
		}
		if authInfo.TokenSource == middleware.TokenSourceOAuth2AccessToken {
			errors.WriteError(w, errors.Forbidden("oauth2 access tokens cannot be used to authorize new oauth2 grants"))
			return
		}
		if authInfo.IsResourceBound() {
			errors.WriteError(w, errors.Forbidden("resource-restricted tokens cannot authorize oauth2 grants"))
			return
		}
		// PAT/first-party token: collect the caller's scopes so the service
		// can bound the authorization code scopes accordingly.
		callerScopes = make([]string, 0, len(authInfo.Scopes))
		for scope := range authInfo.Scopes {
			callerScopes = append(callerScopes, string(scope))
		}
	}

	// === Phase 3: token-authenticated callers are CSRF-immune (the
	// Authorization header is never attached by a browser to a cross-site
	// navigation), so they get the code directly.
	if isTokenAuth {
		h.issueAuthorizeCodeAndRedirectFrom(w, r, req, user.ID, callerScopes, authInfo.TokenID)
		return
	}

	// Session-authenticated browser: require an explicit, CSRF-bound
	// confirmation before minting the code. The session cookie DOES ride
	// along on attacker-initiated top-level GET navigations (SameSite=Lax),
	// so a bare GET must never mint a grant bound to request-supplied
	// state/PKCE values.
	h.renderAuthorizeConsent(w, r, req)
}

// PostAuthorizeDecision handles the consent form submitted from the page
// rendered by GetAuthorize (application/x-www-form-urlencoded).
// POST /api/oauth2/authorize
//
// CSRF binding: the form must echo the single-use nonce that GetAuthorize
// set in the smithers_oauth2_authorize_csrf cookie. A cross-site attacker
// can force the GET (and receive the consent page in the victim's browser)
// but cannot read the nonce out of it, so they cannot forge the approving
// POST. This endpoint is exempted from the global X-CSRF-Token middleware
// precisely because it carries this dedicated double-submit nonce.
func (h *OAuth2Handler) PostAuthorizeDecision(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		errors.WriteError(w, errors.BadRequest("invalid form data"))
		return
	}
	req := authorizeRequest{
		ResponseType:        r.PostFormValue("response_type"),
		ClientID:            strings.TrimSpace(r.PostFormValue("client_id")),
		RedirectURI:         strings.TrimSpace(r.PostFormValue("redirect_uri")),
		Scope:               r.PostFormValue("scope"),
		State:               r.PostFormValue("state"),
		CodeChallenge:       strings.TrimSpace(r.PostFormValue("code_challenge")),
		CodeChallengeMethod: strings.TrimSpace(r.PostFormValue("code_challenge_method")),
	}
	if !h.validateAuthorizeRequest(w, r, req) {
		return
	}

	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}
	// The consent confirmation is a browser-session flow. Eligible token
	// callers get their code on GET, where scopes and bindings are checked.
	if authInfo := middleware.AuthInfoFromContext(r.Context()); authInfo != nil && authInfo.IsTokenAuth {
		errors.WriteError(w, errors.Forbidden("authorize confirmation requires a browser session"))
		return
	}

	// Validate + burn the single-use CSRF nonce.
	cookie, cookieErr := r.Cookie(oauth2AuthorizeCSRFCookie)
	clearAuthorizeCSRFCookie(w, h.CookieSecure)
	formToken := strings.TrimSpace(r.PostFormValue("csrf_token"))
	if cookieErr != nil || cookie.Value == "" || formToken == "" ||
		subtle.ConstantTimeCompare([]byte(cookie.Value), []byte(formToken)) != 1 {
		errors.WriteError(w, errors.Forbidden("invalid or expired authorize confirmation"))
		return
	}

	switch r.PostFormValue("decision") {
	case "approve":
		h.issueAuthorizeCodeAndRedirect(w, r, req, user.ID, nil)
	case "deny":
		// RFC 6749 §4.1.2.1: user refused consent → access_denied on the
		// (already validated) redirect_uri, state echoed.
		redirectURL, parseErr := url.Parse(req.RedirectURI)
		if parseErr != nil {
			writeRouteError(w, r, errors.Internal("failed to parse redirect_uri").WithCause(parseErr))
			return
		}
		q := redirectURL.Query()
		q.Set("error", "access_denied")
		q.Set("state", req.State)
		redirectURL.RawQuery = q.Encode()
		http.Redirect(w, r, redirectURL.String(), http.StatusFound)
	default:
		errors.WriteError(w, errors.BadRequest("decision must be 'approve' or 'deny'"))
	}
}

// validateAuthorizeRequest runs the shared authorize-request validation for
// both the GET (consent page) and POST (decision) handlers. It writes an
// error response and returns false when the request must not proceed.
//
// Per RFC 6749 §4.1.2.1, params that establish trust in the redirect_uri are
// validated BEFORE anything is ever redirected there.
func (h *OAuth2Handler) validateAuthorizeRequest(w http.ResponseWriter, r *http.Request, req authorizeRequest) bool {
	// === Phase 1: validate params that must be sound BEFORE we trust the
	// redirect_uri. RFC 6749 §4.1.2.1.
	if req.ResponseType != "code" {
		errors.WriteError(w, errors.BadRequest("response_type must be 'code'"))
		return false
	}
	if req.ClientID == "" {
		errors.WriteError(w, errors.BadRequest("client_id is required"))
		return false
	}
	if req.RedirectURI == "" {
		errors.WriteError(w, errors.BadRequest("redirect_uri is required"))
		return false
	}
	// PKCE is mandatory for this endpoint (RFC 8252 §6; RFC 7636).
	if req.CodeChallenge == "" {
		errors.WriteError(w, errors.BadRequest("code_challenge is required"))
		return false
	}
	if req.CodeChallengeMethod != "S256" {
		errors.WriteError(w, errors.BadRequest("code_challenge_method must be S256"))
		return false
	}
	if req.State == "" {
		// State is not technically required by RFC 6749 but omitting it
		// defeats CSRF protection for native apps (RFC 8252 §8.9). We
		// enforce it.
		errors.WriteError(w, errors.BadRequest("state is required"))
		return false
	}
	// Validate client and redirect_uri against the registered client BEFORE
	// we ever redirect anywhere. If either is bad, we must NOT 302 to the
	// supplied redirect_uri.
	valid, validateErr := h.Service.IsValidRegisteredRedirectURI(r.Context(), req.ClientID, req.RedirectURI)
	if validateErr != nil {
		writeRouteError(w, r, validateErr)
		return false
	}
	if !valid {
		errors.WriteError(w, errors.BadRequest("invalid redirect_uri"))
		return false
	}

	// Only the deployment-provisioned first-party client can authorize.
	if !isFirstPartyClient(req.ClientID) {
		errors.WriteError(w, errors.Forbidden("application hosting is unavailable"))
		return false
	}
	return true
}

// issueAuthorizeCodeAndRedirect mints the authorization code and 302s to the
// validated redirect_uri with code + state (RFC 6749 §4.1.2), preserving any
// existing query on the registered redirect_uri (RFC 6749 §3.1.2).
func (h *OAuth2Handler) issueAuthorizeCodeAndRedirect(w http.ResponseWriter, r *http.Request, req authorizeRequest, userID int64, callerScopes []string) {
	h.issueAuthorizeCodeAndRedirectFrom(w, r, req, userID, callerScopes, 0)
}

// issueAuthorizeCodeAndRedirectFrom is issueAuthorizeCodeAndRedirect with the
// personal access token that authorized the grant (0 for session consent);
// the grant is bound to that token's life.
func (h *OAuth2Handler) issueAuthorizeCodeAndRedirectFrom(w http.ResponseWriter, r *http.Request, req authorizeRequest, userID int64, callerScopes []string, sourceAccessTokenID int64) {
	result, err := h.Service.AuthorizeGrant(r.Context(), services.OAuth2AuthorizeInput{
		UserID:              userID,
		ClientID:            req.ClientID,
		RedirectURI:         req.RedirectURI,
		Scope:               req.Scope,
		CodeChallenge:       req.CodeChallenge,
		CodeChallengeMethod: req.CodeChallengeMethod,
		CallerScopes:        callerScopes,
		SourceAccessTokenID: sourceAccessTokenID,
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	redirectURL, parseErr := url.Parse(result.RedirectURI)
	if parseErr != nil {
		writeRouteError(w, r, errors.Internal("failed to parse redirect_uri").WithCause(parseErr))
		return
	}
	q := redirectURL.Query()
	q.Set("code", result.Code)
	q.Set("state", req.State)
	redirectURL.RawQuery = q.Encode()

	http.Redirect(w, r, redirectURL.String(), http.StatusFound)
}

// oauth2AuthorizeCSRFCookie carries the single-use consent nonce between the
// GET consent page and the POST decision. HttpOnly (never script-readable)
// and SameSite=Strict: the approving POST is always a same-origin form
// submit from our own consent page, so Strict costs nothing and refuses the
// cookie on any cross-site request.
const oauth2AuthorizeCSRFCookie = "smithers_oauth2_authorize_csrf"

// oauth2AuthorizeCSRFTTL bounds how long a rendered consent page stays
// approvable before the user must reload it.
const oauth2AuthorizeCSRFTTL = 10 * time.Minute

// authorizeConsentTemplate renders the minimal interstitial consent page.
// html/template contextually escapes every request-derived value (state,
// code_challenge, redirect_uri, ...), which matters because they are
// attacker-choosable query params.
var authorizeConsentTemplate = template.Must(template.New("oauth2-consent").Parse(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Authorize {{.AppName}} — Smithers</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0d1117;color:#e6edf3;display:flex;justify-content:center;padding:4rem 1rem}
main{max-width:26rem;width:100%}
h1{font-size:1.25rem;font-weight:600}
p{color:#9198a1;line-height:1.5}
ul{padding-left:1.25rem;color:#9198a1}
form{display:flex;gap:.75rem;margin-top:1.5rem}
button{flex:1;padding:.6rem 1rem;border-radius:6px;border:1px solid #3d444d;font-size:.95rem;cursor:pointer}
button.approve{background:#238636;border-color:#238636;color:#fff}
button.deny{background:transparent;color:#e6edf3}
</style>
</head>
<body>
<main>
<h1>Authorize {{.AppName}}</h1>
<p><strong>{{.AppName}}</strong> is requesting access to your Smithers account{{if .Scopes}} with the following scopes:{{end}}</p>
{{if .Scopes}}<ul>{{range .Scopes}}<li><code>{{.}}</code></li>{{end}}</ul>{{end}}
<form method="post" action="/api/oauth2/authorize">
<input type="hidden" name="response_type" value="{{.Req.ResponseType}}">
<input type="hidden" name="client_id" value="{{.Req.ClientID}}">
<input type="hidden" name="redirect_uri" value="{{.Req.RedirectURI}}">
<input type="hidden" name="scope" value="{{.Req.Scope}}">
<input type="hidden" name="state" value="{{.Req.State}}">
<input type="hidden" name="code_challenge" value="{{.Req.CodeChallenge}}">
<input type="hidden" name="code_challenge_method" value="{{.Req.CodeChallengeMethod}}">
<input type="hidden" name="csrf_token" value="{{.CSRFToken}}">
<button class="deny" type="submit" name="decision" value="deny">Cancel</button>
<button class="approve" type="submit" name="decision" value="approve">Authorize</button>
</form>
</main>
</body>
</html>
`))

type authorizeConsentData struct {
	AppName   string
	Scopes    []string
	Req       authorizeRequest
	CSRFToken string
}

// renderAuthorizeConsent sets the single-use CSRF nonce cookie and renders
// the consent form for a session-authenticated user. The
// request params were already fully validated by validateAuthorizeRequest.
func (h *OAuth2Handler) renderAuthorizeConsent(w http.ResponseWriter, r *http.Request, req authorizeRequest) {
	app, err := h.Service.GetApplicationByClientID(r.Context(), req.ClientID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	nonce, err := randomHex(32)
	if err != nil {
		writeRouteError(w, r, errors.Internal("failed to generate authorize csrf token").WithCause(err))
		return
	}
	expiry := time.Now().UTC().Add(oauth2AuthorizeCSRFTTL)
	http.SetCookie(w, &http.Cookie{
		Name:     oauth2AuthorizeCSRFCookie,
		Value:    nonce,
		Path:     "/",
		HttpOnly: true,
		Secure:   h.CookieSecure,
		SameSite: http.SameSiteStrictMode,
		Expires:  expiry,
		MaxAge:   int(time.Until(expiry).Seconds()),
	})

	scopes := strings.Fields(req.Scope)
	if len(scopes) == 0 {
		scopes = app.Scopes
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if err := authorizeConsentTemplate.Execute(w, authorizeConsentData{
		AppName:   app.Name,
		Scopes:    scopes,
		Req:       req,
		CSRFToken: nonce,
	}); err != nil {
		middleware.LoggerFromContext(r.Context()).Error("failed to render oauth2 consent page", "error", err)
	}
}

func clearAuthorizeCSRFCookie(w http.ResponseWriter, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     oauth2AuthorizeCSRFCookie,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteStrictMode,
		Expires:  time.Unix(0, 0).UTC(),
		MaxAge:   -1,
	})
}

// startUpstreamIDPDetour stores the sanitized authorize URL in a short-lived
// cookie and redirects the browser to the upstream IdP login. After login,
// the OAuth callback handler (auth.go) will resume by reading the cookie and
// 302ing back here.
func (h *OAuth2Handler) startUpstreamIDPDetour(w http.ResponseWriter, r *http.Request) {
	// Only preserve the query we already validated — prevents an attacker
	// who steals the cookie from injecting extra params on resume.
	authorizeURL := r.URL.RequestURI()
	expiry := time.Now().UTC().Add(oauth2PendingAuthorizeTTL)
	http.SetCookie(w, &http.Cookie{
		Name:     oauth2PendingAuthorizeCookie,
		Value:    authorizeURL,
		Path:     "/",
		HttpOnly: true,
		Secure:   h.CookieSecure,
		// SameSite=Lax so the cookie survives the redirect back from
		// GitHub. GitHub callback lands as a top-level GET; Lax is
		// sufficient. Strict would drop the cookie.
		SameSite: http.SameSiteLaxMode,
		Expires:  expiry,
		MaxAge:   int(time.Until(expiry).Seconds()),
	})
	// Redirect to the configured browser OAuth start — its callback will
	// deposit a session cookie and then honor our pending-authorize cookie.
	http.Redirect(w, r, h.upstreamAuthorizePath(), http.StatusFound)
}

// devAutoAuthorizeAllowed reports whether the current request should be
// auto-authorized as the configured dev user. Only used in E2E test contexts
// where SMITHERS_ENABLE_E2E_TEST_ROUTES wires a fake user id.
func (h *OAuth2Handler) devAutoAuthorizeAllowed(r *http.Request) bool {
	if h.DevAutoAuthorizeUserID <= 0 {
		return false
	}
	clientID := strings.TrimSpace(h.DevAutoAuthorizeClientID)
	if clientID == "" {
		return true
	}
	return r.URL.Query().Get("client_id") == clientID
}

func (h *OAuth2Handler) upstreamAuthorizePath() string {
	path := strings.TrimSpace(h.UpstreamAuthorizePath)
	if path == "" {
		return "/api/auth/github"
	}
	if strings.HasPrefix(path, "/") {
		return path
	}
	return "/" + path
}

// isFirstPartyClient reports whether clientID is the first-party client, the
// only client that may be authorized at all. validateAuthorizeRequest refuses
// every other client.
func isFirstPartyClient(clientID string) bool {
	return clientID == services.FirstPartyClientID
}

// tokenRequest is the expected body for the token endpoint.
type tokenRequest struct {
	GrantType    string `json:"grant_type"`
	Code         string `json:"code"`
	RedirectURI  string `json:"redirect_uri"`
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret"`
	RefreshToken string `json:"refresh_token"`
	CodeVerifier string `json:"code_verifier"`
}

// PostToken handles the OAuth2 token exchange endpoint.
// POST /api/oauth2/token
// Supports grant_type=authorization_code and grant_type=refresh_token.
func (h *OAuth2Handler) PostToken(w http.ResponseWriter, r *http.Request) {
	var req tokenRequest

	// Support both application/json and application/x-www-form-urlencoded (per RFC 6749).
	contentType := r.Header.Get("Content-Type")
	if strings.HasPrefix(contentType, "application/x-www-form-urlencoded") {
		if err := r.ParseForm(); err != nil {
			errors.WriteError(w, errors.BadRequest("invalid form data"))
			return
		}
		req = tokenRequest{
			GrantType:    r.FormValue("grant_type"),
			Code:         r.FormValue("code"),
			RedirectURI:  r.FormValue("redirect_uri"),
			ClientID:     r.FormValue("client_id"),
			ClientSecret: r.FormValue("client_secret"),
			RefreshToken: r.FormValue("refresh_token"),
			CodeVerifier: r.FormValue("code_verifier"),
		}
	} else {
		if !decodeJSONBody(w, r, &req) {
			return
		}
	}

	// Extract client credentials from Basic auth if not in body.
	if req.ClientID == "" || req.ClientSecret == "" {
		if basicClientID, basicClientSecret, ok := r.BasicAuth(); ok {
			if req.ClientID == "" {
				req.ClientID = basicClientID
			}
			if req.ClientSecret == "" {
				req.ClientSecret = basicClientSecret
			}
		}
	}

	var result services.OAuth2TokenResponse
	var err error
	operation := ""

	switch req.GrantType {
	case "authorization_code":
		operation = "issue"
		if strings.TrimSpace(req.Code) == "" {
			errors.WriteError(w, errors.BadRequest("code is required"))
			return
		}
		if strings.TrimSpace(req.ClientID) == "" {
			errors.WriteError(w, errors.BadRequest("client_id is required"))
			return
		}
		result, err = h.Service.ExchangeCode(
			r.Context(),
			req.ClientID,
			req.ClientSecret,
			req.Code,
			req.RedirectURI,
			req.CodeVerifier,
		)
	case "refresh_token":
		operation = "refresh"
		if strings.TrimSpace(req.RefreshToken) == "" {
			errors.WriteError(w, errors.BadRequest("refresh_token is required"))
			return
		}
		if strings.TrimSpace(req.ClientID) == "" {
			errors.WriteError(w, errors.BadRequest("client_id is required"))
			return
		}
		result, err = h.Service.RefreshToken(
			r.Context(),
			req.ClientID,
			req.ClientSecret,
			req.RefreshToken,
		)
	default:
		errors.WriteError(w, errors.BadRequest("unsupported grant_type, must be 'authorization_code' or 'refresh_token'"))
		return
	}

	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	if operation != "" {
		h.Metrics.ObserveOAuth2TokenOperation(operation)
	}

	errors.WriteJSON(w, http.StatusOK, result)
}

// revokeRequest is the expected body for the revoke endpoint.
type revokeRequest struct {
	Token         string `json:"token"`
	TokenTypeHint string `json:"token_type_hint"`
	ClientID      string `json:"client_id"`
	ClientSecret  string `json:"client_secret"`
}

// PostRevoke handles the OAuth2 token revocation endpoint (RFC 7009).
// POST /api/oauth2/revoke
//
// RFC 7009 §2.1 requires the authorization server to authenticate the
// revoking client and to verify that the token was issued to that client.
// client_id is therefore mandatory (via body, form, or HTTP Basic): this
// route is public, so a token value alone must never be enough to revoke
// it — otherwise anyone who observed a token could log the user out of the
// integration without authenticating as the issuing client. The service
// layer enforces secret verification for confidential clients and token
// ownership for all clients.
func (h *OAuth2Handler) PostRevoke(w http.ResponseWriter, r *http.Request) {
	var req revokeRequest

	contentType := r.Header.Get("Content-Type")
	if strings.HasPrefix(contentType, "application/x-www-form-urlencoded") {
		if err := r.ParseForm(); err != nil {
			errors.WriteError(w, errors.BadRequest("invalid form data"))
			return
		}
		req = revokeRequest{
			Token:         r.FormValue("token"),
			TokenTypeHint: r.FormValue("token_type_hint"),
			ClientID:      r.FormValue("client_id"),
			ClientSecret:  r.FormValue("client_secret"),
		}
	} else {
		if !decodeJSONBody(w, r, &req) {
			return
		}
	}

	// RFC 6749 §2.3.1 — accept client credentials via HTTP Basic.
	if req.ClientID == "" || req.ClientSecret == "" {
		if basicClientID, basicClientSecret, ok := r.BasicAuth(); ok {
			if req.ClientID == "" {
				req.ClientID = basicClientID
			}
			if req.ClientSecret == "" {
				req.ClientSecret = basicClientSecret
			}
		}
	}

	if strings.TrimSpace(req.Token) == "" {
		errors.WriteError(w, errors.BadRequest("token is required"))
		return
	}
	if strings.TrimSpace(req.ClientID) == "" {
		errors.WriteError(w, errors.BadRequest("client_id is required"))
		return
	}

	if err := h.Service.RevokeToken(r.Context(), req.ClientID, req.ClientSecret, req.Token); err != nil {
		writeRouteError(w, r, err)
		return
	}
	h.Metrics.ObserveOAuth2TokenOperation("revoke")

	w.WriteHeader(http.StatusOK)
}

// PostRevokeAll handles the authenticated app-wide revoke endpoint.
// POST /api/oauth2/revoke-all
func (h *OAuth2Handler) PostRevokeAll(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}

	authInfo := middleware.AuthInfoFromContext(r.Context())
	if authInfo == nil || !authInfo.IsTokenAuth || authInfo.TokenSource != middleware.TokenSourceOAuth2AccessToken || authInfo.OAuth2AppID == 0 {
		errors.WriteError(w, errors.Forbidden("oauth2 access token required"))
		return
	}

	if err := h.Service.RevokeAllByAppAndUser(r.Context(), authInfo.OAuth2AppID, user.ID); err != nil {
		writeRouteError(w, r, err)
		return
	}
	h.Metrics.ObserveOAuth2TokenOperation("revoke_all")

	w.WriteHeader(http.StatusOK)
}
