package ssh

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"sync"
	"time"
)

// ConnectTCP opens only the daemon's guest-loopback primitive; net.Pipe is an
// in-process read buffer, never a host network destination.
func (b *DaemonBridge) ConnectTCP(ctx context.Context, a WorkspaceAccess, port uint16) (WorkspaceTCPConnection, error) {
	if err := b.Validate(ctx, a); err != nil {
		return nil, err
	}
	if port == 0 {
		return nil, ErrWorkspaceAccessDenied
	}
	reserved, err := b.Track(ctx, a, 0)
	if err != nil {
		return nil, err
	}
	if reserved == nil {
		return nil, ErrWorkspaceUnavailable
	}
	client, release, err := b.Admit(ctx, a, daemonAdmission(a), io.Discard)
	if err != nil {
		reserved()
		return nil, err
	}
	cleanup := func() {
		reserved()
		if release != nil {
			release()
		}
	}
	if client == nil {
		cleanup()
		return nil, ErrWorkspaceUnavailable
	}
	if err = b.Validate(ctx, a); err != nil {
		cleanup()
		return nil, err
	}
	id, err := client.TCPConnect(ctx, port)
	if err != nil {
		cleanup()
		return nil, err
	}
	closeSession := func() {
		closing, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = client.CloseSession(closing, id)
		cleanup()
	}
	untrack, err := b.Track(ctx, a, id)
	if err != nil || untrack == nil {
		closeSession()
		if err == nil {
			err = ErrWorkspaceUnavailable
		}
		return nil, err
	}
	stream, err := client.Stream(ctx, id)
	if err != nil {
		untrack()
		closeSession()
		return nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	reader, writer := net.Pipe()
	input, inputReader := net.Pipe()
	conn := &daemonTCP{Conn: reader, writer: writer, input: input, inputReader: inputReader, inputDone: make(chan struct{}), ctx: ctx, cancel: cancel, stream: stream, release: func() { untrack(); closeSession() }}
	go conn.pumpInput()
	go func() {
		defer writer.Close()
		for {
			payload, err := stream.Receive(ctx)
			if err != nil {
				return
			}
			if len(payload) == 0 {
				return
			}
			switch payload[0] {
			case 1:
				if len(payload) < 2 || payload[1] != 1 {
					return
				}
				n, err := writer.Write(payload[2:])
				if err != nil {
					return
				}
				if n > 0 {
					credit := []byte{6, 0, 0, 0, 0}
					binary.BigEndian.PutUint32(credit[1:], uint32(n))
					if stream.Send(ctx, credit) != nil {
						return
					}
				}
			case 2:
				if len(payload) != 2 || payload[1] != 1 {
					return
				}
				return
			case 6:
				if len(payload) != 5 {
					return
				}
			case 5, 7:
				return
			default:
				return
			}
		}
	}()
	return conn, nil
}

type daemonTCP struct {
	net.Conn
	writer, input, inputReader net.Conn
	ctx                        context.Context
	cancel                     context.CancelFunc
	stream                     DaemonStream
	release                    func()
	once, halfOnce             sync.Once
	inputDone                  chan struct{}
	inputErr                   error
}

func (c *daemonTCP) pumpInput() {
	defer close(c.inputDone)
	defer c.inputReader.Close()
	buffer := make([]byte, 32768)
	for {
		n, err := c.inputReader.Read(buffer)
		if n > 0 {
			if e := c.stream.Send(c.ctx, append([]byte{1, 0}, buffer[:n]...)); e != nil {
				c.inputErr = e
				return
			}
		}
		if err != nil {
			if err == io.EOF {
				err = c.stream.Send(c.ctx, []byte{2, 0})
			}
			c.inputErr = err
			return
		}
	}
}
func (c *daemonTCP) Write(p []byte) (int, error) { return c.input.Write(p) }
func (c *daemonTCP) CloseWrite() error {
	c.halfOnce.Do(func() { _ = c.input.Close() })
	select {
	case <-c.inputDone:
		return c.inputErr
	case <-c.ctx.Done():
		return c.ctx.Err()
	}
}
func (c *daemonTCP) Close() error {
	c.once.Do(func() {
		c.cancel()
		_ = c.input.Close()
		_ = c.inputReader.Close()
		_ = c.writer.Close()
		_ = c.Conn.Close()
		c.release()
	})
	return nil
}
func (c *daemonTCP) SetWriteDeadline(t time.Time) error { return c.input.SetWriteDeadline(t) }
func (c *daemonTCP) SetDeadline(t time.Time) error {
	_ = c.SetWriteDeadline(t)
	return c.SetReadDeadline(t)
}
