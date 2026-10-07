package compose

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
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
		if err := wire.Write(guest, wire.Frame{Kind: wire.Hello, Payload: wire.Union(1, wire.Field(1, wire.U32(0x534d4d44)), wire.Field(2, wire.U16(wire.Protocol)), wire.Field(3, authority.ID[:]), wire.Field(4, nonce))}); err != nil {
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
		if !wire.VerifyHostMAC(authority.Secret[:], wire.Protocol, authority.ID[:], nonce, fields[2]) {
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
	// Verify capture retention on the authenticated link used below by the
	// composed browser document route. A host rewrite wins over replay, while
	// the displaced snapshot remains readable. This does not activate ingest.
	branch := "11111111-1111-4111-8111-111111111111"
	headRef := "refs/smithers/branches/" + branch + "/head"
	git("-C", store, "update-ref", headRef, base)
	captures := machined.GitCaptureObjects{Resolve: func(_ context.Context, id string) (string, error) {
		if id != branch {
			return "", machined.ErrUnauthorized
		}
		return store, nil
	}}
	capture := wire.Captured{Head: head, Tree: git("-C", store, "rev-parse", head+"^{tree}"), Base: base}
	// The production capture writer shares this browser's authenticated link.
	// PostgreSQL and Git are real; only the pending/rebase adapter is a fixture.
	pool := docDatabase(t)
	var user, repository int64
	require.NoError(t, pool.QueryRow(t.Context(), `INSERT INTO users(username,lower_username) VALUES('capture-owner','capture-owner') RETURNING id`).Scan(&user))
	require.NoError(t, pool.QueryRow(t.Context(), `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'capture','capture') RETURNING id`, user).Scan(&repository))
	_, err = pool.Exec(t.Context(), `INSERT INTO workspaces(id,repository_id,user_id,name) VALUES($1,$2,$3,'capture')`, branch, repository, user)
	require.NoError(t, err)
	failProjection := true
	projections := 0
	writer := &machined.CaptureIngest{Objects: captures, Reconcile: func(ctx context.Context, tx pgx.Tx, id string, got wire.Captured, applied bool) error {
		require.Equal(t, branch, id)
		require.Equal(t, capture, got)
		if failProjection {
			return errors.New("projection interrupted")
		}
		projections++
		return nil
	}}
	ingestor := &machined.Ingestor{Pool: pool, Write: writer.Write}
	payload := func(c wire.Captured) []byte {
		h, _ := hex.DecodeString(c.Head)
		tree, _ := hex.DecodeString(c.Tree)
		base, _ := hex.DecodeString(c.Base)
		return wire.Union(2, wire.Field(1, h), wire.Field(2, tree), wire.Field(3, base))
	}
	// Missing objects leave neither a receipt nor a projection, so the same
	// outbox item remains retryable after object transfer.
	missingCapture := capture
	missingCapture.Head = strings.Repeat("ab", 20)
	missingEvent := machined.Event{Seq: 3, EventID: [16]byte{3}, Payload: payload(missingCapture)}
	missingAck, missingErr := ingestor.Commit(t.Context(), link.Connection, branch, missingEvent)
	require.NoError(t, missingErr)
	require.Equal(t, machined.AckMissingObjects, missingAck.Outcome)
	require.Equal(t, []string{missingCapture.Head}, missingAck.OIDs)
	refused := &machined.Ingestor{Pool: pool, Write: (&machined.CaptureIngest{Objects: captures}).Write}
	_, missingErr = refused.Commit(t.Context(), link.Connection, branch, missingEvent)
	require.ErrorIs(t, missingErr, machined.ErrNotReady)
	event := machined.Event{Seq: 1, EventID: [16]byte{1}, Payload: payload(capture)}
	_, err = ingestor.Commit(t.Context(), link.Connection, branch, event)
	require.ErrorContains(t, err, "projection interrupted")
	var count int
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM machine_event_receipts`).Scan(&count))
	require.Zero(t, count)
	require.Equal(t, head, git("-C", store, "rev-parse", headRef))
	failProjection = false
	dispatchCtx, stopDispatch := context.WithCancel(t.Context())
	dispatched := make(chan error, 1)
	go func() { dispatched <- ingestor.Dispatch(dispatchCtx, link, branch) }()
	require.NoError(t, wire.Write(guest, wire.Frame{Kind: wire.Events, Payload: wire.Union(1, wire.Field(1, wire.U64(event.Seq)), wire.Field(2, event.EventID[:]), wire.Field(3, event.Payload))}))
	appliedFrame, err := wire.Read(guest)
	require.NoError(t, err)
	require.Equal(t, wire.Frame{Kind: wire.Events, Payload: wire.Union(3, wire.Field(1, wire.U64(1)), wire.Field(2, []byte{1}))}, appliedFrame)
	t.Cleanup(func() {
		stopDispatch()
		require.ErrorIs(t, <-dispatched, context.Canceled)
	})
	ack, err := ingestor.Commit(t.Context(), link.Connection, branch, event)
	require.NoError(t, err)
	require.Equal(t, machined.AckDuplicate, ack.Outcome)
	require.Equal(t, 1, projections)
	var projectedHead string
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT head_commit_id FROM workspaces WHERE id=$1`, branch).Scan(&projectedHead))
	require.Equal(t, head, projectedHead)
	git("-C", store, "update-ref", headRef, base)
	_, err = pool.Exec(t.Context(), `UPDATE workspaces SET head_commit_id=$2 WHERE id=$1`, branch, base)
	require.NoError(t, err)
	capture.Base = head
	event.Seq = 2
	event.EventID[0] = 2
	event.Payload = payload(capture)
	ack, err = ingestor.Commit(t.Context(), link.Connection, branch, event)
	require.NoError(t, err)
	require.Equal(t, machined.AckStaleBase, ack.Outcome)
	ack, err = ingestor.Commit(t.Context(), link.Connection, branch, event)
	require.NoError(t, err)
	require.Equal(t, machined.AckStaleBase, ack.Outcome)
	require.Equal(t, 2, projections)
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT head_commit_id FROM workspaces WHERE id=$1`, branch).Scan(&projectedHead))
	require.Equal(t, base, projectedHead)
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM machine_event_receipts`).Scan(&count))
	require.Equal(t, 2, count)
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type='branch.captured'`).Scan(&count))
	require.Equal(t, 2, count)
	git("-C", store, "update-ref", "-d", "refs/smithers/branches/"+branch+"/incoming/"+head)
	git("-C", store, "gc", "--prune=now")
	require.Equal(t, base, git("-C", store, "rev-parse", headRef))
	require.Equal(t, "captured bytes", git("-C", store, "show", "refs/smithers/branches/"+branch+"/captures/"+head+":retry.ts"))
	// Pruning activity cannot erase the stale capture's recovery identities.
	_, err = pool.Exec(t.Context(), `DELETE FROM product_job_events WHERE event_type='branch.captured'`)
	require.NoError(t, err)
	var retained []byte
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT capture_payload FROM machine_event_receipts WHERE workspace_id=$1 AND outcome='stale_base'`, branch).Scan(&retained))
	recovered, err := wire.DecodeCaptured(retained)
	require.NoError(t, err)
	require.Equal(t, capture, recovered)
	missing, err := captures.VerifyCapture(t.Context(), branch, recovered)
	require.NoError(t, err)
	require.Empty(t, missing)
	ack, err = ingestor.Commit(t.Context(), link.Connection, branch, event)
	require.NoError(t, err)
	require.Equal(t, machined.AckStaleBase, ack.Outcome)
	require.Equal(t, 2, projections, "replay must not project after activity pruning")
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
	// The current live protocol forwards the opaque authenticated principal,
	// not the legacy mirror label used by the older connection fixture.
	principal := []byte{0x00, 0xff, 0x80, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d}
	require.Equal(t, wire.Union(1, wire.Field(1, wire.Bytes(principal))), fields[2])
	require.NoError(t, wire.Write(guest, wire.Frame{Kind: wire.Control, Payload: wire.Union(2, wire.Field(1, wire.U32(id)), wire.Field(2, wire.Union(13, wire.Field(1, wire.U32(5)))))}))

	// The host mirror first asks the daemon for its persisted state. Complete
	// that sync before expecting a browser snapshot, then accept real native
	// updates and return sequence-bound durability receipts from the fake peer.
	syncRequest, err := wire.Read(guest)
	require.NoError(t, err)
	initial, err := wire.DecodeDocumentV2(syncRequest.Payload)
	require.NoError(t, err)
	require.Equal(t, principal, initial.Actor)
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
