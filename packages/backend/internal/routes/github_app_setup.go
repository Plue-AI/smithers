package routes

import (
	"context"
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

const GitHubAppSetupSessionCookie = "smithers_setup_session"
const GitHubAppStateCookie = "smithers_github_app_state"

type GitHubAppSetupService interface {
	Begin(context.Context, services.GitHubAppManifestRequest) (services.GitHubAppManifestStart, error)
	ValidateCallbackOrigin(context.Context, string, string) error
	Convert(context.Context, string, string, string) (string, error)
	ResumeInstallation(context.Context) error
}
type GitHubAppSetupOwners interface {
	GetSelfHostOwner(context.Context) (db.User, error)
}
type GitHubAppSetupCredentials interface {
	Load(context.Context) (services.GitHubAppCredentials, error)
	InstallURL(context.Context) (string, error)
	CallbackURLs(context.Context) ([]string, error)
	CallbackFixes(context.Context, []string) ([]services.GitHubAppCallbackFix, error)
}
type InstallSetupSessionAuthority interface {
	Exchange(context.Context, string) (string, error)
	Validate(context.Context, string) error
}

type GitHubAppSetupHandler struct {
	Sessions       InstallSetupSessionAuthority
	Service        GitHubAppSetupService
	Store          GitHubAppSetupCredentials
	Owners         GitHubAppSetupOwners
	AllowedOrigins []string
	Serving        *services.InstallServing
}

// authorize requires the live durable setup session before claim and the
// owner browser session afterwards, on every listener.
func (h *GitHubAppSetupHandler) authorize(w http.ResponseWriter, r *http.Request) bool {
	if h == nil || h.Owners == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("install setup is unavailable"))
		return false
	}
	owner, err := h.Owners.GetSelfHostOwner(r.Context())
	if errors.Is(err, pgx.ErrNoRows) {
		if h.Sessions == nil {
			pkgerrors.WriteError(w, pkgerrors.Internal("setup session authority unavailable"))
			return false
		}
		cookie, err := r.Cookie(GitHubAppSetupSessionCookie)
		if err != nil {
			pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeUnauthenticated, "setup session required"))
			return false
		}
		if err := h.Sessions.Validate(r.Context(), cookie.Value); err != nil {
			writeRouteError(w, r, err)
			return false
		}

		return true
	}
	if err != nil {
		writeRouteError(w, r, pkgerrors.Internal("failed to read install owner").WithCause(err))
		return false
	}
	info := middleware.AuthInfoFromContext(r.Context())
	if cookie, err := r.Cookie(GitHubAppSetupSessionCookie); err == nil && (info == nil || info.User == nil) {
		if h.Sessions != nil {
			if err := h.Sessions.Validate(r.Context(), cookie.Value); err != nil {
				writeRouteError(w, r, err)
				return false
			}
		}
		pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeSetupClosed, "setup_closed"))
		return false
	}
	if info == nil || info.User == nil || info.User.ID != owner.ID || info.IsTokenAuth || info.IsAgent() || info.SessionHash == "" {
		pkgerrors.WriteError(w, pkgerrors.Forbidden("install owner session required"))
		return false
	}
	return true
}
func (h *GitHubAppSetupHandler) requestOrigin(r *http.Request) (string, bool) {
	origin := middleware.EffectiveOrigin(r.Context())
	ok := origin != ""
	if !ok {
		origin, ok = middleware.ResolveEffectiveOrigin(r, h.AllowedOrigins)
	}
	if ok && r.Header.Get("Origin") != "" && r.Header.Get("Origin") != origin {
		return origin, false
	}
	return origin, ok
}

// OpenSetup exchanges the terminal token for the shared durable session before
// any setup step. Redirect removes the token from the address and referrer.
func (h *GitHubAppSetupHandler) OpenSetup(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	origin, ok := h.requestOrigin(r)
	if !ok {
		writeGitHubAppOriginError(w, origin)
		return
	}
	if h.Sessions == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("setup session authority unavailable"))
		return
	}
	session, err := h.Sessions.Exchange(r.Context(), r.URL.Query().Get("token"))
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: GitHubAppSetupSessionCookie, Value: session, Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: strings.HasPrefix(origin, "https://"), MaxAge: 86400})
	token, err := middleware.NewCSRFToken()
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: middleware.CSRFCookieName, Value: token, Path: "/", SameSite: http.SameSiteLaxMode, Secure: strings.HasPrefix(origin, "https://"), MaxAge: 86400})
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func writeGitHubAppOriginError(w http.ResponseWriter, origin string) {
	if origin != "" {
		pkgerrors.WriteError(w, pkgerrors.Forbidden("request origin differs from install origin"))
		return
	}
	pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeUnknownOrigin, "install origin is not configured"))
}

func (h *GitHubAppSetupHandler) Status(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if origin, ok := h.requestOrigin(r); !ok {
		writeGitHubAppOriginError(w, origin)
		return
	}
	if !h.authorize(w, r) {
		return
	}
	address, err := h.address(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	if h.Store == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("GitHub App credential store is unavailable"))
		return
	}
	credentials, err := h.Store.Load(r.Context())
	if errors.Is(err, services.ErrGitHubAppNotConfigured) {
		pkgerrors.WriteJSON(w, http.StatusOK, map[string]any{"address": address, "ssh_line": address.SSHLine("<branch>"), "github_app": map[string]any{"configured": false, "installed": false}})
		return
	}
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	installURL, err := h.Store.InstallURL(r.Context())
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	callbackURLs, err := h.Store.CallbackURLs(r.Context())
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	callbackFixes, err := h.Store.CallbackFixes(r.Context(), address.Origins)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, map[string]any{"address": address, "ssh_line": address.SSHLine("<branch>"), "github_app": map[string]any{"configured": true, "installed": credentials.InstallationID > 0, "slug": credentials.Slug, "installation_id": credentials.InstallationID, "install_url": installURL, "callback_urls": callbackURLs, "callback_fixes": callbackFixes}})
}
func (h *GitHubAppSetupHandler) Begin(w http.ResponseWriter, r *http.Request) {
	origin, ok := h.requestOrigin(r)
	if !ok {
		writeGitHubAppOriginError(w, origin)
		return
	}
	if !h.authorize(w, r) {
		return
	}
	csrf, err := r.Cookie(middleware.CSRFCookieName)
	if r.Header.Get("Origin") != origin || err != nil || csrf.Value == "" || subtle.ConstantTimeCompare([]byte(csrf.Value), []byte(r.Header.Get("X-CSRF-Token"))) != 1 {
		pkgerrors.WriteError(w, pkgerrors.Forbidden("setup origin and CSRF token required"))
		return
	}
	var req services.GitHubAppManifestRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}
	req.Origin = origin
	address, err := h.address(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	req.Origins = address.Origins
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("GitHub App setup is unavailable"))
		return
	}
	session := ""
	if cookie, err := r.Cookie(GitHubAppSetupSessionCookie); err == nil {
		session = cookie.Value
	} else if info := middleware.AuthInfoFromContext(r.Context()); info != nil {
		session = info.SessionHash
	}
	ctx := services.WithGitHubAppSetupSession(r.Context(), session, origin)
	start, err := h.Service.Begin(ctx, req)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	if start.State != "" {
		http.SetCookie(w, &http.Cookie{Name: GitHubAppStateCookie, Value: start.State, Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: strings.HasPrefix(origin, "https://"), MaxAge: 600, Expires: time.Now().Add(10 * time.Minute)})
	}
	w.Header().Set("Cache-Control", "no-store")
	pkgerrors.WriteJSON(w, http.StatusOK, start)
}
func (h *GitHubAppSetupHandler) callbackState(w http.ResponseWriter, r *http.Request) (string, string, bool) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	origin, originAllowed := h.requestOrigin(r)
	if !originAllowed {
		writeGitHubAppOriginError(w, origin)
		return "", "", false
	}
	if !h.authorize(w, r) {
		return "", "", false
	}
	session, sessionErr := r.Cookie(GitHubAppSetupSessionCookie)
	if sessionErr != nil || len(session.Value) != 64 {
		pkgerrors.WriteError(w, pkgerrors.Forbidden("setup session required"))
		return "", "", false
	}
	*r = *r.WithContext(services.WithGitHubAppSetupSession(r.Context(), session.Value, origin))
	cookie, err := r.Cookie(GitHubAppStateCookie)
	state := r.URL.Query().Get("state")
	if err != nil || cookie.Value == "" || state == "" || subtle.ConstantTimeCompare([]byte(cookie.Value), []byte(state)) != 1 {
		pkgerrors.WriteError(w, pkgerrors.Forbidden("invalid GitHub App setup state"))
		return "", "", false
	}
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("GitHub App setup is unavailable"))
		return "", "", false
	}
	if err := h.Service.ValidateCallbackOrigin(r.Context(), state, origin); err != nil {
		writeRouteError(w, r, err)
		return "", "", false
	}
	return state, cookie.Value, true
}
func (h *GitHubAppSetupHandler) Callback(w http.ResponseWriter, r *http.Request) {
	state, browser, ok := h.callbackState(w, r)
	if !ok {
		return
	}
	target, err := h.Service.Convert(r.Context(), r.URL.Query().Get("code"), state, browser)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	http.Redirect(w, r, target, http.StatusSeeOther)
}
func (h *GitHubAppSetupHandler) Installed(w http.ResponseWriter, r *http.Request) {
	if origin, ok := h.requestOrigin(r); !ok {
		writeGitHubAppOriginError(w, origin)
		return
	}
	if !h.authorize(w, r) {
		return
	}
	if h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("installation resume unavailable"))
		return
	}
	if err := h.Service.ResumeInstallation(r.Context()); err != nil {
		writeRouteError(w, r, err)
		return
	}
	origin, _ := h.requestOrigin(r)
	http.SetCookie(w, &http.Cookie{Name: GitHubAppStateCookie, Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: strings.HasPrefix(origin, "https://")})
	pkgerrors.WriteJSON(w, http.StatusOK, map[string]bool{"installed": true})
}

func (h *GitHubAppSetupHandler) address(r *http.Request) (services.InstallAddress, error) {
	if h.Serving != nil {
		return h.Serving.Read(r.Context())
	}
	// The existing loopback path stays available before providers land.
	public := []string{}
	for _, origin := range h.AllowedOrigins {
		if origin != "http://localhost:4000" && origin != "http://127.0.0.1:4000" && origin != "http://[::1]:4000" {
			public = append(public, origin)
		}
	}
	return services.NewInstallAddress("", public)
}

// PutSettings permits only the live owner browser session, never setup or
// delegated credentials. Missing parallel providers refuse before effects.
func (h *GitHubAppSetupHandler) PutSettings(w http.ResponseWriter, r *http.Request) {
	if h.Owners == nil {
		pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "owner authority unavailable"))
		return
	}
	owner, err := h.Owners.GetSelfHostOwner(r.Context())
	info := middleware.AuthInfoFromContext(r.Context())
	if err != nil || info == nil || info.User == nil || info.User.ID != owner.ID || info.IsTokenAuth || info.IsAgent() || info.SessionHash == "" {
		pkgerrors.WriteError(w, pkgerrors.Forbidden("install owner session required"))
		return
	}
	origin, ok := h.requestOrigin(r)
	if !ok {
		writeGitHubAppOriginError(w, origin)
		return
	}
	if r.Header.Get("Origin") != origin {
		pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeOrigin, "request origin required"))
		return
	}
	csrf, err := r.Cookie(middleware.CSRFCookieName)
	if err != nil || csrf.Value == "" || subtle.ConstantTimeCompare([]byte(csrf.Value), []byte(r.Header.Get("X-CSRF-Token"))) != 1 {
		pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeCSRF, "CSRF token required"))
		return
	}
	var req struct {
		Address services.InstallAddress `json:"address"`
	}
	if !decodeJSONBody(w, r, &req) {
		return
	}
	address, err := services.NewInstallAddress(req.Address.Bind, req.Address.Origins)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	if h.Serving == nil {
		pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "install serving providers unavailable"))
		return
	}
	if err = h.Serving.Set(r.Context(), address); err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, map[string]any{"address": address})
}
