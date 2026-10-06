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

// sessionRegistry tracks every live SSH session with the principal it was
// authorized as, so a revocation can end it. An SSH session is authorized
// once at connection time (public key for git and LFS, a workspace access
// token for workspace logins) and the guest never re-checks; closing the
// session is the only way to enforce a revocation that lands mid-session.
type sessionRegistry struct {
	mu       sync.Mutex
	sessions map[ssh.Session]revocation.Principal
	channels map[io.Closer]revocation.Principal
	unsub    func()
}

var liveSessions = &sessionRegistry{sessions: map[ssh.Session]revocation.Principal{}}

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

func (r *sessionRegistry) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.sessions) + len(r.channels)
}

// handle closes every live session the event revokes, telling the client why
// on stderr first so the disconnect is not mistaken for a network fault.
func (r *sessionRegistry) handle(event revocation.Event) {
	r.mu.Lock()
	var doomed []ssh.Session
	var channels []io.Closer
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
	return principal
}
