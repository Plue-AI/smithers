package machined

import (
	"context"
	"encoding/hex"
	"errors"
	"net"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

func rpcFixture(t *testing.T) (*Registry, *Link, net.Conn) {
	t.Helper()
	r := new(Registry)
	a, err := r.MintBoot("a", "vm")
	require.NoError(t, err)
	l, peer := connectTest(t, r, "a", a)
	require.NoError(t, l.Reconciled())
	return r, l, peer
}
func answer(t *testing.T, peer net.Conn, method wire.Method, fields ...[]byte) {
	t.Helper()
	f, err := wire.Read(peer)
	require.NoError(t, err)
	id, m, _, err := f.Request()
	require.NoError(t, err)
	require.Equal(t, byte(method), m)
	require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(byte(method), fields...)))}))
}
func TestRegistryFileRPC(t *testing.T) {
	r, _, peer := rpcFixture(t)
	type read struct {
		file File
		err  error
	}
	result := make(chan read, 1)
	go func() { file, err := r.ReadFile(t.Context(), "a", "README.md", ""); result <- read{file, err} }()
	digest, _ := hex.DecodeString(strings.Repeat("ab", 32))
	answer(t, peer, wire.ReadFile, wire.Field(1, wire.Bytes([]byte("hello"))), wire.Field(2, digest), wire.Field(3, wire.U32(420)))
	got := <-result
	require.NoError(t, got.err)
	require.Equal(t, File{Content: []byte("hello"), Digest: strings.Repeat("ab", 32), Mode: 420}, got.file)
	type written struct {
		result WriteResult
		err    error
	}
	writes := make(chan written, 1)
	go func() {
		result, err := r.WriteFiles(t.Context(), "a", []byte("host-author"), []FileChange{{Path: "first", Content: []byte("a")}, {Path: "second", Content: []byte("b")}})
		writes <- written{result, err}
	}()
	answer(t, peer, wire.WriteFile, wire.Field(1, digest), wire.Field(2, wire.Struct(wire.Field(1, wire.String("first")), wire.Field(2, digest))))
	request, err := wire.Read(peer)
	require.NoError(t, err)
	id, method, _, err := request.Request()
	require.NoError(t, err)
	require.Equal(t, byte(wire.WriteFile), method)
	require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(255, wire.Field(1, []byte{byte(wire.Stale)}), wire.Field(2, wire.String("second")), wire.Field(3, digest))))}))
	write := <-writes
	require.NoError(t, write.err)
	require.Len(t, write.result.Applied, 1)
	require.Equal(t, "first", write.result.Applied[0].Path)
	require.Equal(t, "first", write.result.Raced[0].Path)
	require.Equal(t, "second", write.result.Stale.Path)
	require.Equal(t, strings.Repeat("ab", 32), *write.result.Stale.CurrentDigest)
	_, err = r.ReadFile(t.Context(), "foreign", "README.md", "")
	require.ErrorIs(t, err, ErrNotReady)
	_, err = r.ReadFile(t.Context(), "a", "README.md", "invalid")
	require.ErrorIs(t, err, wire.BadValue)
	_, err = r.WriteFiles(t.Context(), "a", nil, []FileChange{{Path: "bad"}})
	require.ErrorIs(t, err, ErrUnauthorized)
}
func TestRegistryAdmissionRPC(t *testing.T) {
	r, _, peer := rpcFixture(t)
	head := strings.Repeat("a", 40)
	headBytes, _ := hex.DecodeString(head)
	results := make(chan error, 1)
	go func() { _, err := r.Capture(t.Context(), "a"); results <- err }()
	answer(t, peer, wire.Capture, wire.Field(1, headBytes), wire.Field(2, headBytes), wire.Field(3, wire.U16(2)))
	require.NoError(t, <-results)
	for _, test := range []struct {
		value   []byte
		outcome ReconcileOutcome
	}{
		{wire.Union(1), ReconcileUnchanged}, {wire.Union(2, wire.Field(1, headBytes)), ReconcileMoved},
		{wire.Union(3, wire.Field(1, append(wire.U16(1), wire.String("README.md")...))), ReconcileConflict},
	} {
		received := make(chan ReconcileResult, 1)
		go func() { value, err := r.WakeReconcile(t.Context(), "a", head); received <- value; results <- err }()
		answer(t, peer, wire.WakeReconcile, wire.Field(1, test.value))
		require.NoError(t, <-results)
		require.Equal(t, test.outcome, (<-received).Outcome)
	}
	go func() { results <- r.SetRoster(t.Context(), "a", []SessionUser{{Login: "alice", UID: 20001}}) }()
	answer(t, peer, wire.SetRoster)
	require.NoError(t, <-results)
	require.ErrorIs(t, r.SetRoster(t.Context(), "a", []SessionUser{{Login: "root", UID: 0}}), ErrUnauthorized)
	go func() { _, err := r.Rebase(t.Context(), "a", []byte("actor"), head); results <- err }()
	answer(t, peer, wire.Rebase, wire.Field(1, headBytes))
	require.NoError(t, <-results)
	go func() { _, err := r.ReturnToItem(t.Context(), "a", []byte("actor")); results <- err }()
	answer(t, peer, wire.ReturnToItem, wire.Field(1, headBytes))
	require.NoError(t, <-results)
}
func TestRegistryDocumentRPC(t *testing.T) {
	r, _, peer := rpcFixture(t)
	type opened struct {
		document DocumentStream
		err      error
	}
	result := make(chan opened, 1)
	go func() {
		doc, err := r.OpenDocument(t.Context(), "a", "README.md", []byte("actor"))
		result <- opened{doc, err}
	}()
	// First document frame may precede the RPC response on the same byte stream.
	request, err := wire.Read(peer)
	require.NoError(t, err)
	id, _, _, err := request.Request()
	require.NoError(t, err)
	require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Documents, Stream: 5, Payload: []byte{2, 0, 0}}))
	require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(13, wire.Field(1, wire.U32(5)))))}))
	openedDoc := <-result
	require.NoError(t, openedDoc.err)
	bytes, err := openedDoc.document.Receive(t.Context())
	require.NoError(t, err)
	require.Equal(t, []byte{2, 0, 0}, bytes)
	sent := make(chan error, 1)
	go func() { sent <- openedDoc.document.Send(t.Context(), []byte{1, 4, 5}) }()
	frame, err := wire.Read(peer)
	require.NoError(t, err)
	require.Equal(t, uint32(5), frame.Stream)
	require.Equal(t, []byte{1, 4, 5}, frame.Payload)
	require.NoError(t, <-sent)
	go func() { sent <- openedDoc.document.Close() }()
	answer(t, peer, wire.CloseDoc)
	require.NoError(t, <-sent)
	_, err = openedDoc.document.Receive(t.Context())
	require.Error(t, err)
	require.NoError(t, openedDoc.document.Close())
}
func TestRegistrySessionRPC(t *testing.T) {
	r, _, peer := rpcFixture(t)
	results := make(chan error, 1)
	for _, test := range []struct {
		call   SessionCall
		method wire.Method
		fields [][]byte
	}{
		{SessionCall{Method: "open_session", User: &SessionUser{Login: "alice", UID: 20001}, Kind: SessionPTY, Argv: []string{"sh"}, Size: &SessionSize{80, 24}}, wire.OpenSession, [][]byte{wire.Field(1, wire.U32(1))}},
		{SessionCall{Method: "tcp_connect", Port: 8080}, wire.TCPConnect, [][]byte{wire.Field(1, wire.U32(2))}},
		{SessionCall{Method: "close_session", Session: 1}, wire.CloseSession, nil},
		{SessionCall{Method: "kill_sessions", User: &SessionUser{Login: "alice", UID: 20001}}, wire.KillSessions, [][]byte{wire.Field(1, wire.U16(1))}},
		{SessionCall{Method: "kill_sessions", Run: "run"}, wire.KillSessions, [][]byte{wire.Field(1, wire.U16(2))}},
		{SessionCall{Method: "register_run", Run: "run", Session: 1}, wire.RegisterRun, nil},
		{SessionCall{Method: "attach_session", Session: 1, Received: 0}, wire.AttachSession, [][]byte{wire.Field(1, wire.U64(0))}},
	} {
		go func() { _, err := r.Sessions("a").CallSession(t.Context(), test.call); results <- err }()
		answer(t, peer, test.method, test.fields...)
		require.NoError(t, <-results)
	}
	_, err := r.Sessions("a").CallSession(t.Context(), SessionCall{Method: "unknown"})
	require.ErrorIs(t, err, wire.UnknownMethod)
}
func TestRegistryRPCRefusesWrongReplyAndCancelledContext(t *testing.T) {
	r, _, peer := rpcFixture(t)
	done := make(chan error, 1)
	go func() { _, err := r.ReadFile(t.Context(), "a", "x", ""); done <- err }()
	request, err := wire.Read(peer)
	require.NoError(t, err)
	id, _, _, err := request.Request()
	require.NoError(t, err)
	require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(16)))}))
	require.ErrorIs(t, <-done, wire.BadValue)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	err = r.Ack(ctx, "a", Acknowledgement{Seq: 1, Outcome: AckApplied})
	require.True(t, errors.Is(err, context.Canceled) || errors.Is(err, ErrNotReady))
}

func TestRegistryAdmissionRequiresActualReady(t *testing.T) {
	for _, state := range []byte{2, 3} {
		t.Run(string(rune('0'+state)), func(t *testing.T) {
			r := new(Registry)
			a, err := r.MintBoot("a", "vm")
			require.NoError(t, err)
			link, peer := connectTest(t, r, "a", a)
			done := make(chan error, 1)
			go func() {
				done <- r.AdmitReady(t.Context(), "a", strings.Repeat("a", 40), []SessionUser{{"alice", 20001}})
			}()
			answer(t, peer, wire.WakeReconcile, wire.Field(1, wire.Union(1)))
			require.ErrorIs(t, link.RequireReady("a"), ErrNotReady)
			answer(t, peer, wire.SetRoster)
			require.ErrorIs(t, link.RequireReady("a"), ErrNotReady)
			answer(t, peer, wire.Status, wire.Field(1, []byte{state}), wire.Field(2, wire.U16(1)), wire.Field(3, wire.String("guest")), wire.Field(4, wire.U32(0)), wire.Field(6, wire.U16(0)))
			err = <-done
			if state == 3 {
				require.NoError(t, err)
				require.NoError(t, link.RequireReady("a"))
			} else {
				require.ErrorIs(t, err, ErrNotReady)
				require.ErrorIs(t, link.RequireReady("a"), ErrNotReady)
			}
		})
	}
}

func TestRegistryAckCanonicalAndRefusals(t *testing.T) {
	r, _, peer := rpcFixture(t)
	result := make(chan error, 1)
	go func() {
		result <- r.Ack(t.Context(), "a", Acknowledgement{Seq: 7, Outcome: AckRejected, Error: &SessionError{Code: "unauthorized", Detail: "member removed"}, Haves: []string{strings.Repeat("a", 40)}})
	}()
	frame, err := wire.Read(peer)
	require.NoError(t, err)
	require.NoError(t, <-result)
	fields, err := wire.Fields("ack", frame.Payload[1:])
	require.NoError(t, err)
	require.NotNil(t, fields[4])
	require.NotNil(t, fields[5])
	require.ErrorIs(t, r.Ack(t.Context(), "a", Acknowledgement{Seq: 0, Outcome: AckApplied}), wire.BadValue)
	require.ErrorIs(t, r.Ack(t.Context(), "a", Acknowledgement{Seq: 1, Outcome: AckApplied, OIDs: []string{"bad"}}), wire.BadValue)
	require.ErrorIs(t, r.Ack(t.Context(), "a", Acknowledgement{Seq: 1, Outcome: AckRejected, Error: &SessionError{Code: "invented"}}), wire.BadValue)
}
