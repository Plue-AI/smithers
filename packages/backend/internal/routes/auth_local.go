package routes

import (
	"context"
	"net/http"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// LocalIdentityService is the local credential entry into the same
// AuthService that owns OAuth sessions and PATs. It is mounted only for the
// single-owner edition.
type LocalIdentityService interface {
	LocalIdentityStatus(context.Context) (services.LocalIdentityStatus, error)
	BootstrapLocalOwner(context.Context, services.LocalBootstrapRequest) (services.LocalLoginResult, error)
	LoginLocalOwner(context.Context, string, string) (services.LocalLoginResult, error)
	CreateLocalOwnerToken(context.Context, string, string, string, []string) (services.CreateTokenResult, db.User, error)
	ChangeLocalOwnerPassword(context.Context, int64, string, string) (services.LocalLoginResult, error)
}

type localCredentialRequest struct {
	Username string `json:"username"`
	Email    string `json:"email,omitempty"`
	Password string `json:"password"`
}

type localTokenRequest struct {
	Username string   `json:"username"`
	Password string   `json:"password"`
	Name     string   `json:"name,omitempty"`
	Scopes   []string `json:"scopes,omitempty"`
}

type localPasswordChangeRequest struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
}

func (h *AuthHandler) GetLocalIdentityStatus(w http.ResponseWriter, r *http.Request) {
	if h.LocalService == nil {
		pkgerrors.WriteError(w, pkgerrors.NotFound("local identity is not enabled"))
		return
	}
	status, err := h.LocalService.LocalIdentityStatus(r.Context())
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, status)
}

func (h *AuthHandler) PostLocalBootstrap(w http.ResponseWriter, r *http.Request) {
	if !h.requireTrustedOrigin(w, r) {
		return
	}
	var req localCredentialRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}
	result, err := h.LocalService.BootstrapLocalOwner(r.Context(), services.LocalBootstrapRequest{
		Username: req.Username, Email: req.Email, Password: req.Password,
		BootstrapToken: strings.TrimSpace(r.Header.Get("X-Smithers-Bootstrap-Token")),
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	h.completeLocalBrowserLogin(w, r, result, "bootstrap")
}

func (h *AuthHandler) PostLocalLogin(w http.ResponseWriter, r *http.Request) {
	if !h.requireTrustedOrigin(w, r) {
		return
	}
	var req localCredentialRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}
	result, err := h.LocalService.LoginLocalOwner(r.Context(), req.Username, req.Password)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	h.completeLocalBrowserLogin(w, r, result, "local")
}

// PostLocalToken is the native/CLI sign-in path. It never creates a browser
// session and the returned PAT uses the ordinary scoped-token store and
// revocation path.
func (h *AuthHandler) PostLocalToken(w http.ResponseWriter, r *http.Request) {
	if !h.requireTrustedOrigin(w, r) {
		return
	}
	var req localTokenRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}
	token, user, err := h.LocalService.CreateLocalOwnerToken(r.Context(), req.Username, req.Password, req.Name, req.Scopes)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	h.auditLocalLogin(r, user, "local-token")
	pkgerrors.WriteJSON(w, http.StatusOK, map[string]any{
		"token": token.Token, "token_id": token.ID, "expires_at": token.ExpiresAt,
		"user": map[string]any{"id": user.ID, "username": user.Username},
	})
}

func (h *AuthHandler) PostLocalPassword(w http.ResponseWriter, r *http.Request) {
	if !h.requireTrustedOrigin(w, r) {
		return
	}
	authInfo := middleware.AuthInfoFromContext(r.Context())
	if authInfo == nil || authInfo.User == nil {
		pkgerrors.WriteError(w, pkgerrors.Unauthorized("authentication required"))
		return
	}
	// Password rotation reissues browser cookies and is intentionally limited
	// to an interactive browser session. PATs remain independently revocable
	// credentials and cannot be traded for a session or CSRF cookie here.
	if authInfo.IsTokenAuth {
		pkgerrors.WriteError(w, pkgerrors.Forbidden("a browser session is required to change the owner password"))
		return
	}
	var req localPasswordChangeRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}
	result, err := h.LocalService.ChangeLocalOwnerPassword(r.Context(), authInfo.User.ID, req.CurrentPassword, req.NewPassword)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	h.completeLocalBrowserLogin(w, r, result, "password-change")
}

func (h *AuthHandler) completeLocalBrowserLogin(w http.ResponseWriter, r *http.Request, result services.LocalLoginResult, method string) {
	csrfToken, err := randomHex(32)
	if err != nil {
		writeRouteError(w, r, pkgerrors.Internal("failed to generate csrf token").WithCause(err))
		return
	}
	setSessionCookie(w, h.AuthConfig.SessionCookieName, result.SessionKey, result.ExpiresAt, middleware.CookieSecure(r, h.AuthConfig.CookieSecure))
	middleware.SetCSRFCookie(w, csrfToken, middleware.CookieSecure(r, h.AuthConfig.CookieSecure), result.ExpiresAt, r)
	h.auditLocalLogin(r, result.User, method)
	pkgerrors.WriteJSON(w, http.StatusOK, map[string]any{
		"user": map[string]any{"id": result.User.ID, "username": result.User.Username},
	})
}

func (h *AuthHandler) auditLocalLogin(r *http.Request, user db.User, method string) {
	if h.AuditService == nil {
		return
	}
	h.AuditService.Log(r.Context(), services.AuditEvent{
		EventType: "auth.login", ActorID: &user.ID, ActorName: user.Username,
		TargetType: "user", TargetID: &user.ID, TargetName: user.Username,
		Action: "login", IPAddress: r.RemoteAddr, Metadata: map[string]any{"method": method},
	})
}

func (h *AuthHandler) requireTrustedOrigin(w http.ResponseWriter, r *http.Request) bool {
	if effective := middleware.EffectiveOrigin(r.Context()); effective != "" {
		if origin := r.Header.Get("Origin"); origin != "" && origin != effective {
			pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeOrigin, "request origin differs from install origin"))
			return false
		}
		return true
	}
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		// Native backend bridges and CLI clients do not send Origin. A browser
		// claiming a cross-site fetch without Origin is never trusted.
		if strings.EqualFold(strings.TrimSpace(r.Header.Get("Sec-Fetch-Site")), "cross-site") {
			pkgerrors.WriteError(w, pkgerrors.Forbidden("cross-site authentication is not allowed"))
			return false
		}
		return true
	}
	got, err := canonicalAuthOrigin(origin)
	if err != nil {
		pkgerrors.WriteError(w, pkgerrors.Forbidden("request origin is not allowed"))
		return false
	}
	for _, allowed := range h.AllowedOrigins {
		want, allowedErr := canonicalAuthOrigin(allowed)
		if allowedErr == nil && strings.EqualFold(want, got) {
			return true
		}
	}
	pkgerrors.WriteError(w, pkgerrors.Forbidden("request origin is not allowed"))
	return false
}

func canonicalAuthOrigin(raw string) (string, error) {
	origin, err := config.CanonicalOrigin(raw)
	if err != nil {
		return "", pkgerrors.Forbidden("request origin is not allowed")
	}
	return origin, nil
}
