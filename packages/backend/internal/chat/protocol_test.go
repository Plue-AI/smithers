package chat

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestJournalDigestsMatchTypeScriptContract(t *testing.T) {
	body := acceptanceUnsigned{
		Version: 1, RunID: "run", LegID: "leg",
		OwnerHash: strings.Repeat("1", 64), AccessHash: strings.Repeat("2", 64),
		RequestHash: strings.Repeat("3", 64), WriterHash: strings.Repeat("4", 64),
		AcceptedAt: 1727000000123,
	}
	acceptanceHash, err := digest("acceptance", body)
	if err != nil {
		t.Fatal(err)
	}
	if acceptanceHash != "f55ec717b9117c52ca3751519fbcda17b07e57c6fc17b9c94ee6e3a988356e99" {
		t.Fatalf("acceptance hash = %s", acceptanceHash)
	}
	accepted := Acceptance{Version: 1, RunID: "run", LegID: "leg", OwnerHash: body.OwnerHash, AccessHash: body.AccessHash,
		RequestHash: body.RequestHash, WriterHash: body.WriterHash, AcceptedAt: body.AcceptedAt, Hash: acceptanceHash}
	cursor := initialCursor(accepted)
	head, err := headHash(accepted, cursor, 0, false)
	if err != nil || head != "be10ebe0f5805ef526e6cd4a8658a87ececb9757c5393343bca380e022bb5c5d" {
		t.Fatalf("head hash = %s err=%v", head, err)
	}
	batch, _, err := makeBatch(cursor, []json.RawMessage{
		json.RawMessage(`{"runId":"run","type":"delta","kind":"text","text":"hi"}`),
		json.RawMessage(`{"runId":"run","type":"done","reason":"stop"}`),
	})
	if err != nil || batch.Hash != "288648dc254cb62a695f59bc784f6727324218c2c371bfc0cb6f7bfb6985877a" {
		t.Fatalf("batch hash = %s err=%v", batch.Hash, err)
	}
	_, requestCanonical, err := parseCanonical([]byte(`{"runId":"run","messages":[],"instructions":""}`))
	if err != nil || digestCanonical("request", requestCanonical) != "7a9f17c30c70881643bb262d48dd26e45e39de68dc4e9cf728b8cef4b10258cc" {
		t.Fatalf("request digest mismatch: %v", err)
	}
	owner, access, err := authHashes(Scope{UserID: 1, Owner: "alice"}, strings.Repeat("a", 32))
	if err != nil || owner != "ebf25acbd40eb9412afce5ba86b5cec39bff2cebf5116ec4923bf910dce5a818" || access != "abf811afe52fee79b49e00b9205836b190fe209c64c3db1d40527f92947c8901" {
		t.Fatalf("authorization digests = %s %s err=%v", owner, access, err)
	}
}

func TestJournalBatchDigestMatchesTypeScriptForLineSeparators(t *testing.T) {
	cursor := Cursor{
		Version: 1, RunID: "run", LegID: "leg",
		Hash: strings.Repeat("a", 64),
	}
	frame := json.RawMessage(`{"runId":"run","type":"delta","kind":"text","text":"actual:\u2028/\u2029 literal:\\u2028/\\u2029"}`)
	batch, canonicalBytes, err := makeBatch(cursor, []json.RawMessage{frame})
	if err != nil {
		t.Fatal(err)
	}
	if batch.Hash != "ad372cc36489e513fe2f072d19d3d2aaaafb18c2918123816d7059ed864edc43" {
		t.Fatalf("line separator batch hash = %s", batch.Hash)
	}
	if canonicalBytes != 320 {
		t.Fatalf("line separator batch bytes = %d", canonicalBytes)
	}
	if _, err = validateFrames(batch.Frames, "run"); err != nil {
		t.Fatalf("line separator frame rejected: %v", err)
	}
}

func TestEmbeddedSchemaIsProductMigrations(t *testing.T) {
	embedded, err := Schema()
	if err != nil {
		t.Fatal(err)
	}
	first, err := os.ReadFile("../../db/product/migrations/0007_chat_turns.sql")
	if err != nil {
		t.Fatal(err)
	}
	second, err := os.ReadFile("../../db/product/migrations/0013_chat_turn_erasures.sql")
	if err != nil {
		t.Fatal(err)
	}
	third, err := os.ReadFile("../../db/product/migrations/0023_chat_turn_erasure_proofs.sql")
	if err != nil {
		t.Fatal(err)
	}
	files, err := filepath.Glob("../../db/product/migrations/*.sql")
	if err != nil {
		t.Fatal(err)
	}
	var conversationSchema string
	for _, file := range files {
		body, readErr := os.ReadFile(file)
		if readErr != nil {
			t.Fatal(readErr)
		}
		if strings.Contains(string(body), "ALTER TABLE chat_turns ADD COLUMN conversation_id") {
			conversationSchema = strings.Split(string(body), "ALTER TABLE collaborators")[0]
		}
	}
	if conversationSchema == "" {
		t.Fatal("branch conversation migration missing")
	}
	if string(embedded) != string(first)+"\n"+string(second)+"\n"+string(third)+"\n"+conversationSchema {
		t.Fatal("chat integration schema drifted from product migrations")
	}
}

func TestJournalAcceptsCanonicalAgentTurnFrameKinds(t *testing.T) {
	frames := []json.RawMessage{
		json.RawMessage(`{"runId":"run","type":"card","card":{}}`),
		json.RawMessage(`{"runId":"run","type":"card.update","id":"card","patch":{}}`),
		json.RawMessage(`{"runId":"run","type":"link.authored","link":0,"scriptDigest":"digest","script":"script"}`),
		json.RawMessage(`{"runId":"run","type":"call.started","link":0,"ordinal":0,"name":"tool"}`),
		json.RawMessage(`{"runId":"run","type":"call.settled","link":0,"ordinal":0,"name":"tool","verdict":"run"}`),
		json.RawMessage(`{"runId":"run","type":"gate.rejected","link":0,"kind":"denied"}`),
		json.RawMessage(`{"runId":"run","type":"link.ended","link":0,"outcome":"park"}`),
		json.RawMessage(`{"runId":"run","type":"steering.drained","link":0,"count":1}`),
		json.RawMessage(`{"runId":"run","type":"park","code":"approval"}`),
		json.RawMessage(`{"runId":"run","type":"done","reason":"stop"}`),
	}
	meta, err := validateFrames(frames, "run")
	if err != nil || meta.Type != "done" || meta.Reason != "stop" {
		t.Fatalf("canonical frame union: %#v err=%v", meta, err)
	}
}
