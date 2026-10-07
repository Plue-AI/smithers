package machined

// SessionPresence reads the host-owned identity recorded by successful SessionRPC
// admission. Snapshot numbers never authorize a person or invent an agent run.
func (l *Link) SessionPresence(branch string, id uint32) (SessionUser, string, string, error) {
	if err := l.RequireReady(branch); err != nil {
		return SessionUser{}, "", "", err
	}
	l.mu.Lock()
	peer := l.sessions[id]
	l.mu.Unlock()
	if peer == nil {
		return SessionUser{}, "", "", ErrUnauthorized
	}
	peer.mu.Lock()
	defer peer.mu.Unlock()
	if peer.closed || peer.user == nil || !validUser(*peer.user) {
		return SessionUser{}, "", "", ErrUnauthorized
	}
	return *peer.user, peer.run, peer.via, nil
}
