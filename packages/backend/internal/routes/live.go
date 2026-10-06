package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/coder/websocket"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// LiveHandler serves GET /api/live (spec §7.1): one WebSocket per browser
// tab on the install's effective origin, authenticated by the person's
// browser session and authorized by the install's one authorizer
// ("live"). Topics resolve through Topics for that person.
type LiveHandler struct {
	Hub     *live.Hub
	Queries *db.Queries
	// Origins are the install's public origins, read on every upgrade so an
	// origin added in Settings applies without a restart.
	Origins func() []string
	// Topics answers the request's topic resolver; repository is the
	// install's repository id, or 0 before setup binds one.
	Topics   func(r *http.Request) (resolve live.Resolver, repository int64)
	Presence func(r *http.Request, repository int64) live.PresenceSession
}

func liveRefusal(w http.ResponseWriter, status int, class, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"class": class, "code": code, "message": message})
}

func (h *LiveHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.Hub == nil || h.Queries == nil || h.Topics == nil || h.Origins == nil {
		liveRefusal(w, http.StatusServiceUnavailable, "infra", "live_unavailable", "Live updates are unavailable")
		return
	}
	origin, ok := middleware.ResolveEffectiveOrigin(r, h.Origins())
	if !ok {
		liveRefusal(w, http.StatusMisdirectedRequest, "user", "unknown_origin", "Unknown host")
		return
	}
	info := middleware.AuthInfoFromContext(r.Context())
	// Existing tokens are not live session credentials until T-ACC-04.
	if info == nil || info.User == nil || info.IsTokenAuth || info.IsAgent() {
		liveRefusal(w, http.StatusUnauthorized, "permission", "unauthenticated", middleware.UnauthenticatedMessage(r.Context()))
		return
	}
	// A cookie upgrade comes from the install's own page.
	if !middleware.SameOrigin(r.Header.Get("Origin"), origin) {
		liveRefusal(w, http.StatusForbidden, "permission", "forbidden", "request origin differs from install origin")
		return
	}
	if _, err := services.Authorize(r.Context(), h.Queries, "live"); err != nil {
		var access *services.AccessError
		if errors.As(err, &access) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(access.Status)
			_ = json.NewEncoder(w).Encode(access)
			return
		}
		liveRefusal(w, http.StatusServiceUnavailable, "infra", "live_unavailable", "Live updates are unavailable")
		return
	}
	supported := false
	for _, protocol := range strings.Split(r.Header.Get("Sec-WebSocket-Protocol"), ",") {
		supported = supported || strings.TrimSpace(protocol) == live.Protocol
	}
	if !supported {
		liveRefusal(w, http.StatusBadRequest, "user", "unsupported_protocol", "Expected "+live.Protocol)
		return
	}
	resolve, repository := h.Topics(r)
	// Revocation (a removed member, a signed-out session, a disabled
	// person) closes the socket (§5.6).
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	revoked := make(chan struct{})
	var events <-chan revocation.Event
	if source := currentRevocationSource(); source != nil {
		principal := requestPrincipal(r, revocation.Principal{RepositoryID: repository})
		if checker, ok := source.(revocation.Checker); ok {
			if _, denied := revocation.Revoked(checker, principal); denied {
				liveRefusal(w, http.StatusUnauthorized, "permission", "unauthenticated", "Sign in again") // a revoked credential is dead (§5.2.1a)
				return
			}
		}
		events = source.Watch(ctx, principal)
		// Register before a fresh roster read; ignore the middleware cached decision.
		role, err := services.InstallRoleOf(ctx, h.Queries, info.User.ID)
		if err != nil || role == "" {
			liveRefusal(w, http.StatusForbidden, "permission", "forbidden", "Not a member")
			return
		}
		if checker, ok := source.(revocation.Checker); ok {
			if _, denied := revocation.Revoked(checker, principal); denied {
				liveRefusal(w, http.StatusUnauthorized, "permission", "unauthenticated", "Sign in again")
				return
			}
		}
	}
	// The Origin was checked against the effective origin above, which a
	// loopback proxy's X-Forwarded-Host may name instead of Host.
	if events == nil {
		original := resolve
		resolve = func(ctx context.Context, topic string) (live.Source, string) {
			if strings.HasPrefix(topic, "branch:") {
				return live.Source{}, live.Unsupported
			}
			return original(ctx, topic)
		}
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{live.Protocol}, InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer conn.CloseNow()
	var presence live.PresenceSession
	if h.Presence != nil && events != nil {
		presence = h.Presence(r, repository)
	}

	if events != nil {
		go func() {
			select {
			case <-ctx.Done():
			case _, ok := <-events:
				if ok {
					close(revoked)
					if presence.Close != nil {
						presence.Close()
					}
					// Send the reason before canceling the reader: canceling
					// websocket.Read first forcibly closes the transport.
					_ = conn.Close(websocket.StatusPolicyViolation, "access revoked")
					cancel()
				}
			}
		}()
	}
	h.Hub.Serve(ctx, conn, resolve, presence)
	select {
	case <-revoked:
		_ = conn.Close(websocket.StatusPolicyViolation, "access revoked")
	default:
		_ = conn.Close(websocket.StatusNormalClosure, "")
	}
}
