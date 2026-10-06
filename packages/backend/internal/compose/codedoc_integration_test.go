package compose

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/livedocument"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/stretchr/testify/require"
)

// These are literal Yjs v1 structures, not values encoded by the implementation.
func codeInsert(client uint32, text string) []byte {
	b := []byte{1, 1}
	b = binary.AppendUvarint(b, uint64(client))
	b = append(b, 0, 4, 1, 7)
	b = append(b, []byte("content")...)
	b = binary.AppendUvarint(b, uint64(len(text)))
	b = append(b, []byte(text)...)
	return append(b, 0)
}
func codeDelete(client uint32, n uint64) []byte {
	b := []byte{0, 1}
	b = binary.AppendUvarint(b, uint64(client))
	b = append(b, 1, 0)
	return binary.AppendUvarint(b, n)
}
func codeSync(kind byte, payload []byte) []byte {
	b := binary.AppendUvarint([]byte{kind}, uint64(len(payload)))
	return append(b, payload...)
}
func codeDecode(t *testing.T, b []byte) (byte, []byte) {
	t.Helper()
	require.NotEmpty(t, b)
	n, k := binary.Uvarint(b[1:])
	require.Positive(t, k)
	require.Equal(t, int(n), len(b)-1-k)
	return b[0], b[1+k:]
}
func (f *docFixture) assigned(t *testing.T) uint32 {
	t.Helper()
	kind, b := f.read(t)
	require.Equal(t, websocket.MessageText, kind)
	var snap struct {
		T    string
		Data struct {
			Epoch    string
			ClientID uint32 `json:"client_id"`
		}
	}
	require.NoError(t, json.Unmarshal(b, &snap))
	require.Equal(t, "snap", snap.T)
	require.Equal(t, "00112233445566778899aabbccddeeff", snap.Data.Epoch)
	require.NotZero(t, snap.Data.ClientID)
	kind, b = f.read(t)
	require.Equal(t, websocket.MessageBinary, kind)
	require.Equal(t, []byte{1, 0, 0, 0, 7}, b[:5])
	k, _ := codeDecode(t, b[5:])
	require.Equal(t, byte(1), k)
	return snap.Data.ClientID
}
func (f *docFixture) update(t *testing.T, update []byte) {
	t.Helper()
	require.NoError(t, f.conn.Write(t.Context(), websocket.MessageBinary, append([]byte{1, 0, 0, 0, 7}, codeSync(2, update)...)))
}

// A daemon peer backed by the same native core, with explicitly controlled
// durability receipts. This does not claim guest disk durability.
type codePeer struct {
	mu   sync.Mutex
	doc  *livedocument.Document
	save bool
	last uint64
}

func peerFor(t *testing.T, f *docFixture) *codePeer {
	t.Helper()
	lib, err := livedocument.Load(os.Getenv("SMITHERS_FFI_LIBRARY_PATH"))
	require.NoError(t, err)
	doc, err := lib.Open(livedocument.Code, nil)
	require.NoError(t, err)
	p := &codePeer{doc: doc, save: true}
	t.Cleanup(func() { f.relay.Host.Close(); doc.Close(); require.NoError(t, lib.Close()) })
	f.daemon.Reply = func(raw []byte) [][]byte {
		p.mu.Lock()
		defer p.mu.Unlock()
		msg, e := wire.DecodeDocumentV2(raw)
		require.NoError(t, e)
		require.Equal(t, wire.DocumentInput, msg.Msg)
		k, update := codeDecode(t, msg.Data)
		if k == 0 {
			return nil
		}
		_, e = p.doc.Peer(update)
		require.NoError(t, e)
		require.Greater(t, msg.Seq, p.last)
		p.last = msg.Seq
		if !p.save {
			return nil
		}
		sv, e := doc.Sync1()
		require.NoError(t, e)
		reply, e := wire.EncodeDocumentV2(wire.Document{Msg: wire.DocumentSaved, AtMS: 1791028800000, ThroughSeq: msg.Seq, Data: sv})
		require.NoError(t, e)
		return [][]byte{reply}
	}
	return p
}
func readSaved(t *testing.T, f *docFixture, want uint64) {
	t.Helper()
	for {
		_, raw := f.read(t)
		var saved struct {
			T   string
			ID  uint32
			SV  string
			Seq uint64
		}
		require.NoError(t, json.Unmarshal(raw, &saved))
		require.Equal(t, "saved", saved.T)
		require.Equal(t, uint32(7), saved.ID)
		require.NotEmpty(t, saved.SV)
		require.LessOrEqual(t, saved.Seq, want)
		if saved.Seq == want {
			return
		}
	}
}

func TestDocRelayWireContract(t *testing.T) {
	f := newDocFixture(t)
	p := peerFor(t, f)
	f.sub(t, "doc:code:branch-a:retry.ts")
	client := f.assigned(t)
	f.update(t, codeInsert(client, "hello"))
	readSaved(t, f, 1)
	f.update(t, codeDelete(client, 5))
	readSaved(t, f, 2)
	p.mu.Lock()
	text, err := p.doc.Text("content")
	p.mu.Unlock()
	require.NoError(t, err)
	require.Empty(t, text)
	opened, sent, _ := f.daemon.Recorded()
	require.Len(t, opened, 1)
	require.Equal(t, []byte("host"), opened[0].Actor)
	require.GreaterOrEqual(t, len(sent), 3)
	for _, b := range sent {
		msg, e := wire.DecodeDocumentV2(b)
		require.NoError(t, e)
		require.Equal(t, wire.DocumentInput, msg.Msg)
	}
}
func TestDocRelayAuthorization(t *testing.T) {
	for _, attack := range []string{"foreign client", "authors map"} {
		t.Run(attack, func(t *testing.T) {
			f := newDocFixture(t)
			peerFor(t, f)
			for _, topic := range []string{"doc:code:branch-b:retry.ts", "doc:code:branch-a:secret"} {
				f.sub(t, topic)
				f.text(t, `{"t":"err","id":7,"code":"forbidden"}`)
			}
			f.sub(t, "doc:code:branch-a:retry.ts")
			client := f.assigned(t)
			var update []byte
			if attack == "foreign client" {
				update = codeInsert(client^1, "forged")
			} else {
				// Obtain a valid authors-map insertion under the admitted client's id.
				// Yjs: map key "x", any value string "forged".
				update = []byte{1, 1}
				update = binary.AppendUvarint(update, uint64(client))
				update = append(update, 0, 40, 1, 7)
				update = append(update, []byte("authors")...)
				update = append(update, 1, 'x', 1, 119, 6)
				update = append(update, []byte("forged")...)
				update = append(update, 0)
			}
			f.update(t, update)
			f.text(t, `{"t":"err","id":7,"code":"forbidden"}`)
			_, sent, _ := f.daemon.Recorded()
			for _, raw := range sent {
				msg, e := wire.DecodeDocumentV2(raw)
				require.NoError(t, e)
				require.NotContains(t, string(msg.Data), "forged")
			}
		})
	}
}
func TestDocRelayMirrorRecovery(t *testing.T) {
	f := newDocFixture(t)
	p := peerFor(t, f)
	f.sub(t, "doc:code:branch-a:retry.ts")
	client := f.assigned(t)
	f.update(t, codeInsert(client, "deleted"))
	readSaved(t, f, 1)
	f.update(t, codeDelete(client, 7))
	readSaved(t, f, 2)
	p.mu.Lock()
	state, err := p.doc.State()
	p.mu.Unlock()
	require.NoError(t, err)
	f.relay.Host.Close()
	f.text(t, `{"t":"err","id":7,"code":"unsupported"}`)
	require.Eventually(t, func() bool { _, _, n := f.daemon.Recorded(); return n == 1 }, time.Second, time.Millisecond)
	// Restart rebuilds the mirror from the daemon state record, including the
	// delete set. No saved receipt exists in this handshake.
	f.daemon.Script = [][]byte{docGolden(t, "epoch"), append([]byte{3}, codeSync(1, state)...)}
	f.daemon.Reply = nil
	f.sub(t, "doc:code:branch-a:retry.ts")
	kind, raw := f.read(t)
	require.Equal(t, websocket.MessageText, kind)
	require.Contains(t, string(raw), `"t":"snap"`)
	kind, raw = f.read(t)
	require.Equal(t, websocket.MessageBinary, kind)
	_, snapshot := codeDecode(t, raw[5:])
	lib, err := livedocument.Load(os.Getenv("SMITHERS_FFI_LIBRARY_PATH"))
	require.NoError(t, err)
	defer lib.Close()
	doc, err := lib.Open(livedocument.Code, snapshot)
	require.NoError(t, err)
	defer doc.Close()
	text, err := doc.Text("content")
	require.NoError(t, err)
	require.Empty(t, text)
}
func TestDocRelayDarkLanding(t *testing.T) {
	for _, missing := range []string{"host", "authorizer", "connection", "daemon", "wiki"} {
		t.Run(missing, func(t *testing.T) {
			f := newDocFixture(t)
			topic := "doc:code:branch-a:retry.ts"
			switch missing {
			case "host":
				f.relay.Host = nil
			case "authorizer":
				f.relay.Authorize = nil
			case "connection":
				f.relay.Connection = nil
			case "daemon":
				f.relay.Connection = func(context.Context, string) (*machined.Connection, live.DocumentRPC) { return f.binding, nil }
			case "wiki":
				topic = "doc:wiki:page"
			}
			f.sub(t, topic)
			f.text(t, `{"t":"err","id":7,"code":"unsupported"}`)
			opened, sent, _ := f.daemon.Recorded()
			require.Empty(t, opened)
			require.Empty(t, sent)
		})
	}
}
func TestDocRelayDataOnly(t *testing.T) {
	f := newDocFixture(t)
	p := peerFor(t, f)
	f.sub(t, "doc:code:branch-a:$(touch marker);echo text")
	client := f.assigned(t)
	text := "import('file:///tmp/branch'); $(sudo launchctl load x); exec('rm -rf /')"
	f.update(t, codeInsert(client, text))
	readSaved(t, f, 1)
	p.mu.Lock()
	got, err := p.doc.Text("content")
	p.mu.Unlock()
	require.NoError(t, err)
	require.Equal(t, text, got)
	opened, _, _ := f.daemon.Recorded()
	require.Equal(t, "$(touch marker);echo text", opened[0].Path)
}
func TestDocRelayRevocation(t *testing.T) {
	for _, when := range []string{"startup", "admitted"} {
		t.Run(when, func(t *testing.T) {
			bus := revocation.NewBus(nil, nil)
			routes.SetRevocationSource(bus)
			t.Cleanup(func() { routes.SetRevocationSource(nil) })
			f := newDocFixture(t)
			if when == "startup" {
				f.relay.Authorize = func(ctx context.Context, _ live.DocumentTopic, repo, member int64) ([]byte, string) {
					bus.Deliver(revocation.Event{Kind: revocation.KindCollaboratorRemoved, RepositoryID: repo, UserID: member})
					select {
					case <-ctx.Done():
					case <-time.After(time.Second):
						t.Error("startup revocation timed out")
					}
					return nil, live.Forbidden
				}
			}
			f.sub(t, "doc:code:branch-a:retry.ts")
			if when == "admitted" {
				f.assigned(t)
				digest := sha256.Sum256([]byte("doc-cookie"))
				bus.Deliver(revocation.Event{Kind: revocation.KindBrowserSessionRevoked, TokenHash: hex.EncodeToString(digest[:])})
			}
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			for {
				_, _, err := f.conn.Read(ctx)
				if err != nil {
					require.NotEqual(t, context.DeadlineExceeded, ctx.Err())
					break
				}
			}
		})
	}
}

func TestDocRelayBackpressure(t *testing.T) {
	f := newDocFixture(t)
	f.sub(t, "doc:code:branch-a:retry.ts")
	f.assigned(t)
	raw := make([]byte, (2<<20)+1)
	copy(raw, []byte{1, 0, 0, 0, 7})
	require.NoError(t, f.conn.Write(t.Context(), websocket.MessageBinary, raw))
	f.text(t, `{"t":"gap","id":7}`)
	require.Eventually(t, func() bool { _, _, closed := f.daemon.Recorded(); return closed == 1 }, time.Second, time.Millisecond)
	f.sub(t, "doc:code:branch-a:retry.ts")
	f.assigned(t)
}

func TestDocRelaySharedMirror(t *testing.T) {
	f := newDocFixture(t)
	p := peerFor(t, f)
	p.mu.Lock()
	p.save = false
	p.mu.Unlock()
	f.sub(t, "doc:code:branch-a:retry.ts")
	a := f.assigned(t)
	origin := f.server.URL
	second, _, err := websocket.Dial(t.Context(), "ws"+strings.TrimPrefix(origin, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{live.Protocol}, HTTPHeader: http.Header{"Origin": {origin}, "Cookie": {"session=doc-cookie"}}})
	require.NoError(t, err)
	t.Cleanup(func() { second.CloseNow() })
	other := &docFixture{conn: second}
	other.sub(t, "doc:code:branch-a:retry.ts")
	b := other.assigned(t)
	require.NotEqual(t, a, b)
	kind, raw := f.read(t)
	require.Equal(t, websocket.MessageBinary, kind) // host-owned authors delta
	f.update(t, codeInsert(a, "A"))
	kind, raw = other.read(t)
	require.Equal(t, websocket.MessageBinary, kind)
	_, update := codeDecode(t, raw[5:])
	require.Contains(t, string(update), "A")
	other.update(t, codeInsert(b, "B"))
	kind, raw = f.read(t)
	require.Equal(t, websocket.MessageBinary, kind)
	_, update = codeDecode(t, raw[5:])
	require.Contains(t, string(update), "B")
	require.Eventually(t, func() bool {
		p.mu.Lock()
		defer p.mu.Unlock()
		text, _ := p.doc.Text("content")
		return text == "AB" || text == "BA"
	}, time.Second, time.Millisecond)
	opened, _, _ := f.daemon.Recorded()
	require.Len(t, opened, 1, "tabs must share the daemon peer")
	// A later receipt covers both clients independently, including A's deletion.
	p.mu.Lock()
	p.save = true
	p.mu.Unlock()
	f.update(t, codeDelete(a, 1))
	readSaved(t, f, 2)
	// B sees A's deletion before the receipt for its own edit.
	kind, _ = other.read(t)
	require.Equal(t, websocket.MessageBinary, kind)
	readSaved(t, other, 1)
}

func TestDocRelayRebuildBarrier(t *testing.T) {
	f := newDocFixture(t, docGolden(t, "epoch"))
	release := make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	f.daemon.Reply = func([]byte) [][]byte { <-release; return [][]byte{{3, 1, 2, 0, 0}} }
	f.sub(t, "doc:code:branch-a:retry.ts")
	type result struct {
		kind websocket.MessageType
		raw  []byte
		err  error
	}
	frames := make(chan result, 1)
	go func() { k, b, e := f.conn.Read(t.Context()); frames <- result{k, b, e} }()
	select {
	case got := <-frames:
		t.Fatalf("snapshot before daemon rebuild: %s (%v)", got.raw, got.err)
	case <-time.After(100 * time.Millisecond):
	}
	once.Do(func() { close(release) })
	select {
	case got := <-frames:
		require.NoError(t, got.err)
		require.Equal(t, websocket.MessageText, got.kind)
		require.Contains(t, string(got.raw), `"t":"snap"`)
	case <-time.After(5 * time.Second):
		t.Fatal("no rebuilt snapshot")
	}
	kind, _ := f.read(t)
	require.Equal(t, websocket.MessageBinary, kind)
}

type codeRPC func(context.Context, string, []byte) (machined.DocumentStream, error)

func (f codeRPC) OpenDocument(ctx context.Context, path string, actor []byte) (machined.DocumentStream, error) {
	return f(ctx, path, actor)
}

type interruptedDocument struct {
	machined.DocumentStream
	link context.Context
}

func (s interruptedDocument) Receive(ctx context.Context) ([]byte, error) {
	read, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(s.link, cancel)
	defer stop()
	return s.DocumentStream.Receive(read)
}
func (s interruptedDocument) Send(ctx context.Context, b []byte) error {
	if s.link.Err() != nil {
		return s.link.Err()
	}
	return s.DocumentStream.Send(ctx, b)
}

func TestDocRelayReconnectUnreceipted(t *testing.T) {
	f := newDocFixture(t)
	p := peerFor(t, f)
	original := f.relay.Connection
	link, drop := context.WithCancel(t.Context())
	defer drop()
	var offline atomic.Bool
	var opens atomic.Int32
	f.relay.Connection = func(ctx context.Context, branch string) (*machined.Connection, live.DocumentRPC) {
		if offline.Load() {
			return nil, nil
		}
		binding, rpc := original(ctx, branch)
		return binding, codeRPC(func(ctx context.Context, path string, actor []byte) (machined.DocumentStream, error) {
			number := opens.Add(1)
			if number > 1 {
				p.mu.Lock()
				state, err := p.doc.State()
				p.last = 0
				p.mu.Unlock()
				require.NoError(t, err)
				f.daemon.Script = [][]byte{docGolden(t, "epoch"), append([]byte{3}, codeSync(1, state)...)}
			}
			stream, err := rpc.OpenDocument(ctx, path, actor)
			if number == 1 && err == nil {
				return interruptedDocument{stream, link}, nil
			}
			return stream, err
		})
	}
	f.sub(t, "doc:code:branch-a:retry.ts")
	client := f.assigned(t)
	readSaved(t, f, 0) // Untouched text is saved only after the daemon says so.
	offline.Store(true)
	drop()
	f.update(t, codeInsert(client, "offline"))
	// Request the live host snapshot while no daemon link can be opened.
	require.NoError(t, f.conn.Write(t.Context(), websocket.MessageBinary, []byte{1, 0, 0, 0, 7, 0, 1, 0}))
	kind, raw := f.read(t)
	require.Equal(t, websocket.MessageBinary, kind)
	require.Contains(t, string(raw), "offline")
	require.Equal(t, int32(1), opens.Load())
	offline.Store(false)
	kind, _ = f.read(t)
	require.Equal(t, websocket.MessageBinary, kind) // peer resync delta
	readSaved(t, f, 1)
	require.Equal(t, int32(2), opens.Load())
	p.mu.Lock()
	text, err := p.doc.Text("content")
	p.mu.Unlock()
	require.NoError(t, err)
	require.Equal(t, "offline", text)
}

func TestDocRelayAuthorizationAwareness(t *testing.T) {
	f := newDocFixture(t)
	observed := make(chan wire.Document, 1)
	f.daemon.Reply = func(raw []byte) [][]byte {
		msg, err := wire.DecodeDocumentV2(raw)
		require.NoError(t, err)
		if msg.Msg == wire.DocumentAwarenessInput {
			observed <- msg
		}
		return nil
	}
	f.sub(t, "doc:code:branch-a:retry.ts")
	client := f.assigned(t)
	awareness := func(id uint32) []byte {
		data := []byte(`{"actor":{"id":"Mallory"},"colour":"red","line":3,"permission":"admin"}`)
		raw := binary.AppendUvarint([]byte{1}, uint64(id))
		raw = append(raw, 1)
		raw = binary.AppendUvarint(raw, uint64(len(data)))
		return append(raw, data...)
	}
	require.NoError(t, f.conn.Write(t.Context(), websocket.MessageBinary, append([]byte{2, 0, 0, 0, 7}, awareness(client)...)))
	select {
	case msg := <-observed:
		require.Equal(t, []byte("Be"), msg.Actor)
		raw := msg.Data
		for i := 0; i < 4; i++ {
			_, n := binary.Uvarint(raw)
			require.Positive(t, n)
			raw = raw[n:]
		}
		var value map[string]any
		require.NoError(t, json.Unmarshal(raw, &value))
		require.Equal(t, "Be", value["actor"].(map[string]any)["id"])
		require.NotEqual(t, "red", value["colour"])
		require.Equal(t, float64(3), value["line"])
		require.NotContains(t, value, "permission")
	case <-time.After(time.Second):
		t.Fatal("awareness not forwarded")
	}
	require.NoError(t, f.conn.Write(t.Context(), websocket.MessageBinary, append([]byte{2, 0, 0, 0, 7}, awareness(client^1)...)))
	f.text(t, `{"t":"err","id":7,"code":"forbidden"}`)
}

func TestDocRelayEpochResync(t *testing.T) {
	f := newDocFixture(t)
	epoch := docGolden(t, "epoch")
	epoch[1] = 0xff
	f.daemon.Reply = func(raw []byte) [][]byte {
		msg, err := wire.DecodeDocumentV2(raw)
		require.NoError(t, err)
		if msg.Seq > 0 {
			return [][]byte{epoch}
		}
		return nil
	}
	f.sub(t, "doc:code:branch-a:retry.ts")
	f.assigned(t)
	f.text(t, `{"t":"gap","id":7}`)
	require.Eventually(t, func() bool { _, _, n := f.daemon.Recorded(); return n == 1 }, time.Second, time.Millisecond)
	f.daemon.Reply = nil
	f.daemon.Script = [][]byte{epoch, {3, 1, 2, 0, 0}}
	f.sub(t, "doc:code:branch-a:retry.ts")
	kind, raw := f.read(t)
	require.Equal(t, websocket.MessageText, kind)
	require.Contains(t, string(raw), `"epoch":"ff112233445566778899aabbccddeeff"`)
	kind, _ = f.read(t)
	require.Equal(t, websocket.MessageBinary, kind)
}
