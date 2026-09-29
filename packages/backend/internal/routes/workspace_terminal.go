package routes

import (
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	gossh "golang.org/x/crypto/ssh"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/workspace"
)

// errNoAdvertisedHostKeys is returned when the service layer produced a
// WorkspaceSSHConnectionInfo with no pinned host keys. We fail closed
// rather than falling back to an insecure host-key bypass.
var errNoAdvertisedHostKeys = errors.New("no advertised ssh host keys; refusing to dial without a trust anchor")

const (
	// terminalReadLimit is the max WebSocket message size (64 KiB).
	terminalReadLimit = 64 * 1024

	// terminalSSHDialTimeout is the timeout for the SSH dial.
	terminalSSHDialTimeout = 15 * time.Second
)

// terminalKeepAliveInterval sends WebSocket pings.
var terminalKeepAliveInterval = 30 * time.Second

// terminalActivityRefreshInterval is the minimum time between
// activity-timestamp refreshes while the terminal is active.
// Refreshes are debounced: the first message fires immediately;
// subsequent messages within this window are coalesced into one
// refresh at the end of the window.
var terminalActivityRefreshInterval = 30 * time.Second

// terminalResizeMsg is sent by the client as a JSON text message to resize the PTY.
type terminalResizeMsg struct {
	Type string `json:"type"`
	Cols uint32 `json:"cols"`
	Rows uint32 `json:"rows"`
}

// WorkspaceTerminalService defines the service interface needed by the terminal handler.
type WorkspaceTerminalService interface {
	GetSession(ctx context.Context, sessionID string, repositoryID, userID int64) (services.WorkspaceSessionResponse, error)
	GetSSHConnectionInfo(ctx context.Context, sessionID string, repositoryID, userID int64) (services.WorkspaceSSHConnectionInfo, error)
	TouchSessionActivity(ctx context.Context, sessionID string) error
	// ResolveLanguageServer answers the launch for an LSP session (#505).
	ResolveLanguageServer(ctx context.Context, sessionID string, repositoryID, userID int64) (services.LanguageServerLaunch, error)
}

type workspaceRuntimeTerminalService interface {
	WorkspaceRuntimeTerminalAvailable() bool
	OpenWorkspaceTerminal(ctx context.Context, sessionID string, repositoryID, userID int64, columns, rows uint16) (workspace.Terminal, error)
}

// WorkspaceTerminalHandler handles the WebSocket terminal endpoint for workspace sessions.
type WorkspaceTerminalHandler struct {
	Service        WorkspaceTerminalService
	Metrics        *SmithersMetrics
	AllowedOrigins []string
	// SessionCookieName identifies the browser session cookie. An empty value
	// uses the default cookie name used by the auth middleware.
	SessionCookieName string

	// ActiveConnections caps per-user concurrent terminal WebSockets.
	// When nil, no active-connection cap is enforced (useful for tests
	// and for deployments that opt out via config). When set, the
	// handler reserves a slot BEFORE the SSH dial and releases it once
	// the WebSocket closes — see TerminalWebSocket for exact placement.
	ActiveConnections *middleware.ActiveCounter

	// TerminalSessions owns durable SSH/PTYS keyed by workspace session id.
	// When nil, the handler lazily creates the production manager using
	// dialSSH so existing tests and route construction keep working.
	TerminalSessions *TerminalSessionManager

	// LSPSessions owns live language-server relays keyed by workspace
	// session id (#505). Lazily created like TerminalSessions.
	LSPSessions *LSPSessionManager

	managerMu sync.Mutex

	beforeTerminalAttach func(*terminalSession)
	beforeLSPAttach      func(*lspSession)
}

// checkOrigin validates the Origin header against the handler's allowed origins list.
// Returns true if the origin is allowed, false otherwise.
func (h *WorkspaceTerminalHandler) checkOrigin(origin string, r *http.Request) bool {
	if origin == "" || origin == "null" {
		return false
	}
	for _, allowed := range h.AllowedOrigins {
		if strings.EqualFold(origin, allowed) {
			return true
		}
	}
	if forwardedOrigin := forwardedRequestOrigin(r); forwardedOrigin != "" {
		return strings.EqualFold(origin, forwardedOrigin)
	}
	return false
}

func forwardedRequestOrigin(r *http.Request) string {
	proto := firstForwardedValue(r.Header.Get("X-Forwarded-Proto"))
	if proto == "" && r.TLS != nil {
		proto = "https"
	}
	// Load balancers that do not rewrite Host send no X-Forwarded-Host; the
	// request's own Host is then the origin a same-origin client presents.
	host := firstForwardedValue(r.Header.Get("X-Forwarded-Host"))
	if host == "" {
		host = r.Host
	}
	if proto == "" || host == "" {
		return ""
	}
	if !strings.EqualFold(proto, "http") && !strings.EqualFold(proto, "https") {
		return ""
	}
	parsed, err := url.Parse(proto + "://" + host)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return ""
	}
	return parsed.Scheme + "://" + parsed.Host
}

func firstForwardedValue(value string) string {
	if idx := strings.IndexByte(value, ','); idx >= 0 {
		value = value[:idx]
	}
	return strings.TrimSpace(value)
}

func (h *WorkspaceTerminalHandler) hasSessionCookie(r *http.Request) bool {
	cookieName := strings.TrimSpace(h.SessionCookieName)
	if cookieName == "" {
		cookieName = "smithers_session"
	}
	cookie, err := r.Cookie(cookieName)
	return err == nil && cookie.Value != ""
}

// TerminalWebSocket handles GET /api/repos/{owner}/{repo}/workspace/sessions/{id}/terminal.
// It upgrades the HTTP connection to a WebSocket and proxies terminal I/O to the workspace
// VM's SSH session.
//
// Authentication: The user must be authenticated via the standard auth middleware.
// The workspace session must exist and belong to the repository.
//
// WebSocket protocol:
//   - Binary messages from client -> stdin of the SSH session
//   - Text messages from client -> JSON control messages (e.g. resize)
//   - Binary messages to client <- stdout/stderr of the SSH session
//
// Control messages (text, JSON):
//
//	{"type": "resize", "cols": 120, "rows": 40}
func (h *WorkspaceTerminalHandler) TerminalWebSocket(w http.ResponseWriter, r *http.Request) {
	requestCtx := r.Context()
	guard := watchWorkspaceSocket(r)
	defer guard.close()
	r = r.WithContext(guard.ctx)
	if guard.reject(w) {
		return
	}
	pre, ok := h.preflightWorkspaceSocket(w, r, workspaceSocketGate{
		revocation: guard,
		kind:       "terminal",
		observe: func(result string) {
			if h.Metrics != nil {
				h.Metrics.ObserveWorkspaceTerminalAttach(result)
			}
		},
		capMessage: "too many active terminal connections",
	})
	if !ok {
		return
	}
	// Release on every exit path from here on.
	defer pre.release()
	user, repoCtx, sessionID, session := pre.user, pre.repoCtx, pre.sessionID, pre.session
	var svcErr error

	// Runtime-backed terminals and hosted SSH terminals share the same durable
	// terminal manager, WebSocket protocol, limits, activity tracking, and
	// revocation behavior. Only the backend dial strategy differs.
	var sshInfo services.WorkspaceSSHConnectionInfo
	if runtimeService, ok := h.Service.(workspaceRuntimeTerminalService); ok && runtimeService.WorkspaceRuntimeTerminalAvailable() {
		sshInfo = services.WorkspaceSSHConnectionInfo{
			WorkspaceID: session.WorkspaceID, SessionID: sessionID, Kind: "container",
			RuntimeTerminal: true, RepositoryID: repoCtx.Repository.ID, RequesterUserID: user.ID,
		}
	} else {
		sshInfo, svcErr = h.Service.GetSSHConnectionInfo(r.Context(), sessionID, repoCtx.Repository.ID, user.ID)
		if guard.reject(w) {
			return
		}
		if svcErr != nil {
			if h.Metrics != nil {
				h.Metrics.ObserveWorkspaceTerminalAttach("ssh_info_error")
			}
			writeRouteError(w, r, svcErr)
			return
		}
	}

	slog.Info("workspace terminal websocket upgrade",
		"session_id", sessionID,
		"user_id", user.ID,
		"workspace_id", sshInfo.WorkspaceID,
		"vm_id", sshInfo.VMID,
	)

	// activityCh is a best-effort channel: each I/O goroutine sends a signal
	// when bytes flow so that the activity-refresh goroutine can debounce and
	// periodically touch last_activity_at. The channel is buffered to avoid
	// blocking hot I/O paths; dropped signals only delay the touch by one
	// debounce window, which is acceptable.
	activityCh := make(chan struct{}, 8)
	notifyActivity := func() {
		select {
		case activityCh <- struct{}{}:
		default:
		}
	}

	principal := guard.scope(sshInfo.WorkspaceID, sshInfo.VMID, true)
	if guard.reject(w) {
		return
	}
	manager := h.terminalSessionManager()
	termSession, created, err := manager.getOrCreate(r.Context(), sessionID, sshInfo, session.Cols, session.Rows, principal)
	if guard.rejectStartup(w, err) {
		if created {
			termSession.destroyWithCode(websocket.StatusPolicyViolation, "access revoked")
		}
		return
	}
	if err != nil {
		slog.Error("durable terminal session failed", "error", err, "session_id", sessionID)
		if h.Metrics != nil {
			h.Metrics.ObserveWorkspaceTerminalAttach("backend_error")
		}
		writeRouteError(w, r, err)
		return
	}

	if created {
		guard.onRevoke(func() { termSession.destroyWithCode(websocket.StatusPolicyViolation, "access revoked") })
	}

	// Accept only after the backend terminal is ready. If SSH dial/PTY/shell
	// startup fails after a 101 response, browsers surface only closeCode=1006
	// and the live proof cannot classify the real backend failure.
	wsConn, wsErr := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
		Subprotocols:       []string{"terminal"},
	})
	if wsErr != nil {
		slog.Error("websocket accept failed", "error", wsErr, "session_id", sessionID)
		if h.Metrics != nil {
			h.Metrics.ObserveWorkspaceTerminalAttach("accept_error")
		}
		if created {
			// This request dialed the durable SSH session but the upgrade
			// failed before any sink attached: release it immediately rather
			// than leaking it until the idle timeout.
			termSession.destroyIfUnattached("websocket accept failed")
		}
		return
	}
	defer func() { _ = wsConn.CloseNow() }()
	if !guard.bind(wsConn) {
		if created {
			termSession.destroyWithCode(websocket.StatusPolicyViolation, "access revoked")
		}
		return
	}

	wsConn.SetReadLimit(terminalReadLimit)

	ctx, cancel := context.WithCancel(requestCtx)
	defer cancel()

	if h.beforeTerminalAttach != nil {
		h.beforeTerminalAttach(termSession)
	}
	if !guard.bind(wsConn) {
		if created {
			termSession.destroyWithCode(websocket.StatusPolicyViolation, "access revoked")
		}
		return
	}
	sink, err := termSession.addSink(ctx, wsConn, notifyActivity)
	if err != nil {
		if created {
			termSession.destroyIfUnattached("terminal attach failed")
		}
		if !guard.bind(wsConn) {
			return
		}
		if errors.Is(err, errWorkspaceSocketRevoked) {
			_ = wsConn.Close(websocket.StatusPolicyViolation, "access revoked")
			return
		}
		slog.Error("durable terminal attach failed", "error", err, "session_id", sessionID)
		if h.Metrics != nil {
			h.Metrics.ObserveWorkspaceTerminalAttach("attach_error")
		}
		_ = wsConn.Close(websocket.StatusInternalError, "failed to attach terminal")
		return
	}
	if h.Metrics != nil {
		h.Metrics.ObserveWorkspaceTerminalAttach("success")
	}
	defer termSession.removeSink(sink)
	var wg sync.WaitGroup

	// Goroutine 1: WebSocket -> durable SSH stdin (binary = keystrokes, text = control).
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer cancel()
		h.pipeWSToTerminalSession(ctx, guard.ctx, wsConn, termSession, sessionID, notifyActivity)
	}()

	// Goroutine 2: Keep-alive pings for this attached WebSocket.
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

	// Goroutine 3: Activity refresh. Coalesces signals from activityCh and
	// calls TouchSessionActivity at most once per terminalActivityRefreshInterval.
	// This prevents idle-cleanup from evicting a session that has live traffic.
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
					// First signal: touch immediately and arm the debounce window.
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

	<-ctx.Done()
	wg.Wait()

	slog.Info("workspace terminal websocket closed",
		"session_id", sessionID,
		"user_id", user.ID,
	)
}

func (h *WorkspaceTerminalHandler) terminalSessionManager() *TerminalSessionManager {
	h.managerMu.Lock()
	defer h.managerMu.Unlock()
	if h.TerminalSessions == nil {
		h.TerminalSessions = NewTerminalSessionManager(func(ctx context.Context, info services.WorkspaceSSHConnectionInfo, cols, rows int32) (terminalSSHClient, terminalSSHSession, error) {
			if info.RuntimeTerminal {
				runtimeService, ok := h.Service.(workspaceRuntimeTerminalService)
				if !ok || !runtimeService.WorkspaceRuntimeTerminalAvailable() {
					return nil, nil, errors.New("workspace runtime terminal unavailable")
				}
				terminalCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
				stop := context.AfterFunc(ctx, cancel)
				terminal, err := runtimeService.OpenWorkspaceTerminal(terminalCtx, info.SessionID, info.RepositoryID, info.RequesterUserID, uint16(cols), uint16(rows))
				detached := stop()
				if err != nil {
					cancel()
					return nil, nil, err
				}
				if !detached || ctx.Err() != nil {
					cancel()
					if terminal != nil {
						_ = terminal.Close()
					}
					return nil, nil, ctx.Err()
				}
				return newRuntimeTerminalBackend(terminal, cancel)
			}
			client, sess, err := h.dialSSH(ctx, info, cols, rows)
			if err != nil {
				return nil, nil, err
			}
			return client, sess, nil
		})
		if source := currentRevocationSource(); source != nil {
			source.Subscribe(h.TerminalSessions.RevokeMatching)
		}
	}
	return h.TerminalSessions
}

// dialSSH connects to the workspace VM via SSH using the sandbox connection info.
//
// Host-key verification: the callback compares the presented server key
// against every public key advertised in info.HostKeys. A match -> dial
// continues; no match -> connection is torn down before the password
// auth method runs, so the access token never touches an unverified
// peer. An empty HostKeys slice is a hard error; we never silently
// accept any key.
func (h *WorkspaceTerminalHandler) dialSSH(ctx context.Context, info services.WorkspaceSSHConnectionInfo, cols, rows int32) (*gossh.Client, *gossh.Session, error) {
	// The SSH host format from sandbox is: {vmId}+{username}@{host}
	// The access token is used as the password for SSH authentication.
	sshUser := fmt.Sprintf("%s+%s", info.VMID, info.Username)
	verifyHost := info.Host
	sshHost := info.Host
	if info.DialHost != "" {
		sshHost = info.DialHost
	}

	port := info.Port
	if port == 0 {
		port = 22
	}

	hostKeyCallback, err := buildPinnedHostKeyCallback(verifyHost, port, info.HostKeys)
	if err != nil {
		return nil, nil, err
	}
	if info.DialHost != "" {
		expectedAddr := net.JoinHostPort(verifyHost, fmt.Sprintf("%d", port))
		pinnedHostKeyCallback := hostKeyCallback
		hostKeyCallback = func(_ string, remote net.Addr, key gossh.PublicKey) error {
			return pinnedHostKeyCallback(expectedAddr, remote, key)
		}
	}

	config := &gossh.ClientConfig{
		User: sshUser,
		Auth: []gossh.AuthMethod{
			gossh.Password(info.AccessToken),
		},
		HostKeyCallback: hostKeyCallback,
		Timeout:         terminalSSHDialTimeout,
	}

	addr := net.JoinHostPort(sshHost, fmt.Sprintf("%d", port))
	dialCtx, cancel := context.WithTimeout(ctx, terminalSSHDialTimeout)
	defer cancel()
	conn, err := (&net.Dialer{}).DialContext(dialCtx, "tcp", addr)
	if err != nil {
		return nil, nil, fmt.Errorf("ssh dial %s: %w", addr, err)
	}
	stop := context.AfterFunc(dialCtx, func() { _ = conn.Close() })
	defer stop()
	sshConn, chans, reqs, err := gossh.NewClientConn(conn, addr, config)
	if err != nil {
		_ = conn.Close()
		return nil, nil, fmt.Errorf("ssh dial %s: %w", addr, err)
	}
	client := gossh.NewClient(sshConn, chans, reqs)

	session, err := client.NewSession()
	if err != nil {
		_ = client.Close()
		return nil, nil, fmt.Errorf("ssh new session: %w", err)
	}

	if !stop() || dialCtx.Err() != nil {
		_ = client.Close()
		return nil, nil, dialCtx.Err()
	}
	return client, session, nil
}

// buildPinnedHostKeyCallback returns an ssh.HostKeyCallback that
// accepts a server key if and only if its wire-format Marshal() output
// equals the Marshal() of a public key decoded from one of the
// advertised host-key entries.
//
// The comparison uses subtle.ConstantTimeCompare to avoid a timing
// oracle across the pinned set, and the callback never falls back to
// "trust anyway" behavior: an empty pin set, a malformed entry, or any
// non-matching presented key all fail the dial closed.
//
// Error text deliberately includes the presented key's SHA-256
// fingerprint so operators can correlate mismatches with the value
// published by the API; it does not include any user, workspace, or
// token identifiers.
func buildPinnedHostKeyCallback(expectedHost string, expectedPort int, advertised []services.WorkspaceSSHHostKey) (gossh.HostKeyCallback, error) {
	if len(advertised) == 0 {
		return nil, errNoAdvertisedHostKeys
	}

	expectedAddr := net.JoinHostPort(expectedHost, fmt.Sprintf("%d", expectedPort))

	type pin struct {
		algorithm   string
		marshaled   []byte
		fingerprint string
	}
	pins := make([]pin, 0, len(advertised))
	for i, entry := range advertised {
		if entry.PublicKey == "" {
			return nil, fmt.Errorf("advertised host key %d: empty public_key", i)
		}
		raw, err := base64.StdEncoding.DecodeString(entry.PublicKey)
		if err != nil {
			return nil, fmt.Errorf("advertised host key %d: decode public_key: %w", i, err)
		}
		// ParsePublicKey validates the wire format before we trust the
		// bytes as a comparison target.
		pub, err := gossh.ParsePublicKey(raw)
		if err != nil {
			return nil, fmt.Errorf("advertised host key %d: parse public_key: %w", i, err)
		}
		if entry.Algorithm != "" && entry.Algorithm != pub.Type() {
			return nil, fmt.Errorf("advertised host key %d: algorithm %q does not match public_key type %q", i, entry.Algorithm, pub.Type())
		}
		computedFingerprint := gossh.FingerprintSHA256(pub)
		if entry.FingerprintSHA256 != "" && entry.FingerprintSHA256 != computedFingerprint {
			return nil, fmt.Errorf("advertised host key %d: fingerprint %q does not match public_key fingerprint %q", i, entry.FingerprintSHA256, computedFingerprint)
		}
		pins = append(pins, pin{
			algorithm:   pub.Type(),
			marshaled:   pub.Marshal(),
			fingerprint: computedFingerprint,
		})
	}
	expectedFingerprints := make([]string, 0, len(pins))
	for _, p := range pins {
		expectedFingerprints = append(expectedFingerprints, fmt.Sprintf("%s %s", p.algorithm, p.fingerprint))
	}

	return func(hostname string, remote net.Addr, key gossh.PublicKey) error {
		remoteAddr := ""
		if remote != nil {
			remoteAddr = remote.String()
		}
		if hostname != expectedAddr {
			slog.Error("ssh host callback hostname mismatch",
				"expected_hostname", expectedAddr,
				"hostname", hostname,
				"remote_addr", remoteAddr,
				"expected_fingerprints_sha256", expectedFingerprints,
			)
			return fmt.Errorf("ssh host callback hostname mismatch: expected %s, got %s", expectedAddr, hostname)
		}

		presented := key.Marshal()
		presentedFP := gossh.FingerprintSHA256(key)
		for _, p := range pins {
			if len(p.marshaled) == len(presented) &&
				subtle.ConstantTimeCompare(p.marshaled, presented) == 1 {
				return nil
			}
		}
		slog.Error("ssh host key verification failed",
			"expected_hostname", expectedAddr,
			"hostname", hostname,
			"remote_addr", remoteAddr,
			"presented_algorithm", key.Type(),
			"presented_fingerprint_sha256", presentedFP,
			"expected_fingerprints_sha256", expectedFingerprints,
		)
		return fmt.Errorf(
			"ssh host key mismatch for %s: presented %s %s does not match pinned fingerprints %v",
			expectedAddr,
			key.Type(),
			presentedFP,
			expectedFingerprints,
		)
	}, nil
}

// pipeSSHToWS reads from an SSH reader (stdout or stderr) and writes binary messages to WebSocket.
// notifyActivity is called whenever bytes are forwarded so the caller can refresh idle timers.
func (h *WorkspaceTerminalHandler) pipeSSHToWS(ctx context.Context, ws *websocket.Conn, reader io.Reader, sessionID string, notifyActivity func()) {
	buf := make([]byte, 4096)
	for {
		n, err := reader.Read(buf)
		if n > 0 {
			writeErr := ws.Write(ctx, websocket.MessageBinary, buf[:n])
			if writeErr != nil {
				return
			}
			notifyActivity()
		}
		if err != nil {
			if err != io.EOF {
				slog.Debug("ssh read error", "error", err, "session_id", sessionID)
			}
			return
		}
	}
}

// pipeWSToSSH reads from WebSocket and writes to SSH stdin. Text messages are parsed as
// control commands (e.g. resize). Binary messages are raw terminal input.
// notifyActivity is called on every received message so the caller can refresh idle timers.
func (h *WorkspaceTerminalHandler) pipeWSToSSH(ctx context.Context, ws *websocket.Conn, stdin io.WriteCloser, sshSess *gossh.Session, sessionID string, notifyActivity func()) {
	defer func() { _ = stdin.Close() }()

	for {
		msgType, data, err := ws.Read(ctx)
		if err != nil {
			if websocket.CloseStatus(err) != -1 {
				slog.Debug("websocket closed by client", "session_id", sessionID)
			} else {
				slog.Debug("websocket read error", "error", err, "session_id", sessionID)
			}
			return
		}

		notifyActivity()

		switch msgType {
		case websocket.MessageBinary:
			// Raw terminal input -> SSH stdin.
			if _, writeErr := stdin.Write(data); writeErr != nil {
				slog.Debug("ssh stdin write error", "error", writeErr, "session_id", sessionID)
				return
			}

		case websocket.MessageText:
			// Parse as JSON control message.
			var msg terminalResizeMsg
			if jsonErr := json.Unmarshal(data, &msg); jsonErr != nil {
				slog.Debug("invalid terminal control message", "error", jsonErr, "session_id", sessionID)
				continue
			}

			switch msg.Type {
			case "resize":
				if msg.Cols > 0 && msg.Rows > 0 {
					if err := sshSess.WindowChange(int(msg.Rows), int(msg.Cols)); err != nil {
						slog.Debug("ssh window change failed", "error", err, "session_id", sessionID)
					}
				}
			default:
				slog.Debug("unknown terminal control message type", "type", msg.Type, "session_id", sessionID)
			}
		}
	}
}

// pipeWSToTerminalSession reads one attached WebSocket and writes input/control
// into the durable terminal session. The durable session owns stdin and the PTY;
// this attachment closing must not close the shared stdin.
func (h *WorkspaceTerminalHandler) pipeWSToTerminalSession(ctx, authorization context.Context, ws *websocket.Conn, sess *terminalSession, sessionID string, notifyActivity func()) {
	for {
		msgType, data, err := ws.Read(ctx)
		if err != nil {
			if websocket.CloseStatus(err) != -1 {
				slog.Debug("websocket closed by client", "session_id", sessionID)
			} else {
				slog.Debug("websocket read error", "error", err, "session_id", sessionID)
			}
			return
		}

		// Close waits for a peer handshake. A peer may ignore that frame and
		// keep sending data, so revoke input independently of socket closure.
		if authorization.Err() != nil {
			_ = ws.Close(websocket.StatusPolicyViolation, "access revoked")
			return
		}
		notifyActivity()

		switch msgType {
		case websocket.MessageBinary:
			if writeErr := sess.writeStdin(data); writeErr != nil {
				slog.Debug("durable terminal stdin write error", "error", writeErr, "session_id", sessionID)
				return
			}
		case websocket.MessageText:
			var msg terminalResizeMsg
			if jsonErr := json.Unmarshal(data, &msg); jsonErr != nil {
				slog.Debug("invalid terminal control message", "error", jsonErr, "session_id", sessionID)
				continue
			}
			switch msg.Type {
			case "resize":
				if msg.Cols > 0 && msg.Rows > 0 {
					if err := sess.resize(msg.Rows, msg.Cols); err != nil {
						slog.Debug("ssh window change failed", "error", err, "session_id", sessionID)
					}
				}
			default:
				slog.Debug("unknown terminal control message type", "type", msg.Type, "session_id", sessionID)
			}
		}
	}
}

// Ensure WorkspaceService satisfies WorkspaceTerminalService at compile time.
var _ WorkspaceTerminalService = (*services.WorkspaceService)(nil)
