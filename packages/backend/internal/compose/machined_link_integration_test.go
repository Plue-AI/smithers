package compose

import (
	"context"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/hostexec"
	"github.com/smithersai/smithers/packages/backend/internal/livedocument"
	"net"
	"os"
	"path/filepath"
	"strings"
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
	root := t.TempDir()
	source, store, bundle := filepath.Join(root, "source"), filepath.Join(root, "store"), filepath.Join(root, "capture.bundle")
	git := func(args ...string) string {
		out, err := hostexec.Git(t.Context(), append([]string{"-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "core.hooksPath=/dev/null"}, args...)...).CombinedOutput()
		require.NoError(t, err, "%s", out)
		return strings.TrimSpace(string(out))
	}
	git("init", "--initial-branch=main", source)
	require.NoError(t, os.WriteFile(filepath.Join(source, "retry.ts"), []byte("base\n"), 0600))
	git("-C", source, "add", ".")
	git("-C", source, "commit", "-m", "base")
	base := git("-C", source, "rev-parse", "HEAD")
	git("clone", "--bare", source, store)
	require.NoError(t, os.WriteFile(filepath.Join(source, "retry.ts"), []byte("captured bytes\n"), 0600))
	git("-C", source, "add", ".")
	git("-C", source, "commit", "-m", "capture")
	head := git("-C", source, "rev-parse", "HEAD")
	git("-C", source, "bundle", "create", bundle, "--all")
	registry.BindObjectImporter(machined.GitBundleImporter(func(_ context.Context, branch string) (string, error) {
		if branch != "11111111-1111-4111-8111-111111111111" {
			return "", machined.ErrUnauthorized
		}
		return store, nil
	}))
	authority, err := registry.MintBoot("11111111-1111-4111-8111-111111111111", "vm-a")
	require.NoError(t, err)
	host, guest := net.Pipe()
	t.Cleanup(func() { host.Close(); guest.Close() })
	peer := make(chan error, 1)
	go func() {
		nonce := make([]byte, 32)
		nonce[0] = 5
		if err := wire.Write(guest, wire.Frame{Kind: wire.Hello, Payload: wire.Union(1, wire.Field(1, wire.U32(0x534d4d44)), wire.Field(2, wire.U16(2)), wire.Field(3, authority.ID[:]), wire.Field(4, nonce))}); err != nil {
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
	link, err := registry.Connect(t.Context(), "11111111-1111-4111-8111-111111111111", host)
	require.NoError(t, err)
	require.NoError(t, <-peer)
	t.Cleanup(func() { link.Close() })
	// Real object reception shares the authenticated link with the browser's
	// document peer. A stream close certifies pinned, GC-surviving bytes.
	bundleBytes, err := os.ReadFile(bundle)
	require.NoError(t, err)
	for offset := 0; offset < len(bundleBytes); {
		n := min(65536, len(bundleBytes)-offset)
		require.NoError(t, wire.Write(guest, wire.Frame{Kind: wire.Objects, Stream: 8, Payload: append([]byte{1, 0}, bundleBytes[offset:offset+n]...)}))
		window, err := wire.Read(guest)
		require.NoError(t, err)
		require.Equal(t, append([]byte{6}, wire.U32(uint32(n))...), window.Payload)
		offset += n
	}
	require.NoError(t, wire.Write(guest, wire.Frame{Kind: wire.Objects, Stream: 8, Payload: []byte{2, 0}}))
	closed, err := wire.Read(guest)
	require.NoError(t, err)
	require.Equal(t, wire.Frame{Kind: wire.Objects, Stream: 8, Payload: []byte{7}}, closed)
	git("-C", store, "gc", "--prune=now")
	require.Equal(t, "captured bytes", git("-C", store, "show", head+":retry.ts"))
	require.Equal(t, base, git("-C", store, "rev-parse", "refs/heads/main"))
	// Dependency readiness is separate from the transport. A fresh authenticated
	// link is refused by the public subscription before reconciliation completes.
	f.relay.Connection = func(_ context.Context, branch string) (*machined.Connection, live.DocumentRPC) {
		current, err := registry.Current(branch)
		if err != nil {
			return nil, nil
		}
		return current.Connection, machined.Documents(registry, branch)
	}
	f.sub(t, "doc:code:11111111-1111-4111-8111-111111111111:retry.ts")
	kind, body := f.read(t)
	require.Equal(t, websocket.MessageText, kind)
	require.Contains(t, string(body), "unsupported")
	require.NoError(t, link.Reconciled())
	f.sub(t, "doc:code:11111111-1111-4111-8111-111111111111:retry.ts")
	request, err := wire.Read(guest)
	require.NoError(t, err)
	id, method, args, err := request.Request()
	require.NoError(t, err)
	require.Equal(t, byte(wire.OpenDoc), method)
	fields, err := wire.Fields("args13", args)
	require.NoError(t, err)
	require.Equal(t, wire.String("retry.ts"), fields[1])
	require.Equal(t, wire.Union(1, wire.Field(1, wire.Bytes([]byte("host")))), fields[2])
	require.NoError(t, wire.Write(guest, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(13, wire.Field(1, wire.U32(5)))))}))

	// The host mirror first asks the daemon for its persisted state. Complete
	// that sync before expecting a browser snapshot, then accept real native
	// updates and return sequence-bound durability receipts from the fake peer.
	syncRequest, err := wire.Read(guest)
	require.NoError(t, err)
	initial, err := wire.DecodeDocumentV2(syncRequest.Payload)
	require.NoError(t, err)
	require.Equal(t, []byte("host"), initial.Actor)
	require.NoError(t, wire.Write(guest, wire.Frame{Kind: wire.Documents, Stream: 5, Payload: docGolden(t, "epoch")}))
	require.NoError(t, wire.Write(guest, wire.Frame{Kind: wire.Documents, Stream: 5, Payload: []byte{3, 1, 2, 0, 0}}))
	daemonDocument, err := f.relay.Host.Library.Open(livedocument.Code, nil)
	require.NoError(t, err)
	t.Cleanup(func() { daemonDocument.Close() })
	finished := make(chan error, 1)
	go func() {
		for {
			frame, err := wire.Read(guest)
			if err != nil {
				finished <- err
				return
			}
			if frame.Kind == wire.Control {
				closeID, method, _, err := frame.Request()
				if err != nil {
					finished <- err
					return
				}
				if method != byte(wire.CloseDoc) {
					finished <- wire.UnknownMethod
					return
				}
				text, err := daemonDocument.Text("content")
				if err != nil {
					finished <- err
					return
				}
				if text != "hello" {
					finished <- fmt.Errorf("daemon text = %q", text)
					return
				}
				finished <- wire.Write(guest, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(closeID)), wire.Field(2, wire.Union(14)))})
				return
			}
			msg, err := wire.DecodeDocumentV2(frame.Payload)
			if err != nil {
				finished <- err
				return
			}
			if frame.Kind != wire.Documents || frame.Stream != 5 || msg.Msg != wire.DocumentInput {
				finished <- wire.BadValue
				return
			}
			_, update := codeDecode(t, msg.Data)
			if _, err = daemonDocument.Peer(update); err != nil {
				finished <- err
				return
			}
			vector, err := daemonDocument.Sync1()
			if err != nil {
				finished <- err
				return
			}
			saved, err := wire.EncodeDocumentV2(wire.Document{Msg: wire.DocumentSaved, AtMS: 1791028800000, ThroughSeq: msg.Seq, Data: vector})
			if err != nil {
				finished <- err
				return
			}
			if err = wire.Write(guest, wire.Frame{Kind: wire.Documents, Stream: 5, Payload: saved}); err != nil {
				finished <- err
				return
			}
		}
	}()
	client := f.assigned(t)
	f.update(t, codeInsert(client, "hello"))
	readSaved(t, f, 1)
	require.NoError(t, f.conn.Write(t.Context(), websocket.MessageText, []byte(`{"t":"unsub","id":7}`)))
	require.NoError(t, <-finished)
}
