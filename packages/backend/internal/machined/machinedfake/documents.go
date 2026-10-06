// Package machinedfake is test support at the authenticated branch seam.
// Production composition never creates it as a fallback.
package machinedfake

import (
	"context"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"sync"
)

type DocumentOpen struct {
	Path   string
	Actor  []byte
	Stream uint32
}
type Documents struct {
	mu                 sync.Mutex
	Script             [][]byte
	Reply              func([]byte) [][]byte
	opened             []DocumentOpen
	sent               [][]byte
	closed             int
	wireSent, controls [][]byte
}

func (d *Documents) OpenDocument(ctx context.Context, path string, actor []byte) (live.DocumentStream, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s := &document{owner: d, frames: make(chan []byte, len(d.Script)+64), done: make(chan struct{})}
	f, err := wire.RequestFrame(42, wire.OpenDoc, wire.Field(1, wire.String(path)), wire.Field(2, wire.Union(1, wire.Field(1, wire.Bytes(actor)))))
	if err != nil {
		return nil, err
	}
	raw, err := wire.Encode(f)
	if err != nil {
		return nil, err
	}
	d.mu.Lock()
	s.stream = 9 + uint32(len(d.opened))
	d.controls = append(d.controls, raw)
	d.opened = append(d.opened, DocumentOpen{Path: path, Actor: append([]byte(nil), actor...), Stream: s.stream})
	for _, b := range d.Script {
		s.frames <- append([]byte(nil), b...)
	}
	d.mu.Unlock()
	return s, nil
}
func (d *Documents) Recorded() ([]DocumentOpen, [][]byte, int) {
	d.mu.Lock()
	defer d.mu.Unlock()
	opened := append([]DocumentOpen(nil), d.opened...)
	sent := make([][]byte, len(d.sent))
	for i, b := range d.sent {
		sent[i] = append([]byte(nil), b...)
	}
	return opened, sent, d.closed
}

type document struct {
	owner  *Documents
	frames chan []byte
	done   chan struct{}
	once   sync.Once
	stream uint32
}

func (s *document) Send(ctx context.Context, b []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	raw, err := wire.Encode(wire.Frame{Kind: wire.Documents, Stream: s.stream, Payload: b})
	if err != nil {
		return err
	}
	if _, err = wire.Decode(raw); err != nil {
		return err
	}
	s.owner.mu.Lock()
	s.owner.wireSent = append(s.owner.wireSent, raw)
	s.owner.sent = append(s.owner.sent, append([]byte(nil), b...))
	reply := s.owner.Reply
	s.owner.mu.Unlock()
	if reply != nil {
		for _, r := range reply(b) {
			select {
			case s.frames <- append([]byte(nil), r...):
			case <-ctx.Done():
				return ctx.Err()
			case <-s.done:
				return context.Canceled
			}
		}
	}
	return nil
}
func (s *document) Receive(ctx context.Context) ([]byte, error) {
	select {
	case b := <-s.frames:
		raw, err := wire.Encode(wire.Frame{Kind: wire.Documents, Stream: s.stream, Payload: b})
		if err != nil {
			return nil, err
		}
		f, err := wire.Decode(raw)
		return f.Payload, err
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-s.done:
		return nil, context.Canceled
	}
}
func (s *document) Close() error {
	s.once.Do(func() {
		close(s.done)
		f, err := wire.RequestFrame(43, wire.CloseDoc, wire.Field(1, wire.U32(s.stream)))
		if err == nil {
			raw, err := wire.Encode(f)
			if err == nil {
				s.owner.mu.Lock()
				s.owner.controls = append(s.owner.controls, raw)
				s.owner.mu.Unlock()
			}
		}
		s.owner.mu.Lock()
		s.owner.closed++
		s.owner.mu.Unlock()
	})
	return nil
}

func (d *Documents) RecordedWire() (sent, controls [][]byte) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, b := range d.wireSent {
		sent = append(sent, append([]byte(nil), b...))
	}
	for _, b := range d.controls {
		controls = append(controls, append([]byte(nil), b...))
	}
	return
}
