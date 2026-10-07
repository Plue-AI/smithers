package machined

import (
	"context"
	"time"
)

// SessionIdentities persists host spawn bindings independently of a network
// link. Outbox replay after reconnect must not depend on a live stream reader.
type SessionIdentities interface {
	Record(context.Context, string, [16]byte, uint32, SessionUser) error
	Lookup(context.Context, string, [16]byte, uint32) (SessionUser, error)
}

func (r *Registry) BindSessionIdentities(store SessionIdentities) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.identities = store
}

// SessionIdentity returns only the user bound by the host's admitted spawn
// reply. It never trusts a user or principal claimed by a daemon event. Callers
// ingesting events must already fence this link through their receipt commit.
func (l *Link) SessionIdentity(ctx context.Context, id uint32) (SessionUser, error) {
	if l == nil {
		return SessionUser{}, ErrNotReady
	}
	if l.identities != nil {
		deadline := time.Now().Add(time.Second)
		for {
			user, err := l.identities.Lookup(ctx, l.boot.branch, l.boot.id, id)
			if err != ErrNotReady {
				return user, err
			}
			l.mu.Lock()
			pending := l.sessions[id] != nil
			l.mu.Unlock()
			if !pending || !time.Now().Before(deadline) {
				return SessionUser{}, ErrNotReady
			}
			timer := time.NewTimer(10 * time.Millisecond)
			select {
			case <-ctx.Done():
				timer.Stop()
				return SessionUser{}, ctx.Err()
			case <-timer.C:
			}
		}
	}
	l.mu.Lock()
	peer := l.sessions[id]
	l.mu.Unlock()
	if peer == nil {
		return SessionUser{}, ErrUnauthorized
	}
	peer.mu.Lock()
	defer peer.mu.Unlock()
	if peer.user == nil {
		return SessionUser{}, ErrNotReady
	}
	return *peer.user, nil
}
