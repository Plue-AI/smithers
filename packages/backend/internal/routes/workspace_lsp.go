package routes

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// LSPWebSocket handles GET /api/repos/{owner}/{repo}/workspace/sessions/{id}/lsp
// (#505, RFD-005): it relays one language server's stdio inside the workspace
// as JSON-RPC 2.0 over a WebSocket with subprotocol `lsp`.
//
// It shares TerminalWebSocket's preflight (preflightWorkspaceSocket) and adds
// the kind and language checks. After the preflight: SSH connection info, then
// the language server is launched over SSH and its ready line read, so a
// missing binary answers 409 language_server_missing with the install line
// and never a 101.
//
// Wire: one JSON-RPC message per text frame, 1 MiB per frame, larger
// messages as {seq,last,data} fragments; server pings every 30 s.
// Close codes: 1000 final (`language_server_exited: 0`, `language_server_idle`,
// client closed), 1001 reconnect (client too slow), 1008 revoked, 1011
// retry once (`language_server_exited: <code>`), 1002/1003/1009 client
// protocol faults (final).
func (h *WorkspaceTerminalHandler) LSPWebSocket(w http.ResponseWriter, r *http.Request) {
	requestCtx := r.Context()
	guard := watchWorkspaceSocket(r)
	defer guard.close()
	r = r.WithContext(guard.ctx)
	if guard.reject(w) {
		return
	}
	observe := func(result string) {
		if h.Metrics != nil {
			h.Metrics.ObserveWorkspaceLSPAttach(result)
		}
	}
	pre, ok := h.preflightWorkspaceSocket(w, r, workspaceSocketGate{
		revocation: guard,
		kind:       "lsp",
		observe:    observe,
		checkSession: func(w http.ResponseWriter, session services.WorkspaceSessionResponse) bool {
			if session.Kind != services.WorkspaceSessionKindLSP {
				observe("kind_mismatch")
				pkgerrors.WriteError(w, &pkgerrors.APIError{
					Status:  http.StatusConflict,
					Code:    services.CodeWorkspaceSessionKindMismatch,
					Message: "workspace session is a " + session.Kind + " session; create one with kind lsp",
				})
				return false
			}
			if want := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("language"))); want != "" && want != session.Language {
				observe("language_mismatch")
				pkgerrors.WriteError(w, pkgerrors.BadRequest("language "+want+" does not match the session's language "+session.Language))
				return false
			}
			return true
		},
		capMessage: "too many active terminal and language-server connections",
	})
	if !ok {
		return
	}
	defer pre.release()
	user, repoCtx, sessionID := pre.user, pre.repoCtx, pre.sessionID

	sshInfo, svcErr := h.Service.GetSSHConnectionInfo(r.Context(), sessionID, repoCtx.Repository.ID, user.ID)
	if guard.reject(w) {
		return
	}
	if svcErr != nil {
		observe("ssh_info_error")
		writeRouteError(w, r, svcErr)
		return
	}
	principal := guard.scope(sshInfo.WorkspaceID, sshInfo.VMID, true)
	if guard.reject(w) {
		return
	}
	launch, svcErr := h.Service.ResolveLanguageServer(r.Context(), sessionID, repoCtx.Repository.ID, user.ID)
	if guard.reject(w) {
		return
	}
	if svcErr != nil {
		observe("resolve_error")
		writeRouteError(w, r, svcErr)
		return
	}

	slog.Info("workspace lsp websocket upgrade",
		"session_id", sessionID,
		"user_id", user.ID,
		"workspace_id", sshInfo.WorkspaceID,
		"vm_id", sshInfo.VMID,
		"language", launch.Language,
	)

	manager := h.lspSessionManager()
	lspSess, err := manager.start(r.Context(), sessionID, sshInfo, launch, principal)
	if guard.rejectStartup(w, err) {
		if lspSess != nil {
			lspSess.destroy(websocket.StatusPolicyViolation, "access revoked")
		}
		return
	}
	if err != nil {
		switch {
		case errors.Is(err, errLanguageServerMissing):
			observe("language_server_missing")
			writeRouteError(w, r, services.LanguageServerMissing(launch.Spec))
		default:
			var startErr *lspStartError
			if errors.As(err, &startErr) {
				slog.Error("language server exited before ready", "session_id", sessionID, "language", launch.Language, "exit_status", startErr.code, "stderr", startErr.stderr)
				observe("start_error")
				pkgerrors.WriteError(w, pkgerrors.Internal("language server failed to start"))
				return
			}
			slog.Error("language server start failed", "error", err, "session_id", sessionID, "language", launch.Language)
			observe("backend_error")
			writeRouteError(w, r, err)
		}
		return
	}

	guard.onRevoke(func() { lspSess.destroy(websocket.StatusPolicyViolation, "access revoked") })

	activityCh := make(chan struct{}, 8)
	notifyActivity := func() {
		select {
		case activityCh <- struct{}{}:
		default:
		}
	}

	wsConn, wsErr := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
		Subprotocols:       []string{"lsp"},
	})
	if wsErr != nil {
		slog.Error("websocket accept failed", "error", wsErr, "session_id", sessionID)
		observe("accept_error")
		lspSess.destroy(websocket.StatusInternalError, "websocket accept failed")
		return
	}
	defer func() { _ = wsConn.CloseNow() }()
	if !guard.bind(wsConn) {
		lspSess.destroy(websocket.StatusPolicyViolation, "access revoked")
		return
	}
	wsConn.SetReadLimit(lspMaxMessageBytes)

	ctx, cancel := context.WithCancel(requestCtx)
	defer cancel()

	if h.beforeLSPAttach != nil {
		h.beforeLSPAttach(lspSess)
	}
	if err := lspSess.attach(wsConn, notifyActivity); err != nil {
		if !guard.bind(wsConn) {
			return
		}
		if errors.Is(err, errWorkspaceSocketRevoked) {
			_ = wsConn.Close(websocket.StatusPolicyViolation, "access revoked")
			return
		}
		observe("attach_error")
		_ = wsConn.Close(websocket.StatusInternalError, "failed to attach language server")
		return
	}
	observe("success")

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		ticker := time.NewTicker(terminalKeepAliveInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := wsConn.Ping(ctx); err != nil {
					return
				}
			}
		}
	}()
	wg.Add(1)
	go func() {
		defer wg.Done()
		ticker := time.NewTicker(terminalActivityRefreshInterval)
		defer ticker.Stop()
		pending := false
		for {
			select {
			case <-ctx.Done():
				return
			case <-activityCh:
				if !pending {
					if touchErr := h.Service.TouchSessionActivity(ctx, sessionID); touchErr != nil {
						slog.Debug("touch session activity failed", "error", touchErr, "session_id", sessionID)
					}
					pending = true
				}
			case <-ticker.C:
				if pending {
					if touchErr := h.Service.TouchSessionActivity(ctx, sessionID); touchErr != nil {
						slog.Debug("touch session activity failed", "error", touchErr, "session_id", sessionID)
					}
					pending = false
				}
			}
		}
	}()

	lspSess.run(ctx)
	cancel()
	wg.Wait()

	code, reason := lspSess.closeStatus()
	slog.Info("workspace lsp websocket closed",
		"session_id", sessionID,
		"user_id", user.ID,
		"language", launch.Language,
		"close_code", int(code),
		"close_reason", reason,
	)
}

func (h *WorkspaceTerminalHandler) lspSessionManager() *LSPSessionManager {
	h.managerMu.Lock()
	defer h.managerMu.Unlock()
	if h.LSPSessions == nil {
		h.LSPSessions = NewLSPSessionManager(func(ctx context.Context, info services.WorkspaceSSHConnectionInfo) (lspSSHClient, lspSSHSession, error) {
			client, sess, err := h.dialSSH(ctx, info, 0, 0)
			if err != nil {
				return nil, nil, err
			}
			return client, sess, nil
		})
		if source := currentRevocationSource(); source != nil {
			source.Subscribe(h.LSPSessions.RevokeMatching)
		}
	}
	return h.LSPSessions
}
