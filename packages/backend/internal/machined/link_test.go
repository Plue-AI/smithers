package machined

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

func daemonHandshake(stream net.Conn, a BootAuthority, credential string) error {
	nonce := make([]byte, 32)
	nonce[0] = 41
	if err := wire.Write(stream, wire.Frame{Kind: wire.Hello, Payload: wire.Union(1,
		wire.Field(1, wire.U32(0x534d4d44)), wire.Field(2, wire.U16(1)), wire.Field(3, a.ID[:]), wire.Field(4, nonce))}); err != nil {
		return err
	}
	proof, err := wire.Read(stream)
	if err != nil {
		return err
	}
	if proof.Kind != wire.Hello || proof.Payload[0] != 2 {
		return wire.HandshakeOrder
	}
	fields, err := wire.Fields("proof", proof.Payload[1:])
	if err != nil {
		return err
	}
	if !wire.VerifyHostMAC(a.Secret[:], a.ID[:], nonce, fields[2]) {
		return wire.AuthFailed
	}
	if err := wire.Write(stream, wire.Frame{Kind: wire.Hello, Payload: wire.Union(3,
		wire.Field(1, wire.Bytes([]byte(credential))), wire.Field(2, make([]byte, 16)), wire.Field(3, wire.U64(1)), wire.Field(4, wire.U16(0)))}); err != nil {
		return err
	}
	welcome, err := wire.Read(stream)
	if err != nil {
		return err
	}
	if welcome.Kind != wire.Hello || welcome.Payload[0] != 4 {
		return wire.HandshakeOrder
	}
	return nil
}
func connectTest(t *testing.T, r *Registry, branch string, a BootAuthority) (*Link, net.Conn) {
	t.Helper()
	host, daemon := net.Pipe()
	t.Cleanup(func() { _ = host.Close(); _ = daemon.Close() })
	done := make(chan error, 1)
	go func() { done <- daemonHandshake(daemon, a, a.Credential) }()
	link, err := r.Connect(t.Context(), branch, host)
	require.NoError(t, err)
	require.NoError(t, <-done)
	t.Cleanup(func() { _ = link.Close() })
	return link, daemon
}
func TestHostLinkBootAuthority(t *testing.T) {
	r := new(Registry)
	a, err := r.MintBoot("a", "vm-a")
	require.NoError(t, err)
	b, err := r.MintBoot("b", "vm-b")
	require.NoError(t, err)
	require.NotEqual(t, a.ID, b.ID)
	require.NotEqual(t, a.Secret, b.Secret)
	require.NotEqual(t, a.Credential, b.Credential)
	link, _ := connectTest(t, r, "a", a)
	require.ErrorIs(t, link.RequireReady("a"), ErrNotReady)
	require.NoError(t, link.Reconciled())
	for _, test := range []struct {
		name, branch, credential string
		authority                BootAuthority
	}{
		{"cross branch", "b", a.Credential, a}, {"foreign credential", "a", b.Credential, a},
	} {
		t.Run(test.name, func(t *testing.T) {
			host, peer := net.Pipe()
			defer peer.Close()
			done := make(chan error, 1)
			go func() { done <- daemonHandshake(peer, test.authority, test.credential) }()
			_, err := r.Connect(t.Context(), test.branch, host)
			require.ErrorIs(t, err, ErrUnauthorized)
			require.Error(t, <-done)
			require.NoError(t, link.RequireReady("a"))
		})
	}
	newer, err := r.MintBoot("a", "vm-a")
	require.NoError(t, err)
	require.ErrorIs(t, link.RequireReady("a"), ErrUnauthorized)
	replacement, _ := connectTest(t, r, "a", newer)
	require.NoError(t, replacement.Reconciled())
	require.NoError(t, link.Close())
	require.NoError(t, replacement.RequireReady("a"))
	require.Contains(t, string(newer.File(9000)), "topology=bridge\nbridge_port=9000\n")
	require.NotContains(t, string(newer.File(0)), "bridge_port")
}
func TestHostLinkDispatchAndEventsDuringCapture(t *testing.T) {
	r := new(Registry)
	a, err := r.MintBoot("a", "vm")
	require.NoError(t, err)
	link, daemon := connectTest(t, r, "a", a)
	_, err = link.Request(t.Context(), "a", wire.Capture)
	require.ErrorIs(t, err, ErrNotReady)
	require.NoError(t, link.Reconciled())
	peer := make(chan error, 1)
	go func() {
		request, err := wire.Read(daemon)
		if err != nil {
			peer <- err
			return
		}
		id, method, _, err := request.Request()
		if err != nil || method != byte(wire.Capture) {
			peer <- wire.BadValue
			return
		}
		event := wire.Frame{Kind: wire.Events, Payload: wire.Union(1, wire.Field(1, wire.U64(7)), wire.Field(2, a.ID[:]), wire.Field(3, wire.Union(2, wire.Field(1, make([]byte, 20)), wire.Field(2, make([]byte, 20)), wire.Field(3, make([]byte, 20)))))}
		if err = wire.Write(daemon, event); err != nil {
			peer <- err
			return
		}
		// Capture does not reply until the host has consumed the queued event.
		ack, err := wire.Read(daemon)
		if err != nil {
			peer <- err
			return
		}
		if ack.Kind != wire.Events || ack.Payload[0] != 3 {
			peer <- wire.BadValue
			return
		}
		peer <- wire.Write(daemon, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(4, wire.Field(1, make([]byte, 20)), wire.Field(2, make([]byte, 20)), wire.Field(3, wire.U16(0)))))})
	}()
	result := make(chan error, 1)
	go func() { _, err := link.Request(t.Context(), "a", wire.Capture); result <- err }()
	event, err := link.Receive(t.Context())
	require.NoError(t, err)
	require.Equal(t, uint64(7), event.Seq)
	require.Equal(t, a.ID, event.EventID)
	require.NoError(t, link.send(wire.Frame{Kind: wire.Events, Payload: wire.Union(3, wire.Field(1, wire.U64(7)), wire.Field(2, []byte{1}))}))
	require.NoError(t, <-result)
	require.NoError(t, <-peer)
}
func TestHostLinkCancellationAndReplacement(t *testing.T) {
	r := new(Registry)
	a, err := r.MintBoot("a", "vm")
	require.NoError(t, err)
	old, daemon := connectTest(t, r, "a", a)
	require.NoError(t, old.Reconciled())
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { _, err := old.Request(ctx, "a", wire.Capture); done <- err }()
	frame, err := wire.Read(daemon)
	require.NoError(t, err)
	fields, err := wire.Fields("request", frame.Payload[1:])
	require.NoError(t, err)
	require.Equal(t, uint32(1), binary.BigEndian.Uint32(fields[1]))
	cancel()
	require.ErrorIs(t, <-done, context.Canceled)
	fresh, _ := connectTest(t, r, "a", a)
	require.NoError(t, fresh.Reconciled())
	select {
	case <-old.done:
	case <-time.After(time.Second):
		t.Fatal("superseded reader remained alive")
	}
	_, err = old.Receive(t.Context())
	require.ErrorIs(t, err, io.ErrClosedPipe)
	require.NoError(t, fresh.RequireReady("a"))
}
func TestHostLinkHandshakeCancellation(t *testing.T) {
	host, peer := net.Pipe()
	defer peer.Close()
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	_, err := new(Registry).Connect(ctx, "a", host)
	require.Error(t, err)
}
