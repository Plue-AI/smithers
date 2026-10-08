package machined

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func rpcFixture(t *testing.T) (*Registry, *Link, net.Conn) {
	t.Helper()
	r := new(Registry)
	bindFixtureExporter(r)
	a, err := r.MintBoot("a", "vm")
	require.NoError(t, err)
	l, peer := connectTest(t, r, "a", a)
	require.NoError(t, l.Reconciled())
	return r, l, peer
}
func answer(t *testing.T, peer net.Conn, method wire.Method, fields ...[]byte) {
	t.Helper()
	if method == wire.WakeReconcile {
		acceptFixtureBundle(t, peer)
	}
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
	helloDigest, _ := hex.DecodeString("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")
	digest, _ := hex.DecodeString(strings.Repeat("ab", 32))
	answer(t, peer, wire.ReadFile, wire.Field(1, wire.Bytes([]byte("hello"))), wire.Field(2, helloDigest), wire.Field(3, wire.U32(420)))
	got := <-result
	require.NoError(t, got.err)
	require.Equal(t, File{Content: []byte("hello"), Digest: hex.EncodeToString(helloDigest), Mode: 420}, got.file)
	type written struct {
		result WriteResult
		err    error
	}
	writes := make(chan written, 1)
	go func() {
		result, err := r.WriteFiles(t.Context(), "a", []byte("host-author"), []FileChange{{Path: "first", Content: []byte("a")}, {Path: "second", Content: []byte("b")}})
		writes <- written{result, err}
	}()
	request, err := wire.Read(peer)
	require.NoError(t, err)
	id, method, args, err := request.Request()
	require.NoError(t, err)
	require.Equal(t, byte(wire.WriteFiles), method)
	requestFields, err := wire.Fields("args17", args)
	require.NoError(t, err)
	changes, err := wire.List("local_write", requestFields[1])
	require.NoError(t, err)
	require.Len(t, changes, 2)
	failure := wire.Struct(wire.Field(1, wire.U16(1)), wire.Field(2, []byte{1}), wire.Field(3, wire.Struct(wire.Field(1, []byte{byte(wire.Stale)}), wire.Field(3, digest))))
	require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(byte(wire.WriteFiles), wire.Field(1, wire.U16(0)), wire.Field(2, failure))))}))
	write := <-writes
	require.NoError(t, write.err)
	require.Empty(t, write.result.Applied)
	require.Empty(t, write.result.Raced)
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
	r, link, peer := rpcFixture(t)
	head := strings.Repeat("a", 40)
	headBytes, _ := hex.DecodeString(head)
	results := make(chan error, 1)
	go func() { _, err := r.Capture(t.Context(), "a"); results <- err }()
	answer(t, peer, wire.Capture, wire.Field(1, headBytes), wire.Field(2, headBytes), wire.Field(3, wire.U16(2)))
	answerCaptureStatus(t, peer, 3, 0, headBytes)
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
	require.NoError(t, link.Reconciled()) // independent ready fixture for the remaining RPCs
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

func answerCaptureStatus(t *testing.T, peer net.Conn, state byte, depth uint32, head []byte) {
	t.Helper()
	fields := [][]byte{wire.Field(1, []byte{state}), wire.Field(2, wire.U16(2)), wire.Field(3, wire.String("smithers-machined")), wire.Field(4, wire.U32(depth)), wire.Field(6, wire.U16(0))}
	if head != nil {
		fields = append(fields[:4], append([][]byte{wire.Field(5, head)}, fields[4:]...)...)
	}
	answer(t, peer, wire.Status, fields...)
}

func TestRebaseResultRetainsNativeConflictInspection(t *testing.T) {
	for _, paths := range [][]string{nil, {}, {"src/retry.ts", "README.md"}} {
		r, _, peer := rpcFixture(t)
		result := make(chan RewriteResult, 1)
		go func() {
			rewrite, err := r.Rebase(t.Context(), "a", []byte("actor"), strings.Repeat("a", 40))
			require.NoError(t, err)
			result <- rewrite
		}()
		fields := [][]byte{wire.Field(1, bytes.Repeat([]byte{0x22}, 20))}
		if paths != nil {
			list := wire.U16(uint16(len(paths)))
			for _, path := range paths {
				list = append(list, wire.String(path)...)
			}
			fields = append(fields, wire.Field(2, list))
		}
		answer(t, peer, wire.Rebase, fields...)
		rewrite := <-result
		require.Equal(t, strings.Repeat("22", 20), rewrite.Head)
		require.Equal(t, paths != nil, rewrite.Inspected)
		require.Equal(t, len(paths), len(rewrite.Paths))
		if len(paths) > 0 {
			require.Equal(t, paths, rewrite.Paths)
		}
	}
}

func TestRegistryCaptureRequiresAuthenticatedDrain(t *testing.T) {
	for _, outcome := range []string{"drained", "cancelled", "replaced", "missing_ack", "wrong_head", "not_ready", "new_burst", "new_document"} {
		t.Run(outcome, func(t *testing.T) {
			r, _, peer := rpcFixture(t)
			require.NoError(t, peer.SetDeadline(time.Now().Add(5*time.Second)))
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			head, _ := hex.DecodeString(strings.Repeat("ab", 20))
			result := make(chan error, 1)
			go func() { _, err := r.Capture(ctx, "a"); result <- err }()
			answer(t, peer, wire.Capture, wire.Field(1, head), wire.Field(2, head), wire.Field(3, wire.U16(0)))
			answerCaptureStatus(t, peer, 3, 2, head)
			select {
			case err := <-result:
				t.Fatalf("capture completed with pending events: %v", err)
			default:
			}
			switch outcome {
			case "drained":
				answerCaptureStatus(t, peer, 3, 1, head)
				answerCaptureStatus(t, peer, 3, 0, head)
				require.NoError(t, <-result)
			case "new_burst", "new_document":
				burst, document := byte(1), byte(1)
				if outcome == "new_burst" {
					burst = 0
				} else {
					document = 0
				}
				answer(t, peer, wire.Status, wire.Field(1, []byte{3}), wire.Field(2, wire.U16(7)), wire.Field(3, wire.String("fixture")), wire.Field(4, wire.U32(0)), wire.Field(5, head), wire.Field(6, wire.U16(0)), wire.Field(7, []byte{burst}), wire.Field(8, []byte{document}))
				require.ErrorIs(t, <-result, ErrNotReady)
			case "cancelled":
				cancel()
				require.ErrorIs(t, <-result, context.Canceled)
			case "replaced":
				_, err := r.MintBoot("a", "replacement")
				require.NoError(t, err)
				require.Error(t, <-result)
			case "missing_ack":
				answerCaptureStatus(t, peer, 3, 0, nil)
				require.ErrorContains(t, <-result, "not acknowledged")
			case "wrong_head":
				other, _ := hex.DecodeString(strings.Repeat("cd", 20))
				answerCaptureStatus(t, peer, 3, 0, other)
				require.ErrorContains(t, <-result, "not acknowledged")
			case "not_ready":
				answerCaptureStatus(t, peer, 2, 0, head)
				require.ErrorIs(t, <-result, ErrNotReady)
			}
		})
	}
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

// Spec §7.1.1: a document reader that falls behind gaps its own stream. The
// machine link, its other documents and its RPCs continue.
func TestRegistryDocumentOverflowGapsOnlyItsStream(t *testing.T) {
	for _, overflow := range []string{"frames", "bytes"} {
		t.Run(overflow, func(t *testing.T) {
			r, link, peer := rpcFixture(t)
			open := func(stream uint32) DocumentStream {
				result := make(chan DocumentStream, 1)
				go func() {
					doc, err := r.OpenDocument(t.Context(), "a", "retry.ts", []byte("actor"))
					assert.NoError(t, err)
					result <- doc
				}()
				answer(t, peer, wire.OpenDoc, wire.Field(1, wire.U32(stream)))
				return <-result
			}
			slow, other := open(5), open(7)
			// The slow subscriber never reads while the daemon keeps sending.
			count, size := 300, 16
			if overflow == "bytes" {
				count, size = 40, 64<<10
			}
			for i := 0; i < count; i++ {
				require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Documents, Stream: 5, Payload: append([]byte{3}, make([]byte, size)...)}))
			}
			require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Documents, Stream: 7, Payload: []byte{3, 0, 1, 0}}))
			got, err := other.Receive(t.Context())
			require.NoError(t, err)
			require.Equal(t, []byte{3, 0, 1, 0}, got)
			for {
				_, err = slow.Receive(t.Context())
				if err != nil {
					break
				}
			}
			require.ErrorIs(t, err, ErrDocumentGap)
			select {
			case <-link.Done():
				t.Fatal("a slow document reader closed the machine link")
			default:
			}
			require.NoError(t, link.RequireReady("a"))
			// Later frames for the gapped stream are dropped, not fatal.
			require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Documents, Stream: 5, Payload: []byte{3, 0, 1, 0}}))
			closed := make(chan error, 1)
			go func() { closed <- slow.Close() }()
			answer(t, peer, wire.CloseDoc)
			require.NoError(t, <-closed)
			require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Documents, Stream: 7, Payload: []byte{3, 0, 1, 1}}))
			got, err = other.Receive(t.Context())
			require.NoError(t, err)
			require.Equal(t, []byte{3, 0, 1, 1}, got)
		})
	}
}

// ADR 0004 S3: the host refuses an open beyond MaxOpenDocuments itself; the
// daemon never sees it and the open documents keep working.
func TestRegistryDocumentLimit(t *testing.T) {
	r, link, peer := rpcFixture(t)
	open := make([]DocumentStream, 0, MaxOpenDocuments)
	for i := 0; i < MaxOpenDocuments; i++ {
		result := make(chan DocumentStream, 1)
		go func() {
			doc, err := r.OpenDocument(t.Context(), "a", fmt.Sprintf("file-%d.ts", i), []byte("actor"))
			assert.NoError(t, err)
			result <- doc
		}()
		answer(t, peer, wire.OpenDoc, wire.Field(1, wire.U32(uint32(5+2*i))))
		open = append(open, <-result)
	}
	_, err := r.OpenDocument(t.Context(), "a", "one-more.ts", []byte("actor"))
	require.ErrorIs(t, err, ErrDocumentLimit)
	require.Equal(t, "busy", ErrDocumentLimit.Code)
	require.NoError(t, link.RequireReady("a"))
	require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Documents, Stream: 5, Payload: []byte{3, 0, 1, 0}}))
	got, err := open[0].Receive(t.Context())
	require.NoError(t, err)
	require.Equal(t, []byte{3, 0, 1, 0}, got)
	closed := make(chan error, 1)
	go func() { closed <- open[0].Close() }()
	answer(t, peer, wire.CloseDoc)
	require.NoError(t, <-closed)
	result := make(chan error, 1)
	go func() {
		_, err := r.OpenDocument(t.Context(), "a", "one-more.ts", []byte("actor"))
		result <- err
	}()
	answer(t, peer, wire.OpenDoc, wire.Field(1, wire.U32(41)))
	require.NoError(t, <-result, "closing a document frees its slot")
}

// A daemon refusal names one document. It is not a protocol failure, so the
// link stays open for every other stream and session.
func TestRegistryDocumentRefusalKeepsLink(t *testing.T) {
	r, link, peer := rpcFixture(t)
	result := make(chan error, 1)
	go func() {
		_, err := r.OpenDocument(t.Context(), "a", "logo.png", []byte("actor"))
		result <- err
	}()
	f, err := wire.Read(peer)
	require.NoError(t, err)
	id, _, _, err := f.Request()
	require.NoError(t, err)
	refused := wire.Union(255, wire.Field(1, []byte{2}))
	require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, refused))}))
	var refusal *SessionError
	require.ErrorAs(t, <-result, &refusal)
	require.Equal(t, "unsupported", refusal.Code)
	select {
	case <-link.Done():
		t.Fatal("a refused document closed the machine link")
	default:
	}
	require.NoError(t, link.RequireReady("a"))
}
func TestRegistrySessionRPC(t *testing.T) {
	r, _, peer := rpcFixture(t)
	results := make(chan error, 1)
	for _, test := range []struct {
		call   SessionCall
		method wire.Method
		fields [][]byte
	}{
		{SessionCall{Actor: []byte("actor-reference1"), Method: "open_session", User: &SessionUser{Login: "alice", UID: 20001}, Kind: SessionPTY, Argv: []string{"sh"}, Size: &SessionSize{80, 24}}, wire.OpenSession, [][]byte{wire.Field(1, wire.U32(1))}},
		{SessionCall{Actor: []byte("actor-reference1"), Method: "tcp_connect", Port: 8080}, wire.TCPConnect, [][]byte{wire.Field(1, wire.U32(2))}},
		{SessionCall{Method: "close_session", Session: 1}, wire.CloseSession, nil},
		{SessionCall{Method: "kill_sessions", User: &SessionUser{Login: "alice", UID: 20001}}, wire.KillSessions, [][]byte{wire.Field(1, wire.U16(1))}},
		{SessionCall{Method: "kill_sessions", Run: "run"}, wire.KillSessions, [][]byte{wire.Field(1, wire.U16(2))}},
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
	for _, state := range []byte{1, 2, 3} {
		t.Run(string(rune('0'+state)), func(t *testing.T) {
			r := new(Registry)
			bindFixtureExporter(r)
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
			if state == 2 {
				require.ErrorIs(t, link.RequireReady("a"), ErrNotReady)
				answer(t, peer, wire.Status, wire.Field(1, []byte{3}), wire.Field(2, wire.U16(1)), wire.Field(3, wire.String("guest")), wire.Field(4, wire.U32(0)), wire.Field(6, wire.U16(0)))
			}
			err = <-done
			if state != 1 {
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

func TestRegistryRequiresExactLiveProtocolBeforeCredentials(t *testing.T) {
	for version := uint16(0); version <= wire.Protocol+1; version++ {
		if version == wire.Protocol {
			continue
		}
		t.Run(fmt.Sprint(version), func(t *testing.T) {
			r := new(Registry)
			authority, err := r.MintBoot("a", "vm")
			require.NoError(t, err)
			host, guest := net.Pipe()
			defer host.Close()
			defer guest.Close()
			done := make(chan error, 1)
			go func() {
				payload := wire.Union(1, wire.Field(1, wire.U32(0x534d4d44)), wire.Field(2, wire.U16(version)), wire.Field(3, authority.ID[:]), wire.Field(4, make([]byte, 32)))
				raw := append(wire.U32(uint32(len(payload))), wire.Hello, 0, 0, 0, 0)
				raw = append(raw, payload...)
				if _, e := guest.Write(raw); e != nil {
					done <- e
					return
				}
				goodbye, e := wire.Read(guest)
				if e == nil && (goodbye.Kind != wire.Hello || len(goodbye.Payload) != 7 || goodbye.Payload[0] != 5 || goodbye.Payload[6] != byte(wire.VersionMismatch)) {
					e = wire.HandshakeOrder
				}
				done <- e
			}()
			link, err := r.Connect(t.Context(), "a", host)
			require.ErrorIs(t, err, wire.VersionMismatch)
			require.Nil(t, link)
			require.NoError(t, <-done)
			require.Empty(t, r.ConnectedBranches())
		})
	}
}

func TestRegistryReconnectUsesCurrentRosterBeforeReady(t *testing.T) {
	r := new(Registry)
	bindFixtureExporter(r)
	authority, err := r.MintBoot("a", "vm")
	require.NoError(t, err)
	current := []SessionUser{{Login: "alice", UID: 20001}}
	r.BindRosterSync(func(ctx context.Context, branch string) error { return r.SetRoster(ctx, branch, current) })
	stale := []SessionUser{{Login: "removed", UID: 20002}}
	for run := 0; run < 20; run++ {
		started := time.Now()
		link, peer := connectTest(t, r, "a", authority)
		require.NoError(t, peer.SetDeadline(started.Add(5*time.Second)))
		require.Equal(t, []string{"a"}, r.ConnectedBranches())
		done := make(chan error, 1)
		go func() { done <- r.AdmitReady(t.Context(), "a", strings.Repeat("a", 40), stale) }()
		frame, err := wire.Read(peer)
		require.NoError(t, err)
		id, method, args, err := frame.Request()
		require.NoError(t, err)
		require.Equal(t, byte(wire.SetRoster), method)
		fields, err := wire.Fields("args16", args)
		require.NoError(t, err)
		expected := wire.U16(uint16(len(current)))
		for _, member := range current {
			expected = append(expected, wire.Struct(wire.Field(1, wire.String(member.Login)), wire.Field(2, wire.U32(member.UID)))...)
		}
		require.Equal(t, expected, fields[1], "stale caller roster must never reach the reconnected broker")
		require.ErrorIs(t, link.RequireReady("a"), ErrNotReady)
		require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(byte(wire.SetRoster))))}))
		answer(t, peer, wire.WakeReconcile, wire.Field(1, wire.Union(1)))
		answer(t, peer, wire.Status, wire.Field(1, []byte{3}), wire.Field(2, wire.U16(1)), wire.Field(3, wire.String("guest")), wire.Field(4, wire.U32(0)), wire.Field(6, wire.U16(0)))
		require.NoError(t, <-done)
		require.NoError(t, link.RequireReady("a"))
		require.LessOrEqual(t, time.Since(started), 5*time.Second)
		require.NoError(t, link.Close())
		require.Empty(t, r.ConnectedBranches())
		current = nil // member removed while the link is partitioned
	}
}

func TestRegistryRosterFailureCannotAdmit(t *testing.T) {
	r := new(Registry)
	authority, err := r.MintBoot("a", "vm")
	require.NoError(t, err)
	link, _ := connectTest(t, r, "a", authority)
	failure := errors.New("roster unavailable")
	r.BindRosterSync(func(context.Context, string) error { return failure })
	done := make(chan error, 1)
	go func() { done <- r.AdmitReady(t.Context(), "a", strings.Repeat("a", 40), nil) }()
	require.ErrorIs(t, <-done, failure)
	require.ErrorIs(t, link.RequireReady("a"), ErrNotReady)
}

// Exercise the authenticated transport boundary, with a peer that must receive
// no frame when any member of the caller's batch is malformed.
func TestRegistryWriteFilesValidatesEveryBaseBeforeDispatch(t *testing.T) {
	for _, invalid := range []string{"bad", strings.Repeat("ab", 31), strings.Repeat("ab", 33)} {
		t.Run(invalid, func(t *testing.T) {
			r, _, peer := rpcFixture(t)
			ctx, cancel := context.WithTimeout(t.Context(), time.Second)
			defer cancel()
			result, err := r.WriteFiles(ctx, "a", []byte("host-author"), []FileChange{
				{Path: "first", Content: []byte("first")},
				{Path: "second", BaseDigest: &invalid, Content: []byte("second")},
			})
			require.ErrorIs(t, err, wire.BadValue)
			require.Empty(t, result.Applied)
			require.Empty(t, result.Raced)
			require.Nil(t, result.Stale)
			require.NoError(t, peer.SetReadDeadline(time.Now().Add(20*time.Millisecond)))
			var probe [1]byte
			n, err := peer.Read(probe[:])
			require.Zero(t, n)
			var timeout net.Error
			require.ErrorAs(t, err, &timeout)
			require.True(t, timeout.Timeout(), "malformed batch emitted a write frame")
		})
	}
}

func TestRegistryWriteFilesValidatesEveryFrameBeforeDispatch(t *testing.T) {
	for _, scenario := range []string{"path-size", "path-utf8", "content-size"} {
		t.Run(scenario, func(t *testing.T) {
			r, _, peer := rpcFixture(t)
			second := FileChange{Path: "second", Content: []byte("second")}
			switch scenario {
			case "path-size":
				second.Path = strings.Repeat("x", 4097)
			case "path-utf8":
				second.Path = string([]byte{255})
			case "content-size":
				second.Content = make([]byte, wire.MaxWorkspaceFileBytes+1)
			}
			ctx, cancel := context.WithTimeout(t.Context(), time.Second)
			defer cancel()
			result, err := r.WriteFiles(ctx, "a", []byte("host-author"), []FileChange{{Path: "first", Content: []byte("first")}, second})
			require.Error(t, err)
			require.NotErrorIs(t, err, context.DeadlineExceeded)
			require.Empty(t, result.Applied)
			require.NoError(t, peer.SetReadDeadline(time.Now().Add(20*time.Millisecond)))
			var probe [1]byte
			n, err := peer.Read(probe[:])
			require.Zero(t, n)
			var timeout net.Error
			require.ErrorAs(t, err, &timeout)
			require.True(t, timeout.Timeout())
		})
	}
}

func TestRegistryRejectsFalseFileDigests(t *testing.T) {
	for _, method := range []wire.Method{wire.ReadFile, wire.WriteFiles} {
		t.Run(fmt.Sprint(method), func(t *testing.T) {
			r, link, peer := rpcFixture(t)
			done := make(chan error, 1)
			go func() {
				if method == wire.ReadFile {
					file, err := r.ReadFile(t.Context(), "a", "README.md", "")
					if len(file.Content) != 0 {
						done <- fmt.Errorf("unverified bytes escaped")
						return
					}
					done <- err
				} else {
					result, err := r.WriteFiles(t.Context(), "a", []byte("member"), []FileChange{{Path: "README.md", Content: []byte("hello")}})
					if len(result.Applied) != 0 {
						done <- fmt.Errorf("unverified receipt escaped")
						return
					}
					done <- err
				}
			}()
			if method == wire.ReadFile {
				answer(t, peer, method, wire.Field(1, wire.Bytes([]byte("hello"))), wire.Field(2, make([]byte, 32)), wire.Field(3, wire.U32(420)))
			} else {
				answer(t, peer, method, wire.Field(1, append(wire.U16(1), wire.Struct(wire.Field(1, wire.Union(1, wire.Field(1, make([]byte, 32)))))...)))
			}
			require.ErrorIs(t, <-done, wire.BadValue)
			require.ErrorIs(t, link.RequireReady("a"), ErrUnauthorized)
		})
	}
}

func TestRegistryIdleSafetyRequiresFreshCompleteEvidence(t *testing.T) {
	for _, tc := range []struct {
		name           string
		state          byte
		fields         [][]byte
		quiet, flushed bool
		missing        bool
	}{
		{"old daemon", 3, nil, false, false, true},
		{"missing flush", 3, [][]byte{wire.Field(7, []byte{1})}, false, false, true},
		{"reconciling", 2, [][]byte{wire.Field(7, []byte{1}), wire.Field(8, []byte{1})}, false, false, true},
		{"open burst", 3, [][]byte{wire.Field(7, []byte{0}), wire.Field(8, []byte{1})}, false, true, false},
		{"unflushed", 3, [][]byte{wire.Field(7, []byte{1}), wire.Field(8, []byte{0})}, true, false, false},
		{"quiet", 3, [][]byte{wire.Field(7, []byte{1}), wire.Field(8, []byte{1})}, true, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, _, peer := rpcFixture(t)
			defer peer.Close()
			type observation struct {
				quiet, flushed bool
				err            error
			}
			got := make(chan observation, 1)
			go func() { q, f, e := r.IdleSafety(t.Context(), "a"); got <- observation{q, f, e} }()
			fields := [][]byte{wire.Field(1, []byte{tc.state}), wire.Field(2, wire.U16(7)), wire.Field(3, wire.String("fixture")), wire.Field(4, wire.U32(0)), wire.Field(6, wire.U16(0))}
			answer(t, peer, wire.Status, append(fields, tc.fields...)...)
			result := <-got
			if tc.missing {
				require.ErrorIs(t, result.err, ErrNotReady)
			} else {
				require.NoError(t, result.err)
			}
			require.Equal(t, tc.quiet, result.quiet)
			require.Equal(t, tc.flushed, result.flushed)
		})
	}
	r := new(Registry)
	_, _, err := r.IdleSafety(t.Context(), "missing")
	require.Error(t, err)
}

func TestConflictInspectionRequiresBoundNativeReceipt(t *testing.T) {
	for _, tc := range []struct {
		name      string
		paths     []string
		inspected bool
	}{{"legacy", nil, false}, {"resolved", []string{}, true}, {"conflicted", []string{"src/retry.ts", "a.txt"}, true}} {
		t.Run(tc.name, func(t *testing.T) {
			registry, _, peer := rpcFixture(t)
			ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
			defer cancel()
			type inspection struct {
				paths []string
				err   error
			}
			done := make(chan inspection, 1)
			go func() {
				paths, err := registry.InspectConflict(ctx, "a", strings.Repeat("a", 40), strings.Repeat("b", 40))
				done <- inspection{paths, err}
			}()
			request, err := wire.Read(peer)
			require.NoError(t, err)
			id, method, args, err := request.Request()
			require.NoError(t, err)
			require.Equal(t, byte(wire.InspectConflict), method)
			fields, err := wire.Fields("args18", args)
			require.NoError(t, err)
			require.Equal(t, bytes.Repeat([]byte{0xaa}, 20), fields[1])
			require.Equal(t, bytes.Repeat([]byte{0xbb}, 20), fields[2])
			result := [][]byte{wire.Field(1, []byte{byte(wire.UnsupportedMethod)})}
			variant := byte(255)
			if tc.inspected {
				list := wire.U16(uint16(len(tc.paths)))
				for _, path := range tc.paths {
					list = append(list, wire.String(path)...)
				}
				result = [][]byte{wire.Field(1, list)}
				variant = byte(wire.InspectConflict)
			}
			require.NoError(t, wire.Write(peer, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(variant, result...)))}))
			got := <-done
			if !tc.inspected {
				var refusal *SessionError
				require.ErrorAs(t, got.err, &refusal)
				require.Equal(t, "unsupported", refusal.Code)
			} else {
				require.NoError(t, got.err)
				require.Equal(t, tc.paths, got.paths)
			}
		})
	}
}

// The peer is substituted only to inject stale/missing native observations;
// the composed rehearsal independently exercises the installed daemon.
func TestRetainedConflictAdmissionRequiresHostHeadAndActualReadiness(t *testing.T) {
	for _, tc := range []string{"missing ack", "stale ack", "matching ack"} {
		t.Run(tc, func(t *testing.T) {
			registry := new(Registry)
			bindFixtureExporter(registry)
			boot, err := registry.MintBoot("a", "vm")
			require.NoError(t, err)
			link, peer := connectTest(t, registry, "a", boot)
			defer peer.Close()
			_, err = registry.InspectConflict(t.Context(), "a", strings.Repeat("b", 40), strings.Repeat("c", 40))
			require.ErrorIs(t, err, ErrNotReady, "ordinary inspection cannot warm admission")
			done := make(chan error, 1)
			go func() {
				done <- registry.AdmitReady(t.Context(), "a", strings.Repeat("a", 40), nil, &RetainedConflict{Change: strings.Repeat("b", 40), Onto: strings.Repeat("c", 40)})
			}()
			acceptFixtureBundle(t, peer)
			fields := [][]byte{wire.Field(1, []byte{2}), wire.Field(2, wire.U16(wire.Protocol)), wire.Field(3, wire.String("native")), wire.Field(4, wire.U32(0))}
			if tc == "matching ack" {
				fields = append(fields, wire.Field(5, bytes.Repeat([]byte{0xaa}, 20)))
			}
			if tc == "stale ack" {
				fields = append(fields, wire.Field(5, bytes.Repeat([]byte{0xbb}, 20)))
			}
			fields = append(fields, wire.Field(6, wire.U16(0)))
			answer(t, peer, wire.Status, fields...)
			require.ErrorIs(t, link.RequireReady("a"), ErrNotReady)
			if tc != "matching ack" {
				require.ErrorIs(t, <-done, ErrNotReady)
				return
			}
			answer(t, peer, wire.InspectConflict, wire.Field(1, wire.U16(0)))
			require.ErrorIs(t, link.RequireReady("a"), ErrNotReady, "inspection alone is not the roster or actual ready observation")
			answer(t, peer, wire.SetRoster)
			fields[0] = wire.Field(1, []byte{3})
			answer(t, peer, wire.Status, fields...)
			require.NoError(t, <-done)
			require.NoError(t, link.RequireReady("a"))
		})
	}
}
