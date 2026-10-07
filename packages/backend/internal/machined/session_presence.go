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

// RunPresence resolves only a run successfully registered on this admitted link.
// It is attribution evidence, not a grant to operate on the branch.
func (l *Link) RunPresence(branch, run string) (string, error) {
	if err := l.RequireReady(branch); err != nil {
		return "", err
	}
	if run == "" {
		return "", ErrUnauthorized
	}
	l.mu.Lock()
	ids := make([]uint32, 0, len(l.sessions))
	for id := range l.sessions {
		ids = append(ids, id)
	}
	l.mu.Unlock()
	for _, id := range ids {
		user, bound, via, err := l.SessionPresence(branch, id)
		if err == nil && user.Login == "agent" && bound == run {
			return via, nil
		}
	}
	return "", ErrUnauthorized
}
