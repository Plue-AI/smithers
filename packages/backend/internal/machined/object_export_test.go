package machined

import (
	"bytes"
	"context"
	"io"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

func testExporter(t *testing.T, r *Registry, body []byte) {
	t.Helper()
	r.BindObjectExporter(func(context.Context, string, string, uint32) (*os.File, error) {
		f, err := os.CreateTemp(t.TempDir(), "wake-")
		if err != nil {
			return nil, err
		}
		if _, err = f.Write(body); err != nil {
			f.Close()
			return nil, err
		}
		return f, nil
	})
}
func receiveTestBundle(t *testing.T, peer net.Conn) (uint32, []byte) {
	t.Helper()
	var id uint32
	var data []byte
	for {
		f, err := wire.Read(peer)
		require.NoError(t, err)
		require.Equal(t, byte(wire.Objects), f.Kind)
		require.GreaterOrEqual(t, f.Stream, uint32(0x80000000))
		if id == 0 {
			id = f.Stream
		}
		require.Equal(t, id, f.Stream)
		if f.Payload[0] == 2 {
			return id, data
		}
		require.Equal(t, []byte{1, 0}, f.Payload[:2])
		data = append(data, f.Payload[2:]...)
		require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Objects, Stream: id, Payload: append([]byte{6}, wire.U32(uint32(len(f.Payload)-2))...)}))
	}
}
func acknowledgeTestBundle(t *testing.T, peer net.Conn) uint32 {
	t.Helper()
	id, body := receiveTestBundle(t, peer)
	require.NotEmpty(t, body)
	require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Objects, Stream: id, Payload: []byte{7}}))
	return id
}
func TestWakeRequiresObjectReceipt(t *testing.T) {
	r := new(Registry)
	a, err := r.MintBoot("a", "vm")
	require.NoError(t, err)
	link, peer := connectTest(t, r, "a", a)
	_, err = r.WakeReconcile(t.Context(), "a", strings.Repeat("a", 40))
	require.ErrorIs(t, err, ErrNotReady)
	body := bytes.Repeat([]byte("fixed snapshot\n"), 40000)
	testExporter(t, r, body)
	done := make(chan error, 1)
	go func() { _, err := r.WakeReconcile(t.Context(), "a", strings.Repeat("a", 40)); done <- err }()
	id, got := receiveTestBundle(t, peer)
	require.Equal(t, body, got)
	require.NoError(t, peer.SetReadDeadline(time.Now().Add(30*time.Millisecond)))
	_, err = wire.Read(peer)
	require.Error(t, err, "no wake before object receipt")
	require.NoError(t, peer.SetReadDeadline(time.Time{}))
	require.ErrorIs(t, link.RequireReady("a"), ErrNotReady)
	require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Objects, Stream: id, Payload: []byte{7}}))
	answer(t, peer, wire.WakeReconcile, wire.Field(1, wire.Union(1)))
	require.NoError(t, <-done)
	// A reconnect to the same daemon lifetime never reuses its stream id.
	next, other := connectTest(t, r, "a", a)
	go func() { done <- next.transferHead(t.Context(), "a", strings.Repeat("a", 40)) }()
	nextID := acknowledgeTestBundle(t, other)
	require.Greater(t, nextID, id)
	require.NoError(t, <-done)
}
func TestHostBundleCancellationAndPrematureClose(t *testing.T) {
	for _, cancelled := range []bool{false, true} {
		t.Run(map[bool]string{false: "premature close", true: "cancelled"}[cancelled], func(t *testing.T) {
			r, link, peer := rpcFixture(t)
			testExporter(t, r, bytes.Repeat([]byte{1}, wire.InitialCredit+1))
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			done := make(chan error, 1)
			go func() { done <- link.transferHead(ctx, "a", strings.Repeat("a", 40)) }()
			var stream uint32
			for range 4 {
				f, err := wire.Read(peer)
				require.NoError(t, err)
				require.Equal(t, wire.Objects, f.Kind)
				stream = f.Stream
			}
			// All initial credit is consumed. No more data is read from the source.
			if cancelled {
				cancel()
			} else {
				require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Objects, Stream: stream, Payload: []byte{7}}))
			}
			select {
			case err := <-done:
				require.Error(t, err)
			case <-time.After(time.Second):
				t.Fatal("transfer did not stop")
			}
			require.ErrorIs(t, link.RequireReady("a"), ErrUnauthorized)
		})
	}
}
func TestGitBundleExporter(t *testing.T) {
	repo, _, base, _ := bundleFixture(t)
	export := GitBundleExporter(func(context.Context, string) (string, error) { return repo, nil })
	file, err := export(t.Context(), "11111111-1111-4111-8111-111111111111", base, 0x80000000)
	require.NoError(t, err)
	defer file.Close()
	defer os.Remove(file.Name())
	body, err := io.ReadAll(file)
	require.NoError(t, err)
	require.Contains(t, string(body), base+" refs/smithers/xfer/")
	_, err = export(t.Context(), "foreign", base, 0x80000000)
	require.ErrorIs(t, err, ErrUnauthorized)
	_, err = export(t.Context(), "11111111-1111-4111-8111-111111111111", "--all", 0x80000000)
	require.ErrorIs(t, err, wire.BadValue)
}

func TestHostBundleSpoolLimit(t *testing.T) {
	var body bytes.Buffer
	writer := bundleWriter{Writer: &body, remaining: 3}
	n, err := writer.Write([]byte("abc"))
	require.NoError(t, err)
	require.Equal(t, 3, n)
	n, err = writer.Write([]byte("d"))
	require.Error(t, err)
	require.Zero(t, n)
	require.Equal(t, "abc", body.String())
}

func TestDisconnectCancelsHostBundleProducer(t *testing.T) {
	r, link, peer := rpcFixture(t)
	started := make(chan struct{})
	r.BindObjectExporter(func(ctx context.Context, _ string, _ string, _ uint32) (*os.File, error) {
		close(started)
		<-ctx.Done()
		return nil, ctx.Err()
	})
	done := make(chan error, 1)
	go func() { done <- link.transferHead(t.Context(), "a", strings.Repeat("a", 40)) }()
	<-started
	require.NoError(t, peer.Close())
	select {
	case err := <-done:
		require.ErrorIs(t, err, context.Canceled)
	case <-time.After(time.Second):
		t.Fatal("producer outlived disconnected link")
	}
}
