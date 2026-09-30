package services

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

func TestInvokedFlowLogRedactsBeforeTruncation(t *testing.T) {
	secret := "secret-boundary-tail"
	payload, err := json.Marshal(map[string]string{"text": strings.Repeat("x", invokedFlowLogEntryLimit-32) + secret + strings.Repeat("z", 100)})
	require.NoError(t, err)
	event := flowruntime.FlowRuntimeEvent{Kind: "node.output", Payload: payload}
	entry := invokedFlowLogEntry(event, newSecretPatterns([]string{secret}))
	require.NotContains(t, entry, "secret-")
	require.Contains(t, entry, redactedSecretValue)
	require.LessOrEqual(t, len(entry), invokedFlowLogEntryLimit+len(" …"))
}

func TestInvokedFlowProjectionRedactsAcrossTruncationBoundary(t *testing.T) {
	f := newInvokedFlowTestFixture(t)
	secret := "secret-boundary-tail"
	_, err := NewSecretService(db.New(f.pool), f.codec).SetSecret(context.Background(), f.owner, f.owner.Username, f.repository, "API_KEY", secret, nil)
	require.NoError(t, err)
	payload, err := json.Marshal(map[string]string{"text": strings.Repeat("x", invokedFlowLogEntryLimit-32) + secret + strings.Repeat("z", 100)})
	require.NoError(t, err)
	f.project(t, flowdispatch.ProjectionUpdate{State: jobs.StateWaiting, Checkpoint: flowdispatch.RuntimeCheckpoint{RunID: "flow-run-1", Run: &flowruntime.FlowRuntimeRun{RunID: "flow-run-1", FlowID: "echo", Status: "running"}, Cursor: "1"}, Events: []flowruntime.FlowRuntimeEvent{{Sequence: 1, Kind: "node.output", Payload: payload}}})
	logs := f.logs(t)
	require.Len(t, logs, 1)
	require.NotContains(t, logs[0].Entry, "secret-")
	require.Contains(t, logs[0].Entry, redactedSecretValue)
}

func TestInvokedFlowLogRedactsJSONEncodedMultilineSecret(t *testing.T) {
	for _, secret := range []string{"-----BEGIN KEY-----\nprivate-value\n-----END KEY-----", "quoted\"value", "back\\slash"} {
		t.Run(secret, func(t *testing.T) {
			payload, err := json.Marshal(map[string]string{"text": secret})
			require.NoError(t, err)
			entry := invokedFlowLogEntry(flowruntime.FlowRuntimeEvent{Kind: "node.output", Payload: payload}, newSecretPatterns([]string{secret}))
			require.Equal(t, `node.output {"text":"`+redactedSecretValue+`"}`, entry)
		})
	}
}

func TestInvokedFlowProjectionRedactsJSONEncodedMultilineSecret(t *testing.T) {
	f := newInvokedFlowTestFixture(t)
	secret := "-----BEGIN KEY-----\nprivate-value\n-----END KEY-----"
	_, err := NewSecretService(db.New(f.pool), f.codec).SetSecret(context.Background(), f.owner, f.owner.Username, f.repository, "PRIVATE_KEY", secret, nil)
	require.NoError(t, err)
	payload, err := json.Marshal(map[string]string{"text": secret})
	require.NoError(t, err)
	f.project(t, flowdispatch.ProjectionUpdate{State: jobs.StateWaiting, Checkpoint: flowdispatch.RuntimeCheckpoint{RunID: "flow-run-1", Run: &flowruntime.FlowRuntimeRun{RunID: "flow-run-1", FlowID: "echo", Status: "running"}, Cursor: "1"}, Events: []flowruntime.FlowRuntimeEvent{{Sequence: 1, Kind: "node.output", Payload: payload}}})
	logs := f.logs(t)
	require.Len(t, logs, 1)
	require.Equal(t, `node.output {"text":"`+redactedSecretValue+`"}`, logs[0].Entry)
}

func TestInvokedFlowLogRedactsJavaScriptJSONEncoding(t *testing.T) {
	for _, tc := range []struct{ secret, payload string }{
		{"<>&\nquoted\"back\\slash", `{"text":"<>&\nquoted\"back\\slash"}`},
		{"separator\u2028paragraph\u2029\nvalue", "{\"text\":\"separator\u2028paragraph\u2029\\nvalue\"}"},
		{`literal\u003c` + "<\nvalue", `{"text":"literal\\u003c<\nvalue"}`},
		{"line\nvalue", `{"text":"line\u000avalue"}`},
		{"slash/value", `{"text":"slash\/value"}`},
	} {
		t.Run(tc.secret, func(t *testing.T) {
			entry := invokedFlowLogEntry(flowruntime.FlowRuntimeEvent{Kind: "node.output", Payload: json.RawMessage(tc.payload)}, newSecretPatterns([]string{tc.secret}))
			require.Equal(t, `node.output {"text":"`+redactedSecretValue+`"}`, entry)
		})
	}
}

func TestInvokedFlowLogRedactionPreservesJSONFramingUntilDecoded(t *testing.T) {
	entry := invokedFlowLogEntry(flowruntime.FlowRuntimeEvent{Kind: "node.output", Payload: json.RawMessage(`{"text":"line\nvalue"}`)}, newSecretPatterns([]string{`"`, ":", "line\nvalue"}))
	require.NotContains(t, entry, `line\nvalue`)
	require.NotContains(t, entry, "line")
}

func TestInvokedFlowRedactionPreservesUntouchedAndMalformedText(t *testing.T) {
	patterns := newSecretPatterns([]string{"private", "line\nvalue"})
	for _, entry := range []string{`node.output { "text" : "ordinary\/value", "number": 2 }`, `plain "unterminated\`, `"invalid\q"`} {
		require.Equal(t, entry, redactInvokedFlowEntry(patterns, entry))
	}
	require.Equal(t, `plain "unterminated `+redactedSecretValue, redactInvokedFlowEntry(patterns, `plain "unterminated private`))
}

func TestInvokedFlowLogRedactsAfterMalformedQuotePrefix(t *testing.T) {
	patterns := newSecretPatterns([]string{"line\nvalue"})
	event := flowruntime.FlowRuntimeEvent{Kind: `bad"kind`, Payload: json.RawMessage(`{"text":"line\nvalue"}`)}
	require.Equal(t, `bad"kind {"text":"********"}`, invokedFlowLogEntry(event, patterns))
	require.Equal(t, `flow failed: bad"prefix "********"`, redactInvokedFlowEntry(patterns, `flow failed: bad"prefix "line\nvalue"`))
}

func TestInvokedFlowLogRedactsNestedJSON(t *testing.T) {
	secret := "pem\nprivate\nvalue"
	nested, err := json.Marshal(map[string]string{"key": secret})
	require.NoError(t, err)
	payload, err := json.Marshal(map[string]string{"text": string(nested)})
	require.NoError(t, err)
	require.Equal(t, `node.output {"text":"********"}`, invokedFlowLogEntry(flowruntime.FlowRuntimeEvent{Kind: "node.output", Payload: payload}, newSecretPatterns([]string{secret})))
}

func TestInvokedFlowLogRedactsOriginalRawSpans(t *testing.T) {
	require.Equal(t, `node.output ********`, invokedFlowLogEntry(flowruntime.FlowRuntimeEvent{Kind: "node.output", Payload: json.RawMessage(`{"a":"b"}`)}, newSecretPatterns([]string{"b", `{"a":"b"}`})))
}

func TestInvokedFlowRedactionBoundsNestedJSONAndPreservesNoSecretLogs(t *testing.T) {
	text := `{"text":"ordinary"}`
	require.Equal(t, text, redactInvokedFlowEntry(nil, text))
	require.Empty(t, invokedFlowSecretSpans(newSecretPatterns([]string{"unrelated-secret"}), text, 63))
	spans := invokedFlowSecretSpans(newSecretPatterns([]string{"unrelated-secret"}), text, 64)
	require.NotEmpty(t, spans)
	require.Contains(t, redactSecretSpans(text, mergeSecretSpans(spans)), redactedSecretValue)
}

func TestInvokedFlowLogRedactsPunctuationAndEncodedSecretTogether(t *testing.T) {
	entry := invokedFlowLogEntry(flowruntime.FlowRuntimeEvent{Kind: "node.output", Payload: json.RawMessage(`{"text":"line\nvalue"}`)}, newSecretPatterns([]string{":", "line\nvalue"}))
	require.NotContains(t, entry, "line")
	require.NotContains(t, entry, "value")
	require.Contains(t, entry, redactedSecretValue)
}
