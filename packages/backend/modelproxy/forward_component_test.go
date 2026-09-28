package modelproxy

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/stretchr/testify/require"
)

// These are forwarding-component tests with actual local HTTP sockets. They
// omit SQL metering and use a recording key port, so they are not a complete
// independent proxy/ledger integration suite.
func TestForwardComponentDefaultClientDoesNotFollowCredentialRedirect(t *testing.T) {
	var redirected atomic.Int64
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		redirected.Add(1)
		w.WriteHeader(200)
	}))
	defer target.Close()
	var first atomic.Int64
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		first.Add(1)
		w.Header().Set("Location", target.URL+"/should-not-receive-key")
		w.WriteHeader(http.StatusTemporaryRedirect)
		_, _ = io.WriteString(w, "redirect refused")
	}))
	defer origin.Close()
	h := &Handler{Keys: &forwardUnitKeys{key: "platform-private-fixture"}, Upstreams: map[string]string{"openai": origin.URL}}
	request := httptest.NewRequest("POST", "/caller", nil)
	parsed, err := parseRequest("openai", "v1/responses", request.Header, []byte(`{"model":"gpt-6-sol"}`))
	require.NoError(t, err)
	response := httptest.NewRecorder()
	result, err := h.forward(context.Background(), response, request, "openai", routes["openai"], "v1/responses", parsed)
	require.ErrorIs(t, err, ErrNotCharged)
	require.Equal(t, credits.ModelFailed, result.Outcome)
	require.Equal(t, 307, result.Status)
	require.Equal(t, 307, response.Code)
	require.Equal(t, "redirect refused", response.Body.String())
	require.Empty(t, response.Header().Get("Location"), "provider redirect URLs are not forwarded")
	require.Equal(t, int64(1), first.Load())
	require.Zero(t, redirected.Load(), "the default client never sends the key to a redirect destination")
}

func TestForwardComponentDisconnectAfterRequestIsSentHasUnknownOutcome(t *testing.T) {
	var received atomic.Int64
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		received.Add(1)
		connection, _, err := w.(http.Hijacker).Hijack()
		if err == nil {
			_ = connection.Close()
		}
	}))
	defer origin.Close()
	h := &Handler{Keys: &forwardUnitKeys{key: "platform-private-fixture"}, Upstreams: map[string]string{"openai": origin.URL}}
	request := httptest.NewRequest("POST", "/caller", nil)
	parsed, err := parseRequest("openai", "v1/responses", request.Header, []byte(`{"model":"gpt-6-sol"}`))
	require.NoError(t, err)
	response := httptest.NewRecorder()
	result, err := h.forward(context.Background(), response, request, "openai", routes["openai"], "v1/responses", parsed)
	require.EqualError(t, err, "modelproxy: provider connection failed after the request was sent")
	require.False(t, errors.Is(err, ErrNotCharged), "the provider received the body and may have run the call")
	require.Equal(t, credits.ModelUnknown, result.Outcome)
	require.Zero(t, result.Status)
	require.Equal(t, 502, response.Code)
	require.JSONEq(t, `{"error":{"type":"api_error","message":"Model provider unreachable."}}`, response.Body.String())
	require.Equal(t, int64(1), received.Load())
}

func TestForwardComponentTruncatedHTTPBodyDoesNotSettleReportedUsage(t *testing.T) {
	const body = `{"usage":{"input_tokens":7,"output_tokens":2}}`
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Length", "100")
		_, _ = io.WriteString(w, body)
	}))
	defer origin.Close()
	h := &Handler{Keys: &forwardUnitKeys{key: "platform-private-fixture"}, Upstreams: map[string]string{"openai": origin.URL}}
	request := httptest.NewRequest("POST", "/caller", strings.NewReader(`{"model":"gpt-6-sol"}`))
	parsed, err := parseRequest("openai", "v1/responses", request.Header, []byte(`{"model":"gpt-6-sol"}`))
	require.NoError(t, err)
	response := httptest.NewRecorder()
	result, err := h.forward(context.Background(), response, request, "openai", routes["openai"], "v1/responses", parsed)
	require.NoError(t, err)
	require.Equal(t, credits.ModelUnknown, result.Outcome)
	require.Zero(t, result.Usage.InputTokens)
	require.Zero(t, result.Usage.OutputTokens)
	require.Equal(t, 200, result.Status)
	require.Equal(t, body, response.Body.String())
	require.Empty(t, response.Header().Get("Content-Length"), "a truncated provider framing header is never forwarded")
}

func TestForwardComponentCallerCancellationStillReceivesUsage(t *testing.T) {
	arrived := make(chan struct{}, 1)
	var requests atomic.Int64
	release := make(chan struct{})
	var once sync.Once
	finishProvider := func() { once.Do(func() { close(release) }) }
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		select {
		case arrived <- struct{}{}:
		default:
		}
		select {
		case <-release:
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"usage":{"input_tokens":7,"output_tokens":2}}`)
		case <-r.Context().Done():
		}
	}))
	completed := make(chan struct{})
	started := false
	type answer struct {
		result Result
		err    error
	}
	answers := make(chan answer, 1)
	defer func() {
		finishProvider()
		origin.Close()
		if !started {
			return
		}
		timer := time.NewTimer(2 * time.Second)
		defer timer.Stop()
		select {
		case <-completed:
		case <-timer.C:
			t.Error("forward worker did not exit after local server cleanup")
		}
	}()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h := &Handler{Keys: &forwardUnitKeys{key: "platform-private-fixture"}, Upstreams: map[string]string{"openai": origin.URL}}
	request := httptest.NewRequest("POST", "/caller", nil)
	parsed, err := parseRequest("openai", "v1/responses", request.Header, []byte(`{"model":"gpt-6-sol"}`))
	require.NoError(t, err)
	response := httptest.NewRecorder()
	started = true
	go func() {
		defer close(completed)
		result, err := h.forward(ctx, response, request, "openai", routes["openai"], "v1/responses", parsed)
		answers <- answer{result, err}
	}()
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	select {
	case <-arrived:
	case <-timer.C:
		t.Fatal("local provider did not receive the request")
	}
	cancel()
	finishProvider()
	select {
	case value := <-answers:
		require.NoError(t, value.err)
		require.Equal(t, credits.ModelSucceeded, value.result.Outcome)
		require.Equal(t, int64(7), value.result.Usage.InputTokens)
		require.Equal(t, int64(2), value.result.Usage.OutputTokens)
		require.Equal(t, 200, response.Code)
		require.Equal(t, int64(1), requests.Load(), "caller cancellation must not retry inference")
	case <-timer.C:
		t.Fatal("forward did not finish after provider release")
	}
}

func TestForwardComponentProviderWireContracts(t *testing.T) {
	for _, item := range []struct{ provider, path, body, expected string }{
		{"openai", "v1/chat/completions", `{"model":"gpt-6-sol","messages":[],"stream":true}`, `{"model":"gpt-6-sol","messages":[],"stream":true,"max_completion_tokens":32768,"stream_options":{"include_usage":true}}`},
		{"anthropic", "v1/messages", `{"model":"claude-haiku-4-5","max_tokens":3,"messages":[]}`, `{"model":"claude-haiku-4-5","max_tokens":3,"messages":[]}`},
		{"vercel", "v4/ai/evaluation-model", `{"questions":{"1":"hello"}}`, `{"questions":{"1":"hello"}}`},
	} {
		t.Run(item.provider, func(t *testing.T) {
			type wireRequest struct {
				method, path, query string
				header              http.Header
				body                []byte
				length              int64
				err                 error
			}
			seen := make(chan wireRequest, 1)
			var requests atomic.Int64
			origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				raw, err := io.ReadAll(r.Body)
				select {
				case seen <- wireRequest{r.Method, r.URL.Path, r.URL.RawQuery, r.Header.Clone(), raw, r.ContentLength, err}:
				default:
				}
				w.Header().Set("Request-Id", "component-request")
				w.Header().Set("Set-Cookie", "provider-private-fixture")
				if item.provider == "openai" {
					w.Header().Set("Content-Type", "text/event-stream")
					_, _ = io.WriteString(w, "data: {\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":2}}\n\ndata: [DONE]\n\n")
				} else {
					w.Header().Set("Content-Type", "application/json")
					_, _ = io.WriteString(w, `{"usage":{"input_tokens":7,"output_tokens":2}}`)
				}
			}))
			defer origin.Close()
			h := &Handler{Keys: &forwardUnitKeys{key: "platform-private-fixture"}, Upstreams: map[string]string{item.provider: origin.URL + "/base/"}}
			request := httptest.NewRequest("POST", "/caller", nil)
			request.Header.Set("Authorization", "Bearer caller-private-fixture")
			request.Header.Set("X-Api-Key", "caller-private-fixture")
			request.Header.Set("Cookie", "caller-private-fixture")
			request.Header.Set("Ai-Model-Id", "typesafe-ai/jev")
			request.Header.Set("User-Agent", "component-sdk/1")
			parsed, err := parseRequest(item.provider, item.path, request.Header, []byte(item.body))
			require.NoError(t, err)
			response := httptest.NewRecorder()
			result, err := h.forward(context.Background(), response, request, item.provider, routes[item.provider], item.path, parsed)
			require.NoError(t, err)
			require.Equal(t, credits.ModelSucceeded, result.Outcome)
			require.Equal(t, int64(1), requests.Load(), "the wire contract describes exactly one provider dispatch")
			select {
			case wire := <-seen:
				require.NoError(t, wire.err)
				require.Equal(t, "POST", wire.method)
				require.Equal(t, "/base/"+item.path, wire.path)
				require.Empty(t, wire.query)
				require.JSONEq(t, item.expected, string(wire.body))
				require.Equal(t, int64(len(wire.body)), wire.length)
				require.Equal(t, "component-sdk/1", wire.header.Get("User-Agent"))
				require.Equal(t, "application/json", wire.header.Get("Content-Type"))
				require.Empty(t, wire.header.Get("Cookie"))
				if item.provider == "anthropic" {
					require.Equal(t, "platform-private-fixture", wire.header.Get("X-Api-Key"))
					require.Empty(t, wire.header.Get("Authorization"))
					require.Equal(t, "2023-06-01", wire.header.Get("Anthropic-Version"))
				} else {
					require.Equal(t, "Bearer platform-private-fixture", wire.header.Get("Authorization"))
					require.Empty(t, wire.header.Get("X-Api-Key"))
				}
				if item.provider == "vercel" {
					require.Equal(t, "api-key", wire.header.Get("Ai-Gateway-Auth-Method"))
				}
			default:
				t.Fatal("forward completed without a recorded provider request")
			}
			require.Equal(t, "component-request", response.Header().Get("Request-Id"))
			require.Empty(t, response.Header().Get("Set-Cookie"))
			if item.provider != "vercel" {
				require.Equal(t, int64(7), result.Usage.InputTokens)
				require.Equal(t, int64(2), result.Usage.OutputTokens)
			}
		})
	}
}
