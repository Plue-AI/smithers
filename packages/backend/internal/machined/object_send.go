package machined

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"sync"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
)

const maxObjectBundleSize = 256 << 20

// ObjectExporter resolves an authoritative branch/head and returns a completed
// private bundle advertising only refs/smithers/xfer/<decimal stream>. Close
// releases the snapshot. Export must honor ctx and never call the registry.
type ObjectExporter func(context.Context, string, string, uint32) (io.ReadCloser, error)

// BindObjectExporter affects new authenticated links. Missing export cannot
// silently bypass the object-import receipt required before wake.
func (r *Registry) BindObjectExporter(export ObjectExporter) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.objectExporter = export
}

type objectSend struct {
	stream      uint32
	credit      int
	eof, closed bool
	failure     error
	changed     chan struct{}
}

// The connection reader only accounts receipts; export and source reads run in
// the caller, so reverse object traffic and control replies stay independent.
func (l *Link) receiveObjectReceipt(f wire.Frame) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	s := l.objectSend
	if s == nil || f.Stream != s.stream || s.closed || s.failure != nil {
		return false
	}
	switch f.Payload[0] {
	case 6:
		n := binary.BigEndian.Uint32(f.Payload[1:])
		if n == 0 || uint64(n) > uint64(wire.InitialCredit-s.credit) {
			return false
		}
		s.credit += int(n)
	case 7:
		if !s.eof {
			return false
		}
		s.closed = true
	case 255:
		s.failure = errors.New("machine refused host bundle")
		return false // interrupt a writer whose peer has stopped consuming bytes
	default:
		return false
	}
	select {
	case s.changed <- struct{}{}:
	default:
	}
	return true
}

func (l *Link) sendWakeObjects(ctx context.Context, branch, head string) error {
	return l.sendObjects(ctx, branch, head, true)
}

// An onto-only import adds immutable objects without waking or changing the
// working copy. Its authenticated sessions and presence remain admitted.
func (l *Link) sendRebaseObjects(ctx context.Context, branch, head string) error {
	return l.sendObjects(ctx, branch, head, false)
}

func (l *Link) sendObjects(ctx context.Context, branch, head string, waking bool) (err error) {
	if l.objectExporter == nil {
		return ErrNotReady
	}
	l.registry.mu.Lock()
	if branch != l.boot.branch || !l.current() {
		l.registry.mu.Unlock()
		return ErrUnauthorized
	}
	if l.boot.nextObject == ^uint32(0) {
		l.registry.mu.Unlock()
		return ErrNotReady
	}
	if l.boot.nextObject == 0 {
		l.boot.nextObject = 0x8000_0000
	} else {
		l.boot.nextObject++
	}
	stream := l.boot.nextObject
	l.registry.mu.Unlock()
	source, err := l.objectExporter(ctx, branch, head, stream)
	if err != nil {
		return err
	}
	if source == nil {
		return ErrNotReady
	}
	// Export/admission can refuse before the peer sees any bundle bytes.
	// Retain readiness on that path so the stack can retry after its fence
	// changes. Wake transfer needs reconciliation; an onto-only import keeps
	// its unchanged working copy and authenticated presence admitted.
	l.registry.mu.Lock()
	if branch != l.boot.branch || !l.current() {
		l.registry.mu.Unlock()
		_ = source.Close()
		return ErrUnauthorized
	}
	if waking {
		l.ready = false
	}
	l.registry.mu.Unlock()
	var closeOnce sync.Once
	closeSource := func() { closeOnce.Do(func() { _ = source.Close() }) }
	stopRead := context.AfterFunc(ctx, closeSource)
	defer stopRead()
	defer closeSource()
	l.registry.mu.Lock()
	valid := l.current()
	l.registry.mu.Unlock()
	if !valid {
		return ErrUnauthorized
	}
	s := &objectSend{stream: stream, credit: wire.InitialCredit, changed: make(chan struct{}, 1)}
	l.mu.Lock()
	if l.objectSend != nil {
		l.mu.Unlock()
		return ErrNotReady
	}
	l.objectSend = s
	l.mu.Unlock()
	defer func() {
		l.mu.Lock()
		l.objectSend = nil
		l.mu.Unlock()
		if err != nil {
			_ = l.Close()
		}
	}()
	var total int64
	buffer := make([]byte, 65536)
	for {
		l.mu.Lock()
		credit, failure := s.credit, s.failure
		l.mu.Unlock()
		if failure != nil {
			return failure
		}
		if credit == 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-l.done:
				return ErrNotReady
			case <-s.changed:
			}
			continue
		}
		n, readErr := source.Read(buffer[:min(len(buffer), credit)])
		if n > 0 {
			total += int64(n)
			if total > maxObjectBundleSize {
				return errors.New("host bundle exceeds transfer bound")
			}
			l.mu.Lock()
			s.credit -= n
			l.mu.Unlock()
			if err = l.sendContext(ctx, wire.Frame{Kind: wire.Objects, Stream: stream, Payload: append([]byte{1, 0}, buffer[:n]...)}); err != nil {
				return err
			}
		}
		if readErr != nil && readErr != io.EOF {
			return readErr
		}
		if readErr == io.EOF {
			break
		}
		if n == 0 {
			return io.ErrNoProgress
		}
	}
	if total == 0 {
		return errors.New("empty host bundle")
	}
	l.mu.Lock()
	s.eof = true
	l.mu.Unlock()
	if err = l.sendContext(ctx, wire.Frame{Kind: wire.Objects, Stream: stream, Payload: []byte{2, 0}}); err != nil {
		return err
	}
	for {
		l.mu.Lock()
		closed, failure := s.closed, s.failure
		l.mu.Unlock()
		if failure != nil {
			return failure
		}
		if closed {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-l.done:
			return ErrNotReady
		case <-s.changed:
		}
	}
}

// Serialize bundle + wake per boot, including across a replacement connection.
// Cancellation while queued must not consume an id or affect another transfer.
func (l *Link) withWake(ctx context.Context, branch, head string, call func(context.Context) error) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	go func() {
		select {
		case <-l.done:
			cancel()
		case <-ctx.Done():
		}
	}()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case l.boot.wakeGate <- struct{}{}:
	}
	defer func() { <-l.boot.wakeGate }()
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := l.sendWakeObjects(ctx, branch, head); err != nil {
		return err
	}
	return call(ctx)
}
