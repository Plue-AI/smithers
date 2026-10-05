package routes

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	stdErrors "errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type AuthService interface {
	CreateKeyAuthNonce(ctx context.Context) (string, error)
	VerifyKeyAuth(ctx context.Context, message, signature string) (services.VerifyKeyAuthResult, error)
	StartGitHubOAuth(ctx context.Context, stateVerifier string) (string, error)
	StartGitHubOAuthWithScopes(ctx context.Context, stateVerifier, rawScopes string) (string, error)
	CompleteGitHubOAuth(ctx context.Context, code, state, stateVerifier string) (services.OAuthCallbackResult, error)
	StartAuth0OAuth(ctx context.Context, stateVerifier string) (string, error)
	CompleteAuth0OAuth(ctx context.Context, code, state, stateVerifier string) (services.OAuthCallbackResult, error)
	CreateToken(ctx context.Context, userID int64, req services.CreateTokenRequest) (services.CreateTokenResult, error)
	ExchangeGitHubToken(ctx context.Context, githubAccessToken, tokenName, githubRefreshToken string, githubTokenExpiresIn int64, ttlSeconds *int64) (services.ExchangeGitHubTokenResult, error)
	Logout(ctx context.Context, sessionKey string) error
}

// GitHubRepoListingWarmer kicks a background refresh of the per-user GitHub
// repo listing cache (login is a free cache warm). Implementations must not
// block.
type GitHubRepoListingWarmer interface {
	WarmGitHubRepoListing(userID int64)
}

type AuthHandler struct {
	InstallSetup *services.InstallSetupSessions
	Service      AuthService
	AuthConfig   config.AuthConfig
	PublicOrigin string
	// Origins are the known origins an install request resolves against
	// (spec §16.3.3); the install's saved Address joins them without a restart.
	Origins      func() []string
	AuditService *services.AuditService
	// RepoListingWarmer, when set, is invoked after a successful GitHub token
	// exchange to warm the user's repo-listing cache in the background.
	RepoListingWarmer GitHubRepoListingWarmer
}

const oauthStateCookieName = "smithers_oauth_state"
const cliCallbackCookieName = "smithers_cli_callback"

type postKeyAuthVerifyRequest struct {
	Message   string `json:"message"`
	Signature string `json:"signature"`
}

func (h *AuthHandler) GetKeyAuthNonce(w http.ResponseWriter, r *http.Request) {
	nonce, err := h.Service.CreateKeyAuthNonce(r.Context())
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	errors.WriteJSON(w, http.StatusOK, map[string]string{"nonce": nonce})
}

func (h *AuthHandler) PostKeyAuthVerify(w http.ResponseWriter, r *http.Request) {
	var req postKeyAuthVerifyRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Message) == "" || strings.TrimSpace(req.Signature) == "" {
		errors.WriteError(w, errors.BadRequest("message and signature are required"))
		return
	}

	result, err := h.Service.VerifyKeyAuth(r.Context(), req.Message, req.Signature)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	csrfToken, err := randomHex(32)
	if err != nil {
		writeRouteError(w, r, errors.Internal("failed to generate csrf token").WithCause(err))
		return
	}

	setSessionCookie(w, h.AuthConfig.SessionCookieName, result.SessionKey, result.ExpiresAt, h.AuthConfig.CookieSecure)
	middleware.SetCSRFCookie(w, csrfToken, h.AuthConfig.CookieSecure, result.ExpiresAt)

	if h.AuditService != nil {
		h.AuditService.Log(r.Context(), services.AuditEvent{
			EventType:  "auth.login",
			ActorID:    &result.User.ID,
			ActorName:  result.User.Username,
			TargetType: "user",
			TargetID:   &result.User.ID,
			TargetName: result.User.Username,
			Action:     "login",
			IPAddress:  r.RemoteAddr,
			Metadata:   map[string]any{"method": "key"},
		})
	}

	errors.WriteJSON(w, http.StatusOK, map[string]any{
		"user": map[string]any{
			"id":       result.User.ID,
			"username": result.User.Username,
		},
	})
}

// PostKeyAuthToken verifies a key signature and returns an API token directly.
// This is designed for CLI/agent use - no session cookies, no browser required.
// An agent with a private key can self-onboard programmatically.
func (h *AuthHandler) PostKeyAuthToken(w http.ResponseWriter, r *http.Request) {
	var req postKeyAuthVerifyRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Message) == "" || strings.TrimSpace(req.Signature) == "" {
		errors.WriteError(w, errors.BadRequest("message and signature are required"))
		return
	}

	result, err := h.Service.VerifyKeyAuth(r.Context(), req.Message, req.Signature)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	// Create an API token for the verified user.
	tokenResult, err := h.Service.CreateToken(r.Context(), result.User.ID, services.CreateTokenRequest{
		Name:   "smithers-cli",
		Scopes: []string{"repo", "user", "org"},
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	if h.AuditService != nil {
		h.AuditService.Log(r.Context(), services.AuditEvent{
			EventType:  "auth.login",
			ActorID:    &result.User.ID,
			ActorName:  result.User.Username,
			TargetType: "user",
			TargetID:   &result.User.ID,
			TargetName: result.User.Username,
			Action:     "login",
			IPAddress:  r.RemoteAddr,
			Metadata:   map[string]any{"method": "key", "type": "token"},
		})
	}

	errors.WriteJSON(w, http.StatusOK, map[string]any{
		"token":    tokenResult.Token,
		"username": result.User.Username,
	})
}

// consumeOAuth2PendingAuthorizeCookie reads the pending-authorize cookie set
// by OAuth2Handler.startUpstreamIDPDetour, clears it, and returns the safe
// resume URL. Returns "" if the cookie is absent or contains a
// non-same-origin URL (defense against open-redirect).
func consumeOAuth2PendingAuthorizeCookie(w http.ResponseWriter, r *http.Request, secure bool) string {
	cookie, err := r.Cookie(oauth2PendingAuthorizeCookie)
	if err != nil || cookie.Value == "" {
		return ""
	}
	// Clear the cookie whether or not we honor it.
	http.SetCookie(w, &http.Cookie{
		Name:     oauth2PendingAuthorizeCookie,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		Expires:  time.Unix(0, 0).UTC(),
		MaxAge:   -1,
	})

	// Only accept relative paths pointing at our authorize endpoint. This
	// prevents an attacker who plants the cookie from redirecting the
	// user to an arbitrary URL.
	parsed, err := url.Parse(cookie.Value)
	if err != nil {
		return ""
	}
	if parsed.IsAbs() {
		return ""
	}
	if parsed.Path != "/api/oauth2/authorize" {
		return ""
	}
	return parsed.RequestURI()
}

func (h *AuthHandler) knownOrigins() []string {
	if h.Origins == nil {
		return nil
	}
	return h.Origins()
}

// GetGitHubOAuthStart begins the browser GitHub App OAuth flow (the direct
// GitHub sign-in path). It generates an oauth state verifier, stashes it in a
// cookie, and redirects to GitHub's authorize endpoint.
func (h *AuthHandler) GetGitHubOAuthStart(w http.ResponseWriter, r *http.Request) {
	if h.InstallSetup != nil {
		origin, ok := middleware.ResolveEffectiveOrigin(r, h.knownOrigins())
		if !ok {
			errors.WriteError(w, errors.New(errors.CodeUnknownOrigin, "unknown_origin"))
			return
		}
		if origin == "http://127.0.0.1:4000" || origin == "http://[::1]:4000" {
			http.Redirect(w, r, "http://localhost:4000"+r.URL.RequestURI(), http.StatusFound)
			return
		}

		if r.Header.Get("Origin") != "" && r.Header.Get("Origin") != origin {
			errors.WriteError(w, errors.Forbidden("request origin differs from install origin"))
			return
		}
		local := *h
		local.AuthConfig.CookieSecure = strings.HasPrefix(origin, "https://")
		h = &local
		r = r.WithContext(services.WithGitHubRedirectURI(r.Context(), origin+"/api/auth/github/callback"))
	}

	if h.InstallSetup != nil {
		setup := ""
		if cookie, err := r.Cookie(GitHubAppSetupSessionCookie); err == nil {
			setup = cookie.Value
		}
		if err := h.InstallSetup.AdmitOAuth(r.Context(), setup); err != nil {
			writeRouteError(w, r, err)
			return
		}
	}

	returnTo := r.URL.Query().Get("return_to")
	if returnTo != "" && !validBrowserReturn(returnTo) {
		writeRouteError(w, r, errors.BadRequest("return_to must be a local path"))
		return
	}
	stateVerifier, err := randomHex(16)
	if err != nil {
		writeRouteError(w, r, errors.Internal("failed to generate oauth state").WithCause(err))
		return
	}
	redirectURL, err := h.Service.StartGitHubOAuth(r.Context(), stateVerifier)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	setOAuthStateCookie(w, stateVerifier, time.Now().UTC().Add(10*time.Minute), h.AuthConfig.CookieSecure)
	setBrowserReturnCookie(w, r, returnTo, stateVerifier, h.AuthConfig.CookieSecure)
	// A browser login must never complete as a CLI flow: drop any stale CLI
	// callback cookie left behind by an earlier (abandoned) CLI login so the
	// upcoming callback cannot mint a broad CLI token and bounce the browser
	// to a dead localhost port.
	clearCLICallbackCookie(w)
	http.Redirect(w, r, redirectURL, http.StatusFound)
}

func (h *AuthHandler) GetGitHubOAuthCLIStart(w http.ResponseWriter, r *http.Request) {
	portStr := r.URL.Query().Get("callback_port")
	if portStr == "" {
		errors.WriteError(w, errors.BadRequest("callback_port is required"))
		return
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port < 1024 || port > 65535 {
		errors.WriteError(w, errors.BadRequest("callback_port must be a valid port (1024-65535)"))
		return
	}
	callbackState := r.URL.Query().Get("callback_state")
	if r.URL.Query().Has("callback_state") && !validCLICallbackState(callbackState) {
		errors.WriteError(w, errors.BadRequest("callback_state must be a 43-character base64url value"))
		return
	}

	stateVerifier, err := randomHex(16)
	if err != nil {
		writeRouteError(w, r, errors.Internal("failed to generate oauth state").WithCause(err))
		return
	}
	var redirectURL string
	if admin := r.URL.Query().Get("admin"); admin != "" && admin != "1" {
		writeRouteError(w, r, errors.BadRequest("admin must be 1"))
		return
	}
	if r.URL.Query().Get("admin") == "1" {
		svc, ok := h.Service.(adminCLILoginService)
		if !ok {
			writeRouteError(w, r, errors.Internal("admin CLI login unavailable"))
			return
		}
		redirectURL, err = svc.StartAdminCLILogin(r.Context(), stateVerifier, r.URL.Query().Get("ttl"), port, callbackState, r.URL.Query().Get("scopes"))
	} else {
		if r.URL.Query().Has("ttl") {
			writeRouteError(w, r, errors.BadRequest("ttl requires admin=1"))
			return
		}
		redirectURL, err = h.Service.StartGitHubOAuthWithScopes(r.Context(), stateVerifier, r.URL.Query().Get("scopes"))
	}
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	expiry := time.Now().UTC().Add(10 * time.Minute)
	setOAuthStateCookie(w, stateVerifier, expiry, h.AuthConfig.CookieSecure)
	// Store the callback port BOUND to this flow's state verifier so the
	// callback handler only enters CLI mode for the exact OAuth flow the CLI
	// started (a stale cookie must not hijack a later browser login).
	if r.URL.Query().Get("admin") == "1" {
		// The durable admin request already binds the callback port and state.
		clearCLICallbackCookie(w)
	} else {
		setCLICallbackCookie(w, portStr, stateVerifier, expiry, h.AuthConfig.CookieSecure, callbackState)
	}

	http.Redirect(w, r, redirectURL, http.StatusFound)
}

// setupSignInFailed returns a refused pre-claim sign-in to the Setup card,
// whose sign-in step shows the reason. The browser arrived from GitHub, so a
// JSON body would be the whole page.
func (h *AuthHandler) setupSignInFailed(w http.ResponseWriter, r *http.Request, err error) bool {
	if h.InstallSetup == nil {
		return false
	}
	cookie, cookieErr := r.Cookie(GitHubAppSetupSessionCookie)
	if cookieErr != nil || h.InstallSetup.FailSignIn(r.Context(), cookie.Value, installSetupFailure(err)) != nil {
		return false
	}
	http.Redirect(w, r, "/", http.StatusSeeOther)
	return true
}

func (h *AuthHandler) GetGitHubOAuthCallback(w http.ResponseWriter, r *http.Request) {
	if h.InstallSetup != nil {
		origin, ok := middleware.ResolveEffectiveOrigin(r, h.knownOrigins())
		if !ok {
			errors.WriteError(w, errors.New(errors.CodeUnknownOrigin, "unknown_origin"))
			return
		}
		if r.Header.Get("Origin") != "" && r.Header.Get("Origin") != origin {
			errors.WriteError(w, errors.Forbidden("request origin differs from install origin"))
			return
		}
		local := *h
		local.AuthConfig.CookieSecure = strings.HasPrefix(origin, "https://")
		h = &local
		r = r.WithContext(services.WithGitHubRedirectURI(r.Context(), origin+"/api/auth/github/callback"))
	}

	if h.InstallSetup != nil {
		setup := ""
		if cookie, err := r.Cookie(GitHubAppSetupSessionCookie); err == nil {
			setup = cookie.Value
		}
		if err := h.InstallSetup.AdmitOAuth(r.Context(), setup); err != nil {
			writeRouteError(w, r, err)
			return
		}
	}

	returnTo := consumeBrowserReturnCookie(w, r, h.AuthConfig.CookieSecure)
	code := r.URL.Query().Get("code")
	state := r.URL.Query().Get("state")
	if strings.TrimSpace(code) == "" || strings.TrimSpace(state) == "" {
		refusal := errors.BadRequest("code and state are required")
		if r.URL.Query().Get("error") != "" {
			refusal = errors.BadRequest("GitHub sign-in did not complete")
		}
		if h.setupSignInFailed(w, r, refusal) {
			return
		}
		errors.WriteError(w, refusal)
		return
	}

	stateVerifier := oauthStateVerifierFromRequest(r)
	ctx := r.Context()
	if cookie, err := r.Cookie(GitHubAppSetupSessionCookie); err == nil {
		ctx = services.WithInstallSetupSession(ctx, cookie.Value)
	}
	result, err := h.Service.CompleteGitHubOAuth(ctx, code, state, stateVerifier)
	if err != nil {
		clearOAuthStateCookie(w, h.AuthConfig.CookieSecure)
		if h.setupSignInFailed(w, r, err) {
			return
		}
		writeRouteError(w, r, err)
		return
	}

	if h.InstallSetup != nil {
		http.SetCookie(w, &http.Cookie{Name: GitHubAppSetupSessionCookie, Value: "", Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: h.AuthConfig.CookieSecure, MaxAge: -1})
	}
	if result.AdminCLI != nil {
		h.showAdminCLIConsent(w, r, result, state, stateVerifier)
		return
	}

	// CLI login flow: only when the callback cookie is bound to the state
	// verifier that just completed this OAuth flow. A cookie left over from
	// an earlier CLI login attempt fails the binding and is discarded, so it
	// cannot hijack a browser login into minting a CLI token.
	if portStr, ok := cliCallbackPortFromRequest(r); ok {
		h.completeCLIOAuth(w, r, result, portStr)
		return
	}
	clearCLICallbackCookie(w)

	csrfToken, err := randomHex(32)
	if err != nil {
		clearOAuthStateCookie(w, h.AuthConfig.CookieSecure)
		writeRouteError(w, r, errors.Internal("failed to generate csrf token").WithCause(err))
		return
	}

	setSessionCookie(w, h.AuthConfig.SessionCookieName, result.SessionKey, result.ExpiresAt, h.AuthConfig.CookieSecure)
	middleware.SetCSRFCookie(w, csrfToken, h.AuthConfig.CookieSecure, result.ExpiresAt)
	clearOAuthStateCookie(w, h.AuthConfig.CookieSecure)

	if h.AuditService != nil {
		h.AuditService.Log(r.Context(), services.AuditEvent{
			EventType:  "auth.login",
			ActorID:    &result.User.ID,
			ActorName:  result.User.Username,
			TargetType: "user",
			TargetID:   &result.User.ID,
			TargetName: result.User.Username,
			Action:     "login",
			IPAddress:  r.RemoteAddr,
			Metadata:   map[string]any{"method": "github"},
		})
	}

	redirectURL := result.RedirectURL
	if redirectURL == "" || redirectURL == "/" {
		redirectURL = h.githubBrowserOrigin() + "/"
	}
	if returnTo != "" {
		redirectURL = returnTo
	}

	// If the user was mid-way through an OAuth2 authorize flow (ticket 0106),
	// resume it by redirecting back to the stashed authorize URL instead of
	// the default post-login landing page. The cookie was set by
	// OAuth2Handler.startUpstreamIDPDetour; we clear it here so it can't
	// be replayed.
	if resumeURL := consumeOAuth2PendingAuthorizeCookie(w, r, h.AuthConfig.CookieSecure); resumeURL != "" {
		redirectURL = resumeURL
	}

	http.Redirect(w, r, redirectURL, http.StatusFound)
}

// GetAuth0Authorize starts the Auth0 OAuth flow. When callback_port is provided,
// the flow returns an API token to the local CLI callback server after completion.
func (h *AuthHandler) GetAuth0Authorize(w http.ResponseWriter, r *http.Request) {
	portStr := strings.TrimSpace(r.URL.Query().Get("callback_port"))
	if portStr != "" {
		port, err := strconv.Atoi(portStr)
		if err != nil || port < 1024 || port > 65535 {
			errors.WriteError(w, errors.BadRequest("callback_port must be a valid port (1024-65535)"))
			return
		}
	}

	stateVerifier, err := randomHex(16)
	if err != nil {
		writeRouteError(w, r, errors.Internal("failed to generate oauth state").WithCause(err))
		return
	}

	redirectURL, err := h.Service.StartAuth0OAuth(r.Context(), stateVerifier)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	expiry := time.Now().UTC().Add(10 * time.Minute)
	setOAuthStateCookie(w, stateVerifier, expiry, h.AuthConfig.CookieSecure)

	if portStr != "" {
		// Bind the CLI callback port to this flow's state verifier (see
		// GetGitHubOAuthCLIStart).
		setCLICallbackCookie(w, portStr, stateVerifier, expiry, h.AuthConfig.CookieSecure)
	} else {
		// Browser login: discard any stale CLI callback cookie so it cannot
		// hijack this flow's callback (see GetGitHubOAuthStart).
		clearCLICallbackCookie(w)
	}

	http.Redirect(w, r, redirectURL, http.StatusFound)
}

func (h *AuthHandler) GetAuth0Callback(w http.ResponseWriter, r *http.Request) {
	code := r.URL.Query().Get("code")
	state := r.URL.Query().Get("state")
	if strings.TrimSpace(code) == "" || strings.TrimSpace(state) == "" {
		errors.WriteError(w, errors.BadRequest("code and state are required"))
		return
	}

	stateVerifier := oauthStateVerifierFromRequest(r)
	result, err := h.Service.CompleteAuth0OAuth(r.Context(), code, state, stateVerifier)
	if err != nil {
		clearOAuthStateCookie(w, h.AuthConfig.CookieSecure)
		writeRouteError(w, r, err)
		return
	}

	// CLI login flow: only when the callback cookie is bound to the state
	// verifier that just completed this OAuth flow (see
	// GetGitHubOAuthCallback).
	if portStr, ok := cliCallbackPortFromRequest(r); ok {
		h.completeCLIOAuth(w, r, result, portStr)
		return
	}
	clearCLICallbackCookie(w)

	csrfToken, err := randomHex(32)
	if err != nil {
		clearOAuthStateCookie(w, h.AuthConfig.CookieSecure)
		writeRouteError(w, r, errors.Internal("failed to generate csrf token").WithCause(err))
		return
	}

	setSessionCookie(w, h.AuthConfig.SessionCookieName, result.SessionKey, result.ExpiresAt, h.AuthConfig.CookieSecure)
	middleware.SetCSRFCookie(w, csrfToken, h.AuthConfig.CookieSecure, result.ExpiresAt)
	clearOAuthStateCookie(w, h.AuthConfig.CookieSecure)

	if h.AuditService != nil {
		h.AuditService.Log(r.Context(), services.AuditEvent{
			EventType:  "auth.login",
			ActorID:    &result.User.ID,
			ActorName:  result.User.Username,
			TargetType: "user",
			TargetID:   &result.User.ID,
			TargetName: result.User.Username,
			Action:     "login",
			IPAddress:  r.RemoteAddr,
			Metadata:   map[string]any{"method": "auth0"},
		})
	}

	redirectTarget := result.RedirectURL
	if redirectTarget == "" || redirectTarget == "/" {
		redirectTarget = strings.TrimRight(strings.TrimSpace(h.PublicOrigin), "/") + "/"
	}

	// If the user was mid-way through an OAuth2 authorize flow (ticket 0106),
	// resume it by redirecting back to the stashed authorize URL instead of
	// the default post-login landing page. The cookie was set by
	// OAuth2Handler.startUpstreamIDPDetour; we clear it here so it can't
	// be replayed.
	if resumeURL := consumeOAuth2PendingAuthorizeCookie(w, r, h.AuthConfig.CookieSecure); resumeURL != "" {
		redirectTarget = resumeURL
	}

	http.Redirect(w, r, redirectTarget, http.StatusFound)
}

// completeCLIOAuth handles the OAuth callback for CLI logins. It creates an
// access token and redirects to the CLI's local HTTP server.
func (h *AuthHandler) completeCLIOAuth(w http.ResponseWriter, r *http.Request, result services.OAuthCallbackResult, portStr string) {
	// Clear both cookies.
	clearOAuthStateCookie(w, false)
	clearCLICallbackCookie(w)

	// Re-validate the CLI callback port from the (non-Secure, injectable)
	// cookie before building the redirect. The cookie is not Secure/signed, so
	// a value like "@evil.com" could otherwise steer the credential-bearing
	// redirect off loopback. Parsing to an int and range-checking, then
	// formatting with %d, structurally guarantees the loopback host.
	port, err := strconv.Atoi(strings.TrimSpace(portStr))
	if err != nil || port < 1024 || port > 65535 {
		writeRouteError(w, r, errors.BadRequest("invalid callback port"))
		return
	}

	// Create an access token for the CLI.
	tokenResult, err := h.Service.CreateToken(r.Context(), result.User.ID, services.CreateTokenRequest{
		Name:   "smithers-cli",
		Scopes: result.TokenScopes,
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	if h.AuditService != nil {
		h.AuditService.Log(r.Context(), services.AuditEvent{
			EventType:  "auth.login",
			ActorID:    &result.User.ID,
			ActorName:  result.User.Username,
			TargetType: "user",
			TargetID:   &result.User.ID,
			TargetName: result.User.Username,
			Action:     "login",
			IPAddress:  r.RemoteAddr,
			Metadata:   map[string]any{"method": "github-cli"},
		})
	}

	// Redirect to the CLI's local callback server with the token in the URL
	// fragment so intermediaries never log the credential-bearing value.
	callbackParams := url.Values{}
	callbackParams.Set("token", tokenResult.Token)
	callbackParams.Set("username", result.User.Username)
	if _, callbackState, ok := cliCallbackFromRequest(r); ok && callbackState != "" {
		callbackParams.Set("callback_state", callbackState)
	}
	if result.User.Email.Valid && strings.TrimSpace(result.User.Email.String) != "" {
		callbackParams.Set("email", strings.TrimSpace(result.User.Email.String))
	}
	if !result.ExpiresAt.IsZero() {
		callbackParams.Set("expires_at", result.ExpiresAt.UTC().Format(time.RFC3339))
	}
	callbackURL := fmt.Sprintf("http://127.0.0.1:%d/callback#%s", port, callbackParams.Encode())
	http.Redirect(w, r, callbackURL, http.StatusFound)
}

type postGitHubTokenExchangeRequest struct {
	GitHubAccessToken string `json:"github_access_token"`
	TokenName         string `json:"token_name"`
	// GitHubRefreshToken is the GitHub refresh token minted alongside the
	// access token during this login. Optional: when absent/empty the exchange
	// behaves exactly as before (any stored refresh token is preserved); when
	// present it is forwarded and persisted so the ~8h GitHub App access token
	// can later be refreshed instead of 401'ing (fixes multi sessions dying).
	GitHubRefreshToken string `json:"github_refresh_token,omitempty"`
	// GitHubTokenExpiresIn is GitHub's expires_in (seconds) for the access token
	// above. Optional and additive: when absent the credential is stored with a
	// NULL expiry and refreshes reactively on the first 401, exactly as before.
	// When present, the very first GitHub call after expiry is renewed
	// proactively instead of failing — which matters for callers that cannot
	// classify their own 401 (e.g. `git clone` carrying the token).
	GitHubTokenExpiresIn int64 `json:"github_token_expires_in,omitempty"`
	// TTLSeconds optionally bounds the minted token's lifetime (capped at 8
	// days server-side). multi-worker-prefixed token names self-expire after
	// 8 days even when this field is absent.
	TTLSeconds *int64 `json:"ttl_seconds"`
}

// PostGitHubTokenExchange lets a trusted first-party worker (authenticated via
// RequireSharedBearerToken) exchange a user's GitHub access token for a Plue
// personal access token. Identity is verified against the GitHub API inside
// the service; the caller's claims are never trusted directly.
func (h *AuthHandler) PostGitHubTokenExchange(w http.ResponseWriter, r *http.Request) {
	var req postGitHubTokenExchangeRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.GitHubAccessToken) == "" {
		errors.WriteError(w, errors.BadRequest("github_access_token is required"))
		return
	}

	result, err := h.Service.ExchangeGitHubToken(r.Context(), strings.TrimSpace(req.GitHubAccessToken), strings.TrimSpace(req.TokenName), strings.TrimSpace(req.GitHubRefreshToken), req.GitHubTokenExpiresIn, req.TTLSeconds)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	// Login is a free cache warm: refresh the user's GitHub repo listing in
	// the background so the first boot request is served hot.
	if h.RepoListingWarmer != nil {
		h.RepoListingWarmer.WarmGitHubRepoListing(result.User.ID)
	}

	if h.AuditService != nil {
		h.AuditService.Log(r.Context(), services.AuditEvent{
			EventType:  "auth.login",
			ActorID:    &result.User.ID,
			ActorName:  result.User.Username,
			TargetType: "user",
			TargetID:   &result.User.ID,
			TargetName: result.User.Username,
			Action:     "login",
			IPAddress:  r.RemoteAddr,
			Metadata:   map[string]any{"method": "worker-exchange"},
		})
	}

	response := map[string]any{
		"token":    result.Token,
		"token_id": result.TokenID,
		"user": map[string]any{
			"id":       result.User.ID,
			"username": result.User.Username,
		},
	}
	if result.ExpiresAt != nil {
		response["expires_at"] = result.ExpiresAt.UTC().Format(time.RFC3339)
	}
	errors.WriteJSON(w, http.StatusOK, response)
}

func (h *AuthHandler) PostLogout(w http.ResponseWriter, r *http.Request) {
	cookieName := sessionCookieName(h.AuthConfig.SessionCookieName)
	sessionCookie, cookieErr := r.Cookie(cookieName)

	// Clear the client credential first: a failed server-side revoke must not
	// leave the browser signed in. Session expiry removes an orphaned row.
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   h.AuthConfig.CookieSecure,
		SameSite: http.SameSiteLaxMode,
		Expires:  time.Unix(0, 0).UTC(),
		MaxAge:   -1,
	})
	clearCSRFCookie(w, h.AuthConfig.CookieSecure)

	if cookieErr == nil && sessionCookie.Value != "" {
		if err := h.Service.Logout(r.Context(), sessionCookie.Value); err != nil {
			writeRouteError(w, r, err)
			return
		}
	}

	if h.AuditService != nil {
		if user := middleware.UserFromContext(r.Context()); user != nil {
			h.AuditService.Log(r.Context(), services.AuditEvent{
				EventType:  "auth.logout",
				ActorID:    &user.ID,
				ActorName:  user.Username,
				TargetType: "user",
				TargetID:   &user.ID,
				TargetName: user.Username,
				Action:     "logout",
				IPAddress:  r.RemoteAddr,
			})
		}
	}

	w.WriteHeader(http.StatusNoContent)
}

func setSessionCookie(w http.ResponseWriter, configuredName, sessionKey string, expiresAt time.Time, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName(configuredName),
		Value:    sessionKey,
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		Expires:  expiresAt,
		MaxAge:   int(time.Until(expiresAt).Seconds()),
	})
}

func setOAuthStateCookie(w http.ResponseWriter, stateVerifier string, expiresAt time.Time, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     oauthStateCookieName,
		Value:    stateVerifier,
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		Expires:  expiresAt,
		MaxAge:   int(time.Until(expiresAt).Seconds()),
	})
}

func clearCSRFCookie(w http.ResponseWriter, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     middleware.CSRFCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: false,
		Secure:   secure,
		SameSite: http.SameSiteStrictMode,
		Expires:  time.Unix(0, 0).UTC(),
		MaxAge:   -1,
	})
}

func clearOAuthStateCookie(w http.ResponseWriter, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     oauthStateCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		Expires:  time.Unix(0, 0).UTC(),
		MaxAge:   -1,
	})
}

func oauthStateVerifierFromRequest(r *http.Request) string {
	cookie, err := r.Cookie(oauthStateCookieName)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(cookie.Value)
}

// setCLICallbackCookie stores the CLI's loopback callback port bound to the
// state verifier of the OAuth flow that requested it. The callback handler
// only honors the cookie when the bound verifier matches the flow that just
// completed, so a stale cookie from an abandoned CLI login cannot hijack a
// later browser login into minting a broad CLI token. This cookie belongs to
// the API origin and must honor its Secure setting, despite the loopback redirect.
func setCLICallbackCookie(w http.ResponseWriter, portStr, stateVerifier string, expiresAt time.Time, secure bool, callbackState ...string) {
	value := portStr + ":" + stateVerifier
	if len(callbackState) > 0 && callbackState[0] != "" {
		value += ":" + callbackState[0]
	}
	http.SetCookie(w, &http.Cookie{
		Name:     cliCallbackCookieName,
		Value:    value,
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		Expires:  expiresAt,
		MaxAge:   int(time.Until(expiresAt).Seconds()),
	})
}

func clearCLICallbackCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     cliCallbackCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   false,
		SameSite: http.SameSiteLaxMode,
		Expires:  time.Unix(0, 0).UTC(),
		MaxAge:   -1,
	})
}

// cliCallbackPortFromRequest returns the CLI callback port from the CLI
// callback cookie, but ONLY when the cookie is bound to the state verifier of
// the OAuth flow completing in this request. A cookie with a missing or
// mismatched verifier (e.g. left over from an earlier CLI login attempt) is
// reported as absent so the callback completes as a normal browser login.
func cliCallbackPortFromRequest(r *http.Request) (string, bool) {
	port, _, ok := cliCallbackFromRequest(r)
	return port, ok
}

func validCLICallbackState(value string) bool {
	if len(value) != 43 {
		return false
	}
	for _, char := range value {
		if !(char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || char == '-' || char == '_') {
			return false
		}
	}
	return true
}

// The native callback state is honored only with the same OAuth verifier as
// the port. Legacy CLI callers keep the original two-field cookie contract.
func cliCallbackFromRequest(r *http.Request) (string, string, bool) {
	cookie, err := r.Cookie(cliCallbackCookieName)
	if err != nil || cookie.Value == "" {
		return "", "", false
	}
	portStr, binding, found := strings.Cut(cookie.Value, ":")
	boundVerifier, callbackState, hasCallbackState := strings.Cut(binding, ":")
	if !found || portStr == "" || boundVerifier == "" {
		return "", "", false
	}
	if hasCallbackState && !validCLICallbackState(callbackState) {
		return "", "", false
	}
	stateVerifier := oauthStateVerifierFromRequest(r)
	if stateVerifier == "" ||
		subtle.ConstantTimeCompare([]byte(boundVerifier), []byte(stateVerifier)) != 1 {
		return "", "", false
	}
	return portStr, callbackState, true
}

func sessionCookieName(configuredName string) string {
	if strings.TrimSpace(configuredName) == "" {
		return "smithers_session"
	}
	return configuredName
}

// randomHex generates a cryptographically secure random hex string of bytesLen bytes.
// Returns an error if the system PRNG is unavailable - callers must not proceed with
// a predictable verifier as that would enable OAuth CSRF attacks.
func randomHex(bytesLen int) (string, error) {
	buf := make([]byte, bytesLen)
	if _, err := authRandomRead(buf); err != nil {
		return "", fmt.Errorf("randomHex: failed to read random bytes: %w", err)
	}
	return hex.EncodeToString(buf), nil
}

var authRandomRead = rand.Read

// isSafe5xxMessageCode recognizes the closed set of machine-readable error
// codes whose messages are deliberately written for clients. All other 5xx
// messages may contain raw provider, driver, or database details and remain
// sanitized.
func isSafe5xxMessageCode(code errors.Code) bool {
	switch code {
	case errors.CodeNoCapacity,
		// Its messages are written constants ("workspace guest is still
		// starting; retry shortly"); the client needs them to wait, not fail.
		errors.CodeGuestNotReady,
		errors.CodeEgressProxyUnavailable,
		errors.CodeSecretDeliveryUnavailable,
		// Its message is a written constant naming an environment variable and
		// nothing else. Scrubbed to "service unavailable" it says less than the
		// code does, and the one sentence the reader needs — that this is a
		// deployment nobody finished configuring, not their box — is the part
		// that gets thrown away.
		errors.CodeCodingGatewayNotConfigured,
		errors.CodeWorkerDraining:
		return true
	default:
		return false
	}
}

func writeRouteError(w http.ResponseWriter, r *http.Request, err error) {
	var apiErr *errors.APIError
	if stdErrors.As(err, &apiErr) {
		// Retry-After is errors.WriteError's job now, under this exact guard,
		// so the ~1200 handlers that call it directly pace their clients the
		// same way the routed ones do.
		//
		// A 5xx APIError carries its underlying error structurally, attached
		// with WithCause, and keeps Message a human sentence; older call
		// sites still embed raw driver text in Message
		// (Internal("...: "+err.Error())). Log the message, the code and the
		// cause server-side and return the generic status text unless the
		// code belongs to the closed safe-message set. Non-5xx APIErrors
		// (validation, 429, etc.) pass through unchanged.
		if apiErr.Status >= http.StatusInternalServerError {
			attrs := []any{"status", apiErr.Status, "code", apiErr.Code, "error", apiErr.Message}
			if cause := apiErr.Cause(); cause != nil {
				attrs = append(attrs, "cause", cause)
			}
			middleware.LoggerFromContext(r.Context()).Error("internal server error", attrs...)
			message := strings.ToLower(http.StatusText(apiErr.Status))
			if isSafe5xxMessageCode(apiErr.Code) {
				message = apiErr.Message
			}
			errors.WriteError(w, &errors.APIError{
				Status:  apiErr.Status,
				Message: message,
				// The machine-readable Code is a typed verdict (a constant,
				// never internal detail) — keep it so clients can branch on
				// e.g. github_pull_diff_too_large even when the message is
				// sanitized. Fault and RetryAfter are derived from the code,
				// so sanitizing the sentence must not drop them: without
				// RetryAfter here a full pool would answer 503 with no pacing
				// at all.
				Code:       apiErr.Code,
				Fault:      apiErr.Fault,
				RetryAfter: apiErr.RetryAfter,
			})
			return
		}
		errors.WriteError(w, apiErr)
		return
	}
	// Log the full error server-side before returning a sanitized response.
	middleware.LoggerFromContext(r.Context()).Error("internal server error", "error", err)
	errors.WriteError(w, errors.Internal("internal server error"))
}
