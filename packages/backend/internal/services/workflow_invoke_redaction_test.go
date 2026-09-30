package services

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowhost"
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
	_, err := NewSecretService(db.New(f.pool), f.codec).SetSecret(context.Background(), f.owner, f.owner.Username, f.repository, "API_KEY", secret, nil, nil)
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
	_, err := NewSecretService(db.New(f.pool), f.codec).SetSecret(context.Background(), f.owner, f.owner.Username, f.repository, "PRIVATE_KEY", secret, nil, nil)
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

func launchAuthority(t *testing.T, f invokedFlowTestFixture) flowhost.Authority {
	t.Helper()
	authority, err := f.invoked.ResolveFlowHostTarget(context.Background(), flowruntime.Target{
		TenantID: f.scope().TenantID, PrincipalID: f.scope().PrincipalID,
		BindingKind: invokedFlowBinding, BindingID: strconv.FormatInt(f.run.ID, 10),
	})
	require.NoError(t, err)
	return authority
}

func projectEvent(t *testing.T, f invokedFlowTestFixture, cursor string, payload json.RawMessage) {
	t.Helper()
	f.project(t, flowdispatch.ProjectionUpdate{State: jobs.StateWaiting, Checkpoint: flowdispatch.RuntimeCheckpoint{RunID: "flow-run-1", Run: &flowruntime.FlowRuntimeRun{RunID: "flow-run-1", FlowID: "echo", Status: "running"}, Cursor: cursor},
		EventsAfter: map[bool]string{true: "", false: "1"}[cursor == "1"], Events: []flowruntime.FlowRuntimeEvent{{Sequence: 1, Kind: "node.output", Payload: payload}}})
}

// A launch injects secret A; the secret then rotates to B and another is
// deleted. The run's log still masks every value the guest received.
func TestInvokedFlowLogRedactsLaunchSecretsAfterRotation(t *testing.T) {
	f := newInvokedFlowTestFixture(t)
	ctx := context.Background()
	secrets := NewSecretService(db.New(f.pool), f.codec)
	_, err := secrets.SetSecret(ctx, f.owner, f.owner.Username, f.repository, "API_KEY", "value-A-rotated", nil, nil)
	require.NoError(t, err)
	_, err = secrets.SetSecret(ctx, f.owner, f.owner.Username, f.repository, "GONE", "value-gone-deleted", nil, nil)
	require.NoError(t, err)
	environment, err := f.invoked.FlowHostEnvironment(ctx, launchAuthority(t, f))
	require.NoError(t, err)
	require.Equal(t, "value-A-rotated", environment["API_KEY"])

	_, err = secrets.SetSecret(ctx, f.owner, f.owner.Username, f.repository, "API_KEY", "value-B-current", nil, nil)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `DELETE FROM repository_secrets WHERE repository_id=$1 AND name='GONE'`, f.repositoryID)
	require.NoError(t, err)

	var sealed string
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT launch_redaction FROM workflow_run_flow_invocations WHERE workflow_run_id=$1`, f.run.ID).Scan(&sealed))
	require.NotEmpty(t, sealed)
	require.NotContains(t, sealed, "value-A-rotated", "the retained set is encrypted at rest")
	require.NotContains(t, sealed, "value-gone-deleted")

	payload, err := json.Marshal(map[string]string{"text": "a=value-A-rotated b=value-B-current c=value-gone-deleted"})
	require.NoError(t, err)
	projectEvent(t, f, "1", payload)
	logs := f.logs(t)
	require.Len(t, logs, 1)
	for _, leaked := range []string{"value-A", "value-B", "value-gone"} {
		require.NotContains(t, logs[0].Entry, leaked)
	}
	require.Contains(t, logs[0].Entry, redactedSecretValue)

	// A second launch of the run keeps the first launch's values.
	_, err = secrets.SetSecret(ctx, f.owner, f.owner.Username, f.repository, "API_KEY", "value-C-relaunch", nil, nil)
	require.NoError(t, err)
	_, err = f.invoked.FlowHostEnvironment(ctx, launchAuthority(t, f))
	require.NoError(t, err)
	_, err = secrets.SetSecret(ctx, f.owner, f.owner.Username, f.repository, "API_KEY", "value-D-later", nil, nil)
	require.NoError(t, err)
	payload, err = json.Marshal(map[string]string{"text": "value-A-rotated value-C-relaunch"})
	require.NoError(t, err)
	f.project(t, flowdispatch.ProjectionUpdate{State: jobs.StateWaiting, Checkpoint: flowdispatch.RuntimeCheckpoint{RunID: "flow-run-1", Run: &flowruntime.FlowRuntimeRun{RunID: "flow-run-1", FlowID: "echo", Status: "running"}, Cursor: "2"},
		EventsAfter: "1", Events: []flowruntime.FlowRuntimeEvent{{Sequence: 2, Kind: "node.output", Payload: payload}}})
	logs = f.logs(t)
	require.Len(t, logs, 2)
	require.NotContains(t, logs[1].Entry, "value-A")
	require.NotContains(t, logs[1].Entry, "value-C")
	require.Contains(t, logs[1].Entry, redactedSecretValue)
}

func TestInvokedFlowLaunchRedactionIsDeletedWithTheRun(t *testing.T) {
	f := newInvokedFlowTestFixture(t)
	ctx := context.Background()
	_, err := NewSecretService(db.New(f.pool), f.codec).SetSecret(ctx, f.owner, f.owner.Username, f.repository, "API_KEY", "value-A", nil, nil)
	require.NoError(t, err)
	_, err = f.invoked.FlowHostEnvironment(ctx, launchAuthority(t, f))
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `DELETE FROM workflow_runs WHERE id=$1`, f.run.ID)
	require.NoError(t, err)
	var count int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM workflow_run_flow_invocations WHERE workflow_run_id=$1`, f.run.ID).Scan(&count))
	require.Zero(t, count)
}

func TestInvokedFlowLogEntriesBoundRedactionWork(t *testing.T) {
	patterns := newSecretPatterns([]string{"secret-value"})
	small := flowruntime.FlowRuntimeEvent{Kind: "a", Payload: json.RawMessage(`"secret-value"`)}
	atLimit := flowruntime.FlowRuntimeEvent{Kind: "b", Payload: json.RawMessage(`"` + strings.Repeat("x", invokedFlowEventPayloadLimit-2) + `"`)}
	overLimit := flowruntime.FlowRuntimeEvent{Kind: "c", Payload: json.RawMessage(`"` + strings.Repeat("x", invokedFlowEventPayloadLimit-1) + `"`)}
	entries := invokedFlowLogEntries([]flowruntime.FlowRuntimeEvent{small, atLimit, overLimit}, patterns)
	require.Equal(t, `a "`+redactedSecretValue+`"`, entries[0])
	require.Len(t, entries[1], invokedFlowLogEntryLimit+len(" …"))
	require.Equal(t, "c [payload omitted: "+strconv.Itoa(invokedFlowEventPayloadLimit+1)+" bytes]", entries[2])

	// The page budget omits events past it, never logging them unmasked.
	var page []flowruntime.FlowRuntimeEvent
	for i := 0; i < invokedFlowPageRedactionBudget/invokedFlowEventPayloadLimit+1; i++ {
		page = append(page, flowruntime.FlowRuntimeEvent{Kind: "d", Payload: json.RawMessage(`"` + strings.Repeat("y", invokedFlowEventPayloadLimit-2) + `"`)})
	}
	entries = invokedFlowLogEntries(page, patterns)
	require.Contains(t, entries[len(entries)-1], "payload omitted")
	require.NotContains(t, entries[0], "payload omitted")
}

// A 1 MiB event with many secrets takes real redaction time, none of it inside
// the projection transaction.
func TestInvokedFlowProjectionRedactsLargeEventOutsideTransaction(t *testing.T) {
	f := newInvokedFlowTestFixture(t)
	ctx := context.Background()
	var values []string
	for i := 0; i < 100; i++ {
		value := fmt.Sprintf("large-event-secret-%04d-%s", i, strings.Repeat("s", 40))
		values = append(values, value)
		sealed, err := f.codec.EncryptString(value)
		require.NoError(t, err)
		_, err = f.pool.Exec(ctx, `INSERT INTO repository_secrets(repository_id,name,value_encrypted) VALUES($1,$2,$3)`, f.repositoryID, fmt.Sprintf("SECRET_%d", i), []byte(sealed))
		require.NoError(t, err)
	}
	text := strings.Repeat("ab ", (1<<20)/3-100) + values[7] + " " + values[99]
	payload, err := json.Marshal(map[string]string{"text": text})
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(payload), 1<<20-200)
	event := flowruntime.FlowRuntimeEvent{Kind: "node.output", Payload: payload}

	started := time.Now()
	entry := invokedFlowLogEntry(event, newSecretPatterns(values))
	redaction := time.Since(started)
	require.NotContains(t, entry, "large-event-secret")

	var maxTx atomic.Int64
	done := make(chan struct{})
	watcherDone := make(chan struct{})
	go func() {
		defer close(watcherDone)
		for {
			select {
			case <-done:
				return
			default:
			}
			var age int64
			if err := f.pool.QueryRow(ctx, `SELECT COALESCE(max((EXTRACT(EPOCH FROM clock_timestamp()-xact_start)*1000)::bigint),0) FROM pg_stat_activity
				WHERE datname=current_database() AND pid<>pg_backend_pid() AND xact_start IS NOT NULL AND query LIKE '%workflow_run_flow_invocations%'`).Scan(&age); err == nil && age > maxTx.Load() {
				maxTx.Store(age)
			}
			time.Sleep(2 * time.Millisecond)
		}
	}()
	projectEvent(t, f, "1", payload)
	close(done)
	<-watcherDone

	logs := f.logs(t)
	require.Len(t, logs, 1)
	require.NotContains(t, logs[0].Entry, "large-event-secret")
	t.Logf("redaction %s, longest observed projection transaction %dms", redaction, maxTx.Load())
	require.Greater(t, redaction, 100*time.Millisecond, "the event must cost enough for the bound to mean something")
	require.Less(t, time.Duration(maxTx.Load())*time.Millisecond, redaction/2)
}
