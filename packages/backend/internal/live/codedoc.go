package live

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"errors"
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
	actor       []byte
	mu          sync.Mutex
	ctx         context.Context
	cancel      context.CancelFunc
	ready       chan struct{}
	done        chan struct{}
	err         error
	doc         *livedocument.Document
	peer        DocumentStream
	peerCancel  context.CancelFunc
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
	saved  uint64
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
		d = &codeDocument{host: h, key: key, actor: append([]byte(nil), actor...), ctx: lifetime, cancel: cancel, ready: make(chan struct{}), done: make(chan struct{}), subscribers: make(map[*codeSubscription]bool)}
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
	var author []byte
	for attempts := 0; attempts < 32; attempts++ {
		var b [4]byte
		if _, err := rand.Read(b[:]); err != nil {
			return nil, err
		}
		client = binary.BigEndian.Uint32(b[:])
		if client == 0 {
			continue
		}
		delta, err := d.doc.SetAuthor(uint64(client), hex.EncodeToString(actor))
		if errors.Is(err, livedocument.ErrRefused) {
			continue
		}
		if err != nil {
			return nil, err
		}
		// An existing author returns an empty update. Never reuse a retired tab's
		// CRDT clock, even when the same person opens another tab in this epoch.
		if len(delta) == 2 && delta[0] == 0 && delta[1] == 0 {
			continue
		}
		author = delta
		break
	}
	if author == nil {
		return nil, errors.New("client id allocation exhausted")
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
		d.cancel()
		// Remove before notifying subscribers so an immediate gap resubscribe
		// cannot find the discarded epoch's cache.
		d.host.mu.Lock()
		if d.host.docs[d.key] == d {
			delete(d.host.docs, d.key)
		}
		d.host.mu.Unlock()
		d.mu.Lock()
		if err == nil {
			err = context.Canceled
		}
		d.err = err
		if !d.initialized {
			close(d.ready)
		}
		for s := range d.subscribers {
			if errors.Is(err, errDocumentGap) {
				s.err = errDocumentGap
			}
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
		close(d.done)
	}()
	d.doc, err = d.host.Library.Open(livedocument.Code, nil)
	if err != nil {
		return
	}
	err = d.connect(open)
	if err != nil {
		return
	}
	for d.ctx.Err() == nil {
		err = d.pump()
		if d.ctx.Err() != nil {
			return
		}
		_ = d.peer.Close()
		if errors.Is(err, errDocumentGap) {
			return
		}
		// The mirror remains usable while the peer is down. Only the bounded
		// unreceipted ledger is retried; no local event can claim a disk save.
		for {
			select {
			case <-d.ctx.Done():
				return
			case <-time.After(time.Second):
			}
			err = d.connect(open)
			if err == nil {
				break
			}
			if d.peer != nil {
				_ = d.peer.Close()
			}
			if errors.Is(err, errDocumentGap) {
				return
			}
		}
	}
}

func (d *codeDocument) connect(open func(context.Context) (DocumentStream, error)) error {
	peerctx, cancel := context.WithCancel(d.ctx)
	limit := time.AfterFunc(5*time.Second, cancel)
	ok := false
	defer func() {
		limit.Stop()
		if !ok {
			cancel()
		}
	}()
	peer, err := open(peerctx)
	if err != nil {
		return err
	}
	d.peer = peer
	startup, stop := context.WithTimeout(peerctx, 5*time.Second)
	defer stop()
	d.mu.Lock()
	sv, err := d.doc.Sync1()
	d.mu.Unlock()
	if err != nil {
		return err
	}
	if err = d.send(startup, wire.Document{Msg: wire.DocumentInput, Actor: d.actor, Data: syncPayload(0, sv)}); err != nil {
		return err
	}
	hasEpoch := false
	for {
		raw, err := peer.Receive(startup)
		if err != nil {
			return err
		}
		msg, err := wire.DecodeDocumentV2(raw)
		if err != nil {
			return err
		}
		if msg.Msg == wire.DocumentEpoch {
			d.mu.Lock()
			changed := d.initialized && d.epoch != msg.Epoch
			if !changed {
				d.epoch = msg.Epoch
			}
			d.mu.Unlock()
			if changed {
				return errDocumentGap
			}
			hasEpoch = true
			continue
		}
		if !hasEpoch || msg.Msg != wire.DocumentSync {
			return wire.ErrDocumentPayload
		}
		kind, payload, err := parseSync(msg.Data)
		if err != nil {
			return err
		}
		if kind == 0 {
			d.mu.Lock()
			state, e := d.doc.Sync2(payload)
			d.mu.Unlock()
			if e != nil {
				return e
			}
			if e = d.send(startup, wire.Document{Msg: wire.DocumentInput, Actor: d.actor, Data: syncPayload(1, state)}); e != nil {
				return e
			}
			continue
		}
		if kind != 1 {
			return wire.ErrDocumentPayload
		}
		d.mu.Lock()
		_, err = d.doc.Peer(payload)
		if err == nil {
			if !d.initialized {
				d.initialized = true
				close(d.ready)
			} else {
				d.broadcast(wire.Document{Msg: wire.DocumentSync, Data: syncPayload(2, payload)}, nil)
				d.next = 0
				d.sent = 0
				for _, batch := range d.receipts {
					d.next++
					batch.streamSeq = d.next
				}
				d.pending = append([]*codeBatch(nil), d.receipts...)
			}
		}
		d.mu.Unlock()
		if err != nil {
			return err
		}
		ok = true
		// The successful stream keeps its context until mirror shutdown. A child
		// context is explicitly released when its transport ends by pump.
		d.peerCancel = cancel
		return nil
	}
}

func (d *codeDocument) pump() error {
	// The receiver exits before pump returns, so a reconnect's renumbered
	// ledger never sees a receipt from the previous stream.
	var receiving sync.WaitGroup
	defer receiving.Wait()
	ctx, cancel := context.WithCancel(d.ctx)
	defer cancel()
	defer d.peerCancel()
	peer := d.peer
	failed := make(chan error, 1)
	// Daemon frames are applied as they arrive, never only between sends. The
	// link queues few frames per stream and closes the whole machine link when
	// one stream's queue overflows, so receipts must drain during a burst.
	receiving.Add(1)
	go func() {
		defer receiving.Done()
		for {
			b, e := peer.Receive(ctx)
			if e == nil {
				d.mu.Lock()
				if e = ctx.Err(); e == nil {
					e = d.receive(b)
				}
				d.mu.Unlock()
			}
			if e != nil {
				failed <- e
				return
			}
		}
	}()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-d.ctx.Done():
			return d.ctx.Err()
		case err := <-failed:
			return err
		case <-ticker.C:
			d.mu.Lock()
			batch := d.pending
			d.pending = nil
			awareness := d.awareness
			d.awareness = nil
			d.mu.Unlock()
			for sub, payload := range awareness {
				if err := d.send(ctx, wire.Document{Msg: wire.DocumentAwarenessInput, Actor: sub.actor, Data: payload}); err != nil {
					return err
				}
			}
			for _, b := range batch {
				// A fast daemon may acknowledge before Send returns. A failed send
				// ends this stream; reconnect renumbers the whole ledger.
				d.mu.Lock()
				d.sent = b.streamSeq
				d.mu.Unlock()
				if err := d.send(ctx, wire.Document{Msg: wire.DocumentInput, Actor: b.actor, Seq: b.streamSeq, Data: syncPayload(2, b.update)}); err != nil {
					return err
				}
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
		for s := range d.subscribers {
			if covered[s] > s.saved {
				s.saved = covered[s]
			}
			receipt := msg
			receipt.ThroughSeq = s.saved
			s.push(receipt)
		}
	case wire.DocumentEpoch:
		// A changed epoch invalidates the cache. Force a fresh daemon handshake;
		// browsers retain unreceipted edits for explicit recovery.
		return errDocumentGap
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
	d.broadcast(wire.Document{Msg: wire.DocumentSync, Data: syncPayload(2, update)}, s)
	if kind == 2 {
		s.seq++
		d.queue(s, s.actor, sv, update)
	} else {
		// Handshake sync step 2 is not a browser edit. Counting it would let
		// its receipt acknowledge a later delete-only edit prematurely.
		d.queue(nil, s.actor, sv, update)
	}
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
	return stampDocumentAwareness(raw, s.client, s.actor, s.owner.doc)
}
