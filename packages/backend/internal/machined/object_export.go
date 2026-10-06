package machined

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"os"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
)

// ObjectExporter returns a host-owned temporary bundle of the authorized head.
// The sender closes and removes the file. The stream number is host allocated
// and remains unique across reconnects within a boot.
type ObjectExporter func(context.Context, string, string, uint32) (*os.File, error)

func (r *Registry) BindObjectExporter(exporter ObjectExporter) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.exportObjects = exporter
}

type outgoingObject struct {
	stream, credit uint32
	eof, closed    bool
	err            error
	wake           chan struct{}
}

func (l *Link) receiveObjectReply(frame wire.Frame) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := l.outgoingObject
	if out == nil || out.stream != frame.Stream || out.closed {
		return false
	}
	switch frame.Payload[0] {
	case 6:
		n := binary.BigEndian.Uint32(frame.Payload[1:])
		if n == 0 || n > wire.InitialCredit-out.credit {
			return false
		}
		out.credit += n
	case 7:
		if !out.eof {
			return false
		}
		out.closed = true
	case 255:
		out.err = errors.New("machine refused host bundle")
		out.closed = true
	default:
		return false
	}
	select {
	case out.wake <- struct{}{}:
	default:
	}
	return true
}

// transferHead does not permit wake until the peer has verified/imported the
// bundle and returned close. A refusal, cancellation, or premature close fences
// this link; no successful control response can substitute for object receipt.
func (l *Link) transferHead(ctx context.Context, branch, head string) (err error) {
	if err := ctx.Err(); err != nil {
		return err
	}
	l.registry.mu.Lock()
	if branch != l.boot.branch || !l.current() {
		l.registry.mu.Unlock()
		return ErrUnauthorized
	}
	exporter := l.registry.exportObjects
	if exporter == nil || l.boot.nextObject >= 0x80000000 {
		l.registry.mu.Unlock()
		return ErrNotReady
	}
	stream := uint32(0x80000000) + l.boot.nextObject
	l.boot.nextObject++
	l.registry.mu.Unlock()
	out := &outgoingObject{stream: stream, credit: wire.InitialCredit, wake: make(chan struct{}, 1)}
	l.mu.Lock()
	if l.outgoingObject != nil {
		l.mu.Unlock()
		return ErrNotReady
	}
	l.outgoingObject = out
	l.mu.Unlock()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		select {
		case <-l.done:
			cancel()
		case <-ctx.Done():
		}
	}()
	defer func() {
		l.mu.Lock()
		l.outgoingObject = nil
		l.mu.Unlock()
		if err != nil {
			_ = l.Close()
		}
	}()
	file, err := exporter(ctx, branch, head, stream)
	if err != nil {
		return err
	}
	if file == nil {
		return ErrNotReady
	}
	defer os.Remove(file.Name())
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() == 0 || info.Size() > 256<<20 {
		return wire.BadValue
	}
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	remaining := info.Size()
	wait := func() error {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-l.done:
			return io.ErrClosedPipe
		case <-out.wake:
			return nil
		}
	}
	for remaining > 0 {
		l.mu.Lock()
		credit, refused := out.credit, out.err
		n := min(int64(credit), remaining, 65536)
		out.credit -= uint32(n)
		l.mu.Unlock()
		if refused != nil {
			return refused
		}
		if n == 0 {
			if err = wait(); err != nil {
				return err
			}
			continue
		}
		payload := make([]byte, 2+n)
		payload[0] = 1
		if _, err = io.ReadFull(file, payload[2:]); err != nil {
			return err
		}
		if err = l.sendContext(ctx, wire.Frame{Kind: wire.Objects, Stream: stream, Payload: payload}); err != nil {
			return err
		}
		remaining -= n
	}
	l.mu.Lock()
	out.eof = true
	l.mu.Unlock()
	if err = l.sendContext(ctx, wire.Frame{Kind: wire.Objects, Stream: stream, Payload: []byte{2, 0}}); err != nil {
		return err
	}
	for {
		l.mu.Lock()
		closed, refused := out.closed, out.err
		l.mu.Unlock()
		if refused != nil {
			return refused
		}
		if closed {
			l.registry.mu.Lock()
			valid := l.current()
			l.registry.mu.Unlock()
			if !valid {
				return ErrUnauthorized
			}
			return nil
		}
		if err = wait(); err != nil {
			return err
		}
	}
}
