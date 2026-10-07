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
	// Live mirrors use lossless actor keys as well as sequenced save receipts.
	// Recorded older frames still decode, but cannot authorize this live stream.
	if l.protocol < wire.DocumentActorProtocol {
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
func (r *Registry) Sessions(branch string) SessionRPC {
	return registrySessions{registry: r, branch: branch}
}

type registrySessions struct {
	registry   *Registry
	branch     string
	connection *Connection
}

func (s registrySessions) CallSession(ctx context.Context, call SessionCall) (SessionResult, error) {
	l, err := s.registry.Current(s.branch)
	if err != nil {
		return SessionResult{}, err
	}
	if s.connection != nil && l.Connection != s.connection {
		return SessionResult{}, ErrUnauthorized
	}
	l.sessionCallMu.Lock()
	defer l.sessionCallMu.Unlock()
	if call.Method == "open_session" || call.Method == "tcp_connect" {
		if l.protocol < wire.SessionActorProtocol {
			return SessionResult{}, refused("unsupported", "durable session attribution requires protocol 3")
		}
		if !validSessionActor(call) {
			return SessionResult{}, ErrUnauthorized
		}
		l.mu.Lock()
		full := len(l.sessions) >= 512
		l.mu.Unlock()
		if full {
			return SessionResult{}, refused("busy", "session limit")
		}
	}
	attached := false
	if call.Method == "attach_session" {
		if !validSession(call.Session) {
			return SessionResult{}, wire.BadStream
		}
		l.mu.Lock()
		if l.sessions[call.Session] == nil {
			if len(l.sessions) >= 512 {
				l.mu.Unlock()
				return SessionResult{}, refused("busy", "session limit")
			}
			peer := newSessionStream(l, call.Session)
			peer.received = call.Received
			l.sessions[call.Session] = peer
			attached = true
		}
		l.mu.Unlock()
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
		fields = append(fields, wire.Field(5, call.Actor))
		if call.Run != "" {
			fields = append(fields, wire.Field(6, wire.String(call.Run)))
		}
	case "tcp_connect":
		method = wire.TCPConnect
		fields = [][]byte{wire.Field(1, wire.U16(call.Port)), wire.Field(2, call.Actor)}
		if call.Run != "" {
			fields = append(fields, wire.Field(3, wire.String(call.Run)))
		}
	case "close_session":
		method = wire.CloseSession
		fields = [][]byte{wire.Field(1, wire.U32(call.Session))}
	case "kill_sessions":
		method = wire.KillSessions
		selectors := 0
		for _, selected := range []bool{call.User != nil, call.Run != "", call.Session != 0} {
			if selected {
				selectors++
			}
		}
		if selectors != 1 {
			return SessionResult{}, wire.BadValue
		}
		if call.Session != 0 {
			if !validSession(call.Session) {
				return SessionResult{}, wire.BadStream
			}
			if l.protocol < wire.SessionKillProtocol {
				return SessionResult{}, refused("unsupported", "session cancellation requires protocol 4")
			}
		}
		if call.Run != "" && !validString(call.Run) {
			return SessionResult{}, wire.BadValue
		}
		target := wire.Union(2, wire.Field(1, wire.String(call.Run)))
		if call.User != nil {
			if !validUser(*call.User) {
				return SessionResult{}, ErrUnauthorized
			}
			target = wire.Union(1, wire.Field(1, user()))
		}
		if call.Session != 0 {
			target = wire.Union(3, wire.Field(1, wire.U32(call.Session)))
		}
		fields = [][]byte{wire.Field(1, target)}
	case "register_run":
		l.mu.Lock()
		peer := l.sessions[call.Session]
		l.mu.Unlock()
		if peer == nil {
			return SessionResult{}, ErrUnauthorized
		}
		peer.mu.Lock()
		same := peer.user != nil && peer.user.UID == 19999 && peer.run == call.Run && call.Run != ""
		peer.mu.Unlock()
		if !same {
			return SessionResult{}, ErrUnauthorized
		}
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
		if attached {
			l.mu.Lock()
			delete(l.sessions, call.Session)
			l.mu.Unlock()
		}
		if ctx.Err() != nil {
			_ = l.Close()
		}
		return SessionResult{}, err
	}
	switch method {
	case wire.OpenSession, wire.TCPConnect:
		id := binary.BigEndian.Uint32(result[1])
		l.mu.Lock()
		peer := l.sessions[id]
		l.mu.Unlock()
		if peer == nil {
			return SessionResult{}, wire.BadStream
		}
		if method == wire.TCPConnect {
			peer.mu.Lock()
			peer.user = &SessionUser{"agent", 19999}
			peer.mu.Unlock()
		}
		peer.mu.Lock()
		peer.run = call.Run
		peer.mu.Unlock()
		if call.User != nil {
			peer.mu.Lock()
			copy := *call.User
			peer.user = &copy
			peer.via = call.Via
			peer.mu.Unlock()
		}
		if call.User != nil && l.identities != nil {
			if err := l.identities.Record(ctx, s.branch, l.boot.id, id, *call.User); err != nil {
				cleanup, stop := context.WithTimeout(context.Background(), time.Second)
				_, _ = l.call(cleanup, s.branch, wire.CloseSession, wire.Field(1, wire.U32(id)))
				stop()
				_ = l.Close()
				return SessionResult{}, err
			}
		}
		return SessionResult{Session: id}, nil
	case wire.KillSessions:
		if call.Session != 0 && binary.BigEndian.Uint16(result[1]) > 1 {
			_ = l.Close()
			return SessionResult{}, wire.BadValue
		}
		l.mu.Lock()
		for id, peer := range l.sessions {
			peer.mu.Lock()
			matches := call.Session != 0 && id == call.Session || call.User != nil && peer.user != nil && *peer.user == *call.User || call.Run != "" && peer.run == call.Run
			peer.mu.Unlock()
			if matches {
				peer.finish()
				delete(l.sessions, id)
			}
		}
		l.mu.Unlock()
		return SessionResult{Killed: binary.BigEndian.Uint16(result[1])}, nil
	case wire.AttachSession:
		received := binary.BigEndian.Uint64(result[1])
		if attached {
			l.mu.Lock()
			peer := l.sessions[call.Session]
			l.mu.Unlock()
			peer.mu.Lock()
			peer.sent = received
			peer.acknowledged = received
			peer.mu.Unlock()
		}
		return SessionResult{Received: received}, nil
	case wire.RegisterRun:
		l.mu.Lock()
		peer := l.sessions[call.Session]
		l.mu.Unlock()
		if peer != nil {
			peer.mu.Lock()
			peer.run = call.Run
			peer.mu.Unlock()
		}
		return SessionResult{}, nil
	case wire.CloseSession:
		l.mu.Lock()
		peer := l.sessions[call.Session]
		delete(l.sessions, call.Session)
		l.mu.Unlock()
		if peer != nil {
			peer.finish()
		}
		return SessionResult{}, nil
	default:
		return SessionResult{}, nil
	}
}
