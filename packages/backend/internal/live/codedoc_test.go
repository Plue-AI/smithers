package live

import (
	"context"
	"os"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/livedocument"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

func TestCodeDocumentCoalescedDeletionReceipt(t *testing.T) {
	path := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	if path == "" {
		if os.Getenv("SMITHERS_REQUIRE_FFI_TESTS") == "1" {
			t.Fatal("native library required")
		}
		t.Skip("native library required")
	}
	library, err := livedocument.Load(path)
	require.NoError(t, err)
	defer library.Close()
	doc, err := library.Open(livedocument.Code, nil)
	require.NoError(t, err)
	defer doc.Close()
	_, err = doc.SetAuthor(42, "alice")
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	d := &codeDocument{doc: doc, ctx: ctx, cancel: cancel, subscribers: make(map[*codeSubscription]bool)}
	s := &codeSubscription{owner: d, actor: []byte("alice"), client: 42, frames: make(chan []byte, 10), done: make(chan struct{})}
	d.subscribers[s] = true
	// A handshake must not advance the browser's edit receipt counter.
	handshake, err := documentInput(1, s.actor, syncPayload(1, []byte{0, 0}))
	require.NoError(t, err)
	require.NoError(t, s.Send(ctx, handshake))
	require.Zero(t, s.seq)
	d.pending = nil
	d.receipts = nil
	d.next = 0
	// Yjs v1: client 42 inserts x, then deletes it without advancing its vector.
	insertion := []byte{1, 1, 42, 0, 4, 1, 7, 'c', 'o', 'n', 't', 'e', 'n', 't', 1, 'x', 0}
	deletion := []byte{0, 1, 42, 1, 0, 1}
	send := func(update []byte) {
		raw, e := documentInput(1, s.actor, syncPayload(2, update))
		require.NoError(t, e)
		require.NoError(t, s.Send(ctx, raw))
	}
	send(insertion)
	before, err := doc.Sync1()
	require.NoError(t, err)
	send(deletion)
	after, err := doc.Sync1()
	require.NoError(t, err)
	require.Equal(t, before, after)
	require.Len(t, d.pending, 1)
	require.Equal(t, uint64(2), d.pending[0].seq)
	restored, err := library.Open(livedocument.Code, d.pending[0].update)
	require.NoError(t, err)
	defer restored.Close()
	text, err := restored.Text("content")
	require.NoError(t, err)
	require.Empty(t, text)
	receipt, err := wire.EncodeDocumentV2(wire.Document{Msg: wire.DocumentSaved, ThroughSeq: 1, Data: after})
	require.NoError(t, err)
	require.Error(t, d.receive(receipt), "cannot acknowledge an unsent batch")
	d.sent = 1
	require.NoError(t, d.receive(receipt))
	require.Empty(t, d.receipts)
	raw, err := s.Receive(ctx)
	require.NoError(t, err)
	saved, err := wire.DecodeDocumentV2(raw)
	require.NoError(t, err)
	require.Equal(t, uint64(2), saved.ThroughSeq)
	// Once sent, a new deletion must get its own receipt boundary.
	d.pending = nil
	send(deletion)
	require.Equal(t, uint64(2), d.pending[0].streamSeq)
}
