package machined

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile("../compose/testdata/cocontracts/" + name + ".bin")
	if err != nil {
		t.Fatal(err)
	}
	return b
}
func goldenBoot(t *testing.T, r *Registry) {
	t.Helper()
	var id [16]byte
	var secret [32]byte
	for i := range id {
		id[i] = 0x44
	}
	for i := range secret {
		secret[i] = 0x22
	}
	if err := r.bindBoot("A", "M", id, []byte("boot-token"), secret); err != nil {
		t.Fatal(err)
	}
}
func handshakePeer(t *testing.T, peer net.Conn) error {
	t.Helper()
	if _, err := peer.Write(fixture(t, "hello_challenge")); err != nil {
		return err
	}
	want := fixture(t, "hello_host_proof")
	// The corpus proof is a layout placeholder. Python hmac/hashlib independently
	// computes this proof for secret 0x22, boot 0x44 and nonce 0x33.
	mac, _ := hex.DecodeString("afc31776479902afdc175c2143675a2c9b0addbb9aab1d6f6170a35fedea6aa1")
	copy(want[len(want)-32:], mac)
	got := make([]byte, len(want))
	// Read exactly the independent golden proof; a relay-secret bearer would fail.
	if _, err := io.ReadFull(peer, got); err != nil {
		return err
	}
	if !bytes.Equal(got, want) {
		return errors.New("nonce proof differs from golden frame")
	}
	if _, err := peer.Write(fixture(t, "hello_machine")); err != nil {
		return err
	}
	want = fixture(t, "hello_welcome")
	got = make([]byte, len(want))
	if _, err := io.ReadFull(peer, got); err != nil {
		return err
	}
	if !bytes.Equal(got, want) {
		return errors.New("welcome differs from golden frame")
	}
	return nil
}

func testClient(t *testing.T, handler FrameHandler) (*Client, net.Conn) {
	t.Helper()
	var r Registry
	goldenBoot(t, &r)
	host, peer := net.Pipe()
	t.Cleanup(func() { _ = peer.Close() })
	peer.SetDeadline(time.Now().Add(3 * time.Second))
	finished := make(chan error, 1)
	go func() { finished <- handshakePeer(t, peer) }()
	c, err := r.Accept(context.Background(), "A", host, handler)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
	return c, peer
}
func TestClientGoldenHandshakeAndReadyFence(t *testing.T) {
	c, peer := testClient(t, nil)
	if _, err := c.Capture(context.Background()); err != ErrNotReady {
		t.Fatal(err)
	}
	if err := c.lease.RequireReady("B"); err != ErrUnauthorized {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() {
		f, err := wire.Read(peer)
		if err != nil {
			finished <- err
			return
		}
		id, method, _, err := f.Request()
		if err != nil || method != 1 {
			finished <- errors.New("expected status")
			return
		}
		// Literal result with a response id supplied by this request.
		response := fixture(t, "res_status")
		copy(response[15:19], wire.U32(id))
		_, err = peer.Write(response)
		finished <- err
	}()
	v, err := c.Call(context.Background(), wire.Status)
	if err != nil || v.Fields[1].Number != 3 || string(v.Fields[3].Data) != "0.1.0" {
		t.Fatalf("%+v %v", v, err)
	}
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
	// A status ready response does not itself authorize awake operation.
	if _, err := c.Capture(context.Background()); err != ErrNotReady {
		t.Fatal(err)
	}
}
func TestClientReadsEventsBeforeCaptureResponse(t *testing.T) {
	seen := make(chan wire.Frame, 1)
	c, peer := testClient(t, func(_ context.Context, _ *Client, f wire.Frame) error { seen <- f; return nil })
	if err := c.lease.Reconciled(); err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() {
		f, err := wire.Read(peer)
		if err != nil {
			finished <- err
			return
		}
		id, method, _, err := f.Request()
		if err != nil || method != 4 {
			finished <- errors.New("expected capture")
			return
		}
		if _, err = peer.Write(fixture(t, "ev_captured")); err != nil {
			finished <- err
			return
		}
		<-seen
		response := fixture(t, "res_capture")
		copy(response[15:19], wire.U32(id))
		_, err = peer.Write(response)
		finished <- err
	}()
	s, err := c.Capture(context.Background())
	if err != nil || s.Head != [20]byte{0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11} {
		t.Fatalf("%+v %v", s, err)
	}
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
}
func TestClientConcurrentCallsReverseResponses(t *testing.T) {
	c, peer := testClient(t, nil)
	var wg sync.WaitGroup
	finished := make(chan error, 1)
	go func() {
		ids := make([]uint32, 2)
		for i := range ids {
			f, err := wire.Read(peer)
			if err != nil {
				finished <- err
				return
			}
			ids[i], _, _, _ = f.Request()
		}
		if ids[0] == ids[1] {
			finished <- errors.New("reused id")
			return
		}
		for i := 1; i >= 0; i-- {
			b := fixture(t, "res_status")
			copy(b[15:19], wire.U32(ids[i]))
			if _, err := peer.Write(b); err != nil {
				finished <- err
				return
			}
		}
		finished <- nil
	}()
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			v, err := c.Call(context.Background(), wire.Status)
			if err != nil || v.Fields[1].Number != 3 {
				t.Errorf("%v %v", v, err)
			}
		}()
	}
	wg.Wait()
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
}
func TestClientBadCredentialPreservesLiveLease(t *testing.T) {
	c, oldPeer := testClient(t, nil)
	r := c.lease.registry
	host, peer := net.Pipe()
	defer peer.Close()
	peer.SetDeadline(time.Now().Add(3 * time.Second))
	finished := make(chan error, 1)
	go func() {
		if _, err := peer.Write(fixture(t, "hello_challenge")); err != nil {
			finished <- err
			return
		}
		if _, err := wire.Read(peer); err != nil {
			finished <- err
			return
		}
		bad := fixture(t, "hello_machine")
		bad[19] ^= 1
		_, err := peer.Write(bad)
		finished <- err
	}()
	if _, err := r.Accept(context.Background(), "A", host, nil); err != ErrUnauthorized {
		t.Fatal(err)
	}
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
	if err := c.current(); err != nil {
		t.Fatal("newcomer evicted live lease", err)
	}
	// The old stream is still usable.
	done := make(chan error, 1)
	go func() { done <- c.Send(context.Background(), wire.Frame{Kind: wire.Hello, Payload: wire.Union(4)}) }()
	if _, err := wire.Read(oldPeer); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
func TestClientValidReconnectFencesOldLease(t *testing.T) {
	c, _ := testClient(t, nil)
	host, peer := net.Pipe()
	defer peer.Close()
	peer.SetDeadline(time.Now().Add(3 * time.Second))
	finished := make(chan error, 1)
	go func() { finished <- handshakePeer(t, peer) }()
	next, err := c.lease.registry.Accept(context.Background(), "A", host, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer next.Close()
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
	if err := c.current(); err != ErrUnauthorized {
		t.Fatal(err)
	}
	if err := next.lease.RequireReady("A"); err != ErrNotReady {
		t.Fatal(err)
	}
	select {
	case <-c.done:
	case <-time.After(time.Second):
		t.Fatal("half-open stream not replaced immediately")
	}
}
func TestClientCancellationRetainsCorrelation(t *testing.T) {
	c, peer := testClient(t, nil)
	ctx, cancel := context.WithCancel(context.Background())
	got := make(chan uint32, 1)
	release := make(chan struct{})
	finished := make(chan error, 1)
	go func() {
		f, err := wire.Read(peer)
		if err != nil {
			finished <- err
			return
		}
		id, _, _, _ := f.Request()
		got <- id
		<-release
		b := fixture(t, "res_status")
		copy(b[15:19], wire.U32(id))
		_, err = peer.Write(b)
		if err != nil {
			finished <- err
			return
		}
		f, err = wire.Read(peer)
		if err != nil {
			finished <- err
			return
		}
		next, _, _, _ := f.Request()
		if id == next {
			finished <- errors.New("cancelled id reused")
			return
		}
		b = fixture(t, "res_status")
		copy(b[15:19], wire.U32(next))
		_, err = peer.Write(b)
		finished <- err
	}()
	result := make(chan error, 1)
	go func() { _, err := c.Call(ctx, wire.Status); result <- err }()
	<-got
	// Wait for the completed frame write before cancelling its response wait.
	// Cancellation during a partial write intentionally closes the stream.
	c.writeMu.Lock()
	c.writeMu.Unlock()
	cancel()
	if err := <-result; err != context.Canceled {
		t.Fatal(err)
	}
	close(release)
	if _, err := c.Call(context.Background(), wire.Status); err != nil {
		t.Fatal(err)
	}
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
}

type recordingDialer struct {
	called  bool
	request workspaceapi.PortRequest
}

func (d *recordingDialer) DialWorkspacePort(_ context.Context, _ string, r workspaceapi.PortRequest) (net.Conn, error) {
	d.called = true
	d.request = r
	return nil, ErrNotReady
}
func TestRelayUsesRuntimePort(t *testing.T) {
	d := new(recordingDialer)
	if _, err := (RelayLink{Dialer: d, Workspace: "vm-A"}).Next(context.Background()); err != ErrNotReady || !d.called || d.request.Port != 970 || d.request.Purpose != "machined" {
		t.Fatalf("%+v %v", d, err)
	}
}

func TestClientResponseRefusalsAndDigestIntegrity(t *testing.T) {
	for _, name := range []string{"err_stale", "err_stale_absent", "err_too_large", "err_busy", "res_read_file"} {
		t.Run(name, func(t *testing.T) {
			c, peer := testClient(t, nil)
			if err := c.lease.Reconciled(); err != nil {
				t.Fatal(err)
			}
			finished := make(chan error, 1)
			go func() {
				f, err := wire.Read(peer)
				if err != nil {
					finished <- err
					return
				}
				id, _, _, _ := f.Request()
				b := fixture(t, name)
				copy(b[15:19], wire.U32(id))
				_, err = peer.Write(b)
				finished <- err
			}()
			_, err := c.ReadFile(context.Background(), "README.md", nil)
			if name == "res_read_file" {
				// Corpus digest is a layout placeholder, deliberately unequal to bytes.
				if err != wire.BadValue {
					t.Fatal("unverified file digest", err)
				}
			} else {
				var refusal *RPCError
				if !errors.As(err, &refusal) {
					t.Fatal(err)
				}
				expected := map[string]string{"err_stale": "stale", "err_stale_absent": "stale", "err_too_large": "too_large", "err_busy": "busy"}[name]
				if refusal.Error() != expected {
					t.Fatal(refusal)
				}
				if name == "err_stale" && len(refusal.CurrentDigest) != 32 {
					t.Fatal("missing current digest")
				}
				if name == "err_stale_absent" && len(refusal.CurrentDigest) != 0 {
					t.Fatal("invented absent digest")
				}
				if name == "err_too_large" && refusal.Limit != 1048576 {
					t.Fatal("wrong file limit")
				}
			}
			if err := <-finished; err != nil {
				t.Fatal(err)
			}
		})
	}
}
func TestClientWrongResponseDisconnectsWaiters(t *testing.T) {
	for _, mode := range []string{"wrong_id", "wrong_method", "request_instead_of_response", "disconnect"} {
		t.Run(mode, func(t *testing.T) {
			c, peer := testClient(t, nil)
			finished := make(chan error, 1)
			go func() {
				f, err := wire.Read(peer)
				if err != nil {
					finished <- err
					return
				}
				id, _, _, _ := f.Request()
				if mode == "disconnect" {
					finished <- peer.Close()
					return
				}
				name := "res_status"
				if mode == "wrong_method" {
					name = "res_capture"
				}
				if mode == "request_instead_of_response" {
					name = "req_status"
				}
				if mode == "wrong_id" {
					id++
				}
				b := fixture(t, name)
				copy(b[15:19], wire.U32(id))
				_, err = peer.Write(b)
				finished <- err
			}()
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			_, err := c.Call(ctx, wire.Status)
			if mode == "disconnect" {
				if err != wire.Truncated {
					t.Fatal(err)
				}
			} else if err != wire.BadValue {
				t.Fatal(err)
			}
			if err := <-finished; err != nil {
				t.Fatal(err)
			}
			if _, err := c.Call(context.Background(), wire.Status); err == nil {
				t.Fatal("disconnected client accepted call")
			}
		})
	}
}
func TestClientWrongBranchRefusesBeforeProof(t *testing.T) {
	var r Registry
	goldenBoot(t, &r)
	host, peer := net.Pipe()
	defer peer.Close()
	peer.SetDeadline(time.Now().Add(time.Second))
	finished := make(chan error, 1)
	go func() {
		_, err := peer.Write(fixture(t, "hello_challenge"))
		if err == nil {
			var b [1]byte
			n, e := peer.Read(b[:])
			if n != 0 || e == nil {
				err = errors.New("proof offered to wrong branch")
			}
		}
		finished <- err
	}()
	if _, err := r.Accept(context.Background(), "B", host, nil); err != ErrUnauthorized {
		t.Fatal(err)
	}
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
}
func TestClientHandshakeOrderAndCancellation(t *testing.T) {
	for _, mode := range []string{"control_first", "cancelled"} {
		t.Run(mode, func(t *testing.T) {
			var r Registry
			goldenBoot(t, &r)
			host, peer := net.Pipe()
			defer peer.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if mode == "cancelled" {
				cancel()
			} else {
				go func() { _, _ = peer.Write(fixture(t, "req_status")) }()
			}
			_, err := r.Accept(ctx, "A", host, nil)
			if mode == "control_first" && err != wire.HandshakeOrder {
				t.Fatal(err)
			}
			if mode == "cancelled" && err == nil {
				t.Fatal("cancelled handshake succeeded")
			}
			if r.branches["A"].connection != nil {
				t.Fatal("failed handshake admitted lease")
			}
		})
	}
}
func TestClientReservedDocumentsTypedUnsupported(t *testing.T) {
	_, peer := testClient(t, nil)
	b := fixture(t, "doc_reserved_sync")
	if _, err := peer.Write(b); err != nil {
		t.Fatal(err)
	}
	want := fixture(t, "doc_refused_unsupported")
	got := make([]byte, len(want))
	if _, err := io.ReadFull(peer, got); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("got %x want %x", got, want)
	}
}

func TestClientSessionGoldenRequests(t *testing.T) {
	for _, tc := range []struct {
		name string
		call SessionCall
	}{
		{"tcp_connect", SessionCall{Method: "tcp_connect", Port: 3000}},
		{"close_session", SessionCall{Method: "close_session", Session: 1}},
		{"register_run", SessionCall{Method: "register_run", Run: "run-1", Session: 1}},
		{"attach_session", SessionCall{Method: "attach_session", Session: 1, Received: 65536}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, peer := testClient(t, nil)
			if err := c.lease.Reconciled(); err != nil {
				t.Fatal(err)
			}
			finished := make(chan error, 1)
			go func() {
				frame, err := wire.Read(peer)
				if err != nil {
					finished <- err
					return
				}
				id, _, _, _ := frame.Request()
				got, err := wire.Encode(frame)
				if err != nil {
					finished <- err
					return
				}
				want := fixture(t, "req_"+tc.name)
				copy(want[15:19], wire.U32(id))
				if !bytes.Equal(got, want) {
					finished <- errors.New("request differs from golden frame")
					_ = peer.Close()
					return
				}
				reply := fixture(t, "res_unsupported_"+tc.name)
				copy(reply[15:19], wire.U32(id))
				_, err = peer.Write(reply)
				finished <- err
			}()
			_, err := c.CallSession(context.Background(), tc.call)
			if err == nil || err.Error() != "unsupported" {
				t.Fatal(err)
			}
			if err := <-finished; err != nil {
				t.Fatal(err)
			}
		})
	}
}
func TestClientVerifiedReadAndWrite(t *testing.T) {
	digestBytes, _ := hex.DecodeString("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")
	var digest [32]byte
	copy(digest[:], digestBytes)
	c, peer := testClient(t, nil)
	if err := c.lease.Reconciled(); err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() {
		for _, method := range []wire.Method{wire.ReadFile, wire.WriteFile} {
			frame, err := wire.Read(peer)
			if err != nil {
				finished <- err
				return
			}
			id, m, _, err := frame.Request()
			if err != nil || m != byte(method) {
				finished <- errors.New("wrong file method")
				return
			}
			fields := [][]byte{wire.Field(1, digestBytes)}
			if method == wire.ReadFile {
				fields = [][]byte{wire.Field(1, wire.Bytes([]byte("hello"))), wire.Field(2, digestBytes), wire.Field(3, wire.U32(420))}
			}
			reply := wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(byte(method), fields...)))}
			if err := wire.Write(peer, reply); err != nil {
				finished <- err
				return
			}
		}
		finished <- nil
	}()
	f, err := c.ReadFile(context.Background(), "src/a.ts", nil)
	if err != nil || string(f.Content) != "hello" || f.Digest != digest || f.Mode != 420 {
		t.Fatalf("%+v %v", f, err)
	}
	got, err := c.WriteFile(context.Background(), "src/a.ts", nil, []byte("hello"), []byte("principal"))
	if err != nil || got != digest {
		t.Fatalf("%x %v", got, err)
	}
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
	if _, err := c.WriteFile(context.Background(), "a", nil, nil, nil); err != ErrUnauthorized {
		t.Fatal(err)
	}
}
