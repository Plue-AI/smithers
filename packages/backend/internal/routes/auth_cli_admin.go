package routes

import (
	"context"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"html/template"
	"net/http"
	"net/url"
	"time"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type adminCLILoginService interface {
	StartAdminCLILogin(context.Context, string, string, int, string, string) (string, error)
	PrepareAdminCLIConsent(context.Context, services.OAuthCallbackResult, string, string) (services.AdminCLIConsent, error)
	ApproveAdminCLILogin(context.Context, string, string, string, string) (services.AdminCLILoginResult, error)
}

var adminCLIConsentPage = template.Must(template.New("consent").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Smithers CLI admin consent</title></head>
<body><main><h1>Authorize Smithers CLI administrator access</h1>
<p>This token can read and change administrative resources.</p>
<ul>{{range .Scopes}}<li><code>{{.}}</code></li>{{end}}</ul>
<p>TTL: {{.TTL}}. Local callback port: {{.CallbackPort}}.</p>
<p>If approved now, the token expires at <time>{{.ExpiresAt.Format "2006-01-02T15:04:05Z07:00"}}</time>.
The lifetime starts when you approve; the CLI displays the final expiry time.</p>
<form method="post" action="/api/auth/github/cli/consent">
<input type="hidden" name="state" value="{{.State}}">
<input type="hidden" name="csrf_token" value="{{.CSRF}}">
<button type="submit" name="decision" value="approve">Approve administrator access</button>
</form><p><a href="/api/auth/github/cli/consent">Deny</a></p></main></body></html>`))

func adminCLIPageHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
	w.Header().Set("X-Frame-Options", "DENY")
}

func (h *AuthHandler) showAdminCLIConsent(w http.ResponseWriter, r *http.Request, result services.OAuthCallbackResult, state, verifier string) {
	svc, ok := h.Service.(adminCLILoginService)
	if !ok {
		writeRouteError(w, r, pkgerrors.Internal("admin CLI login unavailable"))
		return
	}
	consent, err := svc.PrepareAdminCLIConsent(r.Context(), result, state, verifier)
	if err != nil {
		clearOAuthStateCookie(w, middleware.CookieSecure(r, h.AuthConfig.CookieSecure))
		clearCLICallbackCookie(w)
		if apiErr, ok := err.(*pkgerrors.APIError); ok && apiErr.Status == http.StatusForbidden {
			adminCLIPageHeaders(w)
			w.WriteHeader(http.StatusForbidden)
			_, _ = fmt.Fprint(w, "<!doctype html><html lang=\"en\"><title>Administrator access required</title><h1>Administrator access required</h1><p>No CLI token was created.</p></html>")
			return
		}
		writeRouteError(w, r, err)
		return
	}
	clearCLICallbackCookie(w)
	// Renew the verifier cookie for the consent's ten-minute lifetime.
	setOAuthStateCookie(w, verifier, time.Now().UTC().Add(10*time.Minute), middleware.CookieSecure(r, h.AuthConfig.CookieSecure))
	adminCLIPageHeaders(w)
	_ = adminCLIConsentPage.Execute(w, consent)
}

// GetAdminCLIConsent denies the pending flow by removing its browser verifier.
// The unused durable consent record expires automatically after ten minutes.
func (h *AuthHandler) GetAdminCLIConsent(w http.ResponseWriter, r *http.Request) {
	clearOAuthStateCookie(w, middleware.CookieSecure(r, h.AuthConfig.CookieSecure))
	clearCLICallbackCookie(w)
	adminCLIPageHeaders(w)
	_, _ = fmt.Fprint(w, "<!doctype html><html lang=\"en\"><title>Login denied</title><h1>Admin CLI login denied</h1><p>No token was created. You can close this tab.</p></html>")
}

func (h *AuthHandler) PostAdminCLIConsent(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	r.Body = http.MaxBytesReader(w, r.Body, 8192)
	if err := r.ParseForm(); err != nil {
		writeRouteError(w, r, pkgerrors.BadRequest("invalid consent form"))
		return
	}
	if r.PostForm.Get("decision") != "approve" {
		writeRouteError(w, r, pkgerrors.BadRequest("approval is required"))
		return
	}
	svc, ok := h.Service.(adminCLILoginService)
	if !ok {
		writeRouteError(w, r, pkgerrors.Internal("admin CLI login unavailable"))
		return
	}
	result, err := svc.ApproveAdminCLILogin(r.Context(), r.PostForm.Get("state"), oauthStateVerifierFromRequest(r), r.PostForm.Get("csrf_token"), r.RemoteAddr)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	clearOAuthStateCookie(w, middleware.CookieSecure(r, h.AuthConfig.CookieSecure))
	clearCLICallbackCookie(w)
	params := url.Values{"token": {result.Token.Token}, "username": {result.User.Username}}
	if result.Token.ExpiresAt != nil {
		params.Set("expires_at", result.Token.ExpiresAt.UTC().Format(time.RFC3339))
	}
	if result.User.Email.Valid {
		params.Set("email", result.User.Email.String)
	}
	if result.Request.CallbackState != "" {
		params.Set("callback_state", result.Request.CallbackState)
	}
	http.Redirect(w, r, fmt.Sprintf("http://127.0.0.1:%d/callback#%s", result.Request.CallbackPort, params.Encode()), http.StatusFound)
}
