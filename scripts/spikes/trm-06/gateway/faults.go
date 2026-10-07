package main

import (
	"errors"
	"net"
	"sync"
	"time"
)

// Disposable owner-only relay fault injection. Member SSH requests cannot
// reach it. It closes actual DialWorkspacePort transports, never a test shim.
type relayFaults struct {
	mu          sync.Mutex
	deniedUntil time.Time
	connections map[*faultConnection]struct{}
}
type faultConnection struct {
	net.Conn
	owner *relayFaults
	once  sync.Once
}

func (c *faultConnection) Close() error {
	err := c.Conn.Close()
	c.once.Do(func() { c.owner.mu.Lock(); delete(c.owner.connections, c); c.owner.mu.Unlock() })
	return err
}
func (f *relayFaults) admit(connection net.Conn) (net.Conn, error) {
	if f == nil {
		return connection, nil
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if time.Now().Before(f.deniedUntil) {
		connection.Close()
		return nil, errors.New("reference relay cut active")
	}
	if f.connections == nil {
		f.connections = make(map[*faultConnection]struct{})
	}
	owned := &faultConnection{Conn: connection, owner: f}
	f.connections[owned] = struct{}{}
	return owned, nil
}
func (f *relayFaults) cut(duration time.Duration) {
	f.mu.Lock()
	f.deniedUntil = time.Now().Add(duration)
	owned := make([]*faultConnection, 0, len(f.connections))
	for connection := range f.connections {
		owned = append(owned, connection)
	}
	f.mu.Unlock()
	for _, connection := range owned {
		connection.Close()
	}
}
