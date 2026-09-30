package routes

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	gossh "golang.org/x/crypto/ssh"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

const (
	// defaultLSPIdleTimeout ends a relay with no JSON-RPC traffic in either
	// direction: close 1000 `language_server_idle`, server shut down.
	defaultLSPIdleTimeout = 10 * time.Minute
	// defaultLSPStartTimeout bounds the wait for the launch script's ready
	// line: SSH dial through the gateway plus the guest resolving the binary.
	defaultLSPStartTimeout = 20 * time.Second
	// defaultLSPExitWait is how long the relay waits, after closing the
	// server's stdin, for it to exit on its own before SIGKILL.
	defaultLSPExitWait = 2 * time.Second
	// defaultLSPStartupRetryDelay mirrors the terminal's activation retry on
	// NixOS guests whose shell is not linked yet.
	defaultLSPStartupRetryDelay = defaultTerminalStartupRetryDelay
	// lspWriteTimeout bounds one WebSocket write; a client that cannot drain
	// a message in this long is dropped (close 1001, reconnect).
	lspWriteTimeout = 10 * time.Second
	// lspStderrTailBytes is how much server stderr the relay keeps for logs.
	lspStderrTailBytes = 4 * 1024

	lspCloseReasonIdle     = "language_server_idle"
	lspCloseReasonReplaced = "replaced by a newer client"
	lspCloseReasonExited   = "language_server_exited"
)

// lspSSHSession is the SSH exec session that runs the language server: no
// PTY, stdio relayed 1:1. *gossh.Session satisfies it.
type lspSSHSession interface {
	StdinPipe() (io.WriteCloser, error)
	StdoutPipe() (io.Reader, error)
	StderrPipe() (io.Reader, error)
	Start(cmd string) error
	Signal(sig gossh.Signal) error
	Wait() error
	Close() error
}

type lspSSHClient interface {
	Close() error
}

type lspDialer func(ctx context.Context, info services.WorkspaceSSHConnectionInfo) (lspSSHClient, lspSSHSession, error)

// errLanguageServerMissing is what open reports when the guest printed the
// missing line: the handler answers 409 language_server_missing.
var errLanguageServerMissing = errors.New("language server missing in guest")

// errLanguageServerGuestNotReady is an exit 127 with no handshake line: the
// guest's shell did not resolve (NixOS before activation).
var errLanguageServerGuestNotReady = errors.New("language server guest not ready")

// errLanguageServerReplaced is a launch that a newer start, Destroy or Close
// superseded before it published: its server is killed, never tracked.
var errLanguageServerReplaced = errors.New("language server replaced by a newer client")

// errLSPManagerClosed refuses starts after Close: the server is shutting down.
var errLSPManagerClosed = errors.New("lsp session manager is closed")

// lspStartError is a launch that ended before the ready line for any other
// reason; the exit status and stderr tail go to the log, not the client.
type lspStartError struct {
	code   int
	stderr string
}

func (e *lspStartError) Error() string {
	return fmt.Sprintf("language server exited with status %d before ready: %s", e.code, strings.TrimSpace(e.stderr))
}

// LSPSessionManager owns live language-server relays keyed by workspace
// session id. Unlike terminals there is no durable process: a server lives
// exactly as long as the WebSocket that opened it, so a reconnect starts a
// fresh server and the client's `initialize` is always answered by a server
// that has not seen one. The manager exists to enforce one live server per
// session (a newer attach replaces the older one), to revoke, and to close
// on shutdown.
type LSPSessionManager struct {
	mu       sync.Mutex
	sessions map[string]*lspSession
	// starting holds the launch in flight for each session id. A newer start
	// for the same id cancels it, and a launch publishes only while it is
	// still the one registered here, so two overlapping starts never leave
	// an untracked server alive (the terminal manager has no such window
	// because its process outlives the socket).
	starting          map[string]*lspStartup
	closed            bool
	dial              lspDialer
	idleTimeout       time.Duration
	startTimeout      time.Duration
	exitWait          time.Duration
	startupRetryDelay time.Duration
}

// lspStartup is one launch that has not published yet.
type lspStartup struct {
	cancel    context.CancelCauseFunc
	principal revocation.Principal
}

func NewLSPSessionManager(dial lspDialer) *LSPSessionManager {
	return &LSPSessionManager{
		sessions:          make(map[string]*lspSession),
		starting:          make(map[string]*lspStartup),
		dial:              dial,
		idleTimeout:       defaultLSPIdleTimeout,
		startTimeout:      defaultLSPStartTimeout,
		exitWait:          defaultLSPExitWait,
		startupRetryDelay: defaultLSPStartupRetryDelay,
	}
}

// start launches the language server for sessionID over SSH and waits for
// its ready line. A previous live relay for the same session is closed
// first (1000, replaced by a newer client), and so is a launch still in
// flight for it: the newest start wins, an older one that completes later
// kills its server and reports errLanguageServerReplaced. The returned
// session is not yet attached to a WebSocket; the caller attaches after the
// upgrade.
func (m *LSPSessionManager) start(ctx context.Context, sessionID string, info services.WorkspaceSSHConnectionInfo, launch services.LanguageServerLaunch, principal revocation.Principal) (session *lspSession, err error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if m.dial == nil {
		return nil, errors.New("lsp session manager dialer is nil")
	}
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil, errLSPManagerClosed
	}
	if m.sessions == nil {
		m.sessions = make(map[string]*lspSession)
	}
	if m.starting == nil {
		m.starting = make(map[string]*lspStartup)
	}
	ctx, cancel := context.WithCancelCause(ctx)
	startup := &lspStartup{cancel: cancel, principal: principal}
	if pending := m.starting[sessionID]; pending != nil {
		pending.cancel(context.Canceled)
	}
	m.starting[sessionID] = startup
	previous := m.sessions[sessionID]
	delete(m.sessions, sessionID)
	m.mu.Unlock()
	defer func() {
		if errors.Is(context.Cause(ctx), errWorkspaceSocketRevoked) {
			err = errWorkspaceSocketRevoked
		}
		cancel(context.Canceled)
		m.mu.Lock()
		if m.starting[sessionID] == startup {
			delete(m.starting, sessionID)
		}
		m.mu.Unlock()
	}()
	if previous != nil {
		previous.destroy(websocket.StatusNormalClosure, lspCloseReasonReplaced)
	}

	attempts := 1
	if terminalNeedsActivationWatch(info.Kind) {
		attempts = 2
	}
	for attempt := 0; attempt < attempts; attempt++ {
		sess, err := m.open(ctx, sessionID, info, launch)
		if err != nil {
			if errors.Is(err, errLanguageServerGuestNotReady) {
				if attempt+1 < attempts {
					if waitErr := waitForTerminalRetry(ctx, m.startupRetryDelay); waitErr != nil {
						return nil, waitErr
					}
					continue
				}
				return nil, pkgerrors.GuestNotReady("workspace guest is still starting; retry shortly")
			}
			return nil, err
		}
		m.mu.Lock()
		if m.closed || m.starting[sessionID] != startup || ctx.Err() != nil {
			// Superseded while dialing: whoever displaced this launch owns
			// the id now, so this server dies instead of being orphaned.
			m.mu.Unlock()
			sess.destroy(websocket.StatusNormalClosure, lspCloseReasonReplaced)
			return nil, errLanguageServerReplaced
		}
		sess.setPrincipal(principal)
		m.sessions[sessionID] = sess
		delete(m.starting, sessionID)
		m.mu.Unlock()
		return sess, nil
	}
	return nil, pkgerrors.GuestNotReady("workspace guest is still starting; retry shortly")
}

// open dials, starts the launch command, and reads the handshake line.
func (m *LSPSessionManager) open(ctx context.Context, sessionID string, info services.WorkspaceSSHConnectionInfo, launch services.LanguageServerLaunch) (*lspSession, error) {
	client, sshSess, err := m.dial(ctx, info)
	if err != nil {
		return nil, err
	}
	stop := context.AfterFunc(ctx, func() { _ = sshSess.Close(); _ = client.Close() })
	defer stop()
	fail := func(err error) (*lspSession, error) {
		_ = sshSess.Close()
		_ = client.Close()
		return nil, err
	}
	stdin, err := sshSess.StdinPipe()
	if err != nil {
		return fail(fmt.Errorf("ssh stdin pipe: %w", err))
	}
	stdout, err := sshSess.StdoutPipe()
	if err != nil {
		return fail(fmt.Errorf("ssh stdout pipe: %w", err))
	}
	stderr, err := sshSess.StderrPipe()
	if err != nil {
		return fail(fmt.Errorf("ssh stderr pipe: %w", err))
	}
	if err := sshSess.Start(launch.Command); err != nil {
		return fail(fmt.Errorf("ssh start language server: %w", err))
	}

	sess := &lspSession{
		id:            sessionID,
		language:      launch.Language,
		client:        client,
		sshSess:       sshSess,
		stdin:         stdin,
		br:            bufio.NewReaderSize(stdout, 64*1024),
		stderr:        newTailBuffer(lspStderrTailBytes),
		idleAfter:     m.idleTimeout,
		exitWait:      m.exitWait,
		exited:        make(chan struct{}),
		done:          make(chan struct{}),
		closeFinished: make(chan struct{}),
	}
	// Identity-checked removal, like the terminal manager: a replaced
	// relay's teardown must not evict the newer one under the same id.
	sess.onDone = func() { m.removeSession(sessionID, sess) }
	sess.touch()
	go sess.drainStderr(stderr)
	go sess.waitExit()

	handshake := make(chan handshakeResult, 1)
	go func() {
		// Bounded: the guest chooses what it prints, the API does not
		// buffer an endless line waiting for its newline.
		line, err := readLSPLine(sess.br, lspMaxHeaderLineBytes)
		handshake <- handshakeResult{line: strings.TrimRight(line, "\r\n"), err: err}
	}()

	startTimer := time.NewTimer(m.startTimeout)
	defer startTimer.Stop()

	// The launch script's first stdout line is the verdict: the ready line,
	// the `missing` line, or nothing at all. The exit status never decides on
	// its own — on a real SSH channel it can arrive before the line the guest
	// already wrote is drained, and answering `guest_not_ready` to a guest
	// that told us which binary is missing is a misleading refusal. An exit
	// only bounds how long the line may still arrive.
	var res handshakeResult
	select {
	case res = <-handshake:
	case <-sess.exited:
		select {
		case res = <-handshake:
		case <-time.After(m.exitWait):
		}
	case <-startTimer.C:
		sess.kill()
		return nil, fmt.Errorf("language server did not report ready within %s", m.startTimeout)
	case <-ctx.Done():
		sess.kill()
		return nil, ctx.Err()
	}
	if res.err == nil && res.line == services.LanguageServerReadyLine {
		// The relay is live from here: its exit now ends the WebSocket.
		go sess.closeOnExit()
		return sess, nil
	}
	// No ready line: the process is exiting (missing binary, shell not
	// resolved, crash). Wait briefly for its status to classify.
	sess.kill()
	select {
	case <-sess.exited:
	case <-time.After(m.exitWait):
	}
	if errors.Is(res.err, errLSPHeaderTooLarge) {
		return nil, fmt.Errorf("language server ready line: %w", res.err)
	}
	return nil, classifyLSPStart(res.line, sess.exitCode(), sess.stderr.String())
}

type handshakeResult struct {
	line string
	err  error
}

// classifyLSPStart maps a launch that ended before ready to the error the
// handler answers: the missing line is a 409, an exit 127 without any line
// is the shell itself missing (retry), anything else is a start failure.
func classifyLSPStart(line string, code int, stderr string) error {
	if strings.HasPrefix(line, services.LanguageServerMissingLine+" ") || line == services.LanguageServerMissingLine {
		return errLanguageServerMissing
	}
	if line == "" && code == services.LanguageServerMissingExitCode {
		return errLanguageServerGuestNotReady
	}
	return &lspStartError{code: code, stderr: stderr}
}

func (m *LSPSessionManager) removeSession(sessionID string, sess *lspSession) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.sessions[sessionID] == sess {
		delete(m.sessions, sessionID)
	}
}

// Destroy ends the live relay for sessionID, if any, and cancels a launch
// still in flight for it.
func (m *LSPSessionManager) Destroy(sessionID string, reason string) {
	m.mu.Lock()
	sess := m.sessions[sessionID]
	delete(m.sessions, sessionID)
	if pending := m.starting[sessionID]; pending != nil {
		pending.cancel(context.Canceled)
		delete(m.starting, sessionID)
	}
	m.mu.Unlock()
	if sess != nil {
		sess.destroy(websocket.StatusNormalClosure, reason)
	}
}

// Close ends every live relay and every launch in flight (server shutdown);
// later starts are refused.
func (m *LSPSessionManager) Close() {
	m.mu.Lock()
	m.closed = true
	for id, pending := range m.starting {
		pending.cancel(context.Canceled)
		delete(m.starting, id)
	}
	sessions := make([]*lspSession, 0, len(m.sessions))
	for _, sess := range m.sessions {
		sessions = append(sessions, sess)
	}
	m.mu.Unlock()
	for _, sess := range sessions {
		sess.destroy(websocket.StatusGoingAway, "server shutting down")
	}
}

// RevokeMatching ends every relay the event revokes with close 1008, the
// same code the terminal uses, so clients treat it as final.
func (m *LSPSessionManager) RevokeMatching(event revocation.Event) {
	m.mu.Lock()
	for id, pending := range m.starting {
		if event.Affects(pending.principal) {
			pending.cancel(errWorkspaceSocketRevoked)
			delete(m.starting, id)
		}
	}
	var doomed []*lspSession
	for _, sess := range m.sessions {
		if event.Affects(sess.principalValue()) {
			doomed = append(doomed, sess)
		}
	}
	m.mu.Unlock()
	for _, sess := range doomed {
		reason := "access revoked"
		if event.Reason != "" {
			reason += ": " + event.Reason
		}
		sess.destroy(websocket.StatusPolicyViolation, reason)
	}
}

// lspSession is one live language server and the WebSocket attached to it.
type lspSession struct {
	id        string
	language  string
	client    lspSSHClient
	sshSess   lspSSHSession
	stdin     io.WriteCloser
	br        *bufio.Reader
	stderr    *tailBuffer
	idleAfter time.Duration
	exitWait  time.Duration
	onDone    func()

	// exited closes once Wait returned; exitErr is valid after that.
	exited  chan struct{}
	exitErr error
	done    chan struct{}
	// closeFinished closes after the bounded WebSocket close handshake.
	// done signals teardown immediately; the socket's owner waits separately
	// before invoking CloseNow, which could otherwise win against Close.
	closeFinished chan struct{}
	once          sync.Once

	lastActivity atomic.Int64

	mu        sync.Mutex
	ws        *websocket.Conn
	touchFn   func()
	principal revocation.Principal
	dead      bool
	// closeCode/closeReason record why the relay ended, for tests and logs.
	closeCode   websocket.StatusCode
	closeReason string
}

func (s *lspSession) touch() {
	s.lastActivity.Store(time.Now().UnixNano())
	s.mu.Lock()
	touch := s.touchFn
	s.mu.Unlock()
	if touch != nil {
		touch()
	}
}

func (s *lspSession) setPrincipal(principal revocation.Principal) {
	s.mu.Lock()
	s.principal = principal
	s.mu.Unlock()
}

func (s *lspSession) principalValue() revocation.Principal {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.principal
}

func (s *lspSession) isDead() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.dead
}

// closeStatus reports how the relay ended, once it has.
func (s *lspSession) closeStatus() (websocket.StatusCode, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closeCode, s.closeReason
}

// attach binds the accepted WebSocket. touch is the activity callback that
// refreshes the session row's last_activity_at.
func (s *lspSession) attach(ws *websocket.Conn, touch func()) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dead {
		if s.closeCode == websocket.StatusPolicyViolation {
			return errWorkspaceSocketRevoked
		}
		return errors.New("language server ended before attach")
	}
	s.ws = ws
	s.touchFn = touch
	return nil
}

// waitExit records the server process's exit; it does not tear the session
// down. Teardown during startup belongs to open, which is still reading the
// handshake line: destroying here would close the SSH session out from under
// that read and lose the line the guest wrote.
func (s *lspSession) waitExit() {
	s.exitErr = s.sshSess.Wait()
	close(s.exited)
}

// closeOnExit ends the relay when the server process exits. open starts it
// once the launch reported ready, the point where the session stops being
// open's to tear down.
func (s *lspSession) closeOnExit() {
	<-s.exited
	// The server is gone: whatever the socket was doing, say so.
	code, reason := s.exitClose()
	s.destroy(code, reason)
}

// exitCode is valid after exited is closed: 0 for a clean exit, the status
// for an exit error, -1 when SSH reported no status.
func (s *lspSession) exitCode() int {
	select {
	case <-s.exited:
	default:
		return -1
	}
	if s.exitErr == nil {
		return 0
	}
	return terminalExitStatus(s.exitErr)
}

// exitClose maps the server's exit to the close code the client sees: a
// clean exit (the client sent shutdown/exit) is 1000, anything else 1011
// (retry once). The reason is typed either way: never a silent 1000.
func (s *lspSession) exitClose() (websocket.StatusCode, string) {
	code := s.exitCode()
	if code == 0 {
		return websocket.StatusNormalClosure, lspCloseReasonExited + ": 0"
	}
	if code < 0 {
		return websocket.StatusInternalError, lspCloseReasonExited + ": unknown"
	}
	return websocket.StatusInternalError, fmt.Sprintf("%s: %d", lspCloseReasonExited, code)
}

func (s *lspSession) drainStderr(r io.Reader) {
	buf := make([]byte, 4096)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			s.stderr.Write(buf[:n])
		}
		if err != nil {
			return
		}
	}
}

// run relays until the socket or the server ends. It returns after the
// relay is destroyed and its bounded close handshake finishes; the caller
// owns the WebSocket's final CloseNow.
func (s *lspSession) run(ctx context.Context) {
	defer func() { <-s.closeFinished }()
	s.mu.Lock()
	ws := s.ws
	s.mu.Unlock()
	if ws == nil {
		s.destroy(websocket.StatusInternalError, "no client attached")
		return
	}

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		s.pumpServerToClient(ctx, ws)
	}()
	wg.Add(1)
	go func() {
		defer wg.Done()
		s.watchIdle(ctx)
	}()
	s.pumpClientToServer(ctx, ws)
	<-s.done
	wg.Wait()
}

func (s *lspSession) pumpServerToClient(ctx context.Context, ws *websocket.Conn) {
	reader := newLSPFrameReader(s.br, lspMaxAssembledBytes)
	for {
		msg, err := reader.Next()
		if err != nil {
			if err != io.EOF && !s.isDead() {
				slog.Debug("lsp server stream ended", "error", err, "session_id", s.id)
			}
			// EOF: the process is exiting; waitExit closes with the typed
			// exit reason. A framing error is the server's fault: 1011.
			if err != io.EOF {
				s.destroy(websocket.StatusInternalError, "language_server_protocol_error")
			}
			return
		}
		frames := [][]byte{msg}
		if len(msg) > lspMaxMessageBytes {
			frames = lspSplitFragments(msg, lspFragmentDataBytes)
		}
		for _, frame := range frames {
			if s.isDead() {
				return
			}
			writeCtx, cancel := context.WithTimeout(ctx, lspWriteTimeout)
			err := ws.Write(writeCtx, websocket.MessageText, frame)
			cancel()
			if err != nil {
				s.destroy(websocket.StatusGoingAway, "lsp client too slow")
				return
			}
		}
		s.touch()
	}
}

func (s *lspSession) pumpClientToServer(ctx context.Context, ws *websocket.Conn) {
	assembler := newLSPFragmentAssembler(lspMaxAssembledBytes)
	for {
		msgType, data, err := ws.Read(ctx)
		if err != nil {
			if status := websocket.CloseStatus(err); status != -1 {
				if status == websocket.StatusMessageTooBig {
					s.destroy(websocket.StatusMessageTooBig, "lsp message over 1 MiB; fragment it")
					return
				}
				s.destroy(websocket.StatusNormalClosure, "client closed")
				return
			}
			s.destroy(websocket.StatusNormalClosure, "client disconnected")
			return
		}
		if s.isDead() {
			return
		}
		if msgType != websocket.MessageText {
			s.destroy(websocket.StatusUnsupportedData, "binary frames are not accepted; send one JSON-RPC message per text frame")
			return
		}
		kind, frag, err := lspClassifyFrame(data)
		if err != nil {
			s.destroy(websocket.StatusProtocolError, "lsp_protocol_error: "+err.Error())
			return
		}
		var body []byte
		switch kind {
		case lspFrameFragment:
			complete, done, err := assembler.Push(frag)
			if err != nil {
				s.destroy(websocket.StatusProtocolError, "lsp_protocol_error: "+err.Error())
				return
			}
			s.touch()
			if !done {
				continue
			}
			body = complete
		default:
			if assembler.open() {
				s.destroy(websocket.StatusProtocolError, "lsp_protocol_error: whole message inside an open fragment sequence")
				return
			}
			body = data
		}
		if s.isDead() {
			return
		}
		if _, err := s.stdin.Write(lspEncodeMessage(body)); err != nil {
			// The server went away; waitExit reports the typed exit.
			select {
			case <-s.exited:
			case <-time.After(s.exitWait):
				s.destroy(websocket.StatusInternalError, "language server stdin closed")
			}
			return
		}
		s.touch()
	}
}

func (s *lspSession) watchIdle(ctx context.Context) {
	if s.idleAfter <= 0 {
		return
	}
	interval := s.idleAfter / 4
	if interval > 30*time.Second {
		interval = 30 * time.Second
	}
	if interval < 10*time.Millisecond {
		interval = 10 * time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.done:
			return
		case <-ticker.C:
			last := time.Unix(0, s.lastActivity.Load())
			if time.Since(last) >= s.idleAfter {
				s.destroy(websocket.StatusNormalClosure, lspCloseReasonIdle)
				return
			}
		}
	}
}

// kill ends the server process: stdin closed (a vscode-languageserver
// server exits on stdin EOF), SIGKILL after exitWait if it lingers, then the
// SSH session and connection.
func (s *lspSession) kill() {
	_ = s.stdin.Close()
	select {
	case <-s.exited:
	case <-time.After(s.exitWait):
		_ = s.sshSess.Signal(gossh.SIGKILL)
		select {
		case <-s.exited:
		case <-time.After(time.Second):
		}
	}
	_ = s.sshSess.Close()
	_ = s.client.Close()
}

// destroy ends the relay exactly once: the client is told why with code and
// reason, the server process is killed, and the manager forgets the session.
func (s *lspSession) destroy(code websocket.StatusCode, reason string) {
	s.once.Do(func() {
		s.mu.Lock()
		s.dead = true
		s.closeCode = code
		s.closeReason = reason
		ws := s.ws
		s.mu.Unlock()
		close(s.done)
		if ws != nil {
			go func() {
				defer close(s.closeFinished)
				_ = ws.Close(code, reason)
			}()
		} else {
			close(s.closeFinished)
		}
		go func() {
			s.kill()
			if s.onDone != nil {
				s.onDone()
			}
		}()
	})
}

// tailBuffer keeps the last n bytes written to it.
type tailBuffer struct {
	mu  sync.Mutex
	max int
	buf []byte
}

func newTailBuffer(max int) *tailBuffer { return &tailBuffer{max: max} }

func (t *tailBuffer) Write(p []byte) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if len(t.buf) > t.max {
		t.buf = t.buf[len(t.buf)-t.max:]
	}
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.buf)
}
