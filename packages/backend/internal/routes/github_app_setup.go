package routes

import (
	"context"
	"crypto/subtle"
	"errors"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"io"
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
	Setup          *services.InstallSetupService
	Sessions       InstallSetupSessionAuthority
	Service        GitHubAppSetupService
	Store          GitHubAppSetupCredentials
	Owners         GitHubAppSetupOwners
	AllowedOrigins []string
}

// authorize requires the live durable setup session before claim and the
// owner browser session afterwards, on every listener.
func (h *GitHubAppSetupHandler) authorize(w http.ResponseWriter, r *http.Request) bool {
	if h == nil || h.Owners == nil {
		writeInstallAPIError(w, pkgerrors.Internal("install setup is unavailable"))
		return false
	}
	owner, err := h.Owners.GetSelfHostOwner(r.Context())
	if errors.Is(err, pgx.ErrNoRows) {
		if h.Sessions == nil {
			writeInstallAPIError(w, pkgerrors.Internal("setup session authority unavailable"))
			return false
		}
		cookie, err := r.Cookie(GitHubAppSetupSessionCookie)
		if err != nil {
			writeInstallAPIError(w, pkgerrors.New(pkgerrors.CodeUnauthenticated, "setup session required"))
			return false
		}
		if err := h.Sessions.Validate(r.Context(), cookie.Value); err != nil {
			WriteInstallSetupError(w, r, err)
			return false
		}

		return true
	}
	if err != nil {
		WriteInstallSetupError(w, r, pkgerrors.Internal("failed to read install owner").WithCause(err))
		return false
	}
	info := middleware.AuthInfoFromContext(r.Context())
	if cookie, err := r.Cookie(GitHubAppSetupSessionCookie); err == nil && (info == nil || info.User == nil) {
		if h.Sessions != nil {
			if err := h.Sessions.Validate(r.Context(), cookie.Value); err != nil {
				WriteInstallSetupError(w, r, err)
				return false
			}
		}
		writeInstallAPIError(w, pkgerrors.New(pkgerrors.CodeSetupClosed, "setup_closed"))
		return false
	}
	if info == nil || info.User == nil {
		writeInstallAPIError(w, pkgerrors.New(pkgerrors.CodeUnauthenticated, "owner session required"))
		return false
	}
	if info.User.ID != owner.ID || info.IsTokenAuth || info.IsAgent() || info.SessionHash == "" {
		writeInstallAPIError(w, pkgerrors.Forbidden("install owner session required"))
		return false
	}
	return true
}
func (h *GitHubAppSetupHandler) requestOrigin(r *http.Request) (string, bool) {
	origin, ok := middleware.ResolveEffectiveOrigin(r, h.AllowedOrigins)
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
		writeInstallAPIError(w, pkgerrors.Internal("setup session authority unavailable"))
		return
	}
	session, err := h.Sessions.Exchange(r.Context(), r.URL.Query().Get("token"))
	if err != nil {
		WriteInstallSetupError(w, r, err)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: GitHubAppSetupSessionCookie, Value: session, Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: strings.HasPrefix(origin, "https://"), MaxAge: 86400})
	token, err := middleware.NewCSRFToken()
	if err != nil {
		WriteInstallSetupError(w, r, err)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: middleware.CSRFCookieName, Value: token, Path: "/", SameSite: http.SameSiteLaxMode, Secure: strings.HasPrefix(origin, "https://"), MaxAge: 86400})
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func writeGitHubAppOriginError(w http.ResponseWriter, origin string) {
	if origin != "" {
		writeInstallAPIError(w, pkgerrors.Forbidden("request origin differs from install origin"))
		return
	}
	writeInstallAPIError(w, pkgerrors.New(pkgerrors.CodeUnknownOrigin, "install origin is not configured"))
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
	if h.Setup != nil {
		status, err := h.Setup.Status(r.Context())
		if err != nil {
			WriteInstallSetupError(w, r, err)
			return
		}
		pkgerrors.WriteJSON(w, http.StatusOK, status)
		return
	}
	if h.Store == nil {
		writeInstallAPIError(w, pkgerrors.Internal("GitHub App credential store is unavailable"))
		return
	}
	credentials, err := h.Store.Load(r.Context())
	if errors.Is(err, services.ErrGitHubAppNotConfigured) {
		pkgerrors.WriteJSON(w, http.StatusOK, map[string]any{"github_app": map[string]any{"configured": false, "installed": false}})
		return
	}
	if err != nil {
		WriteInstallSetupError(w, r, err)
		return
	}
	installURL, err := h.Store.InstallURL(r.Context())
	if err != nil {
		WriteInstallSetupError(w, r, err)
		return
	}
	callbackURLs, err := h.Store.CallbackURLs(r.Context())
	if err != nil {
		WriteInstallSetupError(w, r, err)
		return
	}
	callbackFixes, err := h.Store.CallbackFixes(r.Context(), h.AllowedOrigins)
	if err != nil {
		WriteInstallSetupError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, map[string]any{"github_app": map[string]any{"configured": true, "installed": credentials.InstallationID > 0, "slug": credentials.Slug, "installation_id": credentials.InstallationID, "install_url": installURL, "callback_urls": callbackURLs, "callback_fixes": callbackFixes}})
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
		writeInstallAPIError(w, pkgerrors.Forbidden("setup origin and CSRF token required"))
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 16<<10))
	if err != nil {
		writeInstallAPIError(w, pkgerrors.BadRequest("invalid setup body"))
		return
	}
	input, err := services.ValidateInstallSetupBody("app_manifest", raw)
	if err != nil {
		WriteInstallSetupError(w, r, err)
		return
	}
	if h.Setup != nil {
		steps, err := h.Setup.Steps(r.Context())
		if err != nil {
			WriteInstallSetupError(w, r, err)
			return
		}
		if steps[0].Status != services.InstallReady {
			writeInstallAPIError(w, pkgerrors.Conflict("Confirm Address first"))
			return
		}
	}
	req := services.GitHubAppManifestRequest{OwnerLogin: input.Owner}
	req.Origin = origin
	if h.Service == nil {
		writeInstallAPIError(w, pkgerrors.Internal("GitHub App setup is unavailable"))
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
		WriteInstallSetupError(w, r, err)
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
		writeInstallAPIError(w, pkgerrors.Forbidden("setup session required"))
		return "", "", false
	}
	*r = *r.WithContext(services.WithGitHubAppSetupSession(r.Context(), session.Value, origin))
	cookie, err := r.Cookie(GitHubAppStateCookie)
	state := r.URL.Query().Get("state")
	if err != nil || cookie.Value == "" || state == "" || subtle.ConstantTimeCompare([]byte(cookie.Value), []byte(state)) != 1 {
		writeInstallAPIError(w, pkgerrors.Forbidden("invalid GitHub App setup state"))
		return "", "", false
	}
	if h.Service == nil {
		writeInstallAPIError(w, pkgerrors.Internal("GitHub App setup is unavailable"))
		return "", "", false
	}
	if err := h.Service.ValidateCallbackOrigin(r.Context(), state, origin); err != nil {
		WriteInstallSetupError(w, r, err)
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
		WriteInstallSetupError(w, r, err)
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
		writeInstallAPIError(w, pkgerrors.Internal("installation resume unavailable"))
		return
	}
	if err := h.Service.ResumeInstallation(r.Context()); err != nil {
		WriteInstallSetupError(w, r, err)
		return
	}
	origin, _ := h.requestOrigin(r)
	http.SetCookie(w, &http.Cookie{Name: GitHubAppStateCookie, Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: strings.HasPrefix(origin, "https://")})
	installed := true
	if h.Setup != nil {
		credentials, err := h.Store.Load(r.Context())
		if err != nil {
			WriteInstallSetupError(w, r, err)
			return
		}
		installed = credentials.InstallationID > 0
	}
	pkgerrors.WriteJSON(w, http.StatusOK, map[string]bool{"installed": installed})
}

// Step admits slow setup work and returns before any provider executes.
func (h *GitHubAppSetupHandler) Step(w http.ResponseWriter, r *http.Request) {
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
		writeInstallAPIError(w, pkgerrors.Forbidden("setup origin and CSRF token required"))
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/install/setup/")
	if id == "app" {
		h.Begin(w, r)
		return
	}
	if id != "address" && id != "sign_in" {
		info := middleware.AuthInfoFromContext(r.Context())
		if info == nil || info.User == nil || info.SessionHash == "" || info.IsTokenAuth || info.IsAgent() {
			writeInstallAPIError(w, pkgerrors.Forbidden("install owner session required"))
			return
		}
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 16<<10))
	if err != nil {
		writeInstallAPIError(w, pkgerrors.BadRequest("invalid setup body"))
		return
	}
	if _, err = services.ValidateInstallSetupBody(id, raw); err != nil {
		WriteInstallSetupError(w, r, err)
		return
	}
	if h.Setup == nil {
		writeInstallAPIError(w, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "install setup unavailable"))
		return
	}
	receipt, err := h.Setup.Admit(r.Context(), id, r.Header.Get("Idempotency-Key"), raw)
	if err != nil {
		WriteInstallSetupError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusAccepted, receipt)
}

func (h *GitHubAppSetupHandler) SetCapacity(w http.ResponseWriter, r *http.Request) {
	origin, ok := h.requestOrigin(r)
	if !ok {
		writeGitHubAppOriginError(w, origin)
		return
	}
	if !h.authorize(w, r) {
		return
	}
	info := middleware.AuthInfoFromContext(r.Context())
	if info == nil || info.User == nil {
		writeInstallAPIError(w, pkgerrors.Forbidden("install owner session required"))
		return
	}
	csrf, err := r.Cookie(middleware.CSRFCookieName)
	if r.Header.Get("Origin") != origin || err != nil || csrf.Value == "" || subtle.ConstantTimeCompare([]byte(csrf.Value), []byte(r.Header.Get("X-CSRF-Token"))) != 1 {
		writeInstallAPIError(w, pkgerrors.Forbidden("setup origin and CSRF token required"))
		return
	}
	var input struct {
		Capacity *int `json:"capacity"`
	}
	if !decodeStrictJSONBody(w, r, &input) {
		return
	}
	if input.Capacity == nil {
		writeInstallAPIError(w, pkgerrors.BadRequest("capacity required"))
		return
	}
	if h.Setup == nil || h.Setup.Capacity == nil {
		writeInstallAPIError(w, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "install capacity unavailable"))
		return
	}
	if err = h.Setup.Capacity.Set(r.Context(), info.User.ID, *input.Capacity); err != nil {
		var capacity *microsandbox.CapacityError
		if errors.As(err, &capacity) {
			pkgerrors.WriteJSON(w, http.StatusUnprocessableEntity, capacity)
		} else {
			writeInstallAPIError(w, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "install capacity unavailable"))
		}
		return
	}
	h.Status(w, r)
}

// WriteInstallSetupError is the install boundary's §6.2.3 envelope. Existing
// hosted API fault envelopes remain unchanged.
func WriteInstallSetupError(w http.ResponseWriter, r *http.Request, err error) {
	var api *pkgerrors.APIError
	if errors.As(err, &api) {
		writeInstallAPIError(w, api)
		return
	}
	var readiness *services.InstallReadinessError
	if errors.As(err, &readiness) {
		status := http.StatusServiceUnavailable
		if readiness.Class == "user" {
			status = http.StatusBadRequest
		}
		pkgerrors.WriteJSON(w, status, readiness)
		return
	}
	writeInstallAPIError(w, pkgerrors.Internal("install setup unavailable"))
}
func writeInstallAPIError(w http.ResponseWriter, err *pkgerrors.APIError) {
	code, class, message := string(err.Code), "user", err.Message
	switch err.Status {
	case http.StatusUnauthorized:
		class = "permission"
		if code != "setup_closed" {
			code = "unauthenticated"
		}
	case http.StatusForbidden:
		code, class = "permission", "permission"
	case http.StatusConflict:
		class = "conflict"
	default:
		if err.Status >= 500 {
			class = "infra"
			message = "Install setup unavailable"
		}
	}
	pkgerrors.WriteJSON(w, err.Status, &services.InstallReadinessError{Code: code, Class: class, Message: message})
}
