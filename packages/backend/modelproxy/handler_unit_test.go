package modelproxy

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

type unitProxyKeys struct {
	providers []string
	reads     int
}

func (k *unitProxyKeys) PlatformModelProviders() []string { return k.providers }
func (k *unitProxyKeys) PlatformModelKey(context.Context, string) (string, error) {
	k.reads++
	return "", ErrKeyMissing
}

type unitProxyCaller struct {
	calls   int
	failure error
}

func (c *unitProxyCaller) ResolveModelCaller(*http.Request) (Caller, error) {
	c.calls++
	return Caller{OwnerType: "user", OwnerID: 1, Source: "app", UserID: 1}, c.failure
}

type unitReadBody struct {
	reads int
	body  io.Reader
}

func (b *unitReadBody) Read(p []byte) (int, error) { b.reads++; return b.body.Read(p) }
func (b *unitReadBody) Close() error               { return nil }

func TestHandlerUnitRoutingAndAuthenticationPrecedeBodyAndKeys(t *testing.T) {
	for _, item := range []struct {
		name, method, path string
		offered            bool
		failure            error
		status             int
		kind, message      string
		calls              int
	}{
		{"unknown provider", "POST", Path + "/unknown/v1/responses", true, nil, 404, "not_found_error", "This provider is not offered on platform keys.", 0},
		{"unoffered provider", "POST", Path + "/openai/v1/responses", false, nil, 404, "not_found_error", "This provider is not offered on platform keys.", 0},
		{"wrong method", "GET", Path + "/openai/v1/responses", true, nil, 404, "not_found_error", "Only POST v1/responses, v1/chat/completions is served.", 0},
		{"unsupported path", "POST", Path + "/openai/v1/models", true, nil, 404, "not_found_error", "Only POST v1/responses, v1/chat/completions is served.", 0},
		{"unauthenticated", "POST", Path + "/openai/v1/responses", true, fmt.Errorf("wrapped: %w", ErrUnauthenticated), 401, "authentication_error", "Authentication required.", 1},
		{"forbidden", "POST", APIPath + "/openai/v1/responses", true, fmt.Errorf("wrapped: %w", ErrForbidden), 403, "permission_error", "This credential may not spend platform models.", 1},
		{"resolver failure", "POST", Path + "/openai/v1/responses", true, errors.New("caller unavailable"), 403, "permission_error", "This credential may not spend platform models.", 1},
	} {
		t.Run(item.name, func(t *testing.T) {
			keys := &unitProxyKeys{}
			if item.offered {
				keys.providers = []string{"openai"}
			}
			caller := &unitProxyCaller{failure: item.failure}
			body := &unitReadBody{body: strings.NewReader(`{"model":"gpt-6-sol"}`)}
			request := httptest.NewRequest(item.method, item.path, nil)
			request.Body = body
			response := httptest.NewRecorder()
			(&Handler{Keys: keys, Callers: caller}).ServeHTTP(response, request)
			require.Equal(t, item.status, response.Code)
			require.JSONEq(t, fmt.Sprintf(`{"error":{"type":%q,"message":%q}}`, item.kind, item.message), response.Body.String())
			require.Equal(t, "application/json", response.Header().Get("Content-Type"))
			require.Equal(t, "private, no-store", response.Header().Get("Cache-Control"))
			require.Equal(t, item.calls, caller.calls)
			require.Zero(t, body.reads)
			require.Zero(t, keys.reads, "no provider credential or dispatch before admission")
		})
	}
}

func TestHandlerUnitBodyLimitBoundary(t *testing.T) {
	raw := `{"model":"unpriced-unit-model"}`
	for _, item := range []struct {
		name    string
		limit   int64
		status  int
		message string
	}{
		{"one below body", int64(len(raw) - 1), 413, "Request body is too large."},
		{"exact body", int64(len(raw)), 400, "Model unpriced-unit-model is not offered on platform keys."},
		{"one above body", int64(len(raw) + 1), 400, "Model unpriced-unit-model is not offered on platform keys."},
		{"default", 0, 400, "Model unpriced-unit-model is not offered on platform keys."},
		{"negative selects default", -1, 400, "Model unpriced-unit-model is not offered on platform keys."},
	} {
		t.Run(item.name, func(t *testing.T) {
			keys := &unitProxyKeys{providers: []string{"openai"}}
			caller := &unitProxyCaller{}
			response := httptest.NewRecorder()
			(&Handler{Keys: keys, Callers: caller, MaxBodyBytes: item.limit}).ServeHTTP(response, httptest.NewRequest("POST", Path+"/openai/v1/responses", strings.NewReader(raw)))
			require.Equal(t, item.status, response.Code)
			require.JSONEq(t, fmt.Sprintf(`{"error":{"type":"invalid_request_error","message":%q}}`, item.message), response.Body.String())
			require.Equal(t, 1, caller.calls)
			require.Zero(t, keys.reads)
		})
	}
}

func TestHandlerUnitOutputBoundOverflowRefusesBeforeMeteringOrProviderDispatch(t *testing.T) {
	keys := &unitProxyKeys{providers: []string{"openai"}}
	caller := &unitProxyCaller{}
	response := httptest.NewRecorder()
	body := strings.NewReader(`{"model":"gpt-6-sol","max_output_tokens":4611686018427387905,"n":4}`)
	// The unconfigured meter would answer 503 if reached. Request rejection must
	// precede credit admission; no SQL substitute or paid upstream is installed.
	(&Handler{Keys: keys, Callers: caller}).ServeHTTP(response, httptest.NewRequest("POST", Path+"/openai/v1/responses", body))
	require.Equal(t, http.StatusBadRequest, response.Code)
	require.JSONEq(t, `{"error":{"type":"invalid_request_error","message":"combined output token limit is too large"}}`, response.Body.String())
	require.Equal(t, 1, caller.calls)
	require.Zero(t, keys.reads)
}
