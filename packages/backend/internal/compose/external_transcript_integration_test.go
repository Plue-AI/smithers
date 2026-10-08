package compose

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/stretchr/testify/require"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"testing"
	"time"
)

func TestExternalImportCommitReplay(t *testing.T) {
	fixture := newTranscriptImportFixture(t)
	pool, ctx, ben, repo, branch := fixture.pool, t.Context(), fixture.ben, fixture.repo, fixture.branch
	benCookie, aliceCookie, host, call := fixture.benCookie, fixture.aliceCookie, fixture.host, fixture.call
	store, registry, authority := fixture.store, fixture.registry, fixture.authority
	var err error
	link, peer := externalTranscriptLink(t, registry, branch.ID, authority)
	connection := link.Connection
	participant := [16]byte{1}
	source := [16]byte{2}
	scope := chat.Scope{RepositoryID: repo.ID, UserID: ben.ID, Owner: "ben"}
	sessionBinding := TranscriptBinding{Scope: scope, Session: 1, Participant: participant, Source: source, Profile: "claude-code/2.1.0", Live: true}
	draft := chat.ExternalDraft{ID: "literal-source-offset-0", SourceID: "claude-message-1", Origin: "external", ReadOnly: true, Agent: "claude-code", Profile: "claude-code/2.1.0", Session: "1", Participant: "01000000-0000-0000-0000-000000000000", Owner: fmt.Sprint(ben.ID), Author: "01000000-0000-0000-0000-000000000000", Kind: "assistant", Body: json.RawMessage(`"The answer is 42"`)}
	fail := true
	bindings := map[[16]byte]TranscriptBinding{}
	writer := &TranscriptIngest{Store: store, Resolve: func(_ context.Context, _ pgx.Tx, _ string, session uint32, participant, source [16]byte) (TranscriptBinding, error) {
		if len(bindings) == 0 {
			return sessionBinding, nil
		}
		binding, ok := bindings[source]
		if !ok || binding.Session != session || binding.Participant != participant {
			return TranscriptBinding{}, machined.ErrUnauthorized
		}
		return binding, nil
	}, Normalize: func(context.Context, pgx.Tx, string, TranscriptBinding, wire.Transcript) ([]chat.ExternalDraft, error) {
		return []chat.ExternalDraft{draft}, nil
	}}
	ingestor := &machined.Ingestor{Pool: pool, Write: func(ctx context.Context, tx pgx.Tx, b string, e machined.Event) (machined.Acknowledgement, error) {
		ack, err := writer.Write(ctx, tx, b, e)
		if err == nil && fail {
			return ack, errors.New("fixture failure before commit")
		}
		return ack, err
	}}
	payload, err := wire.EncodeTranscript(wire.Transcript{Version: 1, Session: 1, Participant: participant, Source: source, Profile: "claude-code/2.1.0", Generation: 1, End: 16, Record: `{"type":"user"}`})
	require.NoError(t, err)
	event := machined.Event{Seq: 1, EventID: [16]byte{3}, Payload: payload}
	_, err = ingestor.Commit(ctx, connection, branch.ID, event)
	require.ErrorContains(t, err, "fixture failure before commit")
	var entries, receipts int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM chat_turns`).Scan(&entries))
	require.Zero(t, entries)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM machine_event_receipts`).Scan(&receipts))
	require.Zero(t, receipts)
	fail = false
	// Commit on the authenticated production link while the peer deliberately
	// does not consume its acknowledgment. Closing it then forces outbox replay.
	dispatched := make(chan error, 1)
	go func() { dispatched <- ingestor.Dispatch(ctx, link, branch.ID) }()
	require.NoError(t, wire.Write(peer, transcriptEventFrame(event)))
	require.Eventually(t, func() bool {
		return pool.QueryRow(ctx, `SELECT count(*) FROM machine_event_receipts WHERE outcome='applied'`).Scan(&receipts) == nil && receipts == 1
	}, 3*time.Second, 10*time.Millisecond)
	require.NoError(t, peer.Close())
	require.Error(t, <-dispatched)
	// Lost acknowledgment and a new host/store instance retain the same history.
	store, err = chat.NewStore(pool)
	require.NoError(t, err)
	writer.Store = store
	link, peer = externalTranscriptLink(t, registry, branch.ID, authority)
	connection = link.Connection
	dispatchCtx, stopDispatch := context.WithCancel(ctx)
	dispatched = make(chan error, 1)
	go func() { dispatched <- ingestor.Dispatch(dispatchCtx, link, branch.ID) }()
	t.Cleanup(func() { stopDispatch(); <-dispatched })
	require.NoError(t, wire.Write(peer, transcriptEventFrame(event)))
	ackFrame, err := wire.Read(peer)
	require.NoError(t, err)
	require.Equal(t, wire.Frame{Kind: wire.Events, Payload: wire.Union(3, wire.Field(1, wire.U64(1)), wire.Field(2, []byte{2}))}, ackFrame)
	event.Seq = 2
	event.EventID[0] = 4
	_, err = ingestor.Commit(ctx, connection, branch.ID, event)
	require.NoError(t, err)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM chat_turns`).Scan(&entries))
	require.Equal(t, 1, entries)
	shared := call("GET", "/api/conversations/"+branch.ID, "", benCookie, 200)
	require.Contains(t, shared, `"The answer is 42"`)
	require.Contains(t, shared, `"origin":"external"`)
	require.Contains(t, shared, `"read_only":true`)
	require.Contains(t, shared, `"authorName":"Ben"`)
	require.Contains(t, shared, `"authorLogin":"ben"`)
	require.JSONEq(t, shared, call("GET", "/api/conversations/"+branch.ID, "", aliceCookie, 200))
	var conversation chat.SharedConversation
	require.NoError(t, json.Unmarshal([]byte(shared), &conversation))
	require.Len(t, conversation.Entries, 1)
	require.Positive(t, conversation.Entries[0].Sequence, "the served import retains its durable entry cursor")
	id := conversation.Entries[0].ID
	for _, cookie := range []string{benCookie, aliceCookie} {
		call("PATCH", "/api/conversations/"+branch.ID+"/turns/"+id, `{"prompt":"mutate imported"}`, cookie, 403)
		call("POST", "/api/conversations/"+branch.ID+"/turns/"+id+"/stop", "{}", cookie, 403)
		call("DELETE", "/api/conversations/"+branch.ID+"/turns/"+id, "", cookie, 403)
	}
	select {
	case <-host.started:
		t.Fatal("import launched app-agent turn")
	default:
	}
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM chat_turns WHERE NOT terminal`).Scan(&entries))
	require.Zero(t, entries)
	// Missing or revoked dependencies refuse before normalization or persistence.
	for _, alter := range []func(*TranscriptIngest){func(w *TranscriptIngest) { w.Store = nil }, func(w *TranscriptIngest) { w.Resolve = nil }, func(w *TranscriptIngest) { w.Normalize = nil }} {
		clone := *writer
		alter(&clone)
		ingestor.Write = clone.Write
		event.Seq++
		event.EventID[0]++
		_, err = ingestor.Commit(ctx, connection, branch.ID, event)
		require.ErrorIs(t, err, machined.ErrNotReady)
	}
	ingestor.Write = writer.Write
	sessionBinding.Live = false
	event.Seq++
	event.EventID[0]++
	_, err = ingestor.Commit(ctx, connection, branch.ID, event)
	require.ErrorIs(t, err, machined.ErrUnauthorized)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM machine_event_receipts`).Scan(&receipts))
	require.Equal(t, 2, receipts)
	// A live source pins all identity fields and its adapter release. Forged
	// bindings refuse at authenticated ingestion before the host sees bytes.
	sessionBinding.Live = true
	trusted := sessionBinding
	normalizations := 0
	writer.Normalize = func(context.Context, pgx.Tx, string, TranscriptBinding, wire.Transcript) ([]chat.ExternalDraft, error) {
		normalizations++
		return []chat.ExternalDraft{draft}, nil
	}
	for _, tc := range []struct {
		name  string
		alter func(*TranscriptBinding)
	}{
		{"session", func(b *TranscriptBinding) { b.Session++ }},
		{"participant", func(b *TranscriptBinding) { b.Participant[0]++ }},
		{"source", func(b *TranscriptBinding) { b.Source[0]++ }},
		{"profile", func(b *TranscriptBinding) { b.Profile = "codex/0.134.0" }},
		{"missing-profile", func(b *TranscriptBinding) { b.Profile = "" }},
		{"repository", func(b *TranscriptBinding) { b.Scope.RepositoryID++ }},
	} {
		t.Run("refuse-"+tc.name, func(t *testing.T) {
			sessionBinding = trusted
			tc.alter(&sessionBinding)
			event.Seq++
			event.EventID[0]++
			_, err := ingestor.Commit(ctx, connection, branch.ID, event)
			require.ErrorIs(t, err, machined.ErrUnauthorized)
			require.Zero(t, normalizations)
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM machine_event_receipts`).Scan(&receipts))
			require.Equal(t, 2, receipts)
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM chat_turns`).Scan(&entries))
			require.Equal(t, 1, entries)
			require.JSONEq(t, shared, call("GET", "/api/conversations/"+branch.ID, "", benCookie, 200))
		})
	}
	sessionBinding = trusted
	// Registry revocation can lag database membership changes. The membership
	// fence must refuse even bookkeeping records before adapter normalization.
	for _, tc := range []struct {
		name, revoke, restore string
	}{
		{"suspended", "UPDATE collaborators SET suspended_at=now() WHERE user_id=$1", "UPDATE collaborators SET suspended_at=NULL WHERE user_id=$1"},
		{"disabled", "UPDATE users SET prohibit_login=true WHERE id=$1", "UPDATE users SET prohibit_login=false WHERE id=$1"},
	} {
		t.Run("refuse-"+tc.name, func(t *testing.T) {
			_, err := pool.Exec(ctx, tc.revoke, ben.ID)
			require.NoError(t, err)
			t.Cleanup(func() { _, err := pool.Exec(ctx, tc.restore, ben.ID); require.NoError(t, err) })
			event.Seq++
			event.EventID[0]++
			_, err = ingestor.Commit(ctx, connection, branch.ID, event)
			require.ErrorIs(t, err, chat.ErrForbidden)
			require.Zero(t, normalizations)
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM machine_event_receipts`).Scan(&receipts))
			require.Equal(t, 2, receipts)
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM chat_turns`).Scan(&entries))
			require.Equal(t, 1, entries)
		})
	}
	// Bookkeeping records commit their adapter state even with no visible draft.
	bindingLive := true
	sessionBinding.Live = bindingLive
	adapter := &checkpointTestAdapter{}
	writer.Normalize = nil
	writer.Host = adapter
	sessionBinding.Source = [16]byte{7}
	record := wire.Transcript{Version: 1, Session: 1, Participant: participant, Source: sessionBinding.Source, Profile: "claude-code/2.1.0", Generation: 1, End: 16, Record: `{"type":"user"}`}
	payload, err = wire.EncodeTranscript(record)
	require.NoError(t, err)
	event = machined.Event{Seq: 30, EventID: [16]byte{30}, Payload: payload}
	_, err = ingestor.Commit(ctx, connection, branch.ID, event)
	require.NoError(t, err)
	require.Equal(t, 1, adapter.calls)
	event.Seq++
	event.EventID[0]++
	_, err = ingestor.Commit(ctx, connection, branch.ID, event)
	require.NoError(t, err)
	require.Equal(t, 1, adapter.calls)
	record.Start = 16
	record.End = 32
	payload, err = wire.EncodeTranscript(record)
	require.NoError(t, err)
	event.Payload = payload
	event.Seq++
	event.EventID[0]++
	_, err = ingestor.Commit(ctx, connection, branch.ID, event)
	require.NoError(t, err)
	require.Equal(t, 2, adapter.calls)
	require.JSONEq(t, `{"offset":16,"pending":"","calls":{"tool1":{"name":"read","input":{"path":"a.ts"}}}}`, string(adapter.previous))
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM machine_event_receipts WHERE transcript_checkpoint IS NOT NULL`).Scan(&receipts))
	require.Equal(t, 3, receipts)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM chat_turns`).Scan(&entries))
	require.Equal(t, 1, entries)
	// A changed record at an already committed range never re-normalizes.
	record.Start = 0
	record.End = 16
	record.Record = `{"type":"edit"}`
	payload, err = wire.EncodeTranscript(record)
	require.NoError(t, err)
	event.Payload = payload
	event.Seq++
	event.EventID[0]++
	_, err = ingestor.Commit(ctx, connection, branch.ID, event)
	require.ErrorIs(t, err, chat.ErrConflict)
	require.Equal(t, 2, adapter.calls)

	// Replacement resets adapter state. Once a newer generation commits,
	// delayed old-generation records may replay an existing range, but cannot
	// advance a retired source or resurrect a previously unseen generation.
	record.Generation = 3
	record.Start, record.End = 0, 16
	record.Record = `{"type":"user"}`
	payload, err = wire.EncodeTranscript(record)
	require.NoError(t, err)
	event.Payload = payload
	event.Seq++
	event.EventID[0]++
	_, err = ingestor.Commit(ctx, connection, branch.ID, event)
	require.NoError(t, err)
	require.Equal(t, 3, adapter.calls)
	require.Empty(t, adapter.previous, "replacement must reset adapter state")
	for _, tc := range []struct {
		name                   string
		generation, start, end uint64
	}{
		{"retired-generation-append", 1, 32, 48},
		{"unseen-retired-generation", 2, 0, 16},
	} {
		t.Run(tc.name, func(t *testing.T) {
			record.Generation, record.Start, record.End = tc.generation, tc.start, tc.end
			payload, err = wire.EncodeTranscript(record)
			require.NoError(t, err)
			event.Payload = payload
			event.Seq++
			event.EventID[0]++
			beforeHistory := call("GET", "/api/conversations/"+branch.ID, "", benCookie, 200)
			// Drive the refusal through authenticated daemon transport, not a
			// direct store call. A failed transaction must not acknowledge it.
			retiredLink, retiredPeer := externalTranscriptLink(t, registry, branch.ID, authority)
			done := make(chan error, 1)
			go func() { done <- ingestor.Dispatch(ctx, retiredLink, branch.ID) }()
			require.NoError(t, retiredPeer.SetDeadline(time.Now().Add(3*time.Second)))
			require.NoError(t, wire.Write(retiredPeer, transcriptEventFrame(event)))
			_, err = wire.Read(retiredPeer)
			require.Error(t, err, "retired source received an acknowledgment")
			require.ErrorIs(t, <-done, chat.ErrCursorConflict)
			require.Equal(t, 3, adapter.calls)
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM machine_event_receipts WHERE transcript_checkpoint IS NOT NULL`).Scan(&receipts))
			require.Equal(t, 4, receipts)
			require.JSONEq(t, beforeHistory, call("GET", "/api/conversations/"+branch.ID, "", aliceCookie, 200))
		})
	}
	link, peer = externalTranscriptLink(t, registry, branch.ID, authority)
	connection = link.Connection
	// Lost acknowledgments of already committed old records remain replayable.
	record.Generation, record.Start, record.End = 1, 0, 16
	payload, err = wire.EncodeTranscript(record)
	require.NoError(t, err)
	event.Payload = payload
	event.Seq++
	event.EventID[0]++
	_, err = ingestor.Commit(ctx, connection, branch.ID, event)
	require.NoError(t, err)
	require.Equal(t, 3, adapter.calls)
	// Current generation continues from its own checkpoint after old replay.
	record.Generation, record.Start, record.End = 3, 16, 32
	payload, err = wire.EncodeTranscript(record)
	require.NoError(t, err)
	event.Payload = payload
	event.Seq++
	event.EventID[0]++
	_, err = ingestor.Commit(ctx, connection, branch.ID, event)
	require.NoError(t, err)
	require.Equal(t, 4, adapter.calls)
	require.JSONEq(t, `{"offset":16,"pending":"","calls":{"tool1":{"name":"read","input":{"path":"a.ts"}}}}`, string(adapter.previous))

	// Invoke the actual install-shipped TS adapters over the same bearer boundary
	// as production. Only discovery/registration remains a test provider until
	// the privileged registry contract and reference-host qualification exist.
	writer.Host = packagedTranscriptHost(t)
	fixtures := []struct {
		directory, file, profile string
		count                    int
	}{
		{"codex-0.160", "rollout.jsonl", "codex-rollout/0.160", 34},
		{"claude-code-2.1", "session.jsonl", "claude-code/2.1", 36},
	}
	type liveFixture struct {
		binding TranscriptBinding
		lines   []string
		offset  uint64
	}
	live := make([]liveFixture, len(fixtures))
	for index, fixture := range fixtures {
		_, sourceFile, _, ok := goruntime.Caller(0)
		require.True(t, ok)
		root := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../.."))
		data, err := os.ReadFile(filepath.Join(root, "packages/smithers/agent/harness/test/fixtures/external", fixture.directory, fixture.file))
		require.NoError(t, err)
		sessionBinding.Source = [16]byte{byte(8 + index)}
		sessionBinding.Participant = [16]byte{byte(3 + index)}
		sessionBinding.Profile = fixture.profile
		bindings[sessionBinding.Source] = sessionBinding
		live[index] = liveFixture{binding: sessionBinding, lines: strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")}
	}
	// Both agent processes share terminal session 1. Interleave records and
	// replay every range while retaining independent parser/tool-call state.
	for lineIndex := 0; ; lineIndex++ {
		progressed := false
		for index := range live {
			fixture := &live[index]
			if lineIndex >= len(fixture.lines) {
				continue
			}
			progressed = true
			line := fixture.lines[lineIndex]
			end := fixture.offset + uint64(len(line)) + 1
			record := wire.Transcript{Version: 1, Session: 1, Participant: fixture.binding.Participant, Source: fixture.binding.Source, Profile: fixture.binding.Profile, Generation: 1, Start: fixture.offset, End: end, Record: line}
			payload, err := wire.EncodeTranscript(record)
			require.NoError(t, err)
			event.Seq++
			event.EventID = [16]byte{byte(event.Seq), byte(event.Seq >> 8), 9}
			event.Payload = payload
			_, err = ingestor.Commit(ctx, connection, branch.ID, event)
			require.NoError(t, err)
			event.EventID[15] = 1
			_, err = ingestor.Commit(ctx, connection, branch.ID, event)
			require.NoError(t, err)
			fixture.offset = end
		}
		if !progressed {
			break
		}
	}
	for _, fixture := range fixtures {
		var imported int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM chat_turns WHERE request_payload->'external'->>'source_format_version'=$1`, fixture.profile).Scan(&imported))
		require.Equal(t, fixture.count, imported)
	}
	for _, cookie := range []string{benCookie, aliceCookie} {
		history := call("GET", "/api/conversations/"+branch.ID, "", cookie, 200)
		require.Contains(t, history, "How do I use ultrafast")
		require.Contains(t, history, "exec-72424bde-7b89-43fe-9962-8fe21e4a3d4b")
		require.Contains(t, history, "toolu_01JD3dL8cHy7FW7iBubC6yjY")
		// The recorded encrypted message body is one read-only line at its
		// source record; neither its ciphertext nor its header is imported.
		require.Equal(t, 1, strings.Count(history, `"text":"Encrypted by Codex"`))
		require.Contains(t, history, `"source_id":"01a10d62-91c7-7163-b038-72dab55a2e8c:98"`)
		require.NotContains(t, history, "gAAAAABqw_FYg6K7")
		require.NotContains(t, history, "Message Type: MESSAGE")
		require.Contains(t, history, `"participant_id":"03000000-0000-0000-0000-000000000000"`)
		require.Contains(t, history, `"participant_id":"04000000-0000-0000-0000-000000000000"`)
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM chat_turns WHERE NOT terminal`).Scan(&entries))
		require.Zero(t, entries)
		require.Contains(t, history, `"read_only":true`)
		_, sourceFile, _, ok := goruntime.Caller(0)
		require.True(t, ok)
		root := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../.."))
		// Decode the actual authenticated HTTP response with the app's existing
		// seam; no fake message projection is injected at this boundary.
		bun, err := exec.LookPath("bun")
		require.NoError(t, err)
		check := exec.CommandContext(t.Context(), bun, "-e", `import { SharedConversationSchema } from "./apps/app/src/mainview/state/seams/SharedConversationSeam.ts"; const conversation = SharedConversationSchema.parse(JSON.parse(await Bun.stdin.text())); if (conversation.entries.length !== 71) throw new Error("lost imported history"); for (const row of conversation.entries) { if (!Number.isSafeInteger(row.sequence) || row.sequence <= 0 || row.origin !== "external" || row.read_only !== true || row.turnId !== undefined || row.runId !== undefined) throw new Error("executable imported history"); }`)
		check.Dir = root
		check.Stdin = strings.NewReader(history)
		output, err := check.CombinedOutput()
		require.NoError(t, err, string(output))
	}
}

func packagedTranscriptHost(t *testing.T) *chat.HTTPChatHost {
	t.Helper()
	node, err := exec.LookPath("node")
	require.NoError(t, err)
	_, source, _, ok := goruntime.Caller(0)
	require.True(t, ok)
	root := filepath.Clean(filepath.Join(filepath.Dir(source), "../../../.."))
	bundle := filepath.Join(t.TempDir(), "transcript-host.mjs")
	build := exec.CommandContext(t.Context(), node, filepath.Join(root, "apps/model-host/build.mjs"), bundle)
	build.Dir = root
	output, err := build.CombinedOutput()
	require.NoError(t, err, string(output))
	ctx, cancel := context.WithCancel(t.Context())
	command := exec.CommandContext(ctx, node, bundle, "serve", "--port", "0")
	for _, value := range os.Environ() {
		if !strings.HasPrefix(value, "SMITHERS_") {
			command.Env = append(command.Env, value)
		}
	}
	command.Env = append(command.Env, "SMITHERS_CHAT_HOST_TOKEN=transcript-integration", "SMITHERS_CHAT_CALLBACK_URL=http://127.0.0.1:9", "SMITHERS_CHAT_MODEL={}")
	stdout, err := command.StdoutPipe()
	require.NoError(t, err)
	require.NoError(t, command.Start())
	t.Cleanup(func() { cancel(); _ = command.Wait() })
	var ready struct {
		Port int `json:"port"`
	}
	require.NoError(t, json.NewDecoder(stdout).Decode(&ready))
	require.Positive(t, ready.Port)
	host, err := chat.NewHTTPChatHost(fmt.Sprintf("http://127.0.0.1:%d", ready.Port), &http.Client{Timeout: 5 * time.Second}, "transcript-integration")
	require.NoError(t, err)
	return host
}

// Test-only adapter provider. Packaged HTTP tests exercise the real TS decoder;
// this provider isolates the receipt transaction from parser semantics.
type checkpointTestAdapter struct {
	calls    int
	previous json.RawMessage
}

// Only the remote daemon is scripted: host authentication, framing, admission,
// dispatch, receipt transaction and the browser history routes are production.
func externalTranscriptLink(t *testing.T, registry *machined.Registry, branch string, authority machined.BootAuthority) (*machined.Link, net.Conn) {
	t.Helper()
	host, peer := net.Pipe()
	t.Cleanup(func() { _ = host.Close(); _ = peer.Close() })
	done := make(chan error, 1)
	go func() {
		done <- func() error {
			nonce := make([]byte, 32)
			nonce[0] = 71
			if err := wire.Write(peer, wire.Frame{Kind: wire.Hello, Payload: wire.Union(1, wire.Field(1, wire.U32(0x534d4d44)), wire.Field(2, wire.U16(wire.Protocol)), wire.Field(3, authority.ID[:]), wire.Field(4, nonce))}); err != nil {
				return err
			}
			proof, err := wire.Read(peer)
			if err != nil {
				return err
			}
			if proof.Kind != wire.Hello || len(proof.Payload) == 0 || proof.Payload[0] != 2 {
				return wire.HandshakeOrder
			}
			fields, err := wire.Fields("proof", proof.Payload[1:])
			if err != nil {
				return err
			}
			if !wire.VerifyHostMAC(authority.Secret[:], wire.Protocol, authority.ID[:], nonce, fields[2]) {
				return wire.AuthFailed
			}
			if err = wire.Write(peer, wire.Frame{Kind: wire.Hello, Payload: wire.Union(3, wire.Field(1, wire.Bytes([]byte(authority.Credential))), wire.Field(2, make([]byte, 16)), wire.Field(3, wire.U64(1)), wire.Field(4, wire.U16(0)))}); err != nil {
				return err
			}
			welcome, err := wire.Read(peer)
			if err != nil {
				return err
			}
			if welcome.Kind != wire.Hello || len(welcome.Payload) == 0 || welcome.Payload[0] != 4 {
				return wire.HandshakeOrder
			}
			return nil
		}()
	}()
	link, err := registry.Connect(t.Context(), branch, host)
	require.NoError(t, err)
	require.NoError(t, <-done)
	t.Cleanup(func() { _ = link.Close() })
	return link, peer
}

func transcriptEventFrame(event machined.Event) wire.Frame {
	return wire.Frame{Kind: wire.Events, Payload: wire.Union(1, wire.Field(1, wire.U64(event.Seq)), wire.Field(2, event.EventID[:]), wire.Field(3, event.Payload))}
}

func TestExternalImportUnavailable(t *testing.T) {
	_, _, pool := splitProcessDatabase(t)
	ctx, q := t.Context(), db.New(pool)
	user, err := q.CreateUser(ctx, db.CreateUserParams{Username: "import-owner", LowerUsername: "import-owner"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: user.ID, Valid: true}, Name: "import", LowerName: "import", DefaultBookmark: "main"})
	require.NoError(t, err)
	branch, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: user.ID, Name: "import", TargetBookmark: "feature", Kind: "vm", Status: "stopped"})
	require.NoError(t, err)
	store, err := chat.NewStore(pool)
	require.NoError(t, err)
	registry := new(machined.Registry)
	authority, err := registry.MintBoot(branch.ID, "vm-import")
	require.NoError(t, err)
	payload, err := wire.EncodeTranscript(wire.Transcript{Version: 1, Session: 1, Participant: [16]byte{1}, Source: [16]byte{2}, Profile: "claude-code/2.1.0", Generation: 1, End: 16, Record: `{"type":"user"}`})
	require.NoError(t, err)
	for _, missing := range []string{"store", "registry", "adapter", "receipt-store", "writer"} {
		t.Run(missing, func(t *testing.T) {
			adapter := &checkpointTestAdapter{}
			writer := &TranscriptIngest{Store: store, Host: adapter, Resolve: func(context.Context, pgx.Tx, string, uint32, [16]byte, [16]byte) (TranscriptBinding, error) {
				t.Fatal("unavailable ingress reached registry resolution")
				return TranscriptBinding{}, machined.ErrNotReady
			}}
			switch missing {
			case "store":
				writer.Store = nil
			case "registry":
				writer.Resolve = nil
			case "adapter":
				writer.Host = nil
			}
			ingestor := &machined.Ingestor{Pool: pool, Write: writer.Write}
			if missing == "receipt-store" {
				ingestor.Pool = nil
			}
			if missing == "writer" {
				ingestor.Write = nil
			}
			link, peer := externalTranscriptLink(t, registry, branch.ID, authority)
			done := make(chan error, 1)
			go func() { done <- ingestor.Dispatch(t.Context(), link, branch.ID) }()
			require.NoError(t, peer.SetDeadline(time.Now().Add(3*time.Second)))
			// An absent ingress itself may close the lease before reading a frame.
			_ = wire.Write(peer, transcriptEventFrame(machined.Event{Seq: 1, EventID: [16]byte{3}, Payload: payload}))
			_, err := wire.Read(peer)
			require.Error(t, err, "unavailable import was acknowledged")
			require.ErrorIs(t, <-done, machined.ErrNotReady)
			require.Zero(t, adapter.calls)
			var receipts, entries int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM machine_event_receipts`).Scan(&receipts))
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM chat_turns`).Scan(&entries))
			require.Zero(t, receipts)
			require.Zero(t, entries)
		})
	}
	t.Run("composed-install-pump", func(t *testing.T) {
		// Use exactly the event consumer mounted by install main.go. An
		// authenticated transcript must refuse before receipt preparation while
		// discovery/reader/source providers are absent, including after replay.
		registry := new(machined.Registry)
		authority, err := registry.MintBoot(branch.ID, "vm-import-pump")
		require.NoError(t, err)
		host := repohost.NewLocalClient(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
			t.Error("unavailable transcript reached repository host")
		}), "transcript-unavailable")
		stop, err := bindMachineEvents(t.Context(), registry, pool, host, nil, nil)
		require.NoError(t, err)
		t.Cleanup(stop)
		event := machined.Event{Seq: 1, EventID: [16]byte{13}, Payload: payload}
		for attempt := 0; attempt < 2; attempt++ {
			link, peer := externalTranscriptLink(t, registry, branch.ID, authority)
			require.NoError(t, peer.SetDeadline(time.Now().Add(3*time.Second)))
			require.NoError(t, wire.Write(peer, transcriptEventFrame(event)))
			_, err = wire.Read(peer)
			require.Error(t, err, "uncomposed transcript was acknowledged")
			select {
			case <-link.Done():
			case <-time.After(3 * time.Second):
				t.Fatal("install consumer did not close refused transcript link")
			}
			var receipts, entries int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM machine_event_receipts`).Scan(&receipts))
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM chat_turns`).Scan(&entries))
			require.Zero(t, receipts)
			require.Zero(t, entries)
		}
	})

}

func (a *checkpointTestAdapter) NormalizeExternalTranscript(_ context.Context, input chat.ExternalNormalizeInput) (chat.ExternalNormalized, error) {
	a.calls++
	a.previous = append(json.RawMessage(nil), input.State...)
	state := json.RawMessage(fmt.Sprintf(`{"offset":%d,"pending":"","calls":{"tool1":{"name":"read","input":{"path":"a.ts"}}}}`, input.End))
	return chat.ExternalNormalized{Entries: []chat.ExternalDraft{}, State: state}, nil
}
