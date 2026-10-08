package live

import (
	"context"
	"encoding/binary"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/livedocument"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

// fakeDaemon answers like the daemon's document dispatcher: exactly one reply
// per input, in order (sync step 2, an echo, or a refusal), plus receipts.
type fakeDaemon struct {
	mu     sync.Mutex
	opens  [][]byte
	inputs []wire.Document
	closed int
	out    chan []byte
	refuse func(wire.Document) bool
	save   bool
	// owners stands in for the daemon's durable authors map (client → actor).
	owners map[uint32]string
}

func newFakeDaemon() *fakeDaemon { return &fakeDaemon{out: make(chan []byte, 1024), save: true} }

// emit writes to the most recently opened stream, as one daemon link would.
func (d *fakeDaemon) emit(t *testing.T, msg wire.Document) {
	t.Helper()
	b, err := wire.EncodeDocumentV2(msg)
	require.NoError(t, err)
	d.mu.Lock()
	out := d.out
	d.mu.Unlock()
	out <- b
}

func (d *fakeDaemon) open(t *testing.T) func(context.Context, []byte) (DocumentStream, error) {
	return func(_ context.Context, actor []byte) (DocumentStream, error) {
		d.mu.Lock()
		d.opens = append(d.opens, append([]byte(nil), actor...))
		d.out = make(chan []byte, 1024)
		stream := &fakeStream{d: d, t: t, out: d.out}
		d.mu.Unlock()
		d.emit(t, wire.Document{Msg: wire.DocumentEpoch, Epoch: [16]byte{1}, ClientID: 5})
		return stream, nil
	}
}

func (d *fakeDaemon) recorded() []wire.Document {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]wire.Document(nil), d.inputs...)
}

type fakeStream struct {
	d   *fakeDaemon
	t   *testing.T
	out chan []byte
}

func (s *fakeStream) Send(_ context.Context, raw []byte) error {
	msg, err := wire.DecodeDocumentV2(raw)
	if err != nil {
		return err
	}
	d := s.d
	d.mu.Lock()
	d.inputs = append(d.inputs, msg)
	refuse := d.refuse != nil && d.refuse(msg)
	save := d.save
	d.mu.Unlock()
	switch {
	case refuse:
		d.emit(s.t, wire.Document{Msg: 255, Refusal: 11})
	case msg.Msg == wire.DocumentAwarenessInput:
		// Like peer_awareness: echo only when authors[client] is the actor.
		client, _ := binary.Uvarint(msg.Data[1:])
		d.mu.Lock()
		owner, known := d.owners[uint32(client)]
		d.mu.Unlock()
		if known && owner == string(msg.Actor) {
			d.emit(s.t, wire.Document{Msg: wire.DocumentAwareness, Data: msg.Data})
		} else {
			d.emit(s.t, wire.Document{Msg: 255, Refusal: 11})
		}
	case msg.Data[0] == 0:
		d.emit(s.t, wire.Document{Msg: wire.DocumentSync, Data: syncPayload(1, []byte{0, 0})})
	default:
		d.emit(s.t, wire.Document{Msg: wire.DocumentSync, Data: append([]byte{2}, msg.Data[1:]...)})
		if save {
			d.emit(s.t, wire.Document{Msg: wire.DocumentSaved, AtMS: 1, ThroughSeq: msg.Seq, Data: []byte{0}})
		}
	}
	return nil
}
func (s *fakeStream) Receive(ctx context.Context) ([]byte, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case b := <-s.out:
		return b, nil
	}
}
func (s *fakeStream) Close() error {
	s.d.mu.Lock()
	s.d.closed++
	s.d.mu.Unlock()
	return nil
}

type topicBrowser struct {
	t      *testing.T
	stream DocumentStream
	seq    uint64
	actor  []byte
}

func (b *topicBrowser) next() wire.Document {
	b.t.Helper()
	ctx, cancel := context.WithTimeout(b.t.Context(), 2*time.Second)
	defer cancel()
	raw, err := b.stream.Receive(ctx)
	require.NoError(b.t, err)
	msg, err := wire.DecodeDocumentV2(raw)
	require.NoError(b.t, err)
	return msg
}

// until skips receipts for earlier inputs and returns the next frame of kind.
func (b *topicBrowser) until(kind byte) wire.Document {
	b.t.Helper()
	for {
		msg := b.next()
		if msg.Msg == kind || msg.Msg != wire.DocumentSaved {
			require.Equal(b.t, kind, msg.Msg)
			return msg
		}
	}
}

// send is what conn forwards: the actor stamped, a per-subscription sequence.
func (b *topicBrowser) send(kind uint64, payload []byte) {
	b.t.Helper()
	if kind != 0 {
		b.seq++
	}
	raw, err := wire.EncodeDocumentV2(wire.Document{Msg: wire.DocumentInput, Actor: b.actor, Seq: b.seq, Data: syncPayload(kind, payload)})
	require.NoError(b.t, err)
	require.NoError(b.t, b.stream.Send(b.t.Context(), raw))
}

func joinTopic(t *testing.T, topics *codeTopics, d *fakeDaemon, actor []byte, requested uint32) (*topicBrowser, uint32) {
	t.Helper()
	stream, err := topics.subscribe(t.Context(), topicKey{topic: "doc:code:b:retry.ts"}, actor, requested, d.open(t))
	require.NoError(t, err)
	b := &topicBrowser{t: t, stream: stream, actor: actor}
	t.Cleanup(func() { _ = stream.Close() })
	epoch := b.next()
	require.Equal(t, wire.DocumentEpoch, epoch.Msg)
	return b, epoch.ClientID
}

func insert(client uint32, clock uint64, text string) []byte {
	b := binary.AppendUvarint([]byte{1, 1}, uint64(client))
	b = binary.AppendUvarint(b, clock)
	b = append(b, 4, 1, 7)
	b = append(b, "content"...)
	b = binary.AppendUvarint(b, uint64(len(text)))
	return append(append(b, text...), 0)
}

// One daemon stream serves every subscriber. A second member is registered in
// the authors map under its own actor, and the daemon's echo of each update
// reaches every other subscriber after the daemon accepted it.
func TestCodeTopicOneStreamFansOut(t *testing.T) {
	topics, d := &codeTopics{}, newFakeDaemon()
	alice, aliceClient := joinTopic(t, topics, d, []byte("alice"), 0)
	require.Equal(t, uint32(5), aliceClient, "the opener takes the daemon's fresh id")
	ben, benClient := joinTopic(t, topics, d, []byte("ben"), 0)
	require.NotEqual(t, aliceClient, benClient)
	require.Len(t, d.opens, 1)
	inputs := d.recorded()
	require.Len(t, inputs, 1, "ben's client is registered before his first frame")
	require.Equal(t, []byte("ben"), inputs[0].Actor)
	require.Equal(t, uint64(1), inputs[0].Seq)
	if path := os.Getenv("SMITHERS_FFI_LIBRARY_PATH"); path != "" {
		library, err := livedocument.Load(path)
		require.NoError(t, err)
		defer library.Close()
		doc, err := library.Open(livedocument.Code, nil)
		require.NoError(t, err)
		defer doc.Close()
		_, payload, err := parseSync(inputs[0].Data)
		require.NoError(t, err)
		_, err = doc.Peer(payload)
		require.NoError(t, err)
		again, err := doc.SetAuthor(uint64(benClient), "62656e")
		require.NoError(t, err)
		require.Equal(t, []byte{0, 0}, again, "the registration maps ben's client to ben's principal key")
	}
	// Alice receives ben's registration once the daemon applied it.
	alice.until(wire.DocumentSync)
	require.Zero(t, alice.until(wire.DocumentSaved).ThroughSeq, "a registration acknowledges no browser edit")
	alice.send(2, insert(aliceClient, 0, "A"))
	echo := ben.until(wire.DocumentSync)
	require.Equal(t, syncPayload(2, insert(aliceClient, 0, "A")), echo.Data)
	saved := alice.until(wire.DocumentSaved)
	require.Equal(t, uint64(1), saved.ThroughSeq, "alice's own sequence, not the stream's")
	require.Zero(t, ben.until(wire.DocumentSaved).ThroughSeq)
	inputs = d.recorded()
	require.Equal(t, []byte("alice"), inputs[1].Actor)
	require.Equal(t, uint64(2), inputs[1].Seq)
	require.Equal(t, syncPayload(2, insert(aliceClient, 0, "A")), inputs[1].Data, "document bytes pass through unparsed")
}

// Sync step 2 answers only the subscriber that asked.
func TestCodeTopicSyncAnswersRequester(t *testing.T) {
	topics, d := &codeTopics{}, newFakeDaemon()
	alice, _ := joinTopic(t, topics, d, []byte("alice"), 0)
	ben, _ := joinTopic(t, topics, d, []byte("ben"), 0)
	alice.until(wire.DocumentSync) // ben's registration
	ben.send(0, []byte{0})
	step2 := ben.until(wire.DocumentSync)
	require.Equal(t, byte(1), step2.Data[0])
	alice.send(2, insert(5, 0, "A"))
	require.Equal(t, byte(2), ben.until(wire.DocumentSync).Data[0])
}

// A refusal ends only the subscriber whose input the daemon refused.
func TestCodeTopicRefusalEndsOnlyThatSubscriber(t *testing.T) {
	topics, d := &codeTopics{}, newFakeDaemon()
	alice, aliceClient := joinTopic(t, topics, d, []byte("alice"), 0)
	ben, _ := joinTopic(t, topics, d, []byte("ben"), 0)
	alice.until(wire.DocumentSync)
	d.mu.Lock()
	d.refuse = func(msg wire.Document) bool { return string(msg.Actor) == "ben" }
	d.mu.Unlock()
	ben.send(2, insert(aliceClient, 1, "forged"))
	refusal := ben.until(255)
	require.Equal(t, byte(11), refusal.Refusal)
	_, err := ben.stream.Receive(t.Context())
	require.Error(t, err)
	alice.send(2, insert(aliceClient, 0, "A"))
	for alice.until(wire.DocumentSaved).ThroughSeq != 1 {
	}
}

// Spec §7.1.1 and ADR 0003: a subscriber over its 2 MiB budget gaps alone. It
// resubscribes with its client id and keeps it, so unsaved typing resends as
// the same author and no recovery is needed.
func TestCodeTopicGapKeepsClientIdentity(t *testing.T) {
	topics, d := &codeTopics{}, newFakeDaemon()
	alice, aliceClient := joinTopic(t, topics, d, []byte("alice"), 0)
	ben, benClient := joinTopic(t, topics, d, []byte("ben"), 0)
	alice.until(wire.DocumentSync)
	alice.until(wire.DocumentSaved)
	d.mu.Lock()
	d.save = false
	d.mu.Unlock()
	// Ben never reads while the daemon broadcasts more than his budget.
	for i := 0; i < 40; i++ {
		d.emit(t, wire.Document{Msg: wire.DocumentSync, Data: syncPayload(2, make([]byte, 64<<10))})
		require.Equal(t, wire.DocumentSync, alice.until(wire.DocumentSync).Msg)
	}
	var err error
	for err == nil {
		_, err = ben.stream.Receive(t.Context())
	}
	require.ErrorIs(t, err, errDocumentGap)
	require.Len(t, d.opens, 1, "the topic's stream outlives one slow subscriber")
	before := len(d.recorded())
	resumed, client := joinTopic(t, topics, d, []byte("ben"), benClient)
	require.Equal(t, benClient, client)
	require.Len(t, d.recorded(), before, "a kept client needs no new registration")
	resumed.send(2, insert(benClient, 0, "typed during the gap"))
	require.Equal(t, []byte("ben"), d.recorded()[before].Actor)
	// Another member cannot claim ben's id; a new tab never reuses an id.
	_, other := joinTopic(t, topics, d, []byte("mallory"), benClient)
	require.NotEqual(t, benClient, other)
	_, tab := joinTopic(t, topics, d, []byte("ben"), 0)
	require.NotEqual(t, benClient, tab)
	_ = aliceClient
}

// A host restart loses the client table but not the daemon's authors map. The
// host admits a requested id the daemon assigns to the same actor, so typing
// resends without Reapply; another member's claim and an unknown id get a new
// id instead.
func TestCodeTopicRestartKeepsOwnedClient(t *testing.T) {
	d := newFakeDaemon()
	_, _ = joinTopic(t, &codeTopics{}, d, []byte("alice"), 0)
	d.mu.Lock()
	d.owners = map[uint32]string{0x80000001: "ben", 5: "alice"}
	d.mu.Unlock()
	restarted := &codeTopics{}
	before := len(d.recorded())
	ben, client := joinTopic(t, restarted, d, []byte("ben"), 0x80000001)
	require.Equal(t, uint32(0x80000001), client)
	inputs := d.recorded()[before:]
	require.Len(t, inputs, 1, "one ownership probe, no registration")
	require.Equal(t, wire.DocumentAwarenessInput, inputs[0].Msg)
	require.Equal(t, []byte("ben"), inputs[0].Actor)
	require.Equal(t, removalNotice(0x80000001), inputs[0].Data)
	ben.send(2, insert(client, 0, "resent"))
	require.Equal(t, uint64(1), ben.until(wire.DocumentSaved).ThroughSeq)
	_, other := joinTopic(t, restarted, d, []byte("mallory"), 0x80000001)
	require.NotEqual(t, uint32(0x80000001), other, "another member cannot claim the id")
	_, unknown := joinTopic(t, restarted, d, []byte("ben"), 0x80000002)
	require.NotEqual(t, uint32(0x80000002), unknown, "an id the daemon never assigned is not admitted")
}

// After the last subscriber leaves, the topic closes its daemon stream; a new
// opener of the same actor never receives the old opener id.
func TestCodeTopicCloseAndReopen(t *testing.T) {
	topics, d := &codeTopics{}, newFakeDaemon()
	alice, first := joinTopic(t, topics, d, []byte("alice"), 0)
	require.NoError(t, alice.stream.Close())
	require.Eventually(t, func() bool { d.mu.Lock(); defer d.mu.Unlock(); return d.closed == 1 }, time.Second, time.Millisecond)
	_, again := joinTopic(t, topics, d, []byte("alice"), first)
	require.Equal(t, first, again, "the same provider keeps its id across a reopened stream")
	require.Len(t, d.opens, 2)
}

// A new daemon epoch ends every subscriber; their ids belonged to that epoch.
func TestCodeTopicEpochChangeGapsAll(t *testing.T) {
	topics, d := &codeTopics{}, newFakeDaemon()
	alice, _ := joinTopic(t, topics, d, []byte("alice"), 0)
	ben, _ := joinTopic(t, topics, d, []byte("ben"), 0)
	alice.until(wire.DocumentSync)
	d.emit(t, wire.Document{Msg: wire.DocumentEpoch, Epoch: [16]byte{2}, ClientID: 9})
	for _, b := range []*topicBrowser{alice, ben} {
		var err error
		for err == nil {
			_, err = b.stream.Receive(t.Context())
		}
		require.ErrorIs(t, err, errDocumentGap)
	}
}

// Admission is cached per subscription, rechecked after its maximum age and
// immediately after a roster or grant change.
func TestDocRelayAdmissionCache(t *testing.T) {
	var mu sync.Mutex
	calls, refused := 0, false
	now := time.Unix(1791028800, 0)
	r := &DocRelay{
		Authorize: func(context.Context, DocumentTopic, int64, int64) ([]byte, string) {
			mu.Lock()
			defer mu.Unlock()
			calls++
			if refused {
				return nil, Forbidden
			}
			return []byte("alice"), ""
		},
		Connection: func(context.Context, string) (*machined.Connection, DocumentRPC) { return readyConnection(t), nil },
		Now:        func() time.Time { mu.Lock(); defer mu.Unlock(); return now },
	}
	_, code := r.Resolve(t.Context(), "doc:code:branch:a", 1, 1)
	require.Equal(t, Unsupported, code, "no daemon document handler")
	rpc := machined.Documents(nil, "branch")
	r.Connection = func(context.Context, string) (*machined.Connection, DocumentRPC) { return readyConnection(t), rpc }
	source, code := r.Resolve(t.Context(), "doc:code:branch:a", 1, 1)
	require.Empty(t, code)
	count := func() int { mu.Lock(); defer mu.Unlock(); return calls }
	start := count()
	for i := 0; i < 100; i++ {
		require.NoError(t, source.Document.Ready())
	}
	require.Equal(t, start, count(), "frames reuse the admission")
	r.Invalidate()
	require.NoError(t, source.Document.Ready())
	require.Equal(t, start+1, count())
	mu.Lock()
	refused = true
	now = now.Add(admissionMaxAge - time.Millisecond)
	mu.Unlock()
	require.NoError(t, source.Document.Ready(), "still within the maximum age")
	mu.Lock()
	now = now.Add(time.Millisecond)
	mu.Unlock()
	require.ErrorIs(t, source.Document.Ready(), machined.ErrUnauthorized)
	mu.Lock()
	refused = false
	mu.Unlock()
	require.NoError(t, source.Document.Ready(), "a refusal is never cached")
}

var testConnections sync.Map

// readyConnection is one admitted, reconciled connection for branch "branch".
func readyConnection(t *testing.T) *machined.Connection {
	if c, ok := testConnections.Load(t.Name()); ok {
		return c.(*machined.Connection)
	}
	registry := new(machined.Registry)
	var boot [16]byte
	boot[0] = 7
	require.NoError(t, registry.BindBoot("branch", "machine", boot, []byte("credential")))
	c, err := registry.Admit(boot, []byte("credential"), nopCloser{})
	require.NoError(t, err)
	require.NoError(t, c.Reconciled())
	testConnections.Store(t.Name(), c)
	return c
}

type nopCloser struct{}

func (nopCloser) Read([]byte) (int, error) { return 0, os.ErrClosed }
func (nopCloser) Close() error             { return nil }
