package modelproxy

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// An install's own Gateway key serves its coding host: chat completions go
// to the Gateway with the owner's key, no credit is reserved (the zero Meter
// has no ledger and would refuse), and the guest never holds the key.
func TestOwnerPaidForwardsGatewayChatWithTheOwnersKey(t *testing.T) {
	var sent *http.Request
	var body map[string]any
	keys := &forwardUnitKeys{key: "owner-gateway-fixture"}
	caller := &unitProxyCaller{}
	h := &Handler{OwnerPaid: true, Keys: keys, Callers: caller, Client: &http.Client{Transport: forwardUnitTransport(func(r *http.Request) (*http.Response, error) {
		sent = r
		raw, _ := io.ReadAll(r.Body)
		require.NoError(t, json.Unmarshal(raw, &body))
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}},
			Body: io.NopCloser(strings.NewReader(`{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":3,"completion_tokens":1}}`))}, nil
	})}}
	request := httptest.NewRequest("POST", Path+"/vercel/v1/chat/completions", strings.NewReader(`{"model":"openai/gpt-5.1","messages":[{"role":"user","content":"hi"}],"stream":true}`))
	request.Header.Set("Authorization", "Bearer smithers_flowhost_guest")
	response := httptest.NewRecorder()
	h.ServeHTTP(response, request)

	require.Equal(t, 200, response.Code, response.Body.String())
	require.Contains(t, response.Body.String(), `"content":"ok"`)
	require.NotNil(t, sent)
	require.Equal(t, "https://ai-gateway.vercel.sh/v1/chat/completions", sent.URL.String())
	require.Equal(t, "Bearer owner-gateway-fixture", sent.Header.Get("Authorization"))
	require.Equal(t, "openai/gpt-5.1", body["model"])
	require.Equal(t, map[string]any{"include_usage": true}, body["stream_options"], "a streamed call still reports its usage")
	require.Equal(t, 2, caller.calls, "the caller is resolved before the body and again before spending")
	require.Equal(t, 1, keys.reads)
}

func TestOwnerPaidRefusesBeforeTheKeyAndPlatformKeysNeverServeGatewayChat(t *testing.T) {
	dispatch := forwardUnitTransport(func(*http.Request) (*http.Response, error) {
		t.Fatal("a refused call must never dispatch")
		return nil, nil
	})
	chat := `{"model":"openai/gpt-5.1","messages":[]}`
	for _, item := range []struct {
		name      string
		ownerPaid bool
		path      string
		body      string
		header    http.Header
		status    int
		message   string
	}{
		// Smithers prices no Gateway chat model, so platform keys refuse it.
		{"platform keys", false, "/vercel/v1/chat/completions", chat, http.Header{}, 400, "Model openai/gpt-5.1 is not offered on platform keys."},
		{"an unbounded field", true, "/vercel/v1/chat/completions", `{"model":"openai/gpt-5.1","messages":[],"previous_response_id":"r"}`, http.Header{}, 400, "previous_response_id is not offered on platform keys"},
		{"no model", true, "/vercel/v1/chat/completions", `{"messages":[]}`, http.Header{}, 400, "model is required"},
		// The evaluation path is still Jev alone.
		{"evaluation without Jev", true, "/vercel/v4/ai/evaluation-model", `{}`, http.Header{}, 400, "ai-model-id must be typesafe-ai/jev"},
		{"another path", true, "/vercel/v1/responses", chat, http.Header{}, 404, "Only POST v4/ai/evaluation-model, v1/chat/completions is served."},
	} {
		t.Run(item.name, func(t *testing.T) {
			keys := &forwardUnitKeys{key: "owner-gateway-fixture"}
			h := &Handler{OwnerPaid: item.ownerPaid, Keys: keys, Callers: &unitProxyCaller{}, Client: &http.Client{Transport: dispatch}}
			request := httptest.NewRequest("POST", Path+item.path, strings.NewReader(item.body))
			request.Header = item.header
			response := httptest.NewRecorder()
			h.ServeHTTP(response, request)
			require.Equal(t, item.status, response.Code)
			require.Contains(t, response.Body.String(), item.message)
			require.Zero(t, keys.reads)
		})
	}
}
