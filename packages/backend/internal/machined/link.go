package machined

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"sync"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
)

// BootAuthority is host-generated data for the protected boot file. It must
// never be logged or sourced from a branch checkout.
type BootAuthority struct {
	ID         [16]byte
	Secret     [32]byte
	Credential string
}

// MintBoot fences the previous boot before returning data to the installer.
func (r *Registry) MintBoot(branch, machine string) (BootAuthority, error) {
	var a BootAuthority
	var credential [32]byte
	for _, bytes := range [][]byte{a.ID[:], a.Secret[:], credential[:]} {
		if _, err := rand.Read(bytes); err != nil {
			return BootAuthority{}, err
		}
	}
	a.Credential = hex.EncodeToString(credential[:])
	if err := r.BindBoot(branch, machine, a.ID, []byte(a.Credential)); err != nil {
		return BootAuthority{}, err
	}
	r.mu.Lock()
	r.boots[a.ID].secret = a.Secret
	r.mu.Unlock()
	return a, nil
}

// File is consumed by W1's strict boot parser. The installer owns location,
// no-follow checks, machined ownership and mode 0400, never this payload.
func (a BootAuthority) File(bridgePort uint16) []byte {
	topology := "topology=relay\n"
	if bridgePort != 0 {
		topology = fmt.Sprintf("topology=bridge\nbridge_port=%d\n", bridgePort)
	}
	return []byte(fmt.Sprintf("boot_id=%x\nrelay_secret=%x\ncredential=%s\n%s", a.ID, a.Secret, a.Credential, topology))
}

// Connect authenticates the daemon reached through the runtime's existing byte
// stream. The expected branch comes from the host binding, never the handshake.
// Invalid newcomers do not close the current lease. No RPC is ready on return.
func (r *Registry) Connect(ctx context.Context, branch string, stream net.Conn) (*Link, error) {
	admitted := false
	defer func() {
		if !admitted {
			_ = stream.Close()
		}
	}()
	deadline := time.Now().Add(5 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	if err := stream.SetDeadline(deadline); err != nil {
		return nil, err
	}
	stop := context.AfterFunc(ctx, func() { _ = stream.Close() })
	defer stop()
	challenge, err := wire.Read(stream)
	if err != nil {
		return nil, err
	}
	if challenge.Kind != wire.Hello || challenge.Payload[0] != 1 {
		return nil, wire.HandshakeOrder
	}
	fields, err := wire.Fields("challenge", challenge.Payload[1:])
	if err != nil {
		return nil, err
	}
	var id [16]byte
	copy(id[:], fields[3])
	r.mu.Lock()
	b := r.boots[id]
	valid := b != nil && b.branch == branch && r.branches[branch] == b && b.secret != ([32]byte{})
	var secret [32]byte
	if valid {
		secret = b.secret
	}
	r.mu.Unlock()
	if !valid {
		return nil, ErrUnauthorized
	}
	proof := wire.HostMAC(secret[:], id[:], fields[4])
	if err := wire.Write(stream, wire.Frame{Kind: wire.Hello, Payload: wire.Union(2, wire.Field(1, fields[2]), wire.Field(2, proof[:]))}); err != nil {
		return nil, err
	}
	hello, err := wire.Read(stream)
	if err != nil {
		return nil, err
	}
	if hello.Kind != wire.Hello || hello.Payload[0] != 3 {
		return nil, wire.HandshakeOrder
	}
	values, err := wire.Fields("hello", hello.Payload[1:])
	if err != nil {
		return nil, err
	}
	lease, err := r.Admit(id, values[1][4:], stream)
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
	if err := ctx.Err(); err != nil {
		_ = lease.Close()
		return nil, err
	}
	l := &Link{Connection: lease, stream: stream, pending: make(map[uint32]chan wire.Frame), events: make(chan Event, 64), presence: make(chan wire.Frame, 1), done: make(chan struct{}), next: 1, protocol: binary.BigEndian.Uint16(fields[2]), documents: make(map[uint32]chan []byte), sessions: make(map[uint32]*SessionStream)}
	r.mu.Lock()
	if !lease.current() {
		r.mu.Unlock()
		_ = l.Close()
		return nil, ErrUnauthorized
	}
	lease.boot.link = l
	l.objectImporter = r.objects
	l.objectExporter = r.objectExporter
	// Register before releasing admission's lock, so consumer shutdown cannot
	// miss a connection admitted concurrently with its final worker snapshot.
	r.eventsMu.Lock()
	if r.eventsClosing || (r.events != nil && !r.events.start(l)) {
		r.eventsMu.Unlock()
		r.mu.Unlock()
		_ = l.Close()
		return nil, ErrNotReady
	}
	r.eventsMu.Unlock()
	l.identities = r.identities
	r.mu.Unlock()
	admitted = true
	if l.objectImporter != nil {
		l.objectQueue = make(chan struct{}, 1)
		go l.importObjects()
	}
	go l.read()
	return l, nil
}

// Link multiplexes control replies and durable events. Event admission runs
// independently of Capture's reply, which may wait for outbox acknowledgement.
// A stalled consumer closes the link and lets the durable guest outbox replay.
type Link struct {
	identities    SessionIdentities
	sessionCallMu sync.Mutex
	sessions      map[uint32]*SessionStream
	*Connection
	stream           net.Conn
	writeMu          sync.Mutex
	mu               sync.Mutex
	pending          map[uint32]chan wire.Frame
	documents        map[uint32]chan []byte
	openingDocuments int
	protocol         uint16
	next             uint32
	events           chan Event
	presence         chan wire.Frame
	done             chan struct{}
	once             sync.Once
	objectQueue      chan struct{}
	objectData       []byte
	objectImporter   ObjectImporter
	objectExporter   ObjectExporter
	objectSend       *objectSend
	objectStream     uint32
	objectPending    int
	objectEOF        bool
	objectSeen       map[uint32]bool
}

// Done closes when this exact authenticated connection ends.
func (l *Link) Done() <-chan struct{} { return l.done }

func (l *Link) Close() error {
	l.once.Do(func() { close(l.done); _ = l.Connection.Close() })
	return nil
}
func (l *Link) send(f wire.Frame) error {
	l.writeMu.Lock()
	defer l.writeMu.Unlock()
	if err := l.stream.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return err
	}
	return wire.Write(l.stream, f)
}

// A blocked pipe writer must observe caller cancellation as well as its bounded
// transport deadline. Closing this link leaves unacknowledged guest work queued
// for replay; it never cancels a different boot's connection.
func (l *Link) sendContext(ctx context.Context, frame wire.Frame) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	stop := context.AfterFunc(ctx, func() { _ = l.Close() })
	defer stop()
	err := l.send(frame)
	if cancelled := ctx.Err(); cancelled != nil {
		return cancelled
	}
	return err
}

func (l *Link) read() {
	defer l.Close()
	for {
		f, err := wire.Read(l.stream)
		if err != nil {
			return
		}
		switch f.Kind {
		case wire.Control:
			if f.Payload[0] != 2 {
				return
			}
			fields, err := wire.Fields("response", f.Payload[1:])
			if err != nil {
				return
			}
			id := binary.BigEndian.Uint32(fields[1])
			l.mu.Lock()
			reply := l.pending[id]
			delete(l.pending, id)
			l.mu.Unlock()
			if reply != nil {
				value := fields[2]
				if value[0] == byte(wire.OpenSession) || value[0] == byte(wire.TCPConnect) {
					result, e := wire.Fields(fmt.Sprintf("result%d", value[0]), value[1:])
					if e != nil {
						return
					}
					session := binary.BigEndian.Uint32(result[1])
					if !validSession(session) {
						return
					}
					l.mu.Lock()
					if l.sessions[session] != nil || len(l.sessions) >= 512 {
						l.mu.Unlock()
						return
					}
					l.sessions[session] = newSessionStream(l, session)
					l.mu.Unlock()
				}
				reply <- f
			}
		case wire.Events:
			var event Event
			switch f.Payload[0] {
			case 1:
				fields, err := wire.Fields("durable", f.Payload[1:])
				if err != nil {
					return
				}
				event.Payload = append([]byte(nil), fields[3]...)
				event.Seq = binary.BigEndian.Uint64(fields[1])
				copy(event.EventID[:], fields[2])
				if event.Seq == 0 || event.EventID == ([16]byte{}) {
					return
				}
			case 2:
				fields, err := wire.Fields("hint_wrapper", f.Payload[1:])
				if err != nil {
					return
				}
				event.Payload = append([]byte(nil), fields[1]...)
			default:
				return
			}
			select {
			case l.events <- event:
			default:
				return
			}
		case wire.Presence:
			if _, err := f.PresenceSnapshot(); err != nil {
				return
			}
			// Snapshots are complete and ephemeral. Retain the latest without
			// blocking control replies or the durable outbox on a slow consumer.
			select {
			case <-l.presence:
			default:
			}
			l.presence <- f
		case wire.Documents:
			l.mu.Lock()
			queue := l.documents[f.Stream]
			if queue == nil && l.openingDocuments > 0 && len(l.documents) < 16 {
				queue = make(chan []byte, 8)
				l.documents[f.Stream] = queue
			}
			l.mu.Unlock()
			if queue == nil {
				return
			}
			select {
			case queue <- append([]byte(nil), f.Payload...):
			default:
				return
			}
		case wire.Sessions:
			if !l.receiveSession(f) {
				return
			}
		case wire.Objects:
			if f.Stream >= 0x80000000 {
				if !l.receiveObjectReceipt(f) {
					return
				}
				continue
			}
			if !l.receiveObject(f) {
				return
			}
		default:
			return // unsupported streams never grant successful admission
		}
	}
}

// Request dispatches a canonical call fenced to this boot. Admission methods
// remain available before ready; all other methods require reconciliation.
func (l *Link) Request(ctx context.Context, branch string, method wire.Method, args ...[]byte) (wire.Frame, error) {
	if err := ctx.Err(); err != nil {
		return wire.Frame{}, err
	}
	if method == wire.WakeReconcile || method == wire.SetRoster || method == wire.Status {
		l.registry.mu.Lock()
		valid := branch == l.boot.branch && l.current()
		l.registry.mu.Unlock()
		if !valid {
			return wire.Frame{}, ErrUnauthorized
		}
	} else if err := l.RequireReady(branch); err != nil {
		return wire.Frame{}, err
	}
	l.mu.Lock()
	id := l.next
	if id == 0 {
		l.mu.Unlock()
		_ = l.Close()
		return wire.Frame{}, io.ErrClosedPipe
	}
	l.next++
	reply := make(chan wire.Frame, 1)
	l.pending[id] = reply
	l.mu.Unlock()
	defer func() { l.mu.Lock(); delete(l.pending, id); l.mu.Unlock() }()
	frame, err := wire.RequestFrame(id, method, args...)
	if err != nil {
		return wire.Frame{}, err
	}
	if err = l.sendContext(ctx, frame); err != nil {
		_ = l.Close()
		return wire.Frame{}, err
	}
	select {
	case <-ctx.Done():
		return wire.Frame{}, ctx.Err()
	case <-l.done:
		return wire.Frame{}, io.ErrClosedPipe
	case result := <-reply:
		l.registry.mu.Lock()
		valid := branch == l.boot.branch && l.current()
		l.registry.mu.Unlock()
		if !valid {
			return wire.Frame{}, ErrUnauthorized
		}
		return result, nil
	}
}
func (l *Link) Receive(ctx context.Context) (Event, error) {
	select {
	case <-ctx.Done():
		return Event{}, ctx.Err()
	case <-l.done:
		return Event{}, io.ErrClosedPipe
	case event := <-l.events:
		l.registry.mu.Lock()
		valid := l.current()
		l.registry.mu.Unlock()
		if !valid {
			return Event{}, ErrUnauthorized
		}
		return event, nil
	}
}

// ReceivePresence returns the latest complete daemon snapshot, fenced to the
// admitted boot. Identity resolution remains the host consumer's responsibility.
func (l *Link) ReceivePresence(ctx context.Context, branch string) (wire.Frame, error) {
	if err := ctx.Err(); err != nil {
		return wire.Frame{}, err
	}
	if err := l.RequireReady(branch); err != nil {
		return wire.Frame{}, err
	}
	select {
	case <-ctx.Done():
		return wire.Frame{}, ctx.Err()
	case <-l.done:
		return wire.Frame{}, io.ErrClosedPipe
	case frame := <-l.presence:
		if err := l.RequireReady(branch); err != nil {
			return wire.Frame{}, err
		}
		return frame, nil
	}
}
