package chat

import (
	"encoding/json"
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
	}{{422, `{"error":{"_tag":"UnsupportedVersion","detail":"private"}}`}, {200, `{"entries":[],"needs_more":true,"state":{}}`}, {200, `{`}, {200, strings.Repeat(" ", 4*1024*1024+1)}} {
		status, payload = test.status, test.body
		if _, err := host.NormalizeExternalTranscript(t.Context(), input); err == nil {
			t.Fatal("invalid host response accepted")
		}
	}
}
