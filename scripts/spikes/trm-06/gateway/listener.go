package main

import (
	"bytes"
	"context"
	"errors"
	"net"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// listenerAuthority is supplied by the installed provider, never by SSH bytes.
// It is intentionally not constructible from flags, receipts or branch paths.
// The provider must check provenance before handing this adapter a listener.
type listenerAuthority struct {
	hostKey   ssh.Signer
	benKey    ssh.PublicKey
	openGuest sessionOpener
}

// serveListener owns connections until cancellation. Authentication fixes the
// sole spike member to Ben; passwords, arbitrary usernames and other keys fail.
func serveListener(ctx context.Context, listener net.Listener, authority listenerAuthority) error {
	if authority.hostKey == nil || authority.benKey == nil || authority.openGuest == nil {
		return errAuthority
	}
	config := &ssh.ServerConfig{MaxAuthTries: 3, PublicKeyCallback: func(metadata ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
		if metadata.User() != "ben" || !bytes.Equal(key.Marshal(), authority.benKey.Marshal()) {
			return nil, errors.New("member authentication refused")
		}
		return &ssh.Permissions{Extensions: map[string]string{"login": "ben"}}, nil
	}}
	config.AddHostKey(authority.hostKey)
	var mu sync.Mutex
	connections := make(map[net.Conn]struct{})
	limit := make(chan struct{}, 128)
	var workers sync.WaitGroup
	finished := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
		case <-finished:
		}
		listener.Close()
		mu.Lock()
		for connection := range connections {
			connection.Close()
		}
		mu.Unlock()
	}()
	defer func() {
		close(finished)
		listener.Close()
		mu.Lock()
		for connection := range connections {
			connection.Close()
		}
		mu.Unlock()
		workers.Wait()
	}()
	for {
		connection, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return err
		}
		select {
		case limit <- struct{}{}:
		default:
			connection.Close()
			continue
		}
		mu.Lock()
		connections[connection] = struct{}{}
		mu.Unlock()
		workers.Add(1)
		go func() {
			defer workers.Done()
			defer func() { <-limit }()
			defer func() { connection.Close(); mu.Lock(); delete(connections, connection); mu.Unlock() }()
			// Bound unauthenticated peers; clear the deadline only after SSH auth.
			connection.SetDeadline(time.Now().Add(10 * time.Second))
			server, channels, requests, err := ssh.NewServerConn(connection, config)
			if err != nil {
				return
			}
			defer server.Close()
			connection.SetDeadline(time.Time{})
			serveChannels(channels, requests, authority.openGuest)
		}()
	}
}
