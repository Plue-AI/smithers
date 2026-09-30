package modelproxy

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/modelprice"
	"github.com/stretchr/testify/require"
)

// This is an explicit unit transport fake, not real-provider integration.
type forwardUnitTransport func(*http.Request) (*http.Response, error)

func (f forwardUnitTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type forwardUnitKeys struct {
	key   string
	err   error
	reads int
}

func (k *forwardUnitKeys) PlatformModelProviders() []string {
	return []string{"openai", "anthropic", "vercel"}
}
func (k *forwardUnitKeys) PlatformModelKey(context.Context, string) (string, error) {
	k.reads++
	return k.key, k.err
}

type forwardUnitBody struct {
	io.Reader
	closes int
}

func (b *forwardUnitBody) Close() error { b.closes++; return nil }

func TestForwardUnitKeyRefusalNeverDispatches(t *testing.T) {
	for _, item := range []struct {
		name, key string
		err       error
	}{
		{"lookup error", "", errors.New("secret-store unavailable")},
		{"blank", "  ", nil}, {"placeholder", "changeme-private-fixture", nil}, {"template", "<key>", nil},
	} {
		t.Run(item.name, func(t *testing.T) {
			keys := &forwardUnitKeys{key: item.key, err: item.err}
			h := &Handler{Keys: keys, Client: &http.Client{Transport: forwardUnitTransport(func(*http.Request) (*http.Response, error) {
				t.Fatal("unusable key must never dispatch")
				return nil, nil
			})}}
			request := httptest.NewRequest("POST", "/model-proxy/openai/v1/responses", strings.NewReader(`{"model":"gpt-6-sol"}`))
			parsed, err := parseRequest("openai", "v1/responses", request.Header, []byte(`{"model":"gpt-6-sol"}`))
			require.NoError(t, err)
			response := httptest.NewRecorder()
			result, err := h.forward(context.Background(), response, request, "openai", routes["openai"], "v1/responses", parsed)
			require.ErrorIs(t, err, ErrNotCharged)
			require.ErrorIs(t, err, ErrKeyMissing)
			require.Equal(t, credits.ModelFailed, result.Outcome)
			require.Equal(t, 503, response.Code)
			require.JSONEq(t, `{"error":{"type":"api_error","message":"This provider is not available."}}`, response.Body.String())
			require.Equal(t, 1, keys.reads)
		})
	}
}

func TestForwardUnitCredentialsAndDetachedContext(t *testing.T) {
	for _, item := range []struct{ provider, path, body string }{
		{"openai", "v1/responses", `{"model":"gpt-6-sol","max_output_tokens":3}`},
		{"anthropic", "v1/messages", `{"model":"claude-haiku-4-5","max_tokens":3,"messages":[]}`},
		{"vercel", "v4/ai/evaluation-model", `{"questions":{}}`},
	} {
		t.Run(item.provider, func(t *testing.T) {
			request := httptest.NewRequest("POST", "/caller", strings.NewReader(item.body))
			request.Header.Set("Authorization", "Bearer caller-private-fixture")
			request.Header.Set("X-Api-Key", "caller-private-fixture")
			request.Header.Set("Cookie", "caller-private-fixture")
			request.Header.Set("Ai-Model-Id", "typesafe-ai/jev")
			request.Header.Set("Accept", "application/json")
			parsed, err := parseRequest(item.provider, item.path, request.Header, []byte(item.body))
			require.NoError(t, err)
			type contextKey struct{}
			ctx, cancel := context.WithCancel(context.WithValue(context.Background(), contextKey{}, "caller-correlation"))
			cancel()
			body := &forwardUnitBody{Reader: strings.NewReader(`{"usage":{"input_tokens":7,"output_tokens":2}}`)}
			calls := 0
			keys := &forwardUnitKeys{key: "platform-private-fixture"}
			h := &Handler{Keys: keys, Upstreams: map[string]string{item.provider: "https://unit.invalid/base/"}, Client: &http.Client{Transport: forwardUnitTransport(func(sent *http.Request) (*http.Response, error) {
				defer sent.Body.Close()
				calls++
				require.Equal(t, "POST", sent.Method)
				require.Equal(t, "https://unit.invalid/base/"+item.path, sent.URL.String())
				require.NoError(t, sent.Context().Err(), "caller cancellation does not cancel metered inference")
				require.Equal(t, "caller-correlation", sent.Context().Value(contextKey{}))
				deadline, ok := sent.Context().Deadline()
				require.True(t, ok)
				require.WithinDuration(t, time.Now().Add(15*time.Minute), deadline, time.Second)
				raw, err := io.ReadAll(sent.Body)
				require.NoError(t, err)
				require.Equal(t, parsed.body, raw)
				require.Equal(t, int64(len(raw)), sent.ContentLength)
				require.Empty(t, sent.Header.Get("Cookie"))
				require.Equal(t, "application/json", sent.Header.Get("Content-Type"))
				if item.provider == "anthropic" {
					require.Empty(t, sent.Header.Get("Authorization"))
					require.Equal(t, "platform-private-fixture", sent.Header.Get("X-Api-Key"))
					require.Equal(t, "2023-06-01", sent.Header.Get("Anthropic-Version"))
				} else {
					require.Equal(t, "Bearer platform-private-fixture", sent.Header.Get("Authorization"))
					require.Empty(t, sent.Header.Get("X-Api-Key"))
				}
				if item.provider == "vercel" {
					require.Equal(t, "api-key", sent.Header.Get("Ai-Gateway-Auth-Method"))
				}
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: body, Request: sent}, nil
			})}}
			response := httptest.NewRecorder()
			result, err := h.forward(ctx, response, request, item.provider, routes[item.provider], item.path, parsed)
			require.NoError(t, err)
			require.Equal(t, credits.ModelSucceeded, result.Outcome)
			require.Equal(t, 200, result.Status)
			if item.provider != "vercel" {
				require.Equal(t, int64(7), result.Usage.InputTokens)
				require.Equal(t, int64(2), result.Usage.OutputTokens)
			}
			require.Equal(t, 1, calls)
			require.Equal(t, 1, keys.reads)
			require.Equal(t, 1, body.closes)
		})
	}
}

func TestForwardUnitStatusClassificationAndCredentialRedaction(t *testing.T) {
	for _, item := range []struct {
		name       string
		status     int
		body       string
		outcome    credits.ModelOutcome
		notCharged bool
		retry      string
	}{
		{"success usage", 200, `{"usage":{"input_tokens":7,"output_tokens":2}}`, credits.ModelSucceeded, false, ""},
		{"success without usage", 200, `{"answer":"hello"}`, credits.ModelUnknown, false, ""},
		{"malformed success", 200, `{`, credits.ModelUnknown, false, ""},
		{"unauthorized", 401, `platform-private-fixture`, credits.ModelFailed, true, ""},
		{"forbidden", 403, `platform-private-fixture`, credits.ModelFailed, true, ""},
		{"bad request", 400, `{"error":"bad input"}`, credits.ModelFailed, true, ""},
		{"rate limited", 429, `{"error":{"type":"rate_limit_error"}}`, credits.ModelFailed, true, ""},
		{"quota exhausted", 429, `{"error":{"code":"insufficient_quota"}}`, credits.ModelFailed, true, "3600"},
		{"quota error type", 429, `{"error":{"type":"insufficient_quota"}}`, credits.ModelFailed, true, "3600"},
		{"enforced spend cap", 429, `{"error":{"details":{"error_code":"enforced_spend_limit_reached"}}}`, credits.ModelFailed, true, "3600"},
		{"service unavailable", 503, `{"error":"unavailable"}`, credits.ModelFailed, true, ""},
		{"overloaded", 529, `{"error":"overloaded"}`, credits.ModelFailed, true, ""},
		{"not implemented", 501, `{"error":"not implemented"}`, credits.ModelFailed, true, ""},
		{"request timeout", 408, `{"error":"timeout"}`, credits.ModelUnknown, false, ""},
		{"bad gateway", 502, `{"error":"gateway"}`, credits.ModelUnknown, false, ""},
		{"internal error", 500, `{"error":"internal"}`, credits.ModelUnknown, false, ""},
		{"client closed request at gateway", 499, `{"error":"closed"}`, credits.ModelUnknown, false, ""},
		{"gateway timeout", 504, `{"error":"gateway timeout"}`, credits.ModelUnknown, false, ""},
		{"unclassified gateway error", 520, `{"error":"unknown gateway error"}`, credits.ModelUnknown, false, ""},
		{"gateway connection timeout", 522, `{"error":"connection timeout"}`, credits.ModelUnknown, false, ""},
		{"gateway response timeout", 524, `{"error":"response timeout"}`, credits.ModelUnknown, false, ""},
	} {
		t.Run(item.name, func(t *testing.T) {
			body := &forwardUnitBody{Reader: strings.NewReader(item.body)}
			h := &Handler{Keys: &forwardUnitKeys{key: "platform-private-fixture"}, Client: &http.Client{Transport: forwardUnitTransport(func(sent *http.Request) (*http.Response, error) {
				defer sent.Body.Close()
				return &http.Response{StatusCode: item.status, Header: http.Header{"Content-Type": []string{"application/json"}, "Set-Cookie": []string{"platform-private-fixture"}}, Body: body, Request: sent}, nil
			})}}
			request := httptest.NewRequest("POST", "/caller", nil)
			parsed, err := parseRequest("openai", "v1/responses", request.Header, []byte(`{"model":"gpt-6-sol"}`))
			require.NoError(t, err)
			response := httptest.NewRecorder()
			result, err := h.forward(context.Background(), response, request, "openai", routes["openai"], "v1/responses", parsed)
			require.Equal(t, item.outcome, result.Outcome)
			require.Equal(t, item.status, result.Status)
			if item.notCharged {
				require.ErrorIs(t, err, ErrNotCharged)
			} else if item.status >= 300 {
				require.EqualError(t, err, "modelproxy: provider answered HTTP "+strconv.Itoa(item.status))
			} else {
				require.NoError(t, err)
			}
			if item.status == 401 || item.status == 403 {
				require.Equal(t, 502, response.Code)
				require.JSONEq(t, `{"error":{"type":"api_error","message":"The provider refused the platform credential."}}`, response.Body.String())
			} else {
				require.Equal(t, item.status, response.Code)
				require.Equal(t, item.body, response.Body.String())
			}
			require.Empty(t, response.Header().Get("Set-Cookie"))
			require.Equal(t, item.retry, response.Header().Get("Retry-After"))
			require.Equal(t, 1, body.closes)
		})
	}
}

func TestForwardUnitEventStreamRequiresUsageAndTerminalFrame(t *testing.T) {
	for _, item := range []struct {
		name, content string
		outcome       credits.ModelOutcome
	}{
		{"complete", "data: {\"usage\":{\"input_tokens\":7,\"output_tokens\":2}}\n\ndata: [DONE]\n\n", credits.ModelSucceeded},
		{"terminal absent", "data: {\"usage\":{\"input_tokens\":7,\"output_tokens\":2}}\n\n", credits.ModelUnknown},
		{"error after terminal", "data: {\"usage\":{\"input_tokens\":7,\"output_tokens\":2}}\n\ndata: [DONE]\n\ndata: {\"type\":\"error\"}\n\n", credits.ModelUnknown},
	} {
		t.Run(item.name, func(t *testing.T) {
			body := &forwardUnitBody{Reader: strings.NewReader(item.content)}
			h := &Handler{Keys: &forwardUnitKeys{key: "platform-private-fixture"}, Client: &http.Client{Transport: forwardUnitTransport(func(sent *http.Request) (*http.Response, error) {
				defer sent.Body.Close()
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"Text/Event-Stream; charset=utf-8"}}, Body: body, Request: sent}, nil
			})}}
			request := httptest.NewRequest("POST", "/caller", nil)
			parsed, err := parseRequest("openai", "v1/responses", request.Header, []byte(`{"model":"gpt-6-sol","stream":true}`))
			require.NoError(t, err)
			response := httptest.NewRecorder()
			result, err := h.forward(context.Background(), response, request, "openai", routes["openai"], "v1/responses", parsed)
			require.NoError(t, err)
			require.Equal(t, item.outcome, result.Outcome)
			require.Equal(t, item.content, response.Body.String())
			require.True(t, response.Flushed, "event-stream frames flush to the caller")
			if item.outcome == credits.ModelSucceeded {
				require.Equal(t, int64(7), result.Usage.InputTokens)
				require.Equal(t, int64(2), result.Usage.OutputTokens)
			} else {
				require.Zero(t, result.Usage.InputTokens)
				require.Zero(t, result.Usage.OutputTokens)
			}
			require.Equal(t, 1, body.closes)
		})
	}
}

type forwardUnitReadFailure struct{ err error }

func (f forwardUnitReadFailure) Read([]byte) (int, error) { return 0, f.err }

func TestForwardUnitResponseReadFailureIsUnknownDespiteCompleteUsageJSON(t *testing.T) {
	raw := `{"usage":{"input_tokens":7,"output_tokens":2}}`
	body := &forwardUnitBody{Reader: io.MultiReader(strings.NewReader(raw), forwardUnitReadFailure{err: io.ErrUnexpectedEOF})}
	h := &Handler{Keys: &forwardUnitKeys{key: "platform-private-fixture"}, Client: &http.Client{Transport: forwardUnitTransport(func(sent *http.Request) (*http.Response, error) {
		defer sent.Body.Close()
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: body, Request: sent}, nil
	})}}
	request := httptest.NewRequest("POST", "/caller", nil)
	parsed, err := parseRequest("openai", "v1/responses", request.Header, []byte(`{"model":"gpt-6-sol"}`))
	require.NoError(t, err)
	response := httptest.NewRecorder()
	result, err := h.forward(context.Background(), response, request, "openai", routes["openai"], "v1/responses", parsed)
	require.NoError(t, err)
	require.Equal(t, 200, result.Status)
	require.Equal(t, credits.ModelUnknown, result.Outcome, "an incomplete HTTP body cannot prove a completed model call")
	require.Zero(t, result.Usage.InputTokens)
	require.Zero(t, result.Usage.OutputTokens)
	require.Equal(t, raw, response.Body.String(), "already received bytes are still relayed")
	require.Equal(t, 1, body.closes)
}

func TestForwardUnitConnectionRefusalBeforeSendDoesNotCharge(t *testing.T) {
	calls := 0
	h := &Handler{Keys: &forwardUnitKeys{key: "platform-private-fixture"}, Client: &http.Client{Transport: forwardUnitTransport(func(sent *http.Request) (*http.Response, error) {
		defer sent.Body.Close()
		calls++
		return nil, &net.OpError{Op: "dial", Net: "tcp", Err: syscall.ECONNREFUSED}
	})}}
	request := httptest.NewRequest("POST", "/caller", nil)
	parsed, err := parseRequest("openai", "v1/responses", request.Header, []byte(`{"model":"gpt-6-sol"}`))
	require.NoError(t, err)
	response := httptest.NewRecorder()
	result, err := h.forward(context.Background(), response, request, "openai", routes["openai"], "v1/responses", parsed)
	require.ErrorIs(t, err, ErrNotCharged)
	require.Equal(t, credits.ModelFailed, result.Outcome)
	require.Zero(t, result.Status)
	require.Equal(t, 502, response.Code)
	require.JSONEq(t, `{"error":{"type":"api_error","message":"Model provider unreachable."}}`, response.Body.String())
	require.Equal(t, 1, calls)
}

// Jev is priced per input token: a reading settles at the tokens it reported,
// and one that reported none is unknown, so the reserved ceiling is kept.
func TestForwardUnitJevSettlesReportedTokens(t *testing.T) {
	for _, item := range []struct {
		name    string
		body    string
		outcome credits.ModelOutcome
		usage   modelprice.Usage
	}{
		{"camel case usage", `{"answers":{"1":{"type":"boolean"}},"usage":{"inputTokens":120,"outputTokens":3}}`, credits.ModelSucceeded, modelprice.Usage{InputTokens: 120, OutputTokens: 3}},
		{"no usage", `{"answers":{"1":{"type":"boolean"}}}`, credits.ModelUnknown, modelprice.Usage{}},
	} {
		t.Run(item.name, func(t *testing.T) {
			h := &Handler{Keys: &forwardUnitKeys{key: "platform-private-fixture"}, Client: &http.Client{Transport: forwardUnitTransport(func(sent *http.Request) (*http.Response, error) {
				defer sent.Body.Close()
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: &forwardUnitBody{Reader: strings.NewReader(item.body)}, Request: sent}, nil
			})}}
			request := httptest.NewRequest("POST", "/caller", nil)
			request.Header.Set("Ai-Model-Id", JevModel)
			parsed, err := parseRequest("vercel", "v4/ai/evaluation-model", request.Header, []byte(`{"questions":{"1":"hello"}}`))
			require.NoError(t, err)
			response := httptest.NewRecorder()
			result, err := h.forward(context.Background(), response, request, "vercel", routes["vercel"], "v4/ai/evaluation-model", parsed)
			require.NoError(t, err)
			require.Equal(t, item.outcome, result.Outcome)
			require.Equal(t, item.usage, result.Usage)
			require.Equal(t, item.body, response.Body.String())
		})
	}
}
