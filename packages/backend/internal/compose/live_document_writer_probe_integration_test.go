package compose

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/livedocument"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

// A reader replica, never a host document authority. Every byte applied here
// comes from the production daemon stream; it invents no save receipt.
type liveWriterProbe struct {
	stream  machined.DocumentStream
	replica *livedocument.Document
	actor   []byte
	epoch   [16]byte
	client  uint32
	seq     uint64
}

func openLiveWriterProbe(t *testing.T, registry *machined.Registry, branch, path string, actor []byte) *liveWriterProbe {
	t.Helper()
	stream, err := registry.OpenDocument(t.Context(), branch, path, actor)
	require.NoError(t, err)
	t.Cleanup(func() { _ = stream.Close() })
	library, err := livedocument.Load(os.Getenv("SMITHERS_FFI_LIBRARY_PATH"))
	require.NoError(t, err)
	replica, err := library.Open(livedocument.Code, nil)
	require.NoError(t, err)
	t.Cleanup(func() { _ = replica.Close(); _ = library.Close() })
	p := &liveWriterProbe{stream: stream, replica: replica, actor: actor}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	for {
		frame := p.receive(t, ctx)
		if frame.Msg == wire.DocumentEpoch {
			p.epoch, p.client = frame.Epoch, frame.ClientID
			require.NotZero(t, p.client)
			break
		}
	}
	p.send(t, codeSync(0, []byte{0}))
	for {
		frame := p.receive(t, ctx)
		if frame.Msg == wire.DocumentSync {
			kind, _ := codeDecode(t, frame.Data)
			if kind == 1 {
				break
			}
		}
	}
	return p
}

func (p *liveWriterProbe) send(t *testing.T, data []byte) {
	t.Helper()
	p.seq++
	raw, err := wire.EncodeDocumentV2(wire.Document{Msg: wire.DocumentInput, Actor: p.actor, Seq: p.seq, Data: data})
	require.NoError(t, err)
	require.NoError(t, p.stream.Send(t.Context(), raw))
}

func (p *liveWriterProbe) receive(t *testing.T, ctx context.Context) wire.Document {
	t.Helper()
	raw, err := p.stream.Receive(ctx)
	require.NoError(t, err)
	frame, err := wire.DecodeDocumentV2(raw)
	require.NoError(t, err)
	require.NotEqual(t, byte(255), frame.Msg, "daemon refused document frame: %x", raw)
	if frame.Msg == wire.DocumentSync {
		_, update := codeDecode(t, frame.Data)
		_, err = p.replica.Peer(update)
		require.NoError(t, err)
	}
	return frame
}

func (p *liveWriterProbe) converge(t *testing.T, want string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	for {
		text, err := p.replica.Text("content")
		require.NoError(t, err)
		if text == want {
			return
		}
		p.receive(t, ctx)
	}
}

// Exercise the reference campaign's independent reader against actual browser
// input, route admission, durable daemon frames and disk on Linux. The absent
// member broker still excludes W2-W4 and installed-machine acceptance.
func TestLiveDocumentWriterProbeRealRoute(t *testing.T) {
	f := startRealDocumentInstall(t, "")
	tx, err := f.pool.Begin(t.Context())
	require.NoError(t, err)
	actor, err := machined.RecordActorInTx(t.Context(), tx, f.branch, f.branch, machined.ActorIdentity{Kind: "person", MemberID: f.ben, Via: "web"})
	require.NoError(t, err)
	require.NoError(t, tx.Commit(t.Context()))
	probe := openLiveWriterProbe(t, f.registry, f.branch, "retry.ts", actor)
	ben, alice := f.browser(t, "ben-cookie"), f.browser(t, "alice-cookie")
	ben.sub(t, f.topic)
	bc := ben.assigned(t)
	alice.sub(t, f.topic)
	ac := alice.assigned(t)
	ben.edit(t, codeInsert(bc, "BEN 🧑🏽‍💻 "))
	alice.edit(t, codeInsert(ac, "ALICE e\u0301 漢字"))
	ben.saved(t, 1)
	alice.saved(t, 1)
	want := f.disk(t)
	probe.converge(t, want)
	ben.converge(t, want)
	alice.converge(t, want)
	require.Contains(t, want, "BEN 🧑🏽‍💻 ")
	require.Contains(t, want, "ALICE e\u0301 漢字")
	require.NoError(t, probe.stream.Close())
	reopened := openLiveWriterProbe(t, f.registry, f.branch, "retry.ts", actor)
	require.Equal(t, probe.epoch, reopened.epoch)
	reopened.converge(t, want)
	f.documentEvidence(t, "writer-probe")
}
