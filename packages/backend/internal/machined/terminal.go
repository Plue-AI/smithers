package machined

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
)

// Terminal adapts one admitted broker session. The broker owns the process;
// this reader returns output credit only when the consumer reads the bytes.
type Terminal struct {
	ctx        context.Context
	cancel     context.CancelFunc
	stream     *SessionStream
	readMu     sync.Mutex
	writeMu    sync.Mutex
	reattachMu sync.Mutex
	pending    []byte
	exit       error
	exitSeen   bool
	ended      bool
	once       sync.Once
	closeErr   error
}

type ExitError struct {
	Code   int32
	Signal byte
	Core   bool
}

func (e *ExitError) Error() string {
	if e.Signal != 0 {
		return fmt.Sprintf("session exited with signal %d", e.Signal)
	}
	return fmt.Sprintf("session exited with status %d", e.Code)
}

func (s *Sessions) OpenTerminal(ctx context.Context, user SessionUser, argv []string, size *SessionSize) (*Terminal, error) {
	id, err := s.OpenSession(ctx, user, SessionPTY, argv, size)
	if err != nil {
		return nil, err
	}
	stream, err := s.Stream(ctx, id)
	if err != nil {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = s.CloseSession(cleanupCtx, id)
		return nil, err
	}
	terminalCtx, cancel := context.WithCancel(ctx)
	t := &Terminal{ctx: terminalCtx, cancel: cancel, stream: stream}
	context.AfterFunc(terminalCtx, func() { _ = t.Close() })
	return t, nil
}

func (t *Terminal) Read(dst []byte) (int, error) {
	t.readMu.Lock()
	defer t.readMu.Unlock()
	if len(dst) == 0 {
		return 0, nil
	}
	for {
		if len(t.pending) != 0 {
			n := min(len(dst), len(t.pending))
			copy(dst, t.pending[:n])
			t.pending = t.pending[n:]
			credit := []byte{6, 0, 0, 0, 0}
			binary.BigEndian.PutUint32(credit[1:], uint32(n))
			if err := t.stream.Send(t.ctx, credit); err != nil {
				t.readMu.Unlock()
				recovered := t.reattach()
				t.readMu.Lock()
				if recovered != nil {
					return n, recovered
				}
			}
			return n, nil
		}
		if t.ended {
			if t.exit != nil {
				return 0, t.exit
			}
			return 0, io.EOF
		}
		frame, err := t.stream.Receive(t.ctx)
		if err != nil {
			if err == io.EOF {
				return 0, err
			}
			t.readMu.Unlock()
			recovered := t.reattach()
			t.readMu.Lock()
			if recovered != nil {
				return 0, recovered
			}
			continue
		}
		switch frame[0] {
		case 1:
			t.pending = frame[2:]
		case 5:
			t.exitSeen = true
			if frame[1] == 0 {
				code := int32(binary.BigEndian.Uint32(frame[2:]))
				if code != 0 {
					t.exit = &ExitError{Code: code}
				}
			} else {
				t.exit = &ExitError{Signal: frame[2], Core: frame[3] != 0}
			}
			t.ended = true
		case 7:
			t.ended = true
		case 255:
			fields, err := wire.Fields("error", frame[1:])
			if err != nil {
				return 0, err
			}
			return 0, &SessionError{Code: fmt.Sprintf("broker_%d", fields[1][0]), Detail: "session refused"}
		}
	}
}
func (t *Terminal) Write(src []byte) (int, error) {
	t.writeMu.Lock()
	defer t.writeMu.Unlock()
	sent := 0
	for len(src) != 0 {
		n := min(len(src), 65536)
		payload := append([]byte{1, 0}, src[:n]...)
		t.stream.mu.Lock()
		before := t.stream.sent
		t.stream.mu.Unlock()
		if err := t.stream.Send(t.ctx, payload); err != nil {
			// A failed write may have reached the guest. Retained stdin is
			// replayed using the broker's consumed offset, never blindly resent.
			t.stream.mu.Lock()
			accepted := t.stream.sent != before
			finished := t.stream.closed || t.stream.inputEOF
			t.stream.mu.Unlock()
			if finished {
				return sent, err
			}
			if err = t.reattach(); err != nil {
				if accepted {
					sent += n
				}
				return sent, err
			}
			if !accepted {
				continue
			}
		}
		sent += n
		src = src[n:]
	}
	return sent, nil
}

// reattach keeps one terminal alive across a host-link partition, within the
// broker's 30-second grace. A different boot, revoked session or cancellation
// cannot reattach. Only bytes read by this consumer count as delivered output.
func (t *Terminal) reattach() error {
	t.reattachMu.Lock()
	defer t.reattachMu.Unlock()
	ctx, cancel := context.WithTimeout(t.ctx, 30*time.Second)
	defer cancel()
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		current, err := t.stream.registry.Current(t.stream.branch)
		if err == nil && current.RequireReady(t.stream.branch) == nil {
			t.readMu.Lock()
			t.stream.mu.Lock()
			old, closed := t.stream.link, t.stream.closed
			received := t.stream.received - uint64(len(t.pending))
			t.stream.mu.Unlock()
			if closed {
				t.readMu.Unlock()
				return io.ErrClosedPipe
			}
			if current == old {
				t.readMu.Unlock()
				return nil // another reader/writer already reattached
			}
			_, err = t.stream.reattachAt(ctx, &received)
			if err == nil {
				t.pending = nil // the broker replays exactly this unread suffix
			}
			t.readMu.Unlock()
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}
func (t *Terminal) Resize(ctx context.Context, cols, rows uint16) error {
	if cols == 0 || rows == 0 {
		return wire.BadValue
	}
	payload := []byte{3, 0, 0, 0, 0}
	binary.BigEndian.PutUint16(payload[1:3], cols)
	binary.BigEndian.PutUint16(payload[3:5], rows)
	return t.stream.Send(ctx, payload)
}
func (t *Terminal) CloseWrite(ctx context.Context) error {
	t.writeMu.Lock()
	defer t.writeMu.Unlock()
	return t.stream.Send(ctx, []byte{2, 0})
}
func (t *Terminal) Close() error {
	t.once.Do(func() {
		t.cancel()
		t.closeErr = t.stream.Close()
	})
	return t.closeErr
}
