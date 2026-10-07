package routes

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
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

func (h *WorkspaceTerminalHandler) OpenTerminal(w http.ResponseWriter, r *http.Request) {
	if h.OwnerTerminals == nil || currentRevocationSource() == nil {
		terminalUnavailable(w)
		return
	}
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		terminalError(w, 401, "unauthorized", "permission", "Sign in")
		return
	}
	var input struct {
		Branch string `json:"branch"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil || input.Branch == "" {
		terminalError(w, 400, "invalid_request", "user", "Invalid terminal request")
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		terminalError(w, 400, "invalid_request", "user", "Invalid terminal request")
		return
	}
	guard := watchWorkspaceSocket(r)
	defer guard.close()
	principal, err := h.OwnerTerminals.Authorize(guard.ctx, input.Branch, user.ID)
	if guard.reject(w) {
		return
	}
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	// Authorize may narrow scope, but may never substitute another member.
	if principal.UserID != user.ID || principal.RepositoryID <= 0 || principal.WorkspaceID == "" {
		terminalUnavailable(w)
		return
	}
	guard.scope(principal.WorkspaceID, principal.SandboxID, true)
	id := uuid.NewString()
	manager := h.terminalSessionManager()
	err = manager.OpenOwned(guard.ctx, id, principal, func(ctx context.Context) (workspaceapi.Terminal, error) {
		return h.OwnerTerminals.Open(ctx, id, principal)
	})
	if guard.rejectStartup(w, err) {
		manager.Destroy(id)
		return
	}
	if err != nil {
		terminalUnavailable(w)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(map[string]string{"id": id, "branch": principal.WorkspaceID})
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
