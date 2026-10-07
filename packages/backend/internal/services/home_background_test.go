package services

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/stretchr/testify/require"
)

func TestHomeBackgroundStoredVersionAndInput(t *testing.T) {
	source, digest := strings.Repeat("a", 40), strings.Repeat("b", 64)
	pin := flowruntime.Pin{Flow: "wiki", SourceCommit: source, ExecutionDigest: digest}
	encode := func(value any) []byte { raw, err := json.Marshal(value); require.NoError(t, err); return raw }
	payload := func(stored *flowruntime.Pin, input any) []byte {
		return encode(map[string]any{"flowId": "wiki", "pin": stored, "payload": input})
	}
	input := map[string]any{"page": "Home"}
	observed := encode(map[string]any{"executionDigest": digest})
	for _, tc := range []struct {
		name, source               string
		payload, checkpoint, input []byte
		valid                      bool
	}{
		{"pinned failure before start", "", payload(&pin, input), nil, []byte(`{"page":"Home"}`), true},
		{"pinned observed run", source, payload(&pin, input), observed, []byte(`{"page":"Home"}`), true},
		{"older observed admission", source, payload(nil, input), observed, []byte(`{"page":"Home"}`), true},
		{"missing stored version", source, payload(nil, input), nil, []byte(`{"page":"Home"}`), false},
		{"wrong observed source", strings.Repeat("c", 40), payload(&pin, input), observed, []byte(`{"page":"Home"}`), false},
		{"wrong observed digest", source, payload(&pin, input), encode(map[string]any{"executionDigest": strings.Repeat("c", 64)}), []byte(`{"page":"Home"}`), false},
		{"wrong stored flow", source, []byte(`{"flowId":"other"}`), observed, []byte(`{"page":"Home"}`), false},
		{"changed input", source, payload(&pin, input), observed, []byte(`{"page":"Settings"}`), false},
		{"malformed admission", source, []byte(`{`), observed, []byte(`{"page":"Home"}`), false},
		{"malformed checkpoint", source, payload(&pin, input), []byte(`{`), []byte(`{"page":"Home"}`), false},
		{"malformed run input", source, payload(&pin, input), observed, []byte(`{`), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := homeBackgroundPin("wiki", tc.source, tc.payload, tc.checkpoint, tc.input)
			if tc.valid {
				require.NoError(t, err)
				require.Equal(t, pin, *got)
			} else {
				require.Error(t, err)
				require.Nil(t, got)
			}
		})
	}
}
