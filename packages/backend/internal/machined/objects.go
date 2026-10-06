package machined

import (
	"context"
	"io"
	"os"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
)

// ObjectImporter verifies and durably imports a git bundle into the host store
// selected by branch. It must ignore bundle ref names and must not execute hooks
// or call the registry. Returning nil certifies that every imported object is
// durable; only then may the daemon release its bundle. The file is host-owned,
// rewound and valid only for this call. No branch path reaches the host filesystem.
type ObjectImporter func(context.Context, string, *os.File) error

// BindObjectImporter affects new handshakes. An absent importer refuses object
// streams rather than acknowledging bytes that have no durable host store.
func (r *Registry) BindObjectImporter(importer ObjectImporter) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.objects = importer
}

// One bundle at a time bounds aggregate memory to the initial stream credit.
// The reader only accounts/enqueues bytes; disk and verification cannot block
// control replies, revocation, document receipts or the outbox event reader.
func (l *Link) receiveObject(f wire.Frame) bool {
	if l.objectQueue == nil {
		return false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.objectStream == 0 {
		if f.Payload[0] != 1 || l.objectSeen[f.Stream] {
			return false
		}
		if l.objectSeen == nil {
			l.objectSeen = make(map[uint32]bool)
		}
		// Bound even a peer sending many empty bundles during one connection.
		if len(l.objectSeen) >= 4096 {
			return false
		}
		l.objectSeen[f.Stream] = true
		l.objectStream = f.Stream
	}
	if f.Stream != l.objectStream || l.objectEOF {
		return false
	}
	switch f.Payload[0] {
	case 1:
		n := len(f.Payload) - 2
		if n == 0 || n > wire.InitialCredit-l.objectPending {
			return false
		}
		l.objectPending += n
		l.objectData = append(l.objectData, f.Payload[2:]...)
	case 2:
		l.objectEOF = true
	default:
		return false
	}
	select {
	case l.objectQueue <- struct{}{}:
		return true
	default:
		return true // a pending wake covers the coalesced bytes
	}
}

func (l *Link) importObjects() {
	defer l.Close()
	var file *os.File
	var size int64
	cleanup := func() {
		if file != nil {
			name := file.Name()
			_ = file.Close()
			_ = os.Remove(name)
			file = nil
		}
	}
	defer cleanup()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		select {
		case <-l.done:
			cancel()
		case <-ctx.Done():
		}
	}()
	for {
		select {
		case <-ctx.Done():
			return
		case <-l.objectQueue:
			l.mu.Lock()
			f := wire.Frame{Kind: wire.Objects, Stream: l.objectStream}
			if len(l.objectData) > 0 {
				f.Payload = append([]byte{1, 0}, l.objectData...)
				l.objectData = nil
				if l.objectEOF {
					select {
					case l.objectQueue <- struct{}{}:
					default:
					}
				}
			} else if l.objectEOF {
				f.Payload = []byte{2, 0}
			} else {
				l.mu.Unlock()
				continue
			}
			l.mu.Unlock()
			if file == nil {
				var err error
				file, err = os.CreateTemp("", "smithers-machined-bundle-*")
				if err != nil {
					return
				}
				size = 0
			}
			if f.Payload[0] == 1 {
				size += int64(len(f.Payload) - 2)
				// Disk is bounded independently of the transport's memory credit.
				if size > 256<<20 {
					return
				}
				if _, err := file.Write(f.Payload[2:]); err != nil {
					return
				}
				l.mu.Lock()
				l.objectPending -= len(f.Payload) - 2
				l.mu.Unlock()
				if err := l.sendContext(ctx, wire.Frame{Kind: wire.Objects, Stream: f.Stream, Payload: append([]byte{6}, wire.U32(uint32(len(f.Payload)-2))...)}); err != nil {
					return
				}
				continue
			}
			if _, err := file.Seek(0, io.SeekStart); err != nil {
				return
			}
			// Fence replacement across durable import just as event commit does.
			// The bounded deadline prevents a broken importer holding admission.
			call, stop := context.WithTimeout(ctx, 30*time.Second)
			l.registry.mu.Lock()
			err := ErrUnauthorized
			if l.current() {
				err = l.objectImporter(call, l.boot.branch, file)
			}
			l.registry.mu.Unlock()
			stop()
			cleanup()
			if err != nil {
				return
			}
			l.mu.Lock()
			l.objectStream, l.objectPending, l.objectEOF = 0, 0, false
			l.mu.Unlock()
			if err := l.sendContext(ctx, wire.Frame{Kind: wire.Objects, Stream: f.Stream, Payload: []byte{7}}); err != nil {
				return
			}
		}
	}
}
