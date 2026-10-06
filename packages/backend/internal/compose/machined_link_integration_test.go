package compose

import (
	"context"
	"net"
	"testing"

	"github.com/coder/websocket"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

// The incomplete W1/W2 process composition is represented only by the remote
// scripted peer. Browser HTTP authentication, live route, host handshake,
// registry, control correlation and document transport are production code.
func TestMachinedComposedDocumentBoundary(t *testing.T) {
	f := newDocFixture(t)
	registry := new(machined.Registry)
	authority, err := registry.MintBoot("branch-a", "vm-a")
	require.NoError(t, err)
	host, guest := net.Pipe()
	t.Cleanup(func() { host.Close(); guest.Close() })
	peer := make(chan error, 1)
	go func() {
		nonce := make([]byte, 32)
		nonce[0] = 5
		if err := wire.Write(guest, wire.Frame{Kind: wire.Hello, Payload: wire.Union(1, wire.Field(1, wire.U32(0x534d4d44)), wire.Field(2, wire.U16(1)), wire.Field(3, authority.ID[:]), wire.Field(4, nonce))}); err != nil {
			peer <- err
			return
		}
		proof, err := wire.Read(guest)
		if err != nil {
			peer <- err
			return
		}
		fields, err := wire.Fields("proof", proof.Payload[1:])
		if err != nil {
			peer <- err
			return
		}
		if !wire.VerifyHostMAC(authority.Secret[:], authority.ID[:], nonce, fields[2]) {
			peer <- wire.AuthFailed
			return
		}
		if err := wire.Write(guest, wire.Frame{Kind: wire.Hello, Payload: wire.Union(3, wire.Field(1, wire.Bytes([]byte(authority.Credential))), wire.Field(2, make([]byte, 16)), wire.Field(3, wire.U64(1)), wire.Field(4, wire.U16(0)))}); err != nil {
			peer <- err
			return
		}
		welcome, err := wire.Read(guest)
		if err == nil && (welcome.Kind != wire.Hello || welcome.Payload[0] != 4) {
			err = wire.HandshakeOrder
		}
		peer <- err
	}()
	link, err := registry.Connect(t.Context(), "branch-a", host)
	require.NoError(t, err)
	require.NoError(t, <-peer)
	t.Cleanup(func() { link.Close() })
	// Dependency readiness is separate from the transport. A fresh authenticated
	// link is refused by the public subscription before reconciliation completes.
	f.relay.Connection = func(_ context.Context, branch string) (*machined.Connection, live.DocumentRPC) {
		current, err := registry.Current(branch)
		if err != nil {
			return nil, nil
		}
		return current.Connection, machined.Documents(registry, branch)
	}
	f.sub(t, "doc:code:branch-a:retry.ts")
	kind, body := f.read(t)
	require.Equal(t, websocket.MessageText, kind)
	require.Contains(t, string(body), "unsupported")
	require.NoError(t, link.Reconciled())
	f.sub(t, "doc:code:branch-a:retry.ts")
	request, err := wire.Read(guest)
	require.NoError(t, err)
	id, method, args, err := request.Request()
	require.NoError(t, err)
	require.Equal(t, byte(wire.OpenDoc), method)
	fields, err := wire.Fields("args13", args)
	require.NoError(t, err)
	require.Equal(t, wire.String("retry.ts"), fields[1])
	require.Equal(t, wire.Union(1, wire.Field(1, wire.Bytes([]byte("Be")))), fields[2])
	require.NoError(t, wire.Write(guest, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(13, wire.Field(1, wire.U32(5)))))}))
	for _, name := range []string{"epoch", "sync", "saved"} {
		require.NoError(t, wire.Write(guest, wire.Frame{Kind: wire.Documents, Stream: 5, Payload: docGolden(t, name)}))
	}
	f.text(t, `{"t":"snap","id":7,"cursor":0,"data":{"epoch":"00112233445566778899aabbccddeeff","client_id":42}}`)
	kind, body = f.read(t)
	require.Equal(t, websocket.MessageBinary, kind)
	require.Equal(t, []byte{1, 0, 0, 0, 7, 0, 1, 0}, body)
	f.text(t, `{"t":"saved","id":7,"sv":"ASoB","at":"2026-10-03T12:00:00Z"}`)
	require.NoError(t, f.conn.Write(t.Context(), websocket.MessageBinary, []byte{1, 0, 0, 0, 7, 0, 1, 0}))
	input, err := wire.Read(guest)
	require.NoError(t, err)
	require.Equal(t, byte(wire.Documents), input.Kind)
	require.Equal(t, uint32(5), input.Stream)
	require.Equal(t, docGolden(t, "input"), input.Payload)
	require.NoError(t, f.conn.Write(t.Context(), websocket.MessageText, []byte(`{"t":"unsub","id":7}`)))
	closeRequest, err := wire.Read(guest)
	require.NoError(t, err)
	closeID, method, _, err := closeRequest.Request()
	require.NoError(t, err)
	require.Equal(t, byte(wire.CloseDoc), method)
	require.NoError(t, wire.Write(guest, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(closeID)), wire.Field(2, wire.Union(14)))}))
}
