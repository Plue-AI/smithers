package main

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"sync"
	"time"
)

// Reserve an authenticated control transport before SSH admission. Ben can
// fill unauthenticated listener slots through guest loopback; revocation must
// not depend on opening another connection through that occupied queue.
type adminControl struct {
	mu      sync.Mutex
	ctx     context.Context
	cancel  context.CancelFunc
	connect func(context.Context) (net.Conn, error)
	lease   *adminLease
}
type adminLease struct {
	connection net.Conn
	done       chan struct{}
	reply      controlReply
	err        error
	sent       bool
}

func newAdminControl(ctx context.Context, connect func(context.Context) (net.Conn, error)) *adminControl {
	owned, cancel := context.WithCancel(ctx)
	return &adminControl{ctx: owned, cancel: cancel, connect: connect}
}
func (a *adminControl) ensure(ctx context.Context) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.ctx.Err() != nil {
		return a.ctx.Err()
	}
	if a.lease != nil {
		select {
		case <-a.lease.done:
			if a.lease.sent {
				return errors.New("revocation already issued")
			}
			a.lease = nil
		default:
			return nil
		}
	}
	connection, err := a.connect(ctx)
	if err != nil {
		return err
	}
	lease := &adminLease{connection: connection, done: make(chan struct{})}
	a.lease = lease
	go func() {
		var length uint32
		if err := binary.Read(connection, binary.BigEndian, &length); err != nil {
			lease.err = err
		} else if length == 0 || length > 4096 {
			lease.err = errors.New("invalid reserved control reply")
		} else {
			body := make([]byte, length)
			if _, err := io.ReadFull(connection, body); err != nil {
				lease.err = err
			} else {
				lease.err = strictControlReply(body, &lease.reply)
			}
		}
		connection.Close()
		close(lease.done)
	}()
	return nil
}
func (a *adminControl) watch() {
	for {
		select {
		case <-a.ctx.Done():
			return
		case <-time.After(100 * time.Millisecond):
		}
		attempt, cancel := context.WithTimeout(a.ctx, 5*time.Second)
		_ = a.ensure(attempt)
		cancel()
	}
}
func (a *adminControl) close() {
	a.cancel()
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.lease != nil {
		a.lease.connection.Close()
	}
}
func (a *adminControl) revoke(ctx context.Context) error {
	if err := a.ensure(ctx); err != nil {
		return err
	}
	a.mu.Lock()
	lease := a.lease
	if lease.sent {
		a.mu.Unlock()
		return errors.New("revocation already issued")
	}
	lease.sent = true
	a.mu.Unlock()
	deadline := time.Now().Add(5 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	if err := lease.connection.SetDeadline(deadline); err != nil {
		return err
	}
	stop := context.AfterFunc(ctx, func() { lease.connection.Close() })
	defer stop()
	if err := (&frameWriter{w: lease.connection}).write(map[string]string{"type": "kill_sessions"}); err != nil {
		return err
	}
	select {
	case <-lease.done:
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if lease.err != nil {
			return lease.err
		}
		if !lease.reply.OK || lease.reply.Class != "" || lease.reply.Code != "" {
			return errors.New("guest drain not confirmed")
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
