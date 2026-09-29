package routes

import (
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// workspaceSocketPreflight is what a terminal or language-server WebSocket
// knows once every pre-upgrade check has passed. release returns the
// active-connection slot and must run on every exit path.
type workspaceSocketPreflight struct {
	user      *db.User
	repoCtx   *middleware.RepoContext
	sessionID string
	session   services.WorkspaceSessionResponse
	release   func()
}

// workspaceSocketGate describes how one socket kind differs in its preflight.
type workspaceSocketGate struct {
	// kind names the socket in logs: "terminal" or "lsp".
	kind       string
	revocation *workspaceSocketRevocation
	// observe records an attach outcome; nil records nothing.
	observe func(result string)
	// checkSession runs after the session loads and before its status gate.
	// It writes its own error and returns false to stop.
	checkSession func(w http.ResponseWriter, session services.WorkspaceSessionResponse) bool
	// capMessage is the 429 message when the per-user active cap is full.
	capMessage string
}

// preflightWorkspaceSocket runs the checks the terminal and LSP sockets share,
// in order: Origin (cookie and ticket principals), auth, repository, session
// lookup, the gate's own session check, session status (409 failed/stopped,
// 425 pending), then the per-user active-connection cap (429). The cap fires
// before any SSH work so a rejected client costs no sandbox capacity. On
// false the response has been written.
func (h *WorkspaceTerminalHandler) preflightWorkspaceSocket(w http.ResponseWriter, r *http.Request, gate workspaceSocketGate) (workspaceSocketPreflight, bool) {
	observe := gate.observe
	if observe == nil {
		observe = func(string) {}
	}

	authInfo := middleware.AuthInfoFromContext(r.Context())
	// Tickets are minted by browsers, including tickets minted from a token,
	// so they must retain the Origin allowlist check. A session cookie also
	// means the browser can authenticate the request without the bearer token.
	isTicketAuth := strings.TrimSpace(r.URL.Query().Get("ticket")) != ""
	if authInfo == nil || !authInfo.IsTokenAuth || h.hasSessionCookie(r) || isTicketAuth {
		origin := r.Header.Get("Origin")
		if !h.checkOrigin(origin, r) {
			slog.Warn("websocket origin rejected",
				"origin", origin,
				"remote_addr", r.RemoteAddr,
				"path", r.URL.Path,
			)
			if h.Metrics != nil {
				h.Metrics.IncWebSocketOriginRejection()
			}
			pkgerrors.WriteError(w, pkgerrors.Forbidden("origin not allowed"))
			return workspaceSocketPreflight{}, false
		}
	} else {
		slog.Debug("websocket origin check skipped for bearer-authenticated request",
			"remote_addr", r.RemoteAddr,
			"path", r.URL.Path,
		)
	}

	user, err := requireRouteUser(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return workspaceSocketPreflight{}, false
	}
	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return workspaceSocketPreflight{}, false
	}
	sessionID, err := routeParam(r, "id", "session id is required")
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return workspaceSocketPreflight{}, false
	}

	session, svcErr := h.Service.GetSession(r.Context(), sessionID, repoCtx.Repository.ID, user.ID)
	if gate.revocation != nil {
		gate.revocation.scope(session.WorkspaceID, "", false)
		if gate.revocation.reject(w) {
			return workspaceSocketPreflight{}, false
		}
	}
	if svcErr != nil {
		observe("session_error")
		writeRouteError(w, r, svcErr)
		return workspaceSocketPreflight{}, false
	}
	if gate.checkSession != nil && !gate.checkSession(w, session) {
		return workspaceSocketPreflight{}, false
	}
	switch strings.ToLower(strings.TrimSpace(session.Status)) {
	case "running":
	case "failed":
		observe("session_failed")
		pkgerrors.WriteError(w, pkgerrors.Conflict("workspace session provisioning failed; create a new session and retry"))
		return workspaceSocketPreflight{}, false
	case "stopped":
		observe("session_stopped")
		pkgerrors.WriteError(w, pkgerrors.Conflict("workspace session is stopped; create a new session and retry"))
		return workspaceSocketPreflight{}, false
	default:
		observe("session_pending")
		w.Header().Set("Retry-After", "2")
		pkgerrors.WriteError(w, &pkgerrors.APIError{
			Status:  http.StatusTooEarly,
			Code:    pkgerrors.CodeWorkspaceSessionPending,
			Message: "workspace session is still provisioning",
		})
		return workspaceSocketPreflight{}, false
	}

	// Ticket 0132: the active-connection cap. The open-rate limiter is a
	// separate middleware composed at route registration time.
	if h.ActiveConnections != nil && !h.ActiveConnections.Acquire(user.ID) {
		slog.Warn("workspace "+gate.kind+" active-connection cap exceeded",
			"scope", "workspace_terminal_active",
			"user_id", user.ID,
			"session_id", sessionID,
			"hit_type", "active_cap",
			"max", h.ActiveConnections.Max(),
		)
		observe("active_cap")
		limit := h.ActiveConnections.Max()
		remaining := 0
		w.Header().Set("Retry-After", "1")
		w.Header().Set("X-RateLimit-Limit", strconv.Itoa(limit))
		w.Header().Set("X-RateLimit-Remaining", strconv.Itoa(remaining))
		w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(time.Now().UTC().Add(time.Second).Unix(), 10))
		pkgerrors.WriteError(w, &pkgerrors.APIError{
			Status:    http.StatusTooManyRequests,
			Code:      pkgerrors.CodeRateLimitExceeded,
			Message:   gate.capMessage,
			Limit:     &limit,
			Remaining: &remaining,
		})
		return workspaceSocketPreflight{}, false
	}
	release := func() {}
	if h.ActiveConnections != nil {
		release = func() { h.ActiveConnections.Release(user.ID) }
	}
	return workspaceSocketPreflight{user: user, repoCtx: repoCtx, sessionID: sessionID, session: session, release: release}, true
}
