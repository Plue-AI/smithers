package machined

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"sync"
	"time"
)

// Terminal adapts ADR 0004 session frames to the existing PTY byte stream.
// It does not reconnect across boots; the host manager owns browser replay.
type Terminal struct {
	exitSeen bool
	stream   *SessionStream
	ctx      context.Context
	cancel   context.CancelFunc
	readMu   sync.Mutex
	pending  []byte
	once     sync.Once
	closeErr error
}

func (s *Sessions) OpenTerminal(ctx context.Context, user SessionUser, argv []string, cols, rows uint16) (*Terminal, error) {
	id, err := s.OpenSession(ctx, user, SessionPTY, argv, &SessionSize{Cols: cols, Rows: rows})
	if err != nil {
		return nil, err
	}
	stream, err := s.Stream(ctx, id)
	if err != nil {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = s.CloseSession(cleanup, id)
		return nil, err
	}
	lifetime, cancel := context.WithCancel(context.WithoutCancel(ctx))
	return &Terminal{stream: stream, ctx: lifetime, cancel: cancel}, nil
}

func (t *Terminal) Read(out []byte) (int, error) {
	if len(out) == 0 {
		return 0, nil
	}
	t.readMu.Lock()
	defer t.readMu.Unlock()
	for len(t.pending) == 0 {
		p, err := t.stream.Receive(t.ctx)
		if err != nil {
			return 0, err
		}
		switch p[0] {
		case 1:
			t.pending = p[2:]
			if len(t.pending) > 0 {
				credit := make([]byte, 5)
				credit[0] = 6
				binary.BigEndian.PutUint32(credit[1:], uint32(len(t.pending)))
				if err := t.stream.Send(t.ctx, credit); err != nil {
					return 0, err
				}
			}
		case 5:
			t.exitSeen = true
			if binary.BigEndian.Uint32(p[1:5]) != 0 || p[5] != 0 {
				return 0, terminalExit{code: int(binary.BigEndian.Uint32(p[1:5])), signal: int(p[5])}
			}
			return 0, io.EOF
		case 7:
			return 0, io.EOF
		case 255:
			return 0, fmt.Errorf("terminal stream refused")
		}
	}
	n := copy(out, t.pending)
	t.pending = t.pending[n:]
	return n, nil
}
func (t *Terminal) Write(p []byte) (int, error) {
	written := 0
	for len(p) > 0 {
		n := min(len(p), 65536)
		if err := t.stream.Send(t.ctx, append([]byte{1, 0}, p[:n]...)); err != nil {
			return written, err
		}
		written += n
		p = p[n:]
	}
	return written, nil
}
func (t *Terminal) Resize(ctx context.Context, cols, rows uint16) error {
	p := []byte{3, 0, 0, 0, 0}
	binary.BigEndian.PutUint16(p[1:3], rows)
	binary.BigEndian.PutUint16(p[3:5], cols)
	return t.stream.Send(ctx, p)
}
func (t *Terminal) Close() error {
	t.once.Do(func() { t.cancel(); t.closeErr = t.stream.Close() })
	return t.closeErr
}

type terminalExit struct{ code, signal int }

func (e terminalExit) Error() string {
	return fmt.Sprintf("terminal exited: %d (signal %d)", e.code, e.signal)
}
func (e terminalExit) ExitStatus() int {
	if e.signal != 0 {
		return 128 + e.signal
	}
	return e.code
}
