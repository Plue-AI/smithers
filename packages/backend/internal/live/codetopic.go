package live

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"strconv"
	"sync"

	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
)

// maxInflight bounds inputs awaiting the daemon's one reply each. A daemon
// that stops replying ends the topic, never host memory.
const maxInflight = 4096

// codeTopics keeps one daemon stream per open code document on an admitted
// machine connection (ADR 0003, ADR 0004 S3). The host owns subscriber client
// ids, fans the daemon's frames out to subscribers and maps the daemon's
// receipts to each subscriber's own sequence. It never holds or parses the
// document: Yjs bytes pass through, and the only frame it writes is a one-item
// authors-map registration for a client id it assigns.
type codeTopics struct {
	mu      sync.Mutex
	open    map[topicKey]*codeTopic
	clients map[string]*clientTable
}

type topicKey struct {
	topic      string
	connection *machined.Connection
}

// clientTable outlives a topic's stream: a subscriber that resubscribes after
// a gap keeps its actor-bound client id while the connection and epoch hold.
type clientTable struct {
	connection *machined.Connection
	epoch      [16]byte
	actors     map[uint32][]byte
}

type codeTopic struct {
	topics *codeTopics
	key    topicKey
	ctx    context.Context
	cancel context.CancelFunc
	ready  chan struct{}
	done   chan struct{}
	// sendMu orders daemon sends with their inflight entries; mu guards state.
	sendMu      sync.Mutex
	mu          sync.Mutex
	stream      DocumentStream
	opener      []byte
	epoch       [16]byte
	initialized bool
	err         error
	subs        map[*codeSub]bool
	inflight    []inflight
	ledger      []receipt
	next        uint64
	sent        uint64
	waiting     int
	// openerClient is the daemon's fresh id for the stream's opener. It is
	// assigned once: a reused id's structs would reach a new tab as remote
	// changes to its own client, which Yjs answers by changing its id.
	openerClient uint32
	openerTaken  bool
}

const (
	inputSync1 = iota
	inputUpdate
	inputAwareness
	inputRegistration
)

// inflight is one input awaiting its single daemon reply, in send order.
type inflight struct {
	sub  *codeSub
	kind int
	echo []byte
}

type receipt struct {
	seq    uint64
	sub    *codeSub
	subSeq uint64
}

type codeSub struct {
	topic  *codeTopic
	actor  []byte
	client uint32
	frames chan []byte
	bytes  int
	done   chan struct{}
	closed bool
	err    error
	saved  uint64
}

// subscribe joins topic on connection, opening its daemon stream if needed.
func (t *codeTopics) subscribe(ctx context.Context, key topicKey, actor []byte, requested uint32, open func(context.Context, []byte) (DocumentStream, error)) (DocumentStream, error) {
	t.mu.Lock()
	if t.open == nil {
		t.open = make(map[topicKey]*codeTopic)
	}
	topic := t.open[key]
	if topic == nil || topic.ctx.Err() != nil {
		lifetime, cancel := context.WithCancel(context.Background())
		topic = &codeTopic{topics: t, key: key, ctx: lifetime, cancel: cancel, ready: make(chan struct{}), done: make(chan struct{}), subs: make(map[*codeSub]bool), opener: append([]byte(nil), actor...)}
		t.open[key] = topic
		go topic.run(open)
	}
	t.mu.Unlock()
	topic.mu.Lock()
	topic.waiting++
	topic.mu.Unlock()
	defer func() {
		topic.mu.Lock()
		topic.waiting--
		topic.mu.Unlock()
		topic.release()
	}()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-topic.ready:
	}
	return topic.join(actor, requested)
}

func (t *codeTopics) table(key topicKey, epoch [16]byte) *clientTable {
	if t.clients == nil {
		t.clients = make(map[string]*clientTable)
	}
	table := t.clients[key.topic]
	if table == nil || table.connection != key.connection || table.epoch != epoch {
		table = &clientTable{connection: key.connection, epoch: epoch, actors: make(map[uint32][]byte)}
		t.clients[key.topic] = table
	}
	return table
}

func (t *codeTopic) run(open func(context.Context, []byte) (DocumentStream, error)) {
	stream, err := open(t.ctx, t.opener)
	if err == nil {
		t.mu.Lock()
		t.stream = stream
		t.mu.Unlock()
		err = t.read(stream)
	}
	t.fail(err)
	if stream != nil {
		_ = stream.Close()
	}
	close(t.done)
}

// read applies daemon frames as they arrive. Each input gets exactly one
// reply in order; any other frame is the daemon's own and fans out to all.
func (t *codeTopic) read(stream DocumentStream) error {
	for {
		raw, err := stream.Receive(t.ctx)
		if err != nil {
			return err
		}
		msg, err := wire.DecodeDocumentV2(raw)
		if err != nil {
			return err
		}
		t.mu.Lock()
		err = t.receive(msg)
		t.mu.Unlock()
		if err != nil {
			return err
		}
	}
}

func (t *codeTopic) receive(msg wire.Document) error {
	var head *inflight
	if len(t.inflight) > 0 {
		head = &t.inflight[0]
	}
	pop := func() { t.inflight = t.inflight[1:] }
	switch msg.Msg {
	case wire.DocumentEpoch:
		if t.initialized {
			// A new epoch invalidates every subscriber's client id and state.
			return errDocumentGap
		}
		t.epoch, t.initialized, t.openerClient = msg.Epoch, true, msg.ClientID
		t.topics.mu.Lock()
		t.topics.table(t.key, t.epoch).actors[msg.ClientID] = t.opener
		t.topics.mu.Unlock()
		close(t.ready)
	case wire.DocumentSync:
		if !t.initialized || len(msg.Data) == 0 {
			return wire.ErrDocumentPayload
		}
		switch {
		case head != nil && head.kind == inputSync1 && msg.Data[0] == 1:
			// Sync step 2 answers only the subscriber that asked.
			pop()
			head.sub.push(msg)
		case head != nil && (head.kind == inputUpdate || head.kind == inputRegistration) && bytes.Equal(msg.Data, head.echo):
			// The daemon applied this input; every other subscriber receives it.
			pop()
			t.broadcast(msg, head.sub)
		default:
			t.broadcast(msg, nil)
		}
	case wire.DocumentAwareness:
		if head != nil && head.kind == inputAwareness && bytes.Equal(msg.Data, head.echo) {
			pop()
			t.broadcast(msg, head.sub)
			return nil
		}
		t.broadcast(msg, nil)
	case wire.DocumentSaved:
		if !t.initialized || msg.ThroughSeq > t.sent {
			return errors.New("receipt beyond sent sequence")
		}
		covered := make(map[*codeSub]uint64)
		n := 0
		for _, r := range t.ledger {
			if r.seq > msg.ThroughSeq {
				break
			}
			n++
			if r.sub != nil && r.subSeq > covered[r.sub] {
				covered[r.sub] = r.subSeq
			}
		}
		t.ledger = t.ledger[n:]
		for s := range t.subs {
			if covered[s] > s.saved {
				s.saved = covered[s]
			}
			receipt := msg
			receipt.ThroughSeq = s.saved
			s.push(receipt)
		}
	case wire.DocumentGone:
		t.broadcast(msg, nil)
	case 255:
		if head == nil {
			return errors.New("unattributed daemon refusal")
		}
		// The daemon refused one subscriber's input; only that subscriber ends.
		pop()
		if head.kind == inputRegistration {
			t.topics.mu.Lock()
			delete(t.topics.table(t.key, t.epoch).actors, head.sub.client)
			t.topics.mu.Unlock()
		}
		head.sub.push(msg)
		head.sub.closeLocked()
	default:
		return wire.ErrDocumentPayload
	}
	return nil
}

func (t *codeTopic) broadcast(msg wire.Document, except *codeSub) {
	for s := range t.subs {
		if s != except {
			s.push(msg)
		}
	}
}

// join assigns the subscriber's client id: the one it held before a gap when
// it still belongs to this actor, the daemon's opener id, or a new id the
// host registers in the document's authors map.
func (t *codeTopic) join(actor []byte, requested uint32) (DocumentStream, error) {
	t.sendMu.Lock()
	defer t.sendMu.Unlock()
	t.mu.Lock()
	if t.err != nil {
		err := t.err
		t.mu.Unlock()
		return nil, err
	}
	inUse := func(client uint32) bool {
		for s := range t.subs {
			if s.client == client {
				return true
			}
		}
		return false
	}
	t.topics.mu.Lock()
	table := t.topics.table(t.key, t.epoch)
	var client uint32
	switch {
	case requested != 0 && bytes.Equal(table.actors[requested], actor) && !inUse(requested):
		// The same provider resubscribing after a gap keeps its identity.
		client = requested
	case !t.openerTaken && t.openerClient != 0 && bytes.Equal(t.opener, actor):
		t.openerTaken = true
		client = t.openerClient
	}
	var registration []byte
	if client == 0 {
		var err error
		client, err = freshClient(table.actors)
		if err == nil {
			var registrar uint32
			registrar, err = freshClient(map[uint32][]byte{client: nil})
			registration = authorRegistration(registrar, client, hex.EncodeToString(actor))
		}
		if err != nil {
			t.topics.mu.Unlock()
			t.mu.Unlock()
			return nil, err
		}
		table.actors[client] = append([]byte(nil), actor...)
	}
	t.topics.mu.Unlock()
	s := &codeSub{topic: t, actor: append([]byte(nil), actor...), client: client, frames: make(chan []byte, 256), done: make(chan struct{})}
	t.subs[s] = true
	var payload []byte
	if registration != nil {
		var err error
		payload, err = t.enqueue(s, inputRegistration, 0, wire.DocumentInput, syncPayload(2, registration))
		if err != nil {
			s.closeLocked()
			t.mu.Unlock()
			return nil, err
		}
	}
	s.push(wire.Document{Msg: wire.DocumentEpoch, Epoch: t.epoch, ClientID: client})
	t.mu.Unlock()
	if payload != nil {
		if err := t.stream.Send(t.ctx, payload); err != nil {
			t.fail(err)
			return nil, err
		}
	}
	return s, nil
}

// enqueue records the input and returns its daemon frame. Callers hold mu and
// sendMu, and send before releasing sendMu, so replies match send order.
func (t *codeTopic) enqueue(s *codeSub, kind int, subSeq uint64, msg byte, data []byte) ([]byte, error) {
	if len(t.inflight) >= maxInflight {
		return nil, errDocumentGap
	}
	frame := wire.Document{Msg: msg, Actor: s.actor, Data: data}
	entry := inflight{sub: s, kind: kind}
	switch kind {
	case inputUpdate, inputRegistration:
		t.next++
		frame.Seq = t.next
		t.sent = t.next
		entry.echo = append([]byte{2}, data[1:]...)
		r := receipt{seq: t.next, subSeq: subSeq}
		if kind == inputUpdate {
			r.sub = s
		}
		t.ledger = append(t.ledger, r)
	case inputAwareness:
		entry.echo = data
	}
	payload, err := wire.EncodeDocumentV2(frame)
	if err != nil {
		return nil, err
	}
	t.inflight = append(t.inflight, entry)
	return payload, nil
}

func (t *codeTopic) fail(err error) {
	if err == nil {
		err = context.Canceled
	}
	t.topics.mu.Lock()
	if t.topics.open[t.key] == t {
		delete(t.topics.open, t.key)
	}
	t.topics.mu.Unlock()
	t.mu.Lock()
	if t.err == nil {
		t.err = err
	}
	if !t.initialized {
		t.initialized = true
		close(t.ready)
	}
	for s := range t.subs {
		// Every subscriber resubscribes and restarts sync step 1.
		s.err = errDocumentGap
		s.closeLocked()
	}
	t.mu.Unlock()
	t.cancel()
}

// release closes the topic when its last subscriber leaves.
func (t *codeTopic) release() {
	t.mu.Lock()
	empty := len(t.subs) == 0 && t.waiting == 0
	t.mu.Unlock()
	if empty {
		t.cancel()
	}
}

func (s *codeSub) push(msg wire.Document) {
	if s.closed {
		return
	}
	b, err := wire.EncodeDocumentV2(msg)
	if err != nil || s.bytes+len(b) > SendBudget {
		// Spec §7.1.1: only this subscriber falls behind and resubscribes.
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

func (s *codeSub) closeLocked() {
	if !s.closed {
		s.closed = true
		close(s.done)
		delete(s.topic.subs, s)
	}
}

// Send stamps the subscriber's actor and forwards its frame on the topic's
// daemon stream with a stream sequence.
func (s *codeSub) Send(ctx context.Context, raw []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	msg, err := wire.DecodeDocumentV2(raw)
	if err != nil {
		return err
	}
	t := s.topic
	t.sendMu.Lock()
	defer t.sendMu.Unlock()
	t.mu.Lock()
	if s.closed || t.err != nil {
		t.mu.Unlock()
		return context.Canceled
	}
	var payload []byte
	switch msg.Msg {
	case wire.DocumentAwarenessInput:
		payload, err = t.enqueue(s, inputAwareness, 0, wire.DocumentAwarenessInput, msg.Data)
	case wire.DocumentInput:
		var kind uint64
		kind, _, err = parseSync(msg.Data)
		if err == nil && kind == 0 {
			payload, err = t.enqueue(s, inputSync1, 0, wire.DocumentInput, msg.Data)
		} else if err == nil {
			payload, err = t.enqueue(s, inputUpdate, msg.Seq, wire.DocumentInput, msg.Data)
		}
	default:
		err = wire.ErrDocumentPayload
	}
	t.mu.Unlock()
	if err != nil {
		if errors.Is(err, errDocumentGap) {
			t.fail(err)
		}
		return err
	}
	if err := t.stream.Send(t.ctx, payload); err != nil {
		t.fail(err)
		return err
	}
	return nil
}

func (s *codeSub) Receive(ctx context.Context) ([]byte, error) {
	t := s.topic
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case b := <-s.frames:
		t.mu.Lock()
		s.bytes -= len(b)
		t.mu.Unlock()
		return b, nil
	case <-s.done:
		// Frames queued before a refusal still reach the subscriber.
		select {
		case b := <-s.frames:
			t.mu.Lock()
			s.bytes -= len(b)
			t.mu.Unlock()
			return b, nil
		default:
		}
		t.mu.Lock()
		err := s.err
		t.mu.Unlock()
		if err != nil {
			return nil, err
		}
		return nil, context.Canceled
	}
}

func (s *codeSub) Close() error {
	t := s.topic
	t.mu.Lock()
	s.closeLocked()
	t.mu.Unlock()
	t.release()
	return nil
}

// freshClient picks an unused id above the daemon's own range, which counts
// up from 1, so host and daemon allocations never collide.
func freshClient(used map[uint32][]byte) (uint32, error) {
	for attempts := 0; attempts < 64; attempts++ {
		var b [4]byte
		if _, err := rand.Read(b[:]); err != nil {
			return 0, err
		}
		id := binary.BigEndian.Uint32(b[:]) | 1<<31
		if _, taken := used[id]; !taken {
			return id, nil
		}
	}
	return 0, errors.New("client id allocation exhausted")
}

// authorRegistration is one Yjs v1 update that sets authors[client] = key. A
// one-use registrar client writes it, so no subscriber's clock is consumed.
// The daemon accepts it only as one new author for the envelope's actor.
func authorRegistration(registrar, client uint32, key string) []byte {
	str := func(b []byte, s string) []byte {
		return append(binary.AppendUvarint(b, uint64(len(s))), s...)
	}
	b := binary.AppendUvarint([]byte{1, 1}, uint64(registrar))
	// clock 0; ContentAny under a map key (0x28); parent is a named root.
	b = append(b, 0, 0x28, 1)
	b = str(b, "authors")
	b = str(b, strconv.FormatUint(uint64(client), 10))
	// one value: a string.
	b = append(b, 1, 119)
	b = str(b, key)
	// empty delete set
	return append(b, 0)
}
