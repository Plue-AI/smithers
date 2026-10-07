package chat

import (
	"encoding/json"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestExternalProjectionReadOnlyMessageContract(t *testing.T) {
	owner := db.User{ID: 42, Username: "ben", DisplayName: "Ben", AvatarUrl: "https://example.test/ben.png"}
	draft := ExternalDraft{ID: "source", SourceID: "transcript:4", Origin: "external", ReadOnly: true, Agent: "codex", Profile: "codex/0.160.0", Session: "9", Participant: "agent-codex", Owner: "42", Author: "agent-codex", Kind: "assistant", Body: json.RawMessage(`"A complete answer"`), At: 1234}
	for _, kind := range []string{"prompt", "assistant", "thinking", "attachment", "tool_request", "tool_result", "edit", "error"} {
		t.Run(kind, func(t *testing.T) {
			current := draft
			current.Kind = kind
			if kind == "prompt" {
				current.Author = "42"
			}
			row := SharedTurn{ExternalDraft: &current, ID: "journal-id", RunID: "private-run", Frames: []json.RawMessage{json.RawMessage(`{"private":"sentinel"}`)}, externalActor: externalActor(owner, current, 2), externalAt: 2000, externalOrdinal: 4}
			encoded, err := json.Marshal(row)
			require.NoError(t, err)
			var message map[string]any
			require.NoError(t, json.Unmarshal(encoded, &message))
			require.Equal(t, "journal-id", message["id"])
			require.Equal(t, "external", message["origin"])
			require.Equal(t, true, message["read_only"])
			require.Equal(t, "codex", message["agent_kind"])
			require.Equal(t, "codex/0.160.0", message["format_version"])
			require.Equal(t, "transcript:4", message["source_id"])
			require.Equal(t, float64(1234), message["createdAt"])
			require.Equal(t, float64(4), message["ordinal"])
			for _, key := range []string{"runId", "turnId", "frames", "action", "answeredAction", "disclosed", "author", "request_payload"} {
				require.NotContains(t, message, key)
			}
			require.NotContains(t, string(encoded), "private-run")
			require.NotContains(t, string(encoded), "sentinel")
			actor := message["actor"].(map[string]any)
			require.Equal(t, float64(2), actor["color_index"])
			if kind == "prompt" {
				require.Equal(t, "user", message["role"])
				require.Equal(t, "person", actor["kind"])
				require.Equal(t, "ben", actor["login"])
			} else {
				require.Equal(t, "smithers", message["role"])
				require.Equal(t, "agent", actor["kind"])
				require.Equal(t, "agent-codex", actor["id"])
				require.Equal(t, "9", actor["session_id"])
				require.JSONEq(t, `{"login":"ben","name":"Ben","avatar_url":"https://example.test/ben.png"}`, mustProjectionJSON(t, actor["for_member"]))
			}
			if kind == "error" {
				require.Equal(t, "failed", message["status"])
			}
			if kind == "thinking" {
				require.Equal(t, "A complete answer", message["reasoning"])
				require.Equal(t, "", message["text"])
			}
		})
	}
	row := SharedTurn{ExternalDraft: &draft, ID: "journal", externalActor: externalActor(db.User{Username: "ben"}, draft, 0), externalAt: 2000}
	draft.At = 0
	encoded, err := json.Marshal(row)
	require.NoError(t, err)
	require.Contains(t, string(encoded), `"createdAt":2000`)
	require.Contains(t, string(encoded), `"name":"ben"`)
	require.Contains(t, string(encoded), "data:image/svg+xml;base64,")
	row.externalActor = nil
	_, err = json.Marshal(row)
	require.ErrorIs(t, err, ErrCorrupt)
	row.externalActor = map[string]any{}
	draft.ReadOnly = false
	_, err = json.Marshal(row)
	require.ErrorIs(t, err, ErrCorrupt)
	// Ordinary turns retain the existing wire contract and context projection.
	encoded, err = json.Marshal(SharedTurn{ID: "ordinary", RunID: "ordinary-run", Frames: []json.RawMessage{}})
	require.NoError(t, err)
	require.Contains(t, string(encoded), `"runId":"ordinary-run"`)
	require.NotContains(t, string(encoded), "origin")
}

func mustProjectionJSON(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	require.NoError(t, err)
	return string(encoded)
}

func TestExternalProjectionKeepsToolOutputAndEditReportsInert(t *testing.T) {
	for _, fixture := range []struct{ kind, body, text, act string }{
		{"tool_request", `{"command":"touch /outside/sentinel","output":""}`, "", "touch /outside/sentinel"},
		{"tool_result", `{"command":"cat a.ts","output":"file output"}`, "file output", "cat a.ts"},
		{"edit", `{"files":[{"path":"a.ts","diff":"+new"},{"path":"b.ts","diff":"-old"}]}`, "a.ts\n+new\nb.ts\n-old", ""},
		{"error", `{"message":"Unsupported version"}`, "Unsupported version", ""},
		{"attachment", `{"query":"search words"}`, "search words", ""},
		{"attachment", `{"objective":"Finish the change"}`, "Finish the change", ""},
		{"attachment", `{"activity":"Read the file"}`, "Read the file", ""},
		{"attachment", `{"text":"Read-only text"}`, "Read-only text", ""},
		{"attachment", `{"type":"encrypted"}`, `{"type":"encrypted"}`, ""},
		{"attachment", `[]`, `[]`, ""},
	} {
		text, act := externalText(ExternalDraft{Kind: fixture.kind, Body: json.RawMessage(fixture.body)})
		require.Equal(t, fixture.text, text)
		require.Equal(t, fixture.act, act)
	}
}
