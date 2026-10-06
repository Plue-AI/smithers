package live

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/livedocument"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
)

var errDocumentGap = errors.New("document send budget exceeded")

// CodeDocuments owns caches only. The authenticated daemon is the sole save
// authority. One topic has one native document and one daemon stream.
type CodeDocuments struct {
	Library *livedocument.Library
	mu      sync.Mutex
	docs    map[string]*codeDocument
}
type codeDocument struct {
	host        *CodeDocuments
	key         string
	mu          sync.Mutex
	ctx         context.Context
	cancel      context.CancelFunc
	ready       chan struct{}
	done        chan struct{}
	err         error
	doc         *livedocument.Document
	peer        DocumentStream
	epoch       [16]byte
	initialized bool
	subscribers map[*codeSubscription]bool
	pending     []*codeBatch
	awareness   map[*codeSubscription][]byte
	receipts    []*codeBatch
	next        uint64
	sent        uint64
}
type codeBatch struct {
	streamSeq  uint64
	sub        *codeSubscription
	seq        uint64
	actor      []byte
	sv, update []byte
}
type codeSubscription struct {
	owner  *codeDocument
	actor  []byte
	client uint32
	seq    uint64
	frames chan []byte
	done   chan struct{}
	closed bool
	err    error
	bytes  int
}

func (h *CodeDocuments) open(ctx context.Context, key string, open func(context.Context) (DocumentStream, error), actor []byte) (DocumentStream, error) {
	if h == nil || h.Library == nil {
		return nil, errors.New(Unsupported)
	}
	h.mu.Lock()
	if h.docs == nil {
		h.docs = make(map[string]*codeDocument)
	}
	d := h.docs[key]
	if d == nil {
		lifetime, cancel := context.WithCancel(context.Background())
		d = &codeDocument{host: h, key: key, ctx: lifetime, cancel: cancel, ready: make(chan struct{}), done: make(chan struct{}), subscribers: make(map[*codeSubscription]bool)}
		h.docs[key] = d
		go d.run(open)
	}
	h.mu.Unlock()
	select {
	case <-ctx.Done():
		d.mu.Lock()
		if len(d.subscribers) == 0 {
			d.cancel()
		}
		d.mu.Unlock()
		return nil, ctx.Err()
	case <-d.ready:
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.err != nil {
		return nil, d.err
	}
	if d.ctx.Err() != nil {
		return nil, d.ctx.Err()
	}
	var client uint32
	for client == 0 {
		var b [4]byte
		if _, err := rand.Read(b[:]); err != nil {
			return nil, err
		}
		client = binary.BigEndian.Uint32(b[:])
		for s := range d.subscribers {
			if s.client == client {
				client = 0
				break
			}
		}
	}
	author, err := d.doc.SetAuthor(uint64(client), string(actor))
	if err != nil {
		return nil, err
	}
	s := &codeSubscription{owner: d, actor: append([]byte(nil), actor...), client: client, frames: make(chan []byte, 256), done: make(chan struct{})}
	d.subscribers[s] = true
	s.push(wire.Document{Msg: wire.DocumentEpoch, Epoch: d.epoch, ClientID: client})
	state, err := d.doc.Sync2([]byte{0})
	if err != nil {
		s.closeLocked()
		return nil, err
	}
	s.push(wire.Document{Msg: wire.DocumentSync, Data: syncPayload(1, state)})
	d.broadcast(wire.Document{Msg: wire.DocumentSync, Data: syncPayload(2, author)}, s)
	// Author registration is host-owned, sent ahead of this subscriber's edits.
	d.queue(nil, actor, nil, author)
	return s, nil
}

func (d *codeDocument) run(open func(context.Context) (DocumentStream, error)) {
	var err error
	defer func() {
		d.mu.Lock()
		if err == nil {
			err = context.Canceled
		}
		d.err = err
		if !d.initialized {
			close(d.ready)
		}
		for s := range d.subscribers {
			s.closeLocked()
		}
		if d.doc != nil {
			_ = d.doc.Close()
		}
		d.mu.Unlock()
		d.cancel()
		if d.peer != nil {
			_ = d.peer.Close()
		}
		d.host.mu.Lock()
		if d.host.docs[d.key] == d {
			delete(d.host.docs, d.key)
		}
		d.host.mu.Unlock()
		close(d.done)
	}()
	startup, stop := context.WithTimeout(d.ctx, 5*time.Second)
	defer stop()
	// Keep the stream on the mirror lifetime, not the startup deadline.
	startupLimit := time.AfterFunc(5*time.Second, d.cancel)
	defer startupLimit.Stop()
	d.peer, err = open(d.ctx)
	if err != nil {
		return
	}
	d.doc, err = d.host.Library.Open(livedocument.Code, nil)
	if err != nil {
		return
	}
	// Start from an empty vector. No browser receives an epoch or snapshot until
	// the daemon has answered sync step 2 and its state has passed native validation.
	err = d.send(startup, wire.Document{Msg: wire.DocumentInput, Actor: []byte("host"), Data: syncPayload(0, []byte{0})})
	if err != nil {
		return
	}
	hasEpoch := false
	for !d.initialized {
		var raw []byte
		raw, err = d.peer.Receive(startup)
		if err != nil {
			return
		}
		var msg wire.Document
		msg, err = wire.DecodeDocumentV2(raw)
		if err != nil {
			return
		}
		if msg.Msg == wire.DocumentEpoch {
			d.epoch = msg.Epoch
			hasEpoch = true
			continue
		}
		if msg.Msg != wire.DocumentSync || !hasEpoch {
			err = errors.New("daemon snapshot required")
			return
		}
		var kind uint64
		var payload []byte
		kind, payload, err = parseSync(msg.Data)
		if err != nil {
			return
		}
		if kind == 0 {
			var state []byte
			state, err = d.doc.Sync2(payload)
			if err == nil {
				err = d.send(startup, wire.Document{Msg: wire.DocumentInput, Actor: []byte("host"), Data: syncPayload(1, state)})
			}
			if err != nil {
				return
			}
			continue
		}
		if kind != 1 {
			err = errors.New("daemon sync step 2 required")
			return
		}
		_, err = d.doc.Peer(payload)
		if err != nil {
			return
		}
		d.mu.Lock()
		d.initialized = true
		close(d.ready)
		d.mu.Unlock()
	}
	startupLimit.Stop()
	stop()
	// Receive runs independently of the 50 ms send cadence. A stalled machine
	// cannot hold up host fan-out. Cancellation closes both directions.
	incoming := make(chan []byte)
	failed := make(chan error, 1)
	go func() {
		for {
			b, e := d.peer.Receive(d.ctx)
			if e != nil {
				failed <- e
				return
			}
			select {
			case incoming <- b:
			case <-d.ctx.Done():
				return
			}
		}
	}()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-d.ctx.Done():
			return
		case err = <-failed:
			return
		case raw := <-incoming:
			d.mu.Lock()
			err = d.receive(raw)
			d.mu.Unlock()
			if err != nil {
				return
			}
		case <-ticker.C:
			d.mu.Lock()
			batch := d.pending
			awareness := d.awareness
			d.awareness = nil
			d.pending = nil
			d.mu.Unlock()
			for sub, payload := range awareness {
				err = d.send(d.ctx, wire.Document{Msg: wire.DocumentAwarenessInput, Actor: sub.actor, Data: payload})
				if err != nil {
					return
				}
			}
			for _, b := range batch {
				err = d.send(d.ctx, wire.Document{Msg: wire.DocumentInput, Actor: b.actor, Seq: b.streamSeq, Data: syncPayload(2, b.update)})
				if err != nil {
					return
				}
				d.mu.Lock()
				d.sent = b.streamSeq
				d.mu.Unlock()
			}
		}
	}
}
func (d *codeDocument) send(ctx context.Context, msg wire.Document) error {
	b, e := wire.EncodeDocumentV2(msg)
	if e != nil {
		return e
	}
	return d.peer.Send(ctx, b)
}
func (d *codeDocument) receive(raw []byte) error {
	msg, err := wire.DecodeDocumentV2(raw)
	if err != nil {
		return err
	}
	switch msg.Msg {
	case wire.DocumentSync:
		kind, payload, e := parseSync(msg.Data)
		if e != nil {
			return e
		}
		if kind == 0 {
			return errors.New("unexpected daemon resync")
		}
		if _, e = d.doc.Peer(payload); e != nil {
			return e
		}
		d.broadcast(msg, nil)
	case wire.DocumentSaved:
		if msg.ThroughSeq > d.sent {
			return errors.New("receipt beyond sent sequence")
		}
		// Map each stream receipt to the subscription it covers. State vectors alone
		// never cover a delete: only this ledger advances the browser's seq.
		covered := make(map[*codeSubscription]uint64)
		n := 0
		for _, b := range d.receipts {
			if b.streamSeq > msg.ThroughSeq {
				break
			}
			n++
			if b.sub != nil && b.seq > covered[b.sub] {
				covered[b.sub] = b.seq
			}
		}
		d.receipts = d.receipts[n:]
		for s, seq := range covered {
			receipt := msg
			receipt.ThroughSeq = seq
			s.push(receipt)
		}
	case wire.DocumentEpoch:
		// A changed epoch invalidates the cache. Force a fresh daemon handshake;
		// browsers retain unreceipted edits for explicit recovery.
		return errors.New("daemon epoch changed")
	case wire.DocumentGone, wire.DocumentAwareness:
		d.broadcast(msg, nil)
	case 255:
		return errors.New("daemon refused document")
	default:
		return wire.ErrDocumentPayload
	}
	return nil
}
func (d *codeDocument) queue(s *codeSubscription, actor, sv, update []byte) {
	if s != nil && len(d.pending) > 0 {
		last := d.pending[len(d.pending)-1]
		if last.sub == s {
			// Sync2 carries the delete set too, even when the vector did not advance.
			if merged, e := d.doc.Sync2(last.sv); e == nil {
				last.update = merged
				last.seq = s.seq
				return
			}
		}
	}
	d.next++
	b := &codeBatch{streamSeq: d.next, sub: s, actor: append([]byte(nil), actor...), seq: 0, sv: sv, update: update}
	if s != nil {
		b.seq = s.seq
	}
	d.pending = append(d.pending, b)
	d.receipts = append(d.receipts, b)
}
func (d *codeDocument) broadcast(msg wire.Document, except *codeSubscription) {
	for s := range d.subscribers {
		if s != except {
			s.push(msg)
		}
	}
}
func (s *codeSubscription) push(msg wire.Document) {
	if s.closed {
		return
	}
	b, e := wire.EncodeDocumentV2(msg)
	if e != nil {
		s.closeLocked()
		return
	}
	if s.bytes+len(b) > SendBudget {
		s.err = errDocumentGap
		s.closeLocked()
		return
	}
	select {
	case s.frames <- b:
		s.bytes += len(b)
	default:
		s.err = errDocumentGap
		s.closeLocked()
	}
}
func (s *codeSubscription) Send(ctx context.Context, raw []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	msg, err := wire.DecodeDocument(raw)
	if err != nil {
		return err
	}
	d := s.owner
	d.mu.Lock()
	defer d.mu.Unlock()
	if s.closed || d.err != nil {
		return context.Canceled
	}
	if msg.Msg == wire.DocumentAwarenessInput {
		stamped, e := s.awareness(msg.Data)
		if e != nil {
			s.push(wire.Document{Msg: 255, Refusal: 11})
			return nil
		}
		d.broadcast(wire.Document{Msg: wire.DocumentAwareness, Data: stamped}, s)
		if d.awareness == nil {
			d.awareness = make(map[*codeSubscription][]byte)
		}
		d.awareness[s] = stamped
		return nil
	}
	if msg.Msg != wire.DocumentInput {
		return wire.ErrDocumentPayload
	}
	kind, payload, err := parseSync(msg.Data)
	if err != nil {
		return err
	}
	if kind == 0 {
		update, e := d.doc.Sync2(payload)
		if e != nil {
			return e
		}
		s.push(wire.Document{Msg: wire.DocumentSync, Data: syncPayload(1, update)})
		return nil
	}
	sv, err := d.doc.Sync1()
	if err != nil {
		return err
	}
	update, err := d.doc.Apply(uint64(s.client), payload)
	if err != nil {
		s.push(wire.Document{Msg: 255, Refusal: 11})
		return nil
	}
	s.seq++
	d.broadcast(wire.Document{Msg: wire.DocumentSync, Data: syncPayload(2, update)}, s)
	d.queue(s, s.actor, sv, update)
	// Bound unreceipted data even if the daemon never acknowledges saves.
	total := 0
	for _, b := range d.receipts {
		total += len(b.update) + 128
	}
	if total > SendBudget {
		d.cancel()
	}
	return nil
}
func (s *codeSubscription) Receive(ctx context.Context) ([]byte, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-s.done:
		s.owner.mu.Lock()
		err := s.err
		s.owner.mu.Unlock()
		if err != nil {
			return nil, err
		}
		return nil, context.Canceled
	case b := <-s.frames:
		s.owner.mu.Lock()
		s.bytes -= len(b)
		s.owner.mu.Unlock()
		return b, nil
	}
}
func (s *codeSubscription) closeLocked() {
	if !s.closed {
		s.closed = true
		close(s.done)
		delete(s.owner.subscribers, s)
	}
}
func (s *codeSubscription) Close() error {
	d := s.owner
	d.mu.Lock()
	s.closeLocked()
	if len(d.subscribers) == 0 {
		d.cancel()
	}
	d.mu.Unlock()
	return nil
}

// Close discards mirrors, never daemon state. Shutdown and tests share this path.
func (h *CodeDocuments) Close() {
	h.mu.Lock()
	docs := make([]*codeDocument, 0, len(h.docs))
	for _, d := range h.docs {
		d.cancel()
		docs = append(docs, d)
	}
	h.mu.Unlock()
	for _, d := range docs {
		<-d.done
	}
}

// Awareness never trusts a browser's actor, colour or another tab's client id.
func (s *codeSubscription) awareness(raw []byte) ([]byte, error) {
	if len(raw) > 64<<10 {
		return nil, wire.ErrDocumentPayload
	}
	read := func() (uint64, error) {
		v, n := binary.Uvarint(raw)
		if n <= 0 {
			return 0, wire.ErrDocumentPayload
		}
		raw = raw[n:]
		return v, nil
	}
	count, e := read()
	if e != nil || count != 1 {
		return nil, wire.ErrDocumentPayload
	}
	client, e := read()
	if e != nil || client != uint64(s.client) {
		return nil, wire.ErrDocumentPayload
	}
	clock, e := read()
	if e != nil {
		return nil, e
	}
	size, e := read()
	if e != nil || size != uint64(len(raw)) {
		return nil, wire.ErrDocumentPayload
	}
	var state map[string]json.RawMessage
	if e = json.Unmarshal(raw, &state); e != nil {
		return nil, e
	}
	if state != nil {
		allowed := make(map[string]json.RawMessage)
		for _, key := range []string{"line", "anchor", "head", "cursor"} {
			if v, ok := state[key]; ok {
				allowed[key] = v
			}
		}
		allowed["actor"], _ = json.Marshal(map[string]string{"id": string(s.actor), "kind": "person", "via": "app"})
		colour := sha256.Sum256(s.actor)
		allowed["colour"], _ = json.Marshal(fmt.Sprintf("#%02x%02x%02x", colour[0], colour[1], colour[2]))
		raw, e = json.Marshal(allowed)
		if e != nil {
			return nil, e
		}
	}
	out := binary.AppendUvarint([]byte{1}, client)
	out = binary.AppendUvarint(out, clock)
	out = binary.AppendUvarint(out, uint64(len(raw)))
	out = append(out, raw...)
	return s.owner.doc.Awareness(out)
}

func syncPayload(kind uint64, payload []byte) []byte {
	b := binary.AppendUvarint(nil, kind)
	b = binary.AppendUvarint(b, uint64(len(payload)))
	return append(b, payload...)
}
func parseSync(b []byte) (uint64, []byte, error) {
	kind, n := binary.Uvarint(b)
	if n <= 0 || kind > 2 {
		return 0, nil, wire.ErrDocumentPayload
	}
	b = b[n:]
	size, n := binary.Uvarint(b)
	if n <= 0 || size != uint64(len(b)-n) {
		return 0, nil, wire.ErrDocumentPayload
	}
	return kind, b[n:], nil
}
