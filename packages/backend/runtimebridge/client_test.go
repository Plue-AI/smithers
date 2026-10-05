package runtimebridge

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"maps"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
)

func runtimeClient(t *testing.T, handler http.Handler) (*Client, *httptest.Server) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client, err := New(Config{Endpoint: server.URL, Credential: "secret", HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	return client, server
}

func writeCommand(t *testing.T, response http.ResponseWriter, operation, requestID string) {
	t.Helper()
	response.Header().Set("content-type", "application/json")
	if err := json.NewEncoder(response).Encode(map[string]any{
		"protocol": flowruntime.FlowRuntimeProtocol,
		"ok":       true,
		"value": map[string]any{
			"operation": operation, "applicationRequestId": requestID,
			"ownerGeneration": 7, "runtimeArtifactDigest": strings.Repeat("a", 64),
			"sourceRevision": strings.Repeat("b", 40), "planId": "plan-1",
			"planDigest": strings.Repeat("c", 64), "executionDigest": strings.Repeat("d", 64),
			"envelope": map[string]any{"capabilities": []any{}, "flows": []any{}, "budget": map[string]any{"tokens": 1, "milliseconds": 1}},
			"approval": map[string]any{"target": map[string]any{"_tag": "Plan"}},
			"receipt":  map[string]any{"_tag": "Accepted", "receiptId": "receipt-1", "runId": "run-1"},
		},
	}); err != nil {
		t.Fatal(err)
	}
}

func TestClientLaunchAuthenticatesAndDecodesCanonicalReceipt(t *testing.T) {
	client, _ := runtimeClient(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/runtime/v1/command" || request.Method != http.MethodPost {
			t.Fatalf("unexpected request %s %s", request.Method, request.URL.Path)
		}
		if got := request.Header.Get("Authorization"); got != "Bearer secret" {
			t.Fatalf("authorization = %q", got)
		}
		var command map[string]any
		if err := json.NewDecoder(request.Body).Decode(&command); err != nil {
			t.Fatal(err)
		}
		if command["protocol"] != flowruntime.FlowRuntimeProtocol || command["operation"] != "launch" || command["attempt"] != float64(2) {
			t.Fatalf("unexpected launch %#v", command)
		}
		writeCommand(t, response, "launch", "request-1")
	}))

	result, err := client.Launch(context.Background(), flowruntime.FlowRuntimeLaunch{
		ApplicationRequestID: "request-1", Attempt: 2, OwnerGeneration: 7,
		RuntimeArtifactDigest: strings.Repeat("a", 64), SourceRevision: strings.Repeat("b", 40),
		FlowID: "fixture/small", Payload: json.RawMessage(`{"value":1}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Receipt.Tag != "Accepted" || result.Receipt.RunID != "run-1" || result.PlanID != "plan-1" ||
		result.PlanDigest != strings.Repeat("c", 64) || result.ExecutionDigest != strings.Repeat("d", 64) || result.OwnerGeneration != 7 {
		t.Fatalf("unexpected result %#v", result)
	}
}

func TestClientReadsNonSecretStartupIdentity(t *testing.T) {
	client, _ := runtimeClient(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/health" || request.Header.Get("Authorization") != "Bearer secret" {
			t.Fatalf("unexpected health request %#v", request)
		}
		_ = json.NewEncoder(response).Encode(map[string]any{"runtimeBridge": map[string]any{
			"protocol": flowruntime.FlowRuntimeProtocol, "runtimeArtifactDigest": strings.Repeat("a", 64),
			"sourceRevision": strings.Repeat("b", 40), "ownerGeneration": 7,
		}})
	}))
	identity, err := client.Identity(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if identity.Protocol != flowruntime.FlowRuntimeProtocol || identity.OwnerGeneration != 7 {
		t.Fatalf("identity = %#v", identity)
	}
}

func TestSharedTypeScriptWireFixtureDecodesInGo(t *testing.T) {
	bytes, err := os.ReadFile(filepath.Join("..", "..", "smithers", "gateway", "testdata", "runtime-bridge-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Launch struct {
			Protocol  string `json:"protocol"`
			Operation string `json:"operation"`
		} `json:"launch"`
		CommandResponse commandEnvelope `json:"commandResponse"`
		ObserveResponse observeEnvelope `json:"observeResponse"`
	}
	if err := json.Unmarshal(bytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Launch.Protocol != flowruntime.FlowRuntimeProtocol || fixture.Launch.Operation != "launch" {
		t.Fatalf("launch fixture = %#v", fixture.Launch)
	}
	if err := checkEnvelope(fixture.CommandResponse.Protocol, fixture.CommandResponse.OK, fixture.CommandResponse.Error); err != nil {
		t.Fatal(err)
	}
	if fixture.CommandResponse.Value.Receipt.RunID != "run-1" || fixture.ObserveResponse.Value.NextCursor != "42" || !fixture.ObserveResponse.Value.Terminal {
		t.Fatalf("fixture responses did not decode: %#v %#v", fixture.CommandResponse, fixture.ObserveResponse)
	}
}

func TestClientMutationsUseOneVersionedContract(t *testing.T) {
	var mu sync.Mutex
	var operations []string
	client, _ := runtimeClient(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		var command map[string]any
		if err := json.NewDecoder(request.Body).Decode(&command); err != nil {
			t.Fatal(err)
		}
		operation, _ := command["operation"].(string)
		mu.Lock()
		operations = append(operations, operation)
		mu.Unlock()
		writeCommand(t, response, operation, command["applicationRequestId"].(string))
	}))
	ctx := context.Background()
	approval := json.RawMessage(`{"target":{"_tag":"Plan","planId":"p","digest":"d","envelope":{"capabilities":[],"flows":[],"budget":{}}},"scope":"run","idempotencyKey":"ignored"}`)
	if _, err := client.Approve(ctx, flowruntime.FlowRuntimeDecision{ApplicationRequestID: "approve-1", OwnerGeneration: 7, Approval: approval}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Deny(ctx, flowruntime.FlowRuntimeDecision{ApplicationRequestID: "deny-1", OwnerGeneration: 7, Approval: approval}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Signal(ctx, flowruntime.FlowRuntimeSignal{ApplicationRequestID: "signal-1", OwnerGeneration: 7, RunID: "run-1", Name: "answer", Payload: json.RawMessage(`true`)}); err != nil {
		t.Fatal(err)
	}
	for _, steer := range []flowruntime.FlowRuntimeSteer{
		{ApplicationRequestID: "steer-message", OwnerGeneration: 7, RunID: "run-1", MessageID: "m1", Kind: "Message", Body: "continue"},
		{ApplicationRequestID: "steer-seat", OwnerGeneration: 7, RunID: "run-1", MessageID: "m2", Kind: "Seat", Seat: "openai:test"},
		{ApplicationRequestID: "steer-thinking", OwnerGeneration: 7, RunID: "run-1", MessageID: "m3", Kind: "Thinking", Thinking: "high"},
		{ApplicationRequestID: "steer-tools", OwnerGeneration: 7, RunID: "run-1", MessageID: "m4", Kind: "Tools", ToolNames: []string{"read"}},
	} {
		if _, err := client.Steer(ctx, steer); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := client.Cancel(ctx, flowruntime.FlowRuntimeLifecycle{ApplicationRequestID: "cancel-1", OwnerGeneration: 7, RunID: "run-1", Reason: "operator"}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Resume(ctx, flowruntime.FlowRuntimeLifecycle{ApplicationRequestID: "resume-1", OwnerGeneration: 7, RunID: "run-1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Steer(ctx, flowruntime.FlowRuntimeSteer{Kind: "unknown"}); ErrorCode(err) != "invalid_request" {
		t.Fatalf("unsupported steer error = %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	want := []string{"approve", "deny", "signal", "steer", "steer", "steer", "steer", "cancel", "resume"}
	if strings.Join(operations, ",") != strings.Join(want, ",") {
		t.Fatalf("operations = %v", operations)
	}
}

func TestClientSteerCarriesAttributionWithoutReplacingAuthentication(t *testing.T) {
	for _, attributed := range []bool{false, true} {
		name := "legacy"
		var attribution map[string]string
		if attributed {
			name = "attributed"
			attribution = map[string]string{"person": "ben", "via": "codex", "session": "terminal-1"}
		}
		t.Run(name, func(t *testing.T) {
			client, _ := runtimeClient(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				if request.Header.Get("Authorization") != "Bearer secret" {
					t.Error("steer lost transport authentication")
				}
				var command map[string]json.RawMessage
				if err := json.NewDecoder(request.Body).Decode(&command); err != nil {
					t.Error(err)
					return
				}
				if _, present := command["principal"]; present {
					t.Error("steer supplied a principal instead of using transport authentication")
				}
				if raw, present := command["attribution"]; attributed {
					var got map[string]string
					if err := json.Unmarshal(raw, &got); err != nil || !maps.Equal(got, attribution) {
						t.Errorf("attribution = %s, error = %v", raw, err)
					}
				} else if present {
					t.Errorf("legacy steer included attribution: %s", raw)
				}
				writeCommand(t, response, "steer", "member-feedback")
			}))
			_, err := client.Steer(context.Background(), flowruntime.FlowRuntimeSteer{
				ApplicationRequestID: "member-feedback", OwnerGeneration: 7, RunID: "run-1",
				MessageID: "message-1", Kind: "Message", Body: "Check cancellation.", Attribution: attribution,
			})
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestClientObserveReconnectsFromOpaqueCursor(t *testing.T) {
	client, _ := runtimeClient(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/runtime/v1/observe" {
			t.Fatalf("path = %s", request.URL.Path)
		}
		var input map[string]any
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
			t.Fatal(err)
		}
		if input["afterCursor"] != "41" || input["limit"] != float64(25) {
			t.Fatalf("observe input %#v", input)
		}
		_ = json.NewEncoder(response).Encode(map[string]any{
			"protocol": flowruntime.FlowRuntimeProtocol, "ok": true,
			"value": map[string]any{
				"run":        map[string]any{"runId": "run-1", "flowId": "fixture/small", "status": "completed", "finalOutput": `{"requestId":"setup-1","phase":"completed"}`},
				"events":     []any{map[string]any{"cursor": map[string]any{"sequence": 42}, "sequence": 42, "kind": "control.run.completed", "occurredAt": 1, "payload": nil}},
				"nextCursor": "42", "hasMore": false, "terminal": true,
			},
		})
	}))
	result, err := client.Observe(context.Background(), "run-1", "41", 25)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Terminal || result.NextCursor != "42" || len(result.Events) != 1 || result.Events[0].Sequence != 42 {
		t.Fatalf("observation = %#v", result)
	}
	if result.Run.FinalOutput == nil || *result.Run.FinalOutput != `{"requestId":"setup-1","phase":"completed"}` {
		t.Fatalf("canonical final output was not retained: %#v", result.Run.FinalOutput)
	}
}

func TestClientRefusesUnsafeConfiguration(t *testing.T) {
	for _, test := range []Config{
		{Endpoint: "http://example.com", Credential: "secret"},
		{Endpoint: "ftp://localhost", Credential: "secret"},
		{Endpoint: "http://user:pass@localhost", Credential: "secret"},
		{Endpoint: "http://localhost?token=x", Credential: "secret"},
		{Endpoint: "http://localhost", Credential: ""},
	} {
		if _, err := New(test); err == nil {
			t.Fatalf("expected config refusal for %#v", test)
		}
	}
	if _, err := New(Config{Endpoint: "https://runtime.example", Credential: "secret"}); err != nil {
		t.Fatal(err)
	}
}

func TestClientClassifiesRefusalsAndProtocolMismatch(t *testing.T) {
	tests := []struct {
		name      string
		status    int
		body      string
		code      string
		retryable bool
	}{
		{"typed", 409, `{"protocol":"smithers.flow-runtime/v1","error":{"code":"stale_owner","message":"stale","retryable":true}}`, "stale_owner", true},
		{"unauthorized", 401, `{"code":"unauthorized"}`, "unauthorized", false},
		{"server", 502, `bad gateway`, "http_refused", true},
		{"bad-json", 200, `{`, "invalid_response", false},
		{"version", 200, `{"protocol":"smithers.flow-runtime/v2","ok":true,"value":{}}`, "incompatible_protocol", false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client, _ := runtimeClient(t, http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
				response.WriteHeader(test.status)
				_, _ = io.WriteString(response, test.body)
			}))
			_, err := client.Resume(context.Background(), flowruntime.FlowRuntimeLifecycle{ApplicationRequestID: "r", OwnerGeneration: 1, RunID: "run"})
			if ErrorCode(err) != test.code || IsRetryable(err) != test.retryable {
				t.Fatalf("error = %#v", err)
			}
		})
	}
}

func TestClientObserveBoundsValidResponseEnvelope(t *testing.T) {
	const marker = "synthetic-response-marker"
	for _, test := range []struct {
		name string
		size int
	}{
		{"below", maxResponseBytes - 1},
		{"exact", maxResponseBytes},
		{"over", maxResponseBytes + 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			event := map[string]any{"sequence": 42, "kind": "", "occurredAt": 1, "payload": map[string]any{"text": marker}}
			envelope := map[string]any{
				"protocol": flowruntime.FlowRuntimeProtocol, "ok": true,
				"value": map[string]any{
					"run":    map[string]any{"runId": "run-1", "flowId": "fixture/small", "status": "running"},
					"events": []any{event}, "nextCursor": "42", "hasMore": false, "terminal": false,
				},
			}
			base, err := json.Marshal(envelope)
			if err != nil {
				t.Fatal(err)
			}
			// Put the padding outside payload: the complete HTTP envelope, including
			// event metadata, must be bounded before decoding or projection.
			kindSize := test.size - len(base)
			event["kind"] = strings.Repeat("x", kindSize)
			body, err := json.Marshal(envelope)
			if err != nil || len(body) != test.size || !json.Valid(body) {
				t.Fatalf("invalid boundary fixture: bytes=%d, want=%d, error=%v", len(body), test.size, err)
			}
			client, _ := runtimeClient(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				if request.Method != http.MethodPost || request.URL.Path != "/runtime/v1/observe" || request.Header.Get("Authorization") != "Bearer secret" {
					t.Error("unexpected observe request")
				}
				response.Header().Set("Content-Type", "application/json")
				_, _ = response.Write(body)
			}))
			result, err := client.Observe(context.Background(), "run-1", "", 1)
			if test.size > maxResponseBytes {
				if ErrorCode(err) != "invalid_response" || IsRetryable(err) {
					t.Fatalf("oversize response error = %v", err)
				}
				if result.Run.RunID != "" || len(result.Events) != 0 || result.NextCursor != "" {
					t.Fatal("oversize response exposed a partial observation")
				}
				if strings.Contains(err.Error(), marker) || strings.Contains(err.Error(), "secret") {
					t.Fatal("oversize response error exposed response or credential data")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if result.Run.RunID != "run-1" || result.NextCursor != "42" || len(result.Events) != 1 || len(result.Events[0].Kind) != kindSize {
				t.Fatal("bounded response did not preserve the complete observation")
			}
			var payload struct {
				Text string `json:"text"`
			}
			if err := json.Unmarshal(result.Events[0].Payload, &payload); err != nil || payload.Text != marker {
				t.Fatal("bounded response did not preserve its payload")
			}
		})
	}
}

func TestClientBoundsResponsesAndHonorsCancellation(t *testing.T) {
	t.Run("bounded", func(t *testing.T) {
		client, _ := runtimeClient(t, http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
			_, _ = io.WriteString(response, strings.Repeat("x", maxResponseBytes+1))
		}))
		_, err := client.Observe(context.Background(), "run", "", 0)
		if ErrorCode(err) != "invalid_response" {
			t.Fatalf("error = %v", err)
		}
	})
	t.Run("cancelled", func(t *testing.T) {
		client, _ := runtimeClient(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			select {
			case <-request.Context().Done():
			case <-time.After(100 * time.Millisecond):
				response.WriteHeader(http.StatusGatewayTimeout)
			}
		}))
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
		defer cancel()
		_, err := client.Observe(ctx, "run", "", 0)
		if !IsRetryable(err) {
			t.Fatalf("error = %v", err)
		}
	})
}

func TestErrorHelpersIgnoreForeignErrors(t *testing.T) {
	err := errors.New("foreign")
	if IsRetryable(err) || ErrorCode(err) == "" {
		t.Fatal("foreign error classification failed")
	}
}

func TestCallRPCRoutesGatewayProceduresToProjections(t *testing.T) {
	cases := map[string]string{
		"Projection.Snapshot": "/projections", "Approval.Submit": "/projections",
		"Run.Fork": "/projections", "Run.Verify": "/projections",
		"Plan": "/rpc", "Resume": "/rpc", "List": "/rpc",
	}
	for procedure, want := range cases {
		t.Run(procedure, func(t *testing.T) {
			var path, tag string
			client, _ := runtimeClient(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				path = request.URL.Path
				var frame struct {
					Tag string `json:"tag"`
				}
				_ = json.NewDecoder(request.Body).Decode(&frame)
				tag = frame.Tag
				_, _ = io.WriteString(response, `{"_tag":"Exit","requestId":1,"exit":{"_tag":"Success","value":{"ok":true}}}`+"\n")
			}))
			if _, err := client.CallRPC(context.Background(), procedure, json.RawMessage(`{"runId":"run-1"}`)); err != nil {
				t.Fatal(err)
			}
			if path != want || tag != procedure {
				t.Fatalf("%s went to %s as %q, want %s", procedure, path, tag, want)
			}
		})
	}
}
