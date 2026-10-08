package compose

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	goruntime "runtime"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

// browserSeed is the recorded response the app-tier C-AGT-01 test serves in
// place of an install. This test keeps it equal to what the import pipeline
// answers for the recorded captures. The check that reads a real composed
// install is TestExternalTranscriptBrowserPostgres.
const browserSeed = "apps/app/src/mainview/state/testdata/external-recorded-conversation.json"

// The conversation a signed-in member reads after the install imports the
// recorded Codex and Claude Code captures, and one source of a release the
// adapters do not read, is the committed browser seed (C-AGT-01).
//
// Run with SMITHERS_UPDATE_BROWSER_SEED=1 to record the file again after a
// deliberate change to the adapters or the message contract, and review its
// diff. Without it this test only compares; it never writes.
func TestExternalImportIsTheRecordedBrowserConversation(t *testing.T) {
	fixture := newTranscriptImportFixture(t)
	pool, ctx, branch := fixture.pool, t.Context(), fixture.branch.ID
	scope := chat.Scope{RepositoryID: fixture.repo.ID, UserID: fixture.ben.ID, Owner: "ben"}
	writer := &TranscriptIngest{Store: fixture.store, Host: packagedTranscriptHost(t), Resolve: func(_ context.Context, _ pgx.Tx, _ string, record wire.Transcript) (TranscriptBinding, error) {
		return TranscriptBinding{Scope: scope, Session: record.Session, Participant: record.Participant, Source: record.Source, Profile: record.Profile, Live: true}, nil
	}}
	ingestor := &machined.Ingestor{Pool: pool, Write: writer.Write}
	link, _ := externalTranscriptLink(t, fixture.registry, branch, fixture.authority)
	var seq uint64
	// Each capture is one agent process in Ben's terminal session.
	for index, capture := range []struct {
		directory, file, profile string
		records                  []string
		last                     machined.AckOutcome
	}{
		{directory: "codex-0.160", file: "rollout.jsonl", profile: "codex-rollout/0.160", last: machined.AckApplied},
		{directory: "claude-code-2.1", file: "session.jsonl", profile: "claude-code/2.1", last: machined.AckApplied},
		{directory: "codex-machine-0.160", file: "rollout.jsonl", profile: "codex-rollout/0.160", last: machined.AckApplied},
		// A Codex release line the adapters do not read: the import stops at its first record.
		{profile: "codex-rollout/0.160", last: machined.AckRejected, records: []string{
			`{"timestamp":"2026-10-08T05:06:10.615Z","type":"session_meta","payload":{"id":"01a119e7-0000-7000-8000-000000000161","cwd":"/workspace","cli_version":"0.161.0"}}`,
		}},
	} {
		records := capture.records
		if records == nil {
			records = recordedTranscript(t, capture.directory, capture.file)
		}
		participant, source := [16]byte{0xb0, byte(index + 1)}, [16]byte{0xc0, byte(index + 1)}
		var offset uint64
		for line, record := range records {
			end := offset + uint64(len(record)) + 1
			payload, err := wire.EncodeTranscript(wire.Transcript{Version: 1, Session: 1, Participant: participant, Source: source, Profile: capture.profile, Generation: 1, Start: offset, End: end, Record: record})
			require.NoError(t, err)
			seq++
			ack, err := ingestor.Commit(ctx, link.Connection, branch, machined.Event{Seq: seq, EventID: [16]byte(uuid.New()), Payload: payload})
			require.NoError(t, err, "%s line %d", capture.directory, line+1)
			expected := machined.AckApplied
			if line == len(records)-1 {
				expected = capture.last
			}
			require.Equal(t, expected, ack.Outcome, "%s line %d", capture.directory, line+1)
			offset = end
		}
	}

	var conversation struct {
		ID      string           `json:"id"`
		Entries []map[string]any `json:"entries"`
	}
	raw := fixture.call("GET", "/api/conversations/"+branch, "", fixture.benCookie, 200)
	require.NoError(t, json.Unmarshal([]byte(raw), &conversation))
	require.JSONEq(t, raw, fixture.call("GET", "/api/conversations/"+branch, "", fixture.aliceCookie, 200), "both members read the same conversation")
	require.Len(t, conversation.Entries, 34+36+12+1)
	// Three values are this run's own and say nothing about the import: the
	// branch, each entry's journal id (a hash of the repository and branch) and
	// the commit time of the one entry whose record carries no time. The seed
	// names them plainly instead.
	conversation.ID = "main"
	for index, entry := range conversation.Entries {
		require.Equal(t, "external", entry["origin"])
		require.Equal(t, true, entry["read_only"])
		entry["id"] = fmt.Sprintf("imported-%03d", index+1)
		if entry["text"] == "This session transcript version is not supported." {
			entry["createdAt"] = float64(1791435970616)
		}
		actor := entry["actor"].(map[string]any)
		if member, ok := actor["for_member"].(map[string]any); ok {
			require.Equal(t, "ben", member["login"])
		} else {
			require.Equal(t, "ben", actor["login"])
		}
	}
	current, err := json.MarshalIndent(conversation, "", "  ")
	require.NoError(t, err)
	current = append(bytes.ReplaceAll(current, []byte(`<`), []byte("<")), '\n')
	current = bytes.ReplaceAll(bytes.ReplaceAll(current, []byte(`>`), []byte(">")), []byte(`&`), []byte("&"))

	_, source, _, ok := goruntime.Caller(0)
	require.True(t, ok)
	path := filepath.Join(filepath.Dir(source), "../../../..", browserSeed)
	if os.Getenv("SMITHERS_UPDATE_BROWSER_SEED") == "1" {
		require.NoError(t, os.WriteFile(path, current, 0o644))
		t.Logf("recorded %s (%d entries)", browserSeed, len(conversation.Entries))
		return
	}
	committed, err := os.ReadFile(path)
	require.NoError(t, err, "record the seed with SMITHERS_UPDATE_BROWSER_SEED=1")
	require.JSONEq(t, string(committed), string(current), "the install's conversation for the recorded captures no longer matches %s", browserSeed)
}
