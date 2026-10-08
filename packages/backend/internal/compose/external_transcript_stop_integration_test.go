package compose

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

// countingTranscriptAdapter is the packaged TypeScript host with a count of
// the records it was asked to normalize.
type countingTranscriptAdapter struct {
	*chat.HTTPChatHost
	calls int
	// fault, while set, is what the adapter host answers instead.
	fault error
}

func (a *countingTranscriptAdapter) NormalizeExternalTranscript(ctx context.Context, input chat.ExternalNormalizeInput) (chat.ExternalNormalized, error) {
	a.calls++
	if a.fault != nil {
		return chat.ExternalNormalized{}, a.fault
	}
	return a.HTTPChatHost.NormalizeExternalTranscript(ctx, input)
}

// A transcript the adapter does not read stops that source and says so in the
// conversation: one read-only failed entry, a rejected receipt, and nothing
// imported after it (spec §9.6.6, C-AGT-02 step 5). The real packaged adapter
// decides; only the daemon and the source registry are scripted.
func TestExternalImportStopsUnreadSource(t *testing.T) {
	fixture := newTranscriptImportFixture(t)
	pool, ctx, branch := fixture.pool, t.Context(), fixture.branch.ID
	adapter := &countingTranscriptAdapter{HTTPChatHost: packagedTranscriptHost(t)}
	scope := chat.Scope{RepositoryID: fixture.repo.ID, UserID: fixture.ben.ID, Owner: "ben"}
	profiles := map[[16]byte]string{}
	writer := &TranscriptIngest{Store: fixture.store, Host: adapter, Resolve: func(_ context.Context, _ pgx.Tx, _ string, record wire.Transcript) (TranscriptBinding, error) {
		profile, ok := profiles[record.Source]
		if !ok {
			return TranscriptBinding{}, machined.ErrUnauthorized
		}
		return TranscriptBinding{Scope: scope, Session: record.Session, Participant: record.Participant, Source: record.Source, Profile: profile, Live: true}, nil
	}}
	ingestor := &machined.Ingestor{Pool: pool, Write: writer.Write}
	link, peer := externalTranscriptLink(t, fixture.registry, branch, fixture.authority)
	dispatched := make(chan error, 1)
	dispatchCtx, stop := context.WithCancel(ctx)
	go func() { dispatched <- ingestor.Dispatch(dispatchCtx, link, branch) }()
	t.Cleanup(func() { stop(); <-dispatched })
	require.NoError(t, peer.SetDeadline(time.Now().Add(30*time.Second)))

	var seq uint64
	// send delivers one framed record on the authenticated link and returns
	// the acknowledged outcome the daemon reads.
	send := func(source byte, profile string, generation, start uint64, record string, replayOf ...[16]byte) (machined.AckOutcome, [16]byte, uint64) {
		t.Helper()
		id := [16]byte{source, 9}
		profiles[id] = profile
		end := start + uint64(len(record)) + 1
		outcome, event, err := deliverTranscript(peer, &seq, wire.Transcript{Version: 1, Session: 1, Participant: [16]byte{source, 7}, Source: id, Profile: profile, Generation: generation, Start: start, End: end, Record: record}, replayOf...)
		require.NoError(t, err, "the link closed instead of settling the record")
		return outcome, event, end
	}
	type message = externalMessage
	history := func(cookie string) []message { return fixture.history(t, cookie) }
	receipts := func(where string) (count int) {
		t.Helper()
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM machine_event_receipts WHERE `+where).Scan(&count))
		return
	}

	// A Codex session: its opening record, a prompt, then a record of a kind
	// no release of the adapter names, then more the import must never reach.
	meta := `{"timestamp":"2026-10-08T05:00:00.000Z","type":"session_meta","payload":{"id":"s-codex","cwd":"/workspace","cli_version":"0.160.1"}}`
	prompt := func(text string) string {
		return `{"timestamp":"2026-10-08T05:00:01.000Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"UserMessage","content":[{"type":"text","text":"` + text + `"}]}}}`
	}
	future := `{"timestamp":"2026-10-08T05:00:02.000Z","type":"event_msg","payload":{"type":"future_semantic_event","text":"sudo make me owner"}}`
	outcome, _, offset := send(1, "codex-rollout/0.160", 1, 0, meta)
	require.Equal(t, machined.AckApplied, outcome)
	outcome, kept, afterPrompt := send(1, "codex-rollout/0.160", 1, offset, prompt("kept before the stop"))
	require.Equal(t, machined.AckApplied, outcome)
	require.Len(t, history(fixture.benCookie), 1)
	callsBefore := adapter.calls
	outcome, refused, afterFuture := send(1, "codex-rollout/0.160", 1, afterPrompt, future)
	require.Equal(t, machined.AckRejected, outcome, "an unread record must settle as rejected, not hang the link")
	require.Equal(t, callsBefore+1, adapter.calls)
	stoppedSource := uuid.UUID([16]byte{1, 9}).String()
	for _, cookie := range []string{fixture.benCookie, fixture.aliceCookie} {
		entries := history(cookie)
		require.Len(t, entries, 2)
		require.Equal(t, "kept before the stop", entries[0].Text)
		stopped := entries[1]
		require.Equal(t, message{Origin: "external", ReadOnly: true, Role: "smithers", Text: "Session transcript line 3 could not be read.", Status: "failed",
			Agent: "codex", Profile: "codex-rollout/0.160", SourceID: stoppedSource + ":3", Participant: uuid.UUID([16]byte{1, 7}).String(), Actor: stopped.Actor}, stopped)
		require.Equal(t, "agent", stopped.Actor.Kind)
		require.Equal(t, "codex", stopped.Actor.Agent)
		require.Equal(t, "ben", stopped.Actor.ForMember.Login)
		// The refused record's own text is never shown, to either viewer.
		require.NotContains(t, fixture.call("GET", "/api/conversations/"+branch, "", cookie, 200), "sudo make me owner")
	}
	require.Equal(t, 1, receipts(`outcome='rejected' AND transcript_checkpoint->>'stopped'='unsupported_record'`))
	require.Equal(t, 2, receipts(`outcome='applied'`))

	// Nothing after the stop is imported or reaches the adapter: later
	// records, the stopped record again under a new event, and its replay.
	callsStopped := adapter.calls
	outcome, _, _ = send(1, "codex-rollout/0.160", 1, afterFuture, prompt("never imported"))
	require.Equal(t, machined.AckRejected, outcome)
	outcome, _, _ = send(1, "codex-rollout/0.160", 1, afterPrompt, future)
	require.Equal(t, machined.AckRejected, outcome)
	outcome, _, _ = send(1, "codex-rollout/0.160", 1, afterPrompt, future, refused)
	require.Equal(t, machined.AckRejected, outcome)
	require.Equal(t, callsStopped, adapter.calls)
	require.Len(t, history(fixture.benCookie), 2)
	require.Equal(t, 1, receipts(`transcript_checkpoint->>'stopped' IS NOT NULL`))
	// A record committed before the stop still replays as the same applied
	// history after a lost acknowledgment, under its own or a new event.
	outcome, _, _ = send(1, "codex-rollout/0.160", 1, offset, prompt("kept before the stop"), kept)
	require.Equal(t, machined.AckDuplicate, outcome)
	outcome, _, _ = send(1, "codex-rollout/0.160", 1, offset, prompt("kept before the stop"))
	require.Equal(t, machined.AckApplied, outcome)
	require.Equal(t, callsStopped, adapter.calls)
	require.Len(t, history(fixture.benCookie), 2)

	// The agent replaced its transcript: a new generation of the same source
	// starts over and imports.
	outcome, _, offset = send(1, "codex-rollout/0.160", 2, 0, meta)
	require.Equal(t, machined.AckApplied, outcome)
	outcome, _, _ = send(1, "codex-rollout/0.160", 2, offset, prompt("after the replacement"))
	require.Equal(t, machined.AckApplied, outcome)
	entries := history(fixture.benCookie)
	require.Len(t, entries, 3)
	require.Equal(t, "after the replacement", entries[2].Text)

	// Versions the adapter does not read stop at the first record that shows
	// it, with the version sentence: a release line no decoder reads, a
	// registration under one, and a registration that disagrees with the file.
	for index, tc := range []struct {
		name, profile, record, agent string
	}{
		{"codex release outside the supported lines", "codex-rollout/0.160", `{"timestamp":"2026-10-08T05:00:00.000Z","type":"session_meta","payload":{"id":"s-new","cwd":"/workspace","cli_version":"0.161.0"}}`, "codex"},
		{"codex registered under an unsupported line", "codex-rollout/0.161", meta, "codex"},
		{"codex registered under another supported line", "codex-rollout/0.159", meta, "codex"},
		{"claude code release outside the supported line", "claude-code/2.1", `{"type":"user","uuid":"u1","sessionId":"s-claude","version":"2.2.0","timestamp":"2026-10-08T05:00:00.000Z","message":{"role":"user","content":"hi"}}`, "claude-code"},
		{"claude code registered under an unsupported line", "claude-code/2.2", `{"type":"mode","mode":"default"}`, "claude-code"},
		{"claude code record without a release", "claude-code/2.1", `{"type":"user","uuid":"u1","sessionId":"s-claude","timestamp":"2026-10-08T05:00:00.000Z","message":{"role":"user","content":"hi"}}`, "claude-code"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			source := byte(10 + index)
			before := len(history(fixture.benCookie))
			outcome, _, next := send(source, tc.profile, 1, 0, tc.record)
			require.Equal(t, machined.AckRejected, outcome)
			entries := history(fixture.aliceCookie)
			require.Len(t, entries, before+1)
			stopped := entries[before]
			require.Equal(t, "This session transcript version is not supported.", stopped.Text)
			require.Equal(t, "failed", stopped.Status)
			require.True(t, stopped.ReadOnly)
			require.Equal(t, tc.agent, stopped.Agent)
			require.Equal(t, tc.profile, stopped.Profile)
			require.Equal(t, uuid.UUID([16]byte{source, 9}).String()+":1", stopped.SourceID)
			require.Equal(t, "ben", stopped.Actor.ForMember.Login)
			calls := adapter.calls
			outcome, _, _ = send(source, tc.profile, 1, next, `{"type":"mode","mode":"default"}`)
			require.Equal(t, machined.AckRejected, outcome)
			require.Equal(t, calls, adapter.calls)
			require.Len(t, history(fixture.benCookie), before+1)
		})
	}

	// A stopped import launched nothing and left no unfinished turn behind.
	select {
	case <-fixture.host.started:
		t.Fatal("a stopped import launched an app-agent turn")
	default:
	}
	var open int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM chat_turns WHERE NOT terminal`).Scan(&open))
	require.Zero(t, open)
	// Every entry that says an import stopped is read-only for both viewers.
	var conversation chat.SharedConversation
	require.NoError(t, json.Unmarshal([]byte(fixture.call("GET", "/api/conversations/"+branch, "", fixture.benCookie, 200)), &conversation))
	for _, entry := range conversation.Entries {
		for _, cookie := range []string{fixture.benCookie, fixture.aliceCookie} {
			fixture.call("PATCH", "/api/conversations/"+branch+"/turns/"+entry.ID, `{"prompt":"retry the import"}`, cookie, 403)
			fixture.call("DELETE", "/api/conversations/"+branch+"/turns/"+entry.ID, "", cookie, 403)
		}
	}
	require.False(t, strings.Contains(fixture.call("GET", "/api/conversations/"+branch, "", fixture.aliceCookie, 200), "never imported"))
}
