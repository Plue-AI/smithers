package ssh

import (
	"context"
	"fmt"
	"io"
	"sync"

	"github.com/gliderlabs/ssh"

	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

// RevocationSource fans revocation events out to this process; *revocation.Bus
// satisfies it.
type RevocationSource interface {
	Subscribe(fn func(revocation.Event)) func()
}

// sessionRegistry tracks SSH connections, sessions and forwarding channels
// with their principals, so revocation also ends idle connections. SSH is authorized
// once at connection time (public key for git and LFS, a workspace access
// token for workspace logins) and the guest never re-checks; closing the
// connection prevents both ongoing access and opening replacement channels.
type sessionRegistry struct {
	mu       sync.Mutex
	sessions map[ssh.Session]revocation.Principal
	channels map[io.Closer]revocation.Principal
	// The connection outlives its sessions. Read its authenticated context at
	// revocation time; the TCP accept callback runs before SSH authentication.
	connections map[io.Closer]context.Context
	unsub       func()
}

var liveSessions = &sessionRegistry{sessions: map[ssh.Session]revocation.Principal{}}

const authFingerprintKey contextKey = "auth-key-fingerprint"

// SetRevocationSource subscribes the SSH server to source. Call once at
// startup; a nil source disables revocation-driven termination.
func SetRevocationSource(source RevocationSource) {
	liveSessions.mu.Lock()
	defer liveSessions.mu.Unlock()
	if liveSessions.unsub != nil {
		liveSessions.unsub()
		liveSessions.unsub = nil
	}
	if source != nil {
		liveSessions.unsub = source.Subscribe(liveSessions.handle)
	}
}

func (r *sessionRegistry) add(sess ssh.Session, principal revocation.Principal) {
	r.mu.Lock()
	r.sessions[sess] = principal
	r.mu.Unlock()
}

func (r *sessionRegistry) remove(sess ssh.Session) {
	r.mu.Lock()
	delete(r.sessions, sess)
	r.mu.Unlock()
}

func (r *sessionRegistry) addChannel(channel io.Closer, principal revocation.Principal) func() {
	r.mu.Lock()
	if r.channels == nil {
		r.channels = make(map[io.Closer]revocation.Principal)
	}
	r.channels[channel] = principal
	r.mu.Unlock()
	return func() {
		r.mu.Lock()
		delete(r.channels, channel)
		r.mu.Unlock()
	}
}

func (r *sessionRegistry) addConnection(conn io.Closer, ctx context.Context) func() {
	r.mu.Lock()
	if r.connections == nil {
		r.connections = make(map[io.Closer]context.Context)
	}
	r.connections[conn] = ctx
	r.mu.Unlock()
	return func() {
		r.mu.Lock()
		delete(r.connections, conn)
		r.mu.Unlock()
	}
}

func (r *sessionRegistry) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.sessions) + len(r.channels) + len(r.connections)
}

// handle closes every affected transport and channel. Session stderr receives
// a best-effort reason; transport termination must not wait for a slow reader.
func (r *sessionRegistry) handle(event revocation.Event) {
	r.mu.Lock()
	var doomed []ssh.Session
	var channels []io.Closer
	var connections []io.Closer
	for conn, ctx := range r.connections {
		if event.Affects(contextPrincipal(ctx)) {
			connections = append(connections, conn)
			delete(r.connections, conn)
		}
	}
	for channel, principal := range r.channels {
		if event.Affects(principal) {
			channels = append(channels, channel)
			delete(r.channels, channel)
		}
	}
	for sess, principal := range r.sessions {
		if event.Affects(principal) {
			doomed = append(doomed, sess)
			delete(r.sessions, sess)
		}
	}
	r.mu.Unlock()
	// End the authenticated transport as well as current channels. Otherwise
	// an idle client (or SSH ControlMaster) can reuse its revoked credential.
	// Closing first also prevents a blocked stderr write delaying revocation.
	for _, conn := range connections {
		_ = conn.Close()
	}
	for _, channel := range channels {
		_ = channel.Close()
	}
	for _, sess := range doomed {
		reason := "access revoked"
		if event.Reason != "" {
			reason += ": " + event.Reason
		}
		_, _ = fmt.Fprintln(sess.Stderr(), "ERROR: "+reason)
		_ = sess.Exit(1)
		_ = sess.Close()
	}
}

// sessionPrincipal describes what a session was authorized as: the key's
// user for git and LFS sessions, the sandbox for workspace logins.
func sessionPrincipal(sess ssh.Session) revocation.Principal {
	return contextPrincipal(sess.Context())
}

func contextPrincipal(ctx context.Context) revocation.Principal {
	var principal revocation.Principal
	if p, ok := ctx.Value(principalKey).(sshPrincipal); ok {
		principal.KeyFingerprint = p.Fingerprint
		if !p.IsDeployKey {
			principal.UserID = p.UserID
		}
	}
	if workspace, ok := ctx.Value(workspaceAccessKey).(WorkspaceAccess); ok {
		principal.SandboxID = workspace.SandboxID
	}
	if fingerprint, ok := ctx.Value(authFingerprintKey).(string); ok {
		principal.KeyFingerprint = fingerprint
	}
	return principal
}
