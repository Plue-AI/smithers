package routes

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	gossh "golang.org/x/crypto/ssh"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

const (
	defaultTerminalRingBufferBytes     = 512 * 1024
	defaultTerminalIdleTimeout         = 15 * time.Minute
	defaultTerminalSSHKeepalive        = 30 * time.Second
	defaultTerminalSinkWriteTimeout    = 10 * time.Second
	defaultTerminalSessionCloseTimeout = 5 * time.Second
	defaultTerminalStartupWatch        = 2 * time.Second
	defaultTerminalStartupRetryDelay   = 3 * time.Second

	// defaultTerminalSinkBufferFrames bounds each attached client's outbound
	// queue. Writes to the websocket happen on the sink's OWN writer goroutine,
	// never under the session mutex, so one slow client can never head-of-line
	// block the PTY pump or the other clients. When a client falls this many
	// frames behind it is evicted (and reconnects, replaying from the ring).
	defaultTerminalSinkBufferFrames = 256
)

type terminalSSHSession interface {
	StdinPipe() (io.WriteCloser, error)
	StdoutPipe() (io.Reader, error)
	StderrPipe() (io.Reader, error)
	RequestPty(term string, h, w int, modes gossh.TerminalModes) error
	Shell() error
	Start(cmd string) error
	WindowChange(h, w int) error
	Wait() error
	Close() error
}

type terminalSSHClient interface {
	NewSession() (*gossh.Session, error)
	SendRequest(name string, wantReply bool, payload []byte) (bool, []byte, error)
	Close() error
}

type terminalDialer func(ctx context.Context, info services.WorkspaceSSHConnectionInfo, cols, rows int32) (terminalSSHClient, terminalSSHSession, error)

type TerminalSessionManager struct {
	mu                sync.Mutex
	sessions          map[string]*terminalSession
	starting          map[*terminalStartup]struct{}
	dial              terminalDialer
	ringBufferBytes   int
	idleTimeout       time.Duration
	keepaliveInterval time.Duration
	startupWatch      time.Duration
	startupRetryDelay time.Duration
}

type terminalStartup struct {
	cancel    context.CancelCauseFunc
	principal revocation.Principal
	sessionID string
}

func NewTerminalSessionManager(dial terminalDialer) *TerminalSessionManager {
	return &TerminalSessionManager{
		sessions:          make(map[string]*terminalSession),
		dial:              dial,
		ringBufferBytes:   defaultTerminalRingBufferBytes,
		idleTimeout:       defaultTerminalIdleTimeout,
		keepaliveInterval: defaultTerminalSSHKeepalive,
		startupWatch:      defaultTerminalStartupWatch,
		startupRetryDelay: defaultTerminalStartupRetryDelay,
	}
}

// getOrCreate returns the durable session for sessionID, dialing a new SSH
// session when none exists. The second return reports whether THIS call
// created the session, so the caller can release it (destroyIfUnattached) if
// the websocket upgrade fails before any sink attaches.
func (m *TerminalSessionManager) getOrCreate(ctx context.Context, sessionID string, info services.WorkspaceSSHConnectionInfo, cols, rows int32, principal revocation.Principal) (session *terminalSession, created bool, err error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	m.mu.Lock()
	if m.sessions == nil {
		m.sessions = make(map[string]*terminalSession)
	}
	if sess := m.sessions[sessionID]; sess != nil {
		m.mu.Unlock()
		if sess.isDead() {
			return nil, false, sess.deadErr()
		}
		return sess, false, nil
	}
	ctx, cancel := context.WithCancelCause(ctx)
	pending := &terminalStartup{cancel: cancel, principal: principal, sessionID: sessionID}
	if m.starting == nil {
		m.starting = make(map[*terminalStartup]struct{})
	}
	m.starting[pending] = struct{}{}
	m.mu.Unlock()
	defer func() {
		if errors.Is(context.Cause(ctx), errWorkspaceSocketRevoked) {
			err = errWorkspaceSocketRevoked
		}
		cancel(context.Canceled)
		m.mu.Lock()
		delete(m.starting, pending)
		m.mu.Unlock()
	}()

	if m.dial == nil {
		return nil, false, errors.New("terminal session manager dialer is nil")
	}

	// NixOS guests have historically exposed SSH a few seconds before their
	// activated login shell. The service-level activation barrier prevents the
	// normal race; this bounded early-exit watch is the last line of defense for
	// an older image or a resume racing activation. A container skips the watch.
	attempts := 1
	if terminalNeedsActivationWatch(info.Kind) {
		attempts = 2
	}
	for attempt := 0; attempt < attempts; attempt++ {
		sess, waitResult, err := m.open(ctx, sessionID, info, cols, rows)
		if err != nil {
			if attempt == 0 && attempts > 1 && terminalExitStatus(err) == 127 {
				if err := waitForTerminalRetry(ctx, m.startupRetryDelay); err != nil {
					return nil, false, err
				}
				continue
			}
			if terminalExitStatus(err) == 127 {
				return nil, false, pkgerrors.GuestNotReady("workspace guest is still starting; retry shortly")
			}
			return nil, false, err
		}

		if attempts > 1 && m.startupWatch > 0 {
			timer := time.NewTimer(m.startupWatch)
			select {
			case waitErr := <-waitResult:
				timer.Stop()
				sess.destroy("terminal startup failed")
				if terminalExitStatus(waitErr) == 127 {
					if attempt == 0 {
						if err := waitForTerminalRetry(ctx, m.startupRetryDelay); err != nil {
							return nil, false, err
						}
						continue
					}
					return nil, false, pkgerrors.GuestNotReady("workspace guest is still starting; retry shortly")
				}
				if waitErr != nil {
					return nil, false, fmt.Errorf("session exited: %w", waitErr)
				}
				return nil, false, errors.New("terminal session ended during startup")
			case <-timer.C:
			case <-ctx.Done():
				timer.Stop()
				sess.destroy("terminal startup canceled")
				return nil, false, ctx.Err()
			}
		}

		m.mu.Lock()
		if ctx.Err() != nil {
			m.mu.Unlock()
			sess.destroy("terminal startup canceled")
			return nil, false, ctx.Err()
		}
		if existing := m.sessions[sessionID]; existing != nil {
			m.mu.Unlock()
			sess.destroy("duplicate session")
			if existing.isDead() {
				return nil, false, existing.deadErr()
			}
			return existing, false, nil
		}
		sess.setPrincipal(principal)
		m.sessions[sessionID] = sess
		m.mu.Unlock()

		sess.startWithWait(waitResult)
		return sess, true, nil
	}
	return nil, false, pkgerrors.GuestNotReady("workspace guest is still starting; retry shortly")
}

// live returns the running durable session for sessionID, or nil when none
// is open. A watcher attaches only through live: it never dials.
func (m *TerminalSessionManager) live(sessionID string) *terminalSession {
	m.mu.Lock()
	sess := m.sessions[sessionID]
	m.mu.Unlock()
	if sess == nil || sess.isDead() {
		return nil
	}
	return sess
}

// open allocates and starts one SSH PTY attempt without publishing it in the
// manager map. The caller can therefore observe an immediate exit and retry
// without exposing a dead durable session to an attaching WebSocket.
func (m *TerminalSessionManager) open(ctx context.Context, sessionID string, info services.WorkspaceSSHConnectionInfo, cols, rows int32) (*terminalSession, <-chan error, error) {
	client, sshSess, err := m.dial(ctx, info, cols, rows)
	if err != nil {
		return nil, nil, err
	}
	stop := context.AfterFunc(ctx, func() { _ = sshSess.Close(); _ = client.Close() })
	defer stop()
	stdin, err := sshSess.StdinPipe()
	if err != nil {
		_ = sshSess.Close()
		_ = client.Close()
		return nil, nil, fmt.Errorf("ssh stdin pipe: %w", err)
	}
	stdout, err := sshSess.StdoutPipe()
	if err != nil {
		_ = sshSess.Close()
		_ = client.Close()
		return nil, nil, fmt.Errorf("ssh stdout pipe: %w", err)
	}
	stderr, err := sshSess.StderrPipe()
	if err != nil {
		_ = sshSess.Close()
		_ = client.Close()
		return nil, nil, fmt.Errorf("ssh stderr pipe: %w", err)
	}
	if err := sshSess.RequestPty("xterm-256color", int(rows), int(cols), gossh.TerminalModes{
		gossh.ECHO:          1,
		gossh.TTY_OP_ISPEED: 14400,
		gossh.TTY_OP_OSPEED: 14400,
	}); err != nil {
		_ = sshSess.Close()
		_ = client.Close()
		return nil, nil, fmt.Errorf("ssh request pty: %w", err)
	}
	// WorkspaceRuntime opens its PTY and shell together. Only a raw SSH
	// session still needs a shell command after its streams are attached.
	if !info.RuntimeTerminal {
		if err := startWorkspaceShell(sshSess, info.Workdir); err != nil {
			_ = sshSess.Close()
			_ = client.Close()
			return nil, nil, fmt.Errorf("ssh shell: %w", err)
		}
	}

	var sess *terminalSession
	sess = newTerminalSession(sessionID, client, sshSess, stdin, stdout, stderr, m.ringBufferBytes, m.idleTimeout, m.keepaliveInterval, func() {
		// Identity-checked removal: when two callers race on the same sessionID, the
		// duplicate loser's teardown must NOT evict the live winner that now occupies
		// this key (which would orphan the winner's SSH connection + goroutines).
		// Mirrors AgentService.clearAgentRuntimeWatchdog.
		m.removeSession(sessionID, sess)
	})

	waitResult := make(chan error, 1)
	go func() { waitResult <- sshSess.Wait() }()
	return sess, waitResult, nil
}

func terminalNeedsActivationWatch(kind string) bool {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "vm":
		return true
	default:
		return false
	}
}

type terminalExitStatuser interface{ ExitStatus() int }

func terminalExitStatus(err error) int {
	var statusErr terminalExitStatuser
	if errors.As(err, &statusErr) {
		return statusErr.ExitStatus()
	}
	return -1
}

func waitForTerminalRetry(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func startWorkspaceShell(sshSess terminalSSHSession, workdir string) error {
	commands := make([]string, 0, 2)
	if workdir != "" {
		quotedWorkdir := shellSingleQuote(workdir)
		commands = append(commands, fmt.Sprintf("if [ -d %s ]; then cd %s; fi", quotedWorkdir, quotedWorkdir))
	}
	// Always start a login shell. The workspace egress and repository Git
	// credential-helper profiles are deliberately runtime files, so Shell()
	// (which invokes the provider's bare default shell) would bypass them.
	// On a NixOS guest the first seconds after boot can precede activation:
	// $SHELL (from /etc/passwd) and /bin/bash may not resolve yet and the exec
	// exits 127, closing the terminal at once. Try the user's shell, then bash,
	// then sh, and never fail the session on a missing login shell.
	commands = append(commands, `for s in "$SHELL" /bin/bash /bin/sh; do if [ -n "$s" ] && [ -x "$s" ]; then exec "$s" -l; fi; done; exec sh -l`)
	return sshSess.Start(strings.Join(commands, "; "))
}

func shellSingleQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func (m *TerminalSessionManager) remove(sessionID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.sessions, sessionID)
}

// removeSession deletes the map entry only if it still points at sess, so a
// duplicate loser tearing itself down cannot evict the live winner for the id.
func (m *TerminalSessionManager) removeSession(sessionID string, sess *terminalSession) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.sessions[sessionID] == sess {
		delete(m.sessions, sessionID)
	}
}

func (m *TerminalSessionManager) Destroy(sessionID string) {
	m.mu.Lock()
	for pending := range m.starting {
		if pending.sessionID == sessionID {
			pending.cancel(context.Canceled)
		}
	}
	sess := m.sessions[sessionID]
	m.mu.Unlock()
	if sess != nil {
		sess.destroy("session ended")
	}
}

func (m *TerminalSessionManager) Close() {
	m.mu.Lock()
	for pending := range m.starting {
		pending.cancel(context.Canceled)
	}
	sessions := make([]*terminalSession, 0, len(m.sessions))
	for _, sess := range m.sessions {
		sessions = append(sessions, sess)
	}
	m.mu.Unlock()
	for _, sess := range sessions {
		sess.destroy("server shutting down")
	}
}

type terminalSession struct {
	id        string
	client    terminalSSHClient
	sshSess   terminalSSHSession
	stdin     io.WriteCloser
	stdout    io.Reader
	stderr    io.Reader
	ring      *terminalRingBuffer
	idleAfter time.Duration
	keepalive time.Duration
	onDone    func()
	// principal is whose authorization the session rides on (user, token,
	// repository, workspace, VM); RevokeMatching compares revocations to it.
	principal revocation.Principal

	mu       sync.Mutex
	sinks    map[*terminalSink]struct{}
	dead     bool
	deadMsg  string
	deadErrV error
	idle     *time.Timer
	// idleGen invalidates in-flight idle-timer callbacks: every arm/stop bumps
	// it, and a callback whose captured generation no longer matches must not
	// destroy the session (Timer.Stop cannot cancel a callback that has
	// already started running).
	idleGen uint64
	done    chan struct{}
	once    sync.Once
}

func newTerminalSession(id string, client terminalSSHClient, sshSess terminalSSHSession, stdin io.WriteCloser, stdout, stderr io.Reader, ringBytes int, idleAfter, keepalive time.Duration, onDone func()) *terminalSession {
	return &terminalSession{
		id:        id,
		client:    client,
		sshSess:   sshSess,
		stdin:     stdin,
		stdout:    stdout,
		stderr:    stderr,
		ring:      newTerminalRingBuffer(ringBytes),
		idleAfter: idleAfter,
		keepalive: keepalive,
		onDone:    onDone,
		sinks:     make(map[*terminalSink]struct{}),
		done:      make(chan struct{}),
	}
}

func (s *terminalSession) startWithWait(waitResult <-chan error) {
	// A freshly created session has no sinks yet: arm the idle timer so a
	// caller that never attaches (websocket upgrade failure, crash between
	// create and attach) cannot leak the SSH session forever. addSink stops it.
	s.mu.Lock()
	if len(s.sinks) == 0 {
		s.armIdleLocked()
	}
	s.mu.Unlock()
	go s.drain(s.stdout)
	go s.drain(s.stderr)
	go s.waitForResult(waitResult)
	go s.keepaliveLoop()
}

func (s *terminalSession) isDead() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.dead
}

func (s *terminalSession) deadErr() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.deadErrV != nil {
		return s.deadErrV
	}
	if s.deadMsg != "" {
		return errors.New(s.deadMsg)
	}
	return errors.New("terminal session ended")
}

// addSink attaches a websocket to the live session. The ring-buffer replay and
// the replay-complete marker are ENQUEUED (not written) under the lock onto the
// sink's bounded outbound channel; the sink's own writer goroutine performs the
// actual websocket writes. This keeps the session mutex hold time O(1) — no
// network write ever blocks it — so a slow attaching client cannot stall the PTY
// pump or the other attached clients. Ordering is preserved because the replay
// frames are enqueued before the sink is registered for live output, and the
// writer drains the channel FIFO.
//
// touch is this attachment's activity callback: it fires on input AND on
// output drained while the sink is attached, so a reconnected client watching
// output (not typing) still refreshes last_activity_at. Each attach carries
// its own callback — the session never holds a stale first-connection one.
func (s *terminalSession) addSink(_ context.Context, ws *websocket.Conn, touch func(), principal revocation.Principal) (*terminalSink, error) {
	sink := newTerminalSink(ws, defaultTerminalSinkBufferFrames, defaultTerminalSinkWriteTimeout)
	sink.touch = touch
	sink.principal = principal
	s.mu.Lock()
	if s.dead {
		err := s.deadErrV
		if err == nil {
			err = errors.New(s.deadMsg)
		}
		s.mu.Unlock()
		return nil, err
	}
	if s.idle != nil {
		s.idle.Stop()
		s.idle = nil
	}
	// Invalidate any idle callback that already fired but lost the Stop race:
	// it re-checks this generation (and the sink count) before destroying.
	s.idleGen++
	replay, _, _ := s.ring.Snapshot()
	if len(replay) > 0 {
		sink.enqueue(sinkFrame{typ: websocket.MessageBinary, data: replay})
	}
	msg, _ := json.Marshal(map[string]string{"type": "replay-complete"})
	sink.enqueue(sinkFrame{typ: websocket.MessageText, data: msg})
	s.sinks[sink] = struct{}{}
	s.mu.Unlock()
	go sink.runWriter(func() {
		s.detachSink(sink, true, websocket.StatusGoingAway, "terminal write failed")
	})
	return sink, nil
}

func (s *terminalSession) removeSink(sink *terminalSink) {
	s.detachSink(sink, false, 0, "")
}

// detachSink removes a sink from the live set, stops its writer goroutine (by
// closing the outbound channel), and optionally closes the websocket. It is
// idempotent and safe to call from the handler (graceful close, closeWS=false —
// the handler owns the socket) or from the eviction paths (closeWS=true). The
// map mutation happens under the lock so it serializes with drain()'s fan-out;
// once a sink is removed no further frames are enqueued to it, making the
// channel close race-free.
func (s *terminalSession) detachSink(sink *terminalSink, closeWS bool, code websocket.StatusCode, reason string) {
	s.mu.Lock()
	_, present := s.sinks[sink]
	if present {
		delete(s.sinks, sink)
	}
	if len(s.sinks) == 0 {
		s.armIdleLocked()
	}
	s.mu.Unlock()
	if present {
		sink.stop()
	}
	if closeWS {
		_ = sink.close(code, reason)
	}
}

// armIdleLocked (re)arms the idle destroy timer. Caller must hold s.mu. Each
// arm bumps idleGen and the callback re-validates that generation, so a timer
// whose callback has already started when addSink calls Stop can never destroy
// a session that a sink has since reattached to.
func (s *terminalSession) armIdleLocked() {
	if s.dead || s.idleAfter <= 0 {
		return
	}
	if s.idle != nil {
		s.idle.Stop()
	}
	s.idleGen++
	gen := s.idleGen
	s.idle = time.AfterFunc(s.idleAfter, func() {
		s.idleExpire(gen)
	})
}

// idleExpire is the idle timer callback. It destroys the session only when the
// arming generation is still current and no sink is attached; death is claimed
// under the same lock addSink takes, so a racing attach either lands first
// (this callback backs off) or observes the session dead (attach rejected) —
// never a live connection torn down underneath.
func (s *terminalSession) idleExpire(gen uint64) {
	s.mu.Lock()
	if s.dead || gen != s.idleGen || len(s.sinks) > 0 {
		s.mu.Unlock()
		return
	}
	s.dead = true
	s.deadMsg = "session idle timeout"
	s.mu.Unlock()
	s.destroy("session idle timeout")
}

// destroyIfUnattached tears the session down only when nothing is attached.
// The websocket handler calls this when it created the session but the upgrade
// failed before addSink, so the freshly dialed SSH session is released
// immediately instead of leaking until the idle timeout. Like idleExpire, it
// claims death under the lock to serialize with concurrent attaches.
func (s *terminalSession) destroyIfUnattached(msg string) {
	s.mu.Lock()
	if s.dead || len(s.sinks) > 0 {
		s.mu.Unlock()
		return
	}
	s.dead = true
	s.deadMsg = msg
	s.mu.Unlock()
	s.destroy(msg)
}

// ownsInput resolves authority from the registered attachment and session, never a frame.
func (s *terminalSession) ownsInput(ws *websocket.Conn) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dead || s.principal.UserID <= 0 {
		return false
	}
	for sink := range s.sinks {
		if sink.ws == ws {
			return sink.principal.UserID == s.principal.UserID
		}
	}
	return false
}

func (s *terminalSession) writeStdin(p []byte) error {
	if len(p) == 0 {
		return nil
	}
	if s.isDead() {
		return s.deadErr()
	}
	if _, err := s.stdin.Write(p); err != nil {
		s.markDead(fmt.Errorf("ssh stdin write: %w", err))
		return err
	}
	s.activity()
	return nil
}

func (s *terminalSession) resize(rows, cols uint32) error {
	if rows == 0 || cols == 0 {
		return nil
	}
	if s.isDead() {
		return s.deadErr()
	}
	if err := s.sshSess.WindowChange(int(rows), int(cols)); err != nil {
		return err
	}
	s.activity()
	return nil
}

func (s *terminalSession) drain(reader io.Reader) {
	buf := make([]byte, 4096)
	for {
		n, err := reader.Read(buf)
		if n > 0 {
			chunk := append([]byte(nil), buf[:n]...)
			var slow []*terminalSink
			s.mu.Lock()
			if !s.dead {
				s.ring.Append(chunk)
				for sink := range s.sinks {
					// Non-blocking hand-off to the sink's writer goroutine. A
					// full queue means the client is too far behind; collect it
					// for eviction AFTER releasing the lock so the (potentially
					// blocking) websocket close never runs under s.mu.
					if !sink.enqueue(sinkFrame{typ: websocket.MessageBinary, data: chunk}) {
						slow = append(slow, sink)
					}
				}
			}
			s.mu.Unlock()
			for _, sink := range slow {
				s.detachSink(sink, true, websocket.StatusGoingAway, "terminal client too slow")
			}
			s.activity()
		}
		if err != nil {
			if err != io.EOF {
				slog.Debug("ssh read error", "error", err, "session_id", s.id)
			}
			return
		}
	}
}

func (s *terminalSession) wait() {
	s.waitForResult(singleTerminalWait(s.sshSess.Wait()))
}

func singleTerminalWait(err error) <-chan error {
	result := make(chan error, 1)
	result <- err
	return result
}

func (s *terminalSession) waitForResult(waitResult <-chan error) {
	err := <-waitResult
	if err != nil {
		s.markDead(fmt.Errorf("session exited: %w", err))
		return
	}
	s.markDead(errors.New("session ended"))
}

func (s *terminalSession) keepaliveLoop() {
	if s.keepalive <= 0 {
		return
	}
	ticker := time.NewTicker(s.keepalive)
	defer ticker.Stop()
	for {
		select {
		case <-s.done:
			return
		case <-ticker.C:
			_, _, err := s.client.SendRequest("keepalive@openssh.com", true, nil)
			if err != nil {
				s.markDead(fmt.Errorf("ssh keepalive failed: %w", err))
				return
			}
		}
	}
}

// activity fans the refresh out to every CURRENTLY attached sink's touch
// callback (collected under the lock, invoked outside it). Activity updates
// are therefore scoped to live attachments — a disconnected websocket's
// callback is dropped with its sink and can never be invoked again.
func (s *terminalSession) activity() {
	s.mu.Lock()
	touches := make([]func(), 0, len(s.sinks))
	for sink := range s.sinks {
		if sink.touch != nil {
			touches = append(touches, sink.touch)
		}
	}
	s.mu.Unlock()
	for _, touch := range touches {
		touch()
	}
}

func (s *terminalSession) markDead(err error) {
	s.markDeadWithCode(websocket.StatusNormalClosure, err)
}

func (s *terminalSession) markDeadWithCode(code websocket.StatusCode, err error) {
	msg := "session ended"
	if err != nil {
		msg = err.Error()
	}
	s.once.Do(func() {
		s.mu.Lock()
		s.dead = true
		s.deadMsg = msg
		s.deadErrV = err
		if code == websocket.StatusPolicyViolation {
			s.deadErrV = fmt.Errorf("%s: %w", msg, errWorkspaceSocketRevoked)
		}
		if s.idle != nil {
			s.idle.Stop()
		}
		sinks := make([]*terminalSink, 0, len(s.sinks))
		for sink := range s.sinks {
			sinks = append(sinks, sink)
		}
		s.sinks = make(map[*terminalSink]struct{})
		s.mu.Unlock()
		// Outside the lock: stop each writer goroutine and close its socket.
		for _, sink := range sinks {
			sink.stop()
			go func() { _ = sink.close(code, msg) }()
		}
		close(s.done)
		if s.onDone != nil {
			s.onDone()
		}
		// State, sinks and publication are settled before returning. Transport
		// closes may wait for the peer and must not delay revocation delivery.
		go func() {
			_ = s.stdin.Close()
			_ = s.sshSess.Close()
			_ = s.client.Close()
		}()
	})
}

func (s *terminalSession) destroy(msg string) {
	s.destroyWithCode(websocket.StatusNormalClosure, msg)
}

func (s *terminalSession) destroyWithCode(code websocket.StatusCode, msg string) {
	s.markDeadWithCode(code, errors.New(msg))
}

// sinkFrame is one queued websocket write owned by a single sink's writer
// goroutine.
type sinkFrame struct {
	typ  websocket.MessageType
	data []byte
}

// terminalSink is one attached websocket. All writes flow through `out` and are
// performed by runWriter on a dedicated goroutine, so the session mutex is never
// held across a network write. `out` is bounded; a backed-up client is evicted
// rather than allowed to block the shared PTY pump.
type terminalSink struct {
	principal    revocation.Principal
	ws           *websocket.Conn
	out          chan sinkFrame
	writeTimeout time.Duration
	// touch refreshes the attached connection's activity; set once at attach
	// (before the sink is registered) and read under the session mutex.
	touch    func()
	writeMu  sync.Mutex
	stopOnce sync.Once
}

func newTerminalSink(ws *websocket.Conn, bufferFrames int, writeTimeout time.Duration) *terminalSink {
	if bufferFrames <= 0 {
		bufferFrames = defaultTerminalSinkBufferFrames
	}
	return &terminalSink{
		ws:           ws,
		out:          make(chan sinkFrame, bufferFrames),
		writeTimeout: writeTimeout,
	}
}

// enqueue offers a frame to the sink's outbound queue without blocking. It
// returns false when the queue is full (the client is too slow), signaling the
// caller to evict.
func (s *terminalSink) enqueue(f sinkFrame) bool {
	select {
	case s.out <- f:
		return true
	default:
		return false
	}
}

// stop closes the outbound channel exactly once, terminating runWriter after it
// drains any already-queued frames. Safe to call from multiple goroutines.
func (s *terminalSink) stop() {
	s.stopOnce.Do(func() {
		close(s.out)
	})
}

// runWriter drains the outbound queue and writes each frame to the websocket
// with a per-write deadline. On the first write error it invokes onError (which
// detaches/evicts this sink) and returns; the deadline guarantees one slow or
// dead client can never wedge its own writer indefinitely.
func (s *terminalSink) runWriter(onError func()) {
	for frame := range s.out {
		ctx, cancel := context.WithTimeout(context.Background(), s.writeTimeout)
		err := s.write(ctx, frame.typ, frame.data)
		cancel()
		if err != nil {
			onError()
			return
		}
	}
}

func (s *terminalSink) write(ctx context.Context, typ websocket.MessageType, data []byte) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.ws.Write(ctx, typ, data)
}

func (s *terminalSink) close(code websocket.StatusCode, reason string) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.ws.Close(code, reason)
}

// setPrincipal records whose authorization the durable session rides on, so a
// revocation can end it even when no WebSocket is attached at that moment.
func (s *terminalSession) setPrincipal(principal revocation.Principal) {
	s.mu.Lock()
	s.principal = principal
	s.mu.Unlock()
}

// RevokeMatching destroys every durable terminal session the event revokes:
// the SSH session into the workspace is closed, every attached WebSocket is
// told why, and the workspace session row is left for the normal lifecycle.
func (m *TerminalSessionManager) RevokeMatching(event revocation.Event) {
	m.mu.Lock()
	for pending := range m.starting {
		if event.Affects(pending.principal) {
			pending.cancel(errWorkspaceSocketRevoked)
		}
	}
	var doomed []*terminalSession
	var watchers []struct {
		session *terminalSession
		sink    *terminalSink
	}
	for _, sess := range m.sessions {
		sess.mu.Lock()
		affected := event.Affects(sess.principal)
		if !affected {
			for sink := range sess.sinks {
				if event.Affects(sink.principal) {
					watchers = append(watchers, struct {
						session *terminalSession
						sink    *terminalSink
					}{sess, sink})
				}
			}
		}
		sess.mu.Unlock()
		if affected {
			doomed = append(doomed, sess)
		}
	}
	m.mu.Unlock()
	for _, watcher := range watchers {
		watcher.session.removeSink(watcher.sink)
		go func(sink *terminalSink) { _ = sink.close(websocket.StatusPolicyViolation, "access revoked") }(watcher.sink)
	}
	for _, sess := range doomed {
		reason := "access revoked"
		if event.Reason != "" {
			reason += ": " + event.Reason
		}
		sess.destroyWithCode(websocket.StatusPolicyViolation, reason)
	}
}
