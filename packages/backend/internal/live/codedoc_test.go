package live

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

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
	_, err = doc.SetAuthor(42, "616c696365")
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

// receiptPeer acknowledges each input at once into a bounded queue, like the
// machine link's per-stream queue. A queue that stays full means the link
// would close for every document and session on the branch.
type receiptPeer struct{ queue chan []byte }

func (p *receiptPeer) Send(ctx context.Context, raw []byte) error {
	msg, err := wire.DecodeDocumentV2(raw)
	if err != nil {
		return err
	}
	receipt, err := wire.EncodeDocumentV2(wire.Document{Msg: wire.DocumentSaved, AtMS: 1, ThroughSeq: msg.Seq, Data: []byte{0}})
	if err != nil {
		return err
	}
	select {
	case p.queue <- receipt:
		return nil
	case <-time.After(time.Second):
		return errors.New("receipt queue stayed full")
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (p *receiptPeer) Receive(ctx context.Context) ([]byte, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case b := <-p.queue:
		return b, nil
	}
}
func (p *receiptPeer) Close() error { return nil }

func TestCodeDocumentDrainsReceiptsDuringBurst(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	d := &codeDocument{ctx: ctx, cancel: cancel, subscribers: make(map[*codeSubscription]bool), peer: &receiptPeer{queue: make(chan []byte, 8)}, peerCancel: func() {}}
	// Twenty batches flush in one tick, more than the link queues per stream.
	for seq := uint64(1); seq <= 20; seq++ {
		b := &codeBatch{streamSeq: seq, actor: []byte("alice"), update: []byte{0, 0}}
		d.next = seq
		d.pending = append(d.pending, b)
		d.receipts = append(d.receipts, b)
	}
	done := make(chan error, 1)
	go func() { done <- d.pump() }()
	deadline := time.After(5 * time.Second)
	for {
		d.mu.Lock()
		left := len(d.receipts)
		d.mu.Unlock()
		if left == 0 {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("pump stopped with %d unreceipted batches: %v", left, err)
		case <-deadline:
			t.Fatalf("%d batches never receipted", left)
		case <-time.After(5 * time.Millisecond):
		}
	}
	cancel()
	require.ErrorIs(t, <-done, context.Canceled)
	require.Equal(t, uint64(20), d.sent)
}
