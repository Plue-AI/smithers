package machined

import (
	"context"
	"encoding/binary"
	"io"
	"sync"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
)

// SessionTransport extends the control client with its admitted session streams.
// The caller returns output credit with window frames after consuming data.
// Input credit is enforced here; window frames wake blocked writers.
type SessionTransport interface {
	SessionRPC
	Stream(context.Context, uint32) (*SessionStream, error)
}

// SessionStream is bound to one authenticated branch/boot. It retains at most
// one credit window of unacknowledged stdin for explicit reconnection.
type SessionStream struct {
	registry                     *Registry
	branch                       string
	id                           uint32
	sendMu                       sync.Mutex
	receiveMu                    sync.Mutex
	mu                           sync.Mutex
	link                         *Link
	changed                      chan struct{}
	queue                        [][]byte
	outputPending, returnable    int
	received, sent, acknowledged uint64
	retained                     []byte
	inputEOF                     bool
	outputEOF                    byte
	closed                       bool
	user                         *SessionUser
	run                          string
}

func newSessionStream(l *Link, id uint32) *SessionStream {
	return &SessionStream{registry: l.registry, branch: l.boot.branch, id: id, link: l, changed: make(chan struct{})}
}
func (s *SessionStream) notify() { close(s.changed); s.changed = make(chan struct{}) }
func (s *SessionStream) finish() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	s.queue = nil
	s.retained = nil
	s.notify()
}
func (s registrySessions) Stream(ctx context.Context, id uint32) (*SessionStream, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	l, err := s.registry.Current(s.branch)
	if err != nil {
		return nil, err
	}
	if s.connection != nil && l.Connection != s.connection {
		return nil, ErrUnauthorized
	}
	if err = l.RequireReady(s.branch); err != nil {
		return nil, err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	stream := l.sessions[id]
	if stream == nil {
		return nil, refused("not_found", "unknown session")
	}
	return stream, nil
}

// receiveSession never blocks the shared connection pump. The byte window and
// a bounded control allowance cap buffering even with one-byte data frames.
func (l *Link) receiveSession(f wire.Frame) bool {
	l.mu.Lock()
	s := l.sessions[f.Stream]
	l.mu.Unlock()
	if s == nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.link != l || s.closed {
		return false
	}
	p := f.Payload
	switch p[0] {
	case 1:
		if p[1] < 1 || p[1] > 2 || s.outputEOF&(1<<p[1]) != 0 || len(p)-2 > wire.InitialCredit-s.outputPending {
			return false
		}
		s.outputPending += len(p) - 2
	case 2:
		if p[1] < 1 || p[1] > 2 {
			return false
		}
		s.outputEOF |= 1 << p[1]
	case 5, 7, 255:
	case 6:
		n := uint64(binary.BigEndian.Uint32(p[1:]))
		if n > s.sent-s.acknowledged || n > uint64(len(s.retained)) {
			return false
		}
		s.acknowledged += n
		s.retained = append(s.retained[:0], s.retained[n:]...)
	default:
		return false
	}
	if len(s.queue) >= wire.InitialCredit+16 {
		return false
	}
	// Coalesce adjacent data/window frames without changing descriptor ordering.
	if len(s.queue) > 0 {
		last := s.queue[len(s.queue)-1]
		if p[0] == 1 && last[0] == 1 && last[1] == p[1] && len(last)+len(p)-4 <= 65536 {
			s.queue[len(s.queue)-1] = append(last, p[2:]...)
			s.notify()
			return true
		}
		if p[0] == 6 && last[0] == 6 {
			n := binary.BigEndian.Uint32(last[1:]) + binary.BigEndian.Uint32(p[1:])
			if n <= wire.InitialCredit {
				binary.BigEndian.PutUint32(last[1:], n)
				s.notify()
				return true
			}
		}
	}
	s.queue = append(s.queue, append([]byte(nil), p...))
	s.notify()
	return true
}

func (s *SessionStream) Send(ctx context.Context, payload []byte) error {
	payload = append([]byte(nil), payload...)
	f := wire.Frame{Kind: wire.Sessions, Stream: s.id, Payload: payload}
	if _, err := wire.Encode(f); err != nil {
		return err
	}
	p := payload
	if !(p[0] == 1 && p[1] == 0 || p[0] == 2 && p[1] == 0 || p[0] == 3 || p[0] == 4 || p[0] == 6 || p[0] == 7) {
		return wire.BadValue
	}
	if p[0] == 3 && (binary.BigEndian.Uint16(p[1:3]) == 0 || binary.BigEndian.Uint16(p[3:5]) == 0) {
		return wire.BadValue
	}
	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		s.mu.Lock()
		l := s.link
		if s.closed {
			s.mu.Unlock()
			return io.ErrClosedPipe
		}
		if err := l.RequireReady(s.branch); err != nil {
			s.mu.Unlock()
			return err
		}
		if p[0] == 1 && s.inputEOF {
			s.mu.Unlock()
			return io.ErrClosedPipe
		}
		if p[0] == 1 && len(p)-2 > wire.InitialCredit-len(s.retained) {
			changed := s.changed
			s.mu.Unlock()
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-l.done:
				return io.ErrClosedPipe
			case <-changed:
				continue
			}
		}
		switch p[0] {
		case 1:
			s.retained = append(s.retained, p[2:]...)
			s.sent += uint64(len(p) - 2)
		case 2:
			s.inputEOF = true
		case 6:
			n := int(binary.BigEndian.Uint32(p[1:]))
			if n > s.returnable {
				s.mu.Unlock()
				return wire.BadValue
			}
			s.returnable -= n
			s.outputPending -= n
		}
		s.mu.Unlock()
		err := l.sendContext(ctx, f)
		if err != nil {
			_ = l.Close()
		}
		if err == nil && p[0] == 7 {
			s.finish()
		}
		return err
	}
}
func (s *SessionStream) Receive(ctx context.Context) ([]byte, error) {
	s.receiveMu.Lock()
	defer s.receiveMu.Unlock()
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		s.mu.Lock()
		l := s.link
		if s.closed {
			s.mu.Unlock()
			return nil, io.EOF
		}
		if err := l.RequireReady(s.branch); err != nil {
			s.mu.Unlock()
			return nil, err
		}
		if len(s.queue) > 0 {
			p := s.queue[0]
			s.queue[0] = nil
			s.queue = s.queue[1:]
			if p[0] == 1 {
				s.received += uint64(len(p) - 2)
				s.returnable += len(p) - 2
			}
			if p[0] == 7 {
				s.closed = true
				s.notify()
			}
			s.mu.Unlock()
			return p, nil
		}
		changed := s.changed
		s.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-l.done:
			return nil, io.ErrClosedPipe
		case <-changed:
		}
	}
}

// Reattach reports delivered output and resends only stdin the broker did not
// consume. A replacement boot or a bad received offset never discards replay.
func (s *SessionStream) Reattach(ctx context.Context) (uint64, error) {
	return s.reattachAt(ctx, nil)
}

// reattachAt lets a buffered consumer discard its unread suffix and request it
// again. Bytes already consumed cannot be rewound; the broker independently
// bounds the offset against its retained output window.
func (s *SessionStream) reattachAt(ctx context.Context, offset *uint64) (uint64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	l, err := s.registry.Current(s.branch)
	if err != nil {
		return 0, err
	}
	if err = l.RequireReady(s.branch); err != nil {
		return 0, err
	}
	s.mu.Lock()
	old := s.link
	if s.closed || old == l || old.boot != l.boot {
		s.mu.Unlock()
		return 0, ErrUnauthorized
	}
	s.mu.Unlock()
	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	s.receiveMu.Lock()
	defer s.receiveMu.Unlock()
	s.mu.Lock()
	received := s.received
	if offset != nil {
		received = *offset
	}
	if received > s.received || received < s.received-uint64(s.returnable) {
		s.mu.Unlock()
		return 0, wire.BadValue
	}
	s.mu.Unlock()
	old.mu.Lock()
	delete(old.sessions, s.id)
	old.mu.Unlock()
	l.sessionCallMu.Lock()
	defer l.sessionCallMu.Unlock()
	l.mu.Lock()
	if _, exists := l.sessions[s.id]; exists || len(l.sessions) >= 512 {
		l.mu.Unlock()
		return 0, wire.BadStream
	}
	l.sessions[s.id] = s
	l.mu.Unlock()
	s.mu.Lock()
	s.link = l
	s.received = received
	s.queue = nil
	s.outputPending = 0
	s.returnable = 0
	s.outputEOF = 0
	s.notify()
	s.mu.Unlock()
	result, err := l.call(ctx, s.branch, wire.AttachSession, wire.Field(1, wire.U32(s.id)), wire.Field(2, wire.U64(received)))
	if err != nil {
		_ = l.Close()
		return 0, err
	}
	consumed := binary.BigEndian.Uint64(result[1])
	s.mu.Lock()
	if consumed < s.acknowledged || consumed > s.sent {
		s.mu.Unlock()
		_ = l.Close()
		return 0, wire.BadValue
	}
	s.retained = append(s.retained[:0], s.retained[consumed-s.acknowledged:]...)
	s.acknowledged = consumed
	replay := append([]byte(nil), s.retained...)
	eof := s.inputEOF
	s.mu.Unlock()
	for len(replay) > 0 {
		n := min(len(replay), 65536)
		if err = l.sendContext(ctx, wire.Frame{Kind: wire.Sessions, Stream: s.id, Payload: append([]byte{1, 0}, replay[:n]...)}); err != nil {
			_ = l.Close()
			return 0, err
		}
		replay = replay[n:]
	}
	if eof {
		err = l.sendContext(ctx, wire.Frame{Kind: wire.Sessions, Stream: s.id, Payload: []byte{2, 0}})
		if err != nil {
			_ = l.Close()
		}
	}
	return consumed, err
}
func (s *SessionStream) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	l := s.link
	s.closed = true
	s.queue = nil
	s.retained = nil
	s.notify()
	s.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := l.call(ctx, s.branch, wire.CloseSession, wire.Field(1, wire.U32(s.id)))
	l.mu.Lock()
	delete(l.sessions, s.id)
	l.mu.Unlock()
	if err != nil {
		_ = l.Close()
	}
	return err
}
