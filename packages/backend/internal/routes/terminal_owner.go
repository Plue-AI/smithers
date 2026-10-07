package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// OwnerTerminalProvider resolves branch.join and owner identity from server
// state. Open must admit a person and use only the owner-uid daemon session.
type OwnerTerminalProvider interface {
	Authorize(context.Context, string, int64) (revocation.Principal, error)
	Open(context.Context, string, revocation.Principal) (workspaceapi.Terminal, error)
	Ready(context.Context, revocation.Principal) error
}

func terminalUnavailable(w http.ResponseWriter) {
	terminalError(w, http.StatusServiceUnavailable, "terminal_unavailable", "infra", "Terminal is unavailable")
}
func terminalError(w http.ResponseWriter, status int, code, class, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"code": code, "class": class, "message": message})
}

type BranchTerminalService interface {
	BranchTerminalAvailable() bool
	OpenBranchTerminal(context.Context, string, int64, int64, string) (services.WorkspaceSessionResponse, error)
}

func (h *WorkspaceTerminalHandler) OpenTerminal(w http.ResponseWriter, r *http.Request) {
	svc, ok := h.Service.(BranchTerminalService)
	if !ok || h.AuthorizeTerminal == nil || !svc.BranchTerminalAvailable() || (h.OwnerOnly && (h.OwnerTerminals == nil || currentRevocationSource() == nil)) {
		terminalUnavailable(w)
		return
	}
	if ready, ok := h.OwnerTerminals.(interface{ Available() bool }); ok && !ready.Available() {
		terminalUnavailable(w)
		return
	}
	repository, member, err := h.AuthorizeTerminal(r, "box.terminal")
	if err != nil {
		writeBranchError(w, r, err)
		return
	}
	var body struct {
		Branch string `json:"branch"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if err = decodeSingleJSONDocument(decoder, &body); err != nil || body.Branch == "" {
		terminalError(w, 400, "invalid_request", "user", "Invalid terminal request")
		return
	}
	session, err := svc.OpenBranchTerminal(r.Context(), body.Branch, repository, member, r.Header.Get("Idempotency-Key"))
	if err != nil {
		writeBranchError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(session)
}

// S2 reuses the existing terminal socket and manager ring. Watchers attach to
// an existing session; attachment can never spawn or take ownership of a PTY.
func (h *WorkspaceTerminalHandler) ownerTerminalWebSocket(w http.ResponseWriter, r *http.Request) {
	if h.OwnerTerminals == nil || currentRevocationSource() == nil {
		terminalUnavailable(w)
		return
	}
	guard := watchWorkspaceSocket(r)
	defer guard.close()
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		terminalError(w, 401, "unauthorized", "permission", "Sign in")
		return
	}
	info := middleware.AuthInfoFromContext(r.Context())
	if info == nil || !info.IsTokenAuth || h.hasSessionCookie(r) || r.URL.Query().Get("ticket") != "" {
		if !h.checkOrigin(r.Header.Get("Origin"), r) {
			terminalError(w, 403, "forbidden", "permission", "Origin not allowed")
			return
		}
	}
	id, err := routeParam(r, "id", "terminal required")
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	manager := h.terminalSessionManager()
	manager.mu.Lock()
	session := manager.sessions[id]
	manager.mu.Unlock()
	if session == nil || session.isDead() {
		terminalError(w, 404, "not_found", "user", "Terminal not found")
		return
	}
	session.mu.Lock()
	owner := session.principal
	session.mu.Unlock()
	repo := middleware.RepoFromContext(r.Context())
	if repo == nil || repo.ID != owner.RepositoryID {
		terminalError(w, 404, "not_found", "user", "Terminal not found")
		return
	}
	principal, err := h.OwnerTerminals.Authorize(guard.ctx, owner.WorkspaceID, user.ID)
	if guard.reject(w) {
		return
	}
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	if principal.UserID != user.ID || principal.RepositoryID != owner.RepositoryID || principal.WorkspaceID != owner.WorkspaceID {
		terminalUnavailable(w)
		return
	}
	if err := h.OwnerTerminals.Ready(guard.ctx, owner); err != nil {
		terminalUnavailable(w)
		return
	}
	principal = guard.scope(owner.WorkspaceID, owner.SandboxID, true)
	if guard.reject(w) {
		return
	}
	if h.ActiveConnections != nil {
		if !h.ActiveConnections.Acquire(user.ID) {
			terminalError(w, 429, "rate_limited", "user", "Too many terminals")
			return
		}
		defer h.ActiveConnections.Release(user.ID)
	}
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true, Subprotocols: []string{"terminal"}})
	if err != nil {
		return
	}
	defer ws.CloseNow()
	if !guard.bind(ws) {
		return
	}
	ws.SetReadLimit(terminalReadLimit)
	// Keep reads alive for the revocation close handshake; guard.ctx fences
	// authorization immediately without cancelling WebSocket transport reads.
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	pingDone := make(chan struct{})
	go func() {
		defer close(pingDone)
		ticker := time.NewTicker(terminalKeepAliveInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if ws.Ping(ctx) != nil {
					cancel()
					return
				}
			}
		}
	}()
	defer func() { cancel(); <-pingDone }()

	sink, err := session.addSink(ctx, ws, func() {}, principal)
	if err != nil {
		_ = ws.Close(websocket.StatusPolicyViolation, "Terminal ended")
		return
	}
	defer session.removeSink(sink)
	if !guard.bind(ws) {
		return
	}
	if credential := session.credential(); credential != nil {
		if err := credential.AcquireCredential(guard.ctx); err != nil {
			_ = ws.Close(websocket.StatusInternalError, "Sign in failed")
			return
		}
		defer credential.ReleaseCredential()
	}
	h.pipeWSToTerminalSession(ctx, guard.ctx, ws, session, id, func() {})
}
