package compose

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/livedocument"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
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

// A fake daemon on the native core with immediate, sequence-bound receipts.
// The relay under test never parses its document; this proves no durability.
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
	t.Cleanup(func() { doc.Close(); require.NoError(t, lib.Close()) })
	f.daemon.Reply = func(raw []byte) [][]byte {
		p.mu.Lock()
		defer p.mu.Unlock()
		msg, e := wire.DecodeDocumentV2(raw)
		require.NoError(t, e)
		if msg.Msg != wire.DocumentInput {
			return nil
		}
		k, update := codeDecode(t, msg.Data)
		if k != 2 {
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

var docActor = []byte{0x00, 0xff, 0x80, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d}

// The host forwards the browser's sync bytes unparsed, stamped with the
// admitted actor and a per-subscription sequence the daemon receipts.
func TestDocRelayWireContract(t *testing.T) {
	f := newDocFixture(t)
	p := peerFor(t, f)
	f.sub(t, "doc:code:branch-a:retry.ts")
	client := f.assigned(t)
	insert, deletion := codeInsert(client, "hello"), codeDelete(client, 5)
	f.update(t, insert)
	readSaved(t, f, 1)
	f.update(t, deletion)
	readSaved(t, f, 2)
	p.mu.Lock()
	text, err := p.doc.Text("content")
	p.mu.Unlock()
	require.NoError(t, err)
	require.Empty(t, text)
	opened, sent, _ := f.daemon.Recorded()
	require.Len(t, opened, 1)
	require.Equal(t, docActor, opened[0].Actor)
	require.Len(t, sent, 2)
	for i, update := range [][]byte{insert, deletion} {
		msg, e := wire.DecodeDocumentV2(sent[i])
		require.NoError(t, e)
		require.Equal(t, wire.DocumentInput, msg.Msg)
		require.Equal(t, docActor, msg.Actor)
		require.Equal(t, uint64(i+1), msg.Seq)
		require.Equal(t, codeSync(2, update), msg.Data, "document bytes pass through unparsed")
	}
}

// The host authenticates and stamps; the daemon refuses a forged client id
// (ADR 0003) and that refusal ends only this subscription.
func TestDocRelayAuthorization(t *testing.T) {
	f := newDocFixture(t)
	for _, topic := range []string{"doc:code:branch-b:retry.ts", "doc:code:branch-a:secret"} {
		f.sub(t, topic)
		f.text(t, `{"t":"err","id":7,"code":"forbidden"}`)
	}
	opened, _, _ := f.daemon.Recorded()
	require.Empty(t, opened, "a refused subscription opens no daemon stream")
	f.daemon.Reply = func([]byte) [][]byte { return [][]byte{docGolden(t, "spoof")} }
	f.sub(t, "doc:code:branch-a:retry.ts")
	client := f.assigned(t)
	forged := codeInsert(client^1, "forged")
	f.update(t, forged)
	f.text(t, `{"t":"err","id":7,"code":"forbidden"}`)
	_, sent, _ := f.daemon.Recorded()
	require.Len(t, sent, 1)
	msg, err := wire.DecodeDocumentV2(sent[0])
	require.NoError(t, err)
	require.Equal(t, docActor, msg.Actor, "the browser cannot choose the actor the daemon checks")
	require.Equal(t, codeSync(2, forged), msg.Data)
}

func TestDocRelayDarkLanding(t *testing.T) {
	for _, missing := range []string{"authorizer", "connection", "daemon", "wiki"} {
		t.Run(missing, func(t *testing.T) {
			f := newDocFixture(t)
			topic := "doc:code:branch-a:retry.ts"
			switch missing {
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
			f := newDocFixture(t)
			bus := f.bus
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
			if when == "startup" {
				opened, _, _ := f.daemon.Recorded()
				require.Empty(t, opened)
			} else {
				require.Eventually(t, func() bool { _, _, n := f.daemon.Recorded(); return n == 1 }, time.Second, time.Millisecond)
			}
		})
	}
}

// Spec §7.1.1: over the 2 MiB budget, in either direction, only this
// subscription gets gap; resubscribing opens a fresh daemon stream.
func TestDocRelayBackpressure(t *testing.T) {
	for _, direction := range []string{"browser", "daemon"} {
		t.Run(direction, func(t *testing.T) {
			var f *docFixture
			if direction == "daemon" {
				f = newDocFixture(t, docGolden(t, "epoch"), append([]byte{3}, make([]byte, 2<<20)...))
				f.sub(t, "doc:code:branch-a:retry.ts")
				for {
					kind, b := f.read(t)
					require.Equal(t, websocket.MessageText, kind, "an oversized document frame never reaches the browser")
					if string(b) == `{"t":"gap","id":7}` {
						break
					}
					require.Contains(t, string(b), `"t":"snap"`)
				}
			} else {
				f = newDocFixture(t)
				f.sub(t, "doc:code:branch-a:retry.ts")
				f.assigned(t)
				raw := make([]byte, (2<<20)+1)
				copy(raw, []byte{1, 0, 0, 0, 7})
				require.NoError(t, f.conn.Write(t.Context(), websocket.MessageBinary, raw))
				f.text(t, `{"t":"gap","id":7}`)
			}
			require.Eventually(t, func() bool { _, _, closed := f.daemon.Recorded(); return closed == 1 }, time.Second, time.Millisecond)
			f.daemon.Script = [][]byte{docGolden(t, "epoch"), {3, 1, 2, 0, 0}}
			f.sub(t, "doc:code:branch-a:retry.ts")
			f.assigned(t)
			opened, _, _ := f.daemon.Recorded()
			require.Len(t, opened, 2)
		})
	}
}

// Every subscription is its own daemon stream; the daemon fans out. Frames
// from one subscription never reach another's stream.
func TestDocRelayStreamPerSubscription(t *testing.T) {
	f := newDocFixture(t)
	f.sub(t, "doc:code:branch-a:retry.ts")
	a := f.assigned(t)
	origin := f.server.URL
	second, _, err := websocket.Dial(t.Context(), "ws"+strings.TrimPrefix(origin, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{live.Protocol}, HTTPHeader: http.Header{"Origin": {origin}, "Cookie": {"session=doc-cookie"}}})
	require.NoError(t, err)
	t.Cleanup(func() { second.CloseNow() })
	other := &docFixture{conn: second}
	other.sub(t, "doc:code:branch-a:retry.ts")
	b := other.assigned(t)
	f.update(t, codeInsert(a, "A"))
	other.update(t, codeInsert(b, "B"))
	require.Eventually(t, func() bool { _, sent, _ := f.daemon.Recorded(); return len(sent) == 2 }, time.Second, time.Millisecond)
	opened, _, _ := f.daemon.Recorded()
	require.Len(t, opened, 2)
	require.NotEqual(t, opened[0].Stream, opened[1].Stream)
	frames, _ := f.daemon.RecordedWire()
	streams := map[string]uint32{}
	for _, raw := range frames {
		frame, err := wire.Decode(raw)
		require.NoError(t, err)
		msg, err := wire.DecodeDocumentV2(frame.Payload)
		require.NoError(t, err)
		_, update := codeDecode(t, msg.Data)
		streams[string(update[len(update)-2:len(update)-1])] = frame.Stream
	}
	require.NotEqual(t, streams["A"], streams["B"])
}

// A daemon epoch change reaches the browser as a fresh assignment.
func TestDocRelayEpochChange(t *testing.T) {
	f := newDocFixture(t)
	epoch := docGolden(t, "epoch")
	epoch[1] = 0xff
	f.daemon.Reply = func([]byte) [][]byte { return [][]byte{epoch} }
	f.sub(t, "doc:code:branch-a:retry.ts")
	client := f.assigned(t)
	f.update(t, codeInsert(client, "x"))
	kind, raw := f.read(t)
	require.Equal(t, websocket.MessageText, kind)
	require.Contains(t, string(raw), `"epoch":"ff112233445566778899aabbccddeeff"`)
}

// A subscription admitted on one machine connection never opens a stream on
// its replacement; the browser resubscribes and is admitted again.
func TestDocRelayReplacementConnection(t *testing.T) {
	f := newDocFixture(t)
	f.relay.Authorize = func(context.Context, live.DocumentTopic, int64, int64) ([]byte, string) { return docActor, "" }
	source, code := f.relay.Resolve(t.Context(), "doc:code:branch-a:retry.ts", 1, 1)
	require.Empty(t, code)
	registry := new(machined.Registry)
	var boot [16]byte
	boot[0] = 2
	require.NoError(t, registry.BindBoot("branch-a", "replacement-machine", boot, []byte("replacement")))
	binding, err := registry.Admit(boot, []byte("replacement"), io.NopCloser(strings.NewReader("")))
	require.NoError(t, err)
	defer binding.Close()
	require.NoError(t, binding.Reconciled())
	f.relay.Connection = func(context.Context, string) (*machined.Connection, live.DocumentRPC) {
		return binding, f.daemon
	}
	_, err = source.Document.Open(t.Context())
	require.ErrorIs(t, err, machined.ErrNotReady)
	opened, _, _ := f.daemon.Recorded()
	require.Empty(t, opened)
}
