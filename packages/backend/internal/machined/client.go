package machined

import (
	"context"
	"net"
	"sync"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// LinkSource is the only topology seam. Above it relay and bridge share the
// same handshake, lease and client. Runtime keeps ownership of the byte pipe.
type LinkSource interface {
	Next(context.Context) (net.Conn, error)
}
type RelayLink struct {
	Dialer    workspaceapi.PortDialer
	Workspace string
}

func (l RelayLink) Next(ctx context.Context) (net.Conn, error) {
	if l.Dialer == nil || l.Workspace == "" {
		return nil, ErrNotReady
	}
	return l.Dialer.DialWorkspacePort(ctx, l.Workspace, workspaceapi.PortRequest{Port: 970, Purpose: workspaceapi.PortPurposeMachined})
}

// FrameHandler handles event/object/session frames while RPCs are pending.
// Durable events are never acknowledged here: the transactional ingest owner
// must explicitly write its acknowledgement only after its commit succeeds.
// Handlers run on the reader: they may Send but must not synchronously Call.
type FrameHandler func(context.Context, *Client, wire.Frame) error

type pendingCall struct {
	method wire.Method
	result chan callResult
}
type callResult struct {
	value wire.Value
	err   error
}
type Client struct {
	stream  net.Conn
	lease   *Connection
	branch  string
	ctx     context.Context
	cancel  context.CancelFunc
	handler FrameHandler
	writeMu sync.Mutex
	mu      sync.Mutex
	next    uint32
	calls   map[uint32]pendingCall
	failure error
	done    chan struct{}
}

// Connect validates host-authoritative branch/boot binding before offering a
// nonce proof. A bad newcomer never displaces the current authenticated lease.
// The returned client remains not_ready until wake reconciliation is complete.
func (r *Registry) Connect(ctx context.Context, branch string, source LinkSource, handler FrameHandler) (*Client, error) {
	if source == nil || branch == "" {
		return nil, ErrUnauthorized
	}
	stream, err := source.Next(ctx)
	if err != nil {
		return nil, err
	}
	c, err := r.Accept(ctx, branch, stream, handler)
	if err != nil {
		_ = stream.Close()
	}
	return c, err
}

// Accept is also the bridge listener entry; branch must be host-authoritative.
func (r *Registry) Accept(ctx context.Context, branch string, stream net.Conn, handler FrameHandler) (*Client, error) {
	if stream == nil {
		return nil, ErrUnauthorized
	}
	ok := false
	defer func() {
		if !ok {
			_ = stream.Close()
		}
	}()
	stop := context.AfterFunc(ctx, func() { _ = stream.Close() })
	defer stop()
	readHello := func(variant byte) (wire.Value, error) {
		deadline := time.Now().Add(5 * time.Second)
		if d, yes := ctx.Deadline(); yes && d.Before(deadline) {
			deadline = d
		}
		if err := stream.SetDeadline(deadline); err != nil {
			return wire.Value{}, err
		}
		frame, err := wire.Read(stream)
		if err != nil {
			return wire.Value{}, err
		}
		value, err := frame.Message()
		if err != nil || frame.Kind != wire.Hello || value.Variant != variant {
			return wire.Value{}, wire.HandshakeOrder
		}
		return value, nil
	}
	challenge, err := readHello(1)
	if err != nil {
		return nil, err
	}
	var id [16]byte
	var nonce [32]byte
	copy(id[:], challenge.Fields[3].Data)
	copy(nonce[:], challenge.Fields[4].Data)
	r.mu.Lock()
	b := r.boots[id]
	bound := b != nil && r.branches[branch] == b && b.branch == branch
	r.mu.Unlock()
	if !bound {
		return nil, ErrUnauthorized
	}
	proof, err := r.HostProof(id, nonce)
	if err != nil {
		return nil, err
	}
	if err := wire.Write(stream, wire.Frame{Kind: wire.Hello, Payload: wire.Union(2, wire.Field(1, wire.U16(wire.Protocol)), wire.Field(2, proof[:]))}); err != nil {
		return nil, err
	}
	hello, err := readHello(3)
	if err != nil {
		return nil, err
	}
	lease, err := r.Admit(id, hello.Fields[1].Data, stream)
	if err != nil {
		return nil, err
	}
	if err := wire.Write(stream, wire.Frame{Kind: wire.Hello, Payload: wire.Union(4)}); err != nil {
		_ = lease.Close()
		return nil, err
	}
	if err := stream.SetDeadline(time.Time{}); err != nil {
		_ = lease.Close()
		return nil, err
	}
	clientCtx, cancel := context.WithCancel(ctx)
	c := &Client{stream: stream, lease: lease, branch: branch, ctx: clientCtx, cancel: cancel, handler: handler, calls: make(map[uint32]pendingCall), done: make(chan struct{})}
	if err := ctx.Err(); err != nil {
		cancel()
		_ = lease.Close()
		return nil, err
	}
	ok = true
	go c.readLoop()
	go func() { <-clientCtx.Done(); _ = c.Close() }()
	return c, nil
}

func (c *Client) readLoop() {
	defer close(c.done)
	for {
		frame, err := wire.Read(c.stream)
		if err != nil {
			c.fail(err)
			return
		}
		if err := c.current(); err != nil {
			c.fail(err)
			return
		}
		if frame.Kind == wire.Control {
			msg, err := frame.Message()
			if err != nil || msg.Variant != 2 {
				c.fail(wire.BadValue)
				return
			}
			id := uint32(msg.Fields[1].Number)
			c.mu.Lock()
			call, found := c.calls[id]
			delete(c.calls, id)
			c.mu.Unlock()
			if !found {
				c.fail(wire.BadValue)
				return
			}
			result := msg.Fields[2]
			if result.Variant != 255 && result.Variant != byte(call.method) {
				c.fail(wire.BadValue)
				call.result <- callResult{err: wire.BadValue}
				return
			}
			call.result <- callResult{value: result}
		} else if frame.Kind == wire.Documents {
			err := c.Send(c.ctx, wire.Frame{Kind: wire.Documents, Stream: frame.Stream, Payload: wire.Union(255, wire.Field(1, []byte{byte(wire.UnsupportedMethod)}))})
			if err != nil {
				c.fail(err)
				return
			}
		} else if frame.Kind == wire.Hello || c.handler == nil {
			c.fail(wire.UnknownMessage)
			return
		} else if err := c.handler(c.ctx, c, frame); err != nil {
			c.fail(err)
			return
		}
	}
}

func (c *Client) current() error {
	r := c.lease.registry
	r.mu.Lock()
	defer r.mu.Unlock()
	if !c.lease.current() {
		return ErrUnauthorized
	}
	return nil
}
func (c *Client) fail(err error) {
	c.mu.Lock()
	if c.failure == nil {
		c.failure = err
	}
	for id, call := range c.calls {
		call.result <- callResult{err: c.failure}
		delete(c.calls, id)
	}
	c.mu.Unlock()
	c.cancel()
	_ = c.lease.Close()
}
func (c *Client) Close() error { c.fail(net.ErrClosed); return nil }

// Send serializes frames across RPC, event acknowledgements and stream credit.
func (c *Client) Send(ctx context.Context, frame wire.Frame) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := c.current(); err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	c.mu.Lock()
	err := c.failure
	c.mu.Unlock()
	if err != nil {
		return err
	}
	// Cancellation interrupts a blocked write and ends the stream: partial frames
	// cannot be retried safely on this connection.
	stop := context.AfterFunc(ctx, func() { _ = c.stream.Close() })
	defer stop()
	err = wire.Write(c.stream, frame)
	if err != nil {
		c.fail(err)
	}
	return err
}

// Call correlates concurrent responses without pausing event/object intake.
// Cancelled requests retain their id until a reply or disconnect, so a late
// response cannot be mistaken for another call.
func (c *Client) Call(ctx context.Context, method wire.Method, fields ...[]byte) (wire.Value, error) {
	if err := ctx.Err(); err != nil {
		return wire.Value{}, err
	}
	if method == wire.Status || method == wire.WakeReconcile {
		if err := c.current(); err != nil {
			return wire.Value{}, err
		}
	} else if err := c.lease.RequireReady(c.branch); err != nil {
		return wire.Value{}, err
	}
	c.mu.Lock()
	if c.failure != nil {
		err := c.failure
		c.mu.Unlock()
		return wire.Value{}, err
	}
	if len(c.calls) >= 1024 {
		c.mu.Unlock()
		return wire.Value{}, refused("busy", "too many pending calls")
	}
	for {
		c.next++
		if c.next != 0 {
			if _, exists := c.calls[c.next]; !exists {
				break
			}
		}
	}
	id := c.next
	call := pendingCall{method: method, result: make(chan callResult, 1)}
	frame, err := wire.RequestFrame(id, method, fields...)
	if err != nil {
		c.mu.Unlock()
		return wire.Value{}, err
	}
	c.calls[id] = call
	c.mu.Unlock()
	if err := c.Send(ctx, frame); err != nil {
		c.fail(err)
		return wire.Value{}, err
	}
	select {
	case <-ctx.Done():
		return wire.Value{}, ctx.Err()
	case result := <-call.result:
		if result.err != nil {
			return wire.Value{}, result.err
		}
		if result.value.Variant == 255 {
			return wire.Value{}, decodeRPCError(result.value)
		}
		return result.value, nil
	}
}

// RPCError retains the digest/session/limit needed by HTTP refusal mapping.
type RPCError struct {
	Code           wire.ErrorCode
	Detail         string
	CurrentDigest  []byte
	Session, Limit uint32
	Protocol       wire.ProtocolError
	OIDs           [][]byte
}

func (e *RPCError) Error() string {
	names := [...]string{"", "malformed", "unsupported", "not_ready", "stale", "not_found", "invalid_path", "not_regular", "too_large", "busy", "moved_off", "unauthorized", "internal"}
	return names[e.Code]
}
func decodeRPCError(v wire.Value) error {
	e := &RPCError{Code: wire.ErrorCode(v.Fields[1].Number), Detail: string(v.Fields[2].Data), CurrentDigest: v.Fields[3].Data, Session: uint32(v.Fields[4].Number), Limit: uint32(v.Fields[5].Number), Protocol: wire.ProtocolError(v.Fields[6].Number)}
	for _, oid := range v.Fields[7].Items {
		e.OIDs = append(e.OIDs, oid.Data)
	}
	return e
}
