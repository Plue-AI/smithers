package machined

import (
	"context"
	"encoding/hex"
	"net"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined/testfake"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
)

// This is a component contract test against the landed T-COL-03f provider.
// It deliberately makes no VM, capture durability or install acceptance claim.
func TestClientScriptedProviderContract(t *testing.T) {
	var registry Registry
	goldenBoot(t, &registry)
	frame := func(name string) wire.Frame {
		t.Helper()
		bytes := fixture(t, name)
		if name == "req_capture" || name == "res_capture" {
			copy(bytes[15:19], []byte{0, 0, 0, 43})
		}
		if name == "hello_host_proof" {
			// Independently computed Python hmac/hashlib vector, not HostMAC.
			proof, _ := hex.DecodeString("afc31776479902afdc175c2143675a2c9b0addbb9aab1d6f6170a35fedea6aa1")
			copy(bytes[len(bytes)-32:], proof)
		}
		f, err := wire.Decode(bytes)
		if err != nil {
			t.Fatal(err)
		}
		return f
	}
	script := []testfake.Step{
		{Frame: frame("hello_challenge")},
		{Receive: true, Frame: frame("hello_host_proof")},
		{Frame: frame("hello_machine")},
		{Receive: true, Frame: frame("hello_welcome")},
		{Receive: true, Frame: frame("req_status")},
		{Frame: frame("res_status")},
		{Receive: true, Frame: frame("req_capture")},
		{Frame: frame("ev_captured")},
		{Frame: frame("res_capture")},
	}
	host, peer := net.Pipe()
	defer peer.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := peer.SetDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() { finished <- testfake.Serve(peer, script) }()
	events := make(chan wire.Frame, 1)
	client, err := registry.Accept(ctx, "A", host, func(_ context.Context, _ *Client, f wire.Frame) error {
		events <- f
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	// The independent corpus starts at request id 42; capture follows at 43.
	client.next = 41
	status, err := client.Call(ctx, wire.Status)
	if err != nil || status.Fields[1].Number != 3 {
		t.Fatalf("status: %+v, %v", status, err)
	}
	if _, err := client.Capture(ctx); err != ErrNotReady {
		t.Fatalf("status must not bypass reconciliation: %v", err)
	}
	if err := client.lease.Reconciled(); err != nil {
		t.Fatal(err)
	}
	snapshot, err := client.Capture(ctx)
	if err != nil || hex.EncodeToString(snapshot.Head[:]) != "1111111111111111111111111111111111111111" || hex.EncodeToString(snapshot.Tree[:]) != "2222222222222222222222222222222222222222" {
		t.Fatalf("capture: %+v, %v", snapshot, err)
	}
	select {
	case event := <-events:
		message, err := event.Message()
		if err != nil || event.Kind != wire.Events || message.Variant != 1 {
			t.Fatalf("captured event: %+v, %v", event, err)
		}
	case <-ctx.Done():
		t.Fatal("capture reply lost its preceding event")
	}
	// Serve refuses any unrequested extra frame: in particular the client
	// must not manufacture a durable-event acknowledgement.
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
}
