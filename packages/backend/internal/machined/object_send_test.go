package machined

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

func bindFixtureExporter(r *Registry) {
	r.BindObjectExporter(func(context.Context, string, string, uint32) (io.ReadCloser, error) {
		return io.NopCloser(strings.NewReader("fixture bundle")), nil
	})
}
func acceptFixtureBundle(t *testing.T, peer net.Conn) uint32 {
	t.Helper()
	var stream uint32
	var received int
	for {
		f, err := wire.Read(peer)
		require.NoError(t, err)
		require.Equal(t, wire.Objects, f.Kind)
		require.GreaterOrEqual(t, f.Stream, uint32(0x80000000))
		if stream == 0 {
			stream = f.Stream
		}
		require.Equal(t, stream, f.Stream)
		if f.Payload[0] == 2 {
			require.Positive(t, received)
			require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Objects, Stream: stream, Payload: []byte{7}}))
			return stream
		}
		require.Equal(t, byte(1), f.Payload[0])
		received += len(f.Payload) - 2
		require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Objects, Stream: stream, Payload: append([]byte{6}, wire.U32(uint32(len(f.Payload)-2))...)}))
	}
}
func answerWake(t *testing.T, peer net.Conn) {
	t.Helper()
	f, err := wire.Read(peer)
	require.NoError(t, err)
	id, method, _, err := f.Request()
	require.NoError(t, err)
	require.Equal(t, byte(wire.WakeReconcile), method)
	require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(5, wire.Field(1, wire.Union(1)))))}))
}
func startWake(t *testing.T, r *Registry, ctx context.Context) <-chan error {
	t.Helper()
	done := make(chan error, 1)
	go func() { _, err := r.WakeReconcile(ctx, "a", strings.Repeat("a", 40)); done <- err }()
	return done
}
func wakeResult(t *testing.T, done <-chan error) error {
	t.Helper()
	select {
	case err := <-done:
		return err
	case <-time.After(3 * time.Second):
		t.Fatal("wake stalled")
		return nil
	}
}

func TestWakeBundleWaitsForImportAndKeepsBothDirectionsLive(t *testing.T) {
	r := new(Registry)
	data := bytes.Repeat([]byte{73}, wire.InitialCredit+123)
	r.BindObjectExporter(func(context.Context, string, string, uint32) (io.ReadCloser, error) {
		return io.NopCloser(bytes.NewReader(data)), nil
	})
	reverse := make(chan []byte, 1)
	r.BindObjectImporter(func(_ context.Context, _ string, file *os.File) error {
		b, err := io.ReadAll(file)
		reverse <- b
		return err
	})
	authority, err := r.MintBoot("a", "vm")
	require.NoError(t, err)
	link, peer := connectTest(t, r, "a", authority)
	require.NoError(t, peer.SetDeadline(time.Now().Add(5*time.Second)))
	done := startWake(t, r, t.Context())
	var stream uint32
	var received []byte
	for len(received) < wire.InitialCredit {
		f, err := wire.Read(peer)
		require.NoError(t, err)
		require.Equal(t, wire.Objects, f.Kind)
		stream = f.Stream
		require.Equal(t, byte(1), f.Payload[0])
		received = append(received, f.Payload[2:]...)
	}
	// No host credit is returned yet. Reverse import still finishes on this link.
	require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Objects, Stream: 9, Payload: []byte{1, 0, 42}}))
	require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Objects, Stream: 9, Payload: []byte{2, 0}}))
	for _, msg := range []byte{6, 7} {
		f, err := wire.Read(peer)
		require.NoError(t, err)
		require.Equal(t, uint32(9), f.Stream)
		require.Equal(t, msg, f.Payload[0])
	}
	require.Equal(t, []byte{42}, <-reverse)
	status := func() {
		reply := make(chan error, 1)
		go func() { _, e := link.Request(t.Context(), "a", wire.Status); reply <- e }()
		answer(t, peer, wire.Status, wire.Field(1, []byte{2}), wire.Field(2, wire.U16(2)), wire.Field(3, wire.String("fixture")), wire.Field(4, wire.U32(0)), wire.Field(6, wire.U16(0)))
		require.NoError(t, wakeResult(t, reply))
	}
	status()
	require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Objects, Stream: stream, Payload: append([]byte{6}, wire.U32(wire.InitialCredit)...)}))
	for {
		f, err := wire.Read(peer)
		require.NoError(t, err)
		require.Equal(t, stream, f.Stream)
		if f.Payload[0] == 2 {
			break
		}
		received = append(received, f.Payload[2:]...)
		require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Objects, Stream: stream, Payload: append([]byte{6}, wire.U32(uint32(len(f.Payload)-2))...)}))
	}
	require.Equal(t, data, received)
	status() // EOF is not successful import, so Wake must not precede this status.
	require.ErrorIs(t, link.RequireReady("a"), ErrNotReady)
	require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Objects, Stream: stream, Payload: []byte{7}}))
	answerWake(t, peer)
	require.NoError(t, wakeResult(t, done))
	require.ErrorIs(t, link.RequireReady("a"), ErrNotReady, "wake alone cannot grant admission")
}

func TestWakeBundleReceiptFailuresCloseOnlyTheirLink(t *testing.T) {
	for _, mode := range []string{"early-close", "over-credit", "wrong-stream", "refused", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			r := new(Registry)
			r.BindObjectExporter(func(context.Context, string, string, uint32) (io.ReadCloser, error) {
				return io.NopCloser(bytes.NewReader(make([]byte, wire.InitialCredit+1))), nil
			})
			a, err := r.MintBoot("a", "vm")
			require.NoError(t, err)
			link, peer := connectTest(t, r, "a", a)
			require.NoError(t, peer.SetDeadline(time.Now().Add(3*time.Second)))
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			done := startWake(t, r, ctx)
			f, err := wire.Read(peer)
			require.NoError(t, err)
			payload := []byte{7}
			stream := f.Stream
			switch mode {
			case "over-credit":
				payload = append([]byte{6}, wire.U32(wire.InitialCredit)...)
			case "wrong-stream":
				stream++
			case "refused":
				payload = wire.Union(255, wire.Field(1, []byte{12}))
			case "cancel":
				cancel()
			}
			if mode != "cancel" {
				require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Objects, Stream: stream, Payload: payload}))
			}
			require.Error(t, wakeResult(t, done))
			select {
			case <-link.done:
			case <-time.After(time.Second):
				t.Fatal("failed transfer retained live link")
			}
		})
	}
}

func TestWakeBundleExporterFailuresNeverIssueWake(t *testing.T) {
	for _, mode := range []string{"missing", "nil", "error", "empty", "read"} {
		t.Run(mode, func(t *testing.T) {
			r := new(Registry)
			if mode != "missing" {
				r.BindObjectExporter(func(context.Context, string, string, uint32) (io.ReadCloser, error) {
					switch mode {
					case "nil":
						return nil, nil
					case "error":
						return nil, errors.New("export failed")
					case "read":
						return badBundleReader{}, nil
					default:
						return io.NopCloser(strings.NewReader("")), nil
					}
				})
			}
			a, err := r.MintBoot("a", "vm")
			require.NoError(t, err)
			_, peer := connectTest(t, r, "a", a)
			require.Error(t, wakeResult(t, startWake(t, r, t.Context())))
			_ = peer.SetReadDeadline(time.Now().Add(20 * time.Millisecond))
			_, err = wire.Read(peer)
			require.Error(t, err, "failed export sent a wake request")
		})
	}
}

type badBundleReader struct{}

func (badBundleReader) Read([]byte) (int, error) { return 0, errors.New("read failed") }
func (badBundleReader) Close() error             { return nil }

func TestWakeBundleCancellationInterruptsSourceRead(t *testing.T) {
	r := new(Registry)
	reader, writer := io.Pipe()
	defer writer.Close()
	entered := make(chan struct{})
	r.BindObjectExporter(func(context.Context, string, string, uint32) (io.ReadCloser, error) {
		close(entered)
		return reader, nil
	})
	a, err := r.MintBoot("a", "vm")
	require.NoError(t, err)
	link, _ := connectTest(t, r, "a", a)
	ctx, cancel := context.WithCancel(t.Context())
	done := startWake(t, r, ctx)
	<-entered
	cancel()
	require.Error(t, wakeResult(t, done))
	select {
	case <-link.done:
	case <-time.After(time.Second):
		t.Fatal("cancelled source retained link")
	}
}

func TestWakeBundleIDsSurviveReconnectAndQueuedCancellation(t *testing.T) {
	r := new(Registry)
	var exports atomic.Int32
	r.BindObjectExporter(func(context.Context, string, string, uint32) (io.ReadCloser, error) {
		exports.Add(1)
		return io.NopCloser(strings.NewReader("bundle")), nil
	})
	a, err := r.MintBoot("a", "vm")
	require.NoError(t, err)
	first, peer := connectTest(t, r, "a", a)
	one := startWake(t, r, t.Context())
	frame, err := wire.Read(peer)
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(t.Context())
	two := startWake(t, r, ctx)
	cancel()
	require.Error(t, wakeResult(t, two))
	require.Equal(t, int32(1), exports.Load())
	require.NoError(t, first.Close())
	require.Error(t, wakeResult(t, one))
	_, next := connectTest(t, r, "a", a)
	three := startWake(t, r, t.Context())
	id := acceptFixtureBundle(t, next)
	require.Greater(t, id, frame.Stream)
	answerWake(t, next)
	require.NoError(t, wakeResult(t, three))
	r.mu.Lock()
	r.branches["a"].nextObject = ^uint32(0)
	r.mu.Unlock()
	require.Error(t, wakeResult(t, startWake(t, r, t.Context())))
	require.Equal(t, int32(2), exports.Load())
}
