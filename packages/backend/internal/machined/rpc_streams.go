package machined

import (
	"context"
	"encoding/binary"
	"io"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
)

var _ Client = (*Registry)(nil)

func (r *Registry) OpenDocument(ctx context.Context, branch, path string, actor []byte) (DocumentStream, error) {
	l, err := r.Current(branch)
	if err != nil {
		return nil, err
	}
	// Live mirrors require sequenced save receipts. Retained v1 decoding does
	// not authorize sending v2 document traffic to an older live daemon.
	if l.protocol < wire.SequencedDocumentProtocol {
		return nil, ErrNotReady
	}
	if len(actor) == 0 || len(actor) > 1024 {
		return nil, ErrUnauthorized
	}
	l.mu.Lock()
	if len(l.documents)+l.openingDocuments >= 16 {
		l.mu.Unlock()
		return nil, refused("busy", "document stream limit")
	}
	l.openingDocuments++
	l.mu.Unlock()
	defer func() { l.mu.Lock(); l.openingDocuments--; l.mu.Unlock() }()
	fields, err := l.call(ctx, branch, wire.OpenDoc, wire.Field(1, wire.String(path)), wire.Field(2, principal(actor)))
	if err != nil {
		_ = l.Close()
		return nil, err
	}
	id := binary.BigEndian.Uint32(fields[1])
	if id == 0 {
		return nil, wire.BadStream
	}
	l.mu.Lock()
	queue := l.documents[id]
	if queue == nil && len(l.documents) < 16 {
		queue = make(chan []byte, 8)
		l.documents[id] = queue
	}
	l.mu.Unlock()
	if queue == nil {
		_ = l.Close()
		return nil, wire.BadStream
	}
	return &documentPeer{link: l, branch: branch, id: id, queue: queue, done: make(chan struct{})}, nil
}

type documentPeer struct {
	link   *Link
	branch string
	id     uint32
	queue  chan []byte
	done   chan struct{}
}

func (d *documentPeer) Send(ctx context.Context, bytes []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := d.link.RequireReady(d.branch); err != nil {
		return err
	}
	select {
	case <-d.done:
		return io.ErrClosedPipe
	default:
	}
	return d.link.sendContext(ctx, wire.Frame{Kind: wire.Documents, Stream: d.id, Payload: append([]byte(nil), bytes...)})
}
func (d *documentPeer) Receive(ctx context.Context) ([]byte, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-d.done:
		return nil, io.ErrClosedPipe
	case <-d.link.done:
		return nil, io.ErrClosedPipe
	case bytes := <-d.queue:
		if err := d.link.RequireReady(d.branch); err != nil {
			return nil, err
		}
		return bytes, nil
	}
}
func (d *documentPeer) Close() error {
	d.link.mu.Lock()
	select {
	case <-d.done:
		d.link.mu.Unlock()
		return nil
	default:
		close(d.done)
	}
	// Wake local readers before waiting for the daemon close receipt.
	d.link.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := d.link.call(ctx, d.branch, wire.CloseDoc, wire.Field(1, wire.U32(d.id)))
	if err != nil {
		_ = d.link.Close()
		return err
	}
	d.link.mu.Lock()
	delete(d.link.documents, d.id)
	d.link.mu.Unlock()
	return nil
}
func (r *Registry) Sessions(branch string) SessionRPC { return registrySessions{r, branch} }

type registrySessions struct {
	registry *Registry
	branch   string
}

func (s registrySessions) CallSession(ctx context.Context, call SessionCall) (SessionResult, error) {
	l, err := s.registry.Current(s.branch)
	if err != nil {
		return SessionResult{}, err
	}
	var method wire.Method
	var fields [][]byte
	user := func() []byte {
		return wire.Struct(wire.Field(1, wire.String(call.User.Login)), wire.Field(2, wire.U32(call.User.UID)))
	}
	switch call.Method {
	case "open_session":
		if call.User == nil || !validUser(*call.User) || len(call.Argv) > 65535 {
			return SessionResult{}, ErrUnauthorized
		}
		method = wire.OpenSession
		fields = [][]byte{wire.Field(1, user()), wire.Field(2, []byte{byte(call.Kind)})}
		if call.Argv != nil {
			list := wire.U16(uint16(len(call.Argv)))
			for _, arg := range call.Argv {
				list = append(list, wire.String(arg)...)
			}
			fields = append(fields, wire.Field(3, list))
		}
		if call.Size != nil {
			fields = append(fields, wire.Field(4, wire.Struct(wire.Field(1, wire.U16(call.Size.Cols)), wire.Field(2, wire.U16(call.Size.Rows)))))
		}
	case "tcp_connect":
		method = wire.TCPConnect
		fields = [][]byte{wire.Field(1, wire.U16(call.Port))}
	case "close_session":
		method = wire.CloseSession
		fields = [][]byte{wire.Field(1, wire.U32(call.Session))}
	case "kill_sessions":
		method = wire.KillSessions
		target := wire.Union(2, wire.Field(1, wire.String(call.Run)))
		if call.User != nil {
			if !validUser(*call.User) {
				return SessionResult{}, ErrUnauthorized
			}
			target = wire.Union(1, wire.Field(1, user()))
		}
		fields = [][]byte{wire.Field(1, target)}
	case "register_run":
		method = wire.RegisterRun
		fields = [][]byte{wire.Field(1, wire.String(call.Run)), wire.Field(2, wire.U32(call.Session))}
	case "attach_session":
		method = wire.AttachSession
		fields = [][]byte{wire.Field(1, wire.U32(call.Session)), wire.Field(2, wire.U64(call.Received))}
	default:
		return SessionResult{}, wire.UnknownMethod
	}
	result, err := l.call(ctx, s.branch, method, fields...)
	if err != nil {
		return SessionResult{}, err
	}
	switch method {
	case wire.OpenSession, wire.TCPConnect:
		return SessionResult{Session: binary.BigEndian.Uint32(result[1])}, nil
	case wire.KillSessions:
		return SessionResult{Killed: binary.BigEndian.Uint16(result[1])}, nil
	case wire.AttachSession:
		return SessionResult{Received: binary.BigEndian.Uint64(result[1])}, nil
	default:
		return SessionResult{}, nil
	}
}
