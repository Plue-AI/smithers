package chat

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestExternalHostNormalizationBoundary(t *testing.T) {
	status := http.StatusOK
	payload := `{"entries":[{"id":"draft","source_id":"message","source_offset":0,"origin":"external","read_only":true,"agent":"codex","source_format_version":"codex/0.160.0","session_id":"1","participant_id":"agent-1","owner_id":"owner-1","author_id":"owner-1","kind":"prompt","body":"Edit a.ts"}],"state":{"offset":5},"needs_more":false}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/prefix/v1/transcript/normalize" || r.Header.Get("Authorization") != "Bearer token" {
			t.Errorf("invalid authenticated endpoint")
		}
		var input map[string]json.RawMessage
		if json.NewDecoder(r.Body).Decode(&input) != nil || string(input["start"]) != "0" || string(input["end"]) != "5" || string(input["profile"]) != `"codex/0.160.0"` {
			t.Error("normalization input differs")
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(payload))
	}))
	defer server.Close()
	host, err := NewHTTPChatHost(server.URL+"/prefix", server.Client(), "token")
	if err != nil {
		t.Fatal(err)
	}
	input := ExternalNormalizeInput{Profile: "codex/0.160.0", Context: map[string]string{"owner_id": "owner-1"}, Record: "data", End: 5}
	out, err := host.NormalizeExternalTranscript(t.Context(), input)
	if err != nil || len(out.Entries) != 1 || out.Entries[0].Kind != "prompt" || string(out.Entries[0].Body) != `"Edit a.ts"` {
		t.Fatal(out, err)
	}
	for _, test := range []struct {
		status int
		body   string
	}{{422, `{"error":{"_tag":"UnsupportedVersion","detail":"private"}}`}, {200, `{"entries":[],"needs_more":true,"state":{}}`}, {200, `{`}, {200, strings.Repeat(" ", 4*1024*1024+1)},
		// A forged envelope is not the decoder's verdict; neither is a refusal
		// without a source line, with a reason of its own, or on another status.
		{422, `{"code":"transcript_invalid"}`}, {422, `{"code":"transcript_refused","reason":"unsupported_record"}`},
		{422, `{"code":"transcript_refused","reason":"rm -rf /","line":3}`}, {500, `{"code":"transcript_refused","reason":"unsupported_record","line":3}`},
		{200, `{"code":"transcript_refused","reason":"unsupported_record","line":3}`}} {
		status, payload = test.status, test.body
		_, err := host.NormalizeExternalTranscript(t.Context(), input)
		var refusal *ExternalRefusal
		if err == nil || errors.As(err, &refusal) {
			t.Fatal("invalid host response accepted", test.body, err)
		}
	}
	// The decoder's refusal carries its reason and source line and nothing else.
	for _, test := range []struct{ reason, sentence string }{
		{"unsupported_version", "This session transcript version is not supported."},
		{"missing_version", "This session transcript version is not supported."},
		{"unsupported_record", "Session transcript line 7 could not be read."},
		{"malformed_record", "Session transcript line 7 could not be read."},
	} {
		status, payload = 422, `{"code":"transcript_refused","reason":"`+test.reason+`","line":7,"message":"private detail"}`
		_, err := host.NormalizeExternalTranscript(t.Context(), input)
		var refusal *ExternalRefusal
		if !errors.As(err, &refusal) || refusal.Reason != test.reason || refusal.Line != 7 || refusal.Sentence() != test.sentence || strings.Contains(refusal.Error(), "private") {
			t.Fatal(test.reason, err)
		}
	}
}

func TestExternalDraftProfileNamesItsAgentAndNothingElse(t *testing.T) {
	draft := ExternalDraft{ID: "id", SourceID: "source", Origin: "external", ReadOnly: true, Session: "1", Participant: "agent", Owner: "42", Author: "agent", Kind: "error", Body: json.RawMessage(`{"type":"error","message":"m"}`)}
	for _, test := range []struct {
		agent, profile string
		valid          bool
	}{
		{"codex", "codex-rollout/0.160", true}, {"codex", "codex-rollout/0.159", true}, {"codex", "codex-rollout/0.161", true},
		{"codex", "codex/0.160.0", true}, {"claude-code", "claude-code/2.1", true}, {"claude-code", "claude-code/2.1.0", true}, {"claude-code", "claude-code/2.2", true},
		// An agent never borrows another's profile, and a profile is a family and a dotted release only.
		{"codex", "claude-code/2.1", false}, {"claude-code", "codex-rollout/0.160", false}, {"smithers", "codex-rollout/0.160", false},
		{"codex", "codex-rollout/", false}, {"codex", "codex-rollout/../../etc", false}, {"codex", "codex-rollout/0.160 ", false},
		{"codex", "codex-rollout/.160", false}, {"codex", "codex-rollout/0.", false}, {"codex", "codex-rollout/0..1", false},
		{"codex", "codex-rollout/v1", false}, {"claude-code", "", false}, {"claude-code", "claude-code/" + strings.Repeat("1", 33), false},
	} {
		draft.Agent, draft.Profile = test.agent, test.profile
		if draft.valid() != test.valid {
			t.Fatal(test.agent, test.profile, "valid:", draft.valid())
		}
	}
}
