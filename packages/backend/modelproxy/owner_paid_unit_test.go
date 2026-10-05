package modelproxy

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/credits"
)

// unitOwnerUsage records what the owner-paid path asks of its usage store
// and answers with refusal instead of spending when it is set.
type unitOwnerUsage struct {
	calls   []Call
	callers []Caller
	results []Result
	refusal error
}

func (u *unitOwnerUsage) Execute(ctx context.Context, caller Caller, call Call, spend func(context.Context) (Result, error)) error {
	u.calls, u.callers = append(u.calls, call), append(u.callers, caller)
	if u.refusal != nil {
		return u.refusal
	}
	result, err := spend(ctx)
	u.results = append(u.results, result)
	return err
}

// An install's own Gateway key serves its coding host: chat completions go
// to the Gateway with the owner's key, no credit is reserved (the zero Meter
// has no ledger and would refuse), the guest never holds the key, and the
// call is recorded with its token bound and the usage the provider reported.
func TestOwnerPaidForwardsGatewayChatWithTheOwnersKey(t *testing.T) {
	var sent *http.Request
	var body map[string]any
	keys := &forwardUnitKeys{key: "owner-gateway-fixture"}
	caller := &unitProxyCaller{}
	usage := &unitOwnerUsage{}
	h := &Handler{OwnerPaid: true, Owner: usage, Keys: keys, Callers: caller, Client: &http.Client{Transport: forwardUnitTransport(func(r *http.Request) (*http.Response, error) {
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
	require.Len(t, usage.calls, 1)
	call := usage.calls[0]
	require.Equal(t, "vercel", call.Provider)
	require.Equal(t, "openai/gpt-5.1", call.Model)
	require.True(t, call.Stream)
	// No output cap was sent: the default cap is added to the body and bounds the call.
	require.EqualValues(t, DefaultOutputCap, call.Maximum.OutputTokens)
	require.EqualValues(t, DefaultOutputCap, body["max_tokens"])
	require.Greater(t, call.Maximum.PromptTokens(), int64(0))
	require.Equal(t, Caller{OwnerType: "user", OwnerID: 1, Source: "app", UserID: 1}, usage.callers[0])
	require.Equal(t, credits.ModelSucceeded, usage.results[0].Outcome)
	require.EqualValues(t, 3, usage.results[0].Usage.InputTokens)
	require.EqualValues(t, 1, usage.results[0].Usage.OutputTokens)
}

// A spent budget, and missing or failed accounting, refuse before the key is
// read or the provider is contacted.
func TestOwnerPaidRefusesWithoutAccountingOrBudget(t *testing.T) {
	dispatch := forwardUnitTransport(func(*http.Request) (*http.Response, error) {
		t.Fatal("a refused call must never dispatch")
		return nil, nil
	})
	for _, item := range []struct {
		name    string
		owner   OwnerUsage
		status  int
		kind    string
		message string
	}{
		{"no accounting", nil, 503, "api_error", "Model usage accounting is unavailable."},
		{"accounting failed", &unitOwnerUsage{refusal: errors.New("database unavailable")}, 503, "api_error", "Model usage accounting is unavailable."},
		{"budget spent", &unitOwnerUsage{refusal: ErrDailyTokenBudget}, 429, "insufficient_quota", "The repository's daily token budget is spent; work resumes at 00:00 UTC."},
	} {
		t.Run(item.name, func(t *testing.T) {
			keys := &forwardUnitKeys{key: "owner-gateway-fixture"}
			h := &Handler{OwnerPaid: true, Owner: item.owner, Keys: keys, Callers: &unitProxyCaller{}, Client: &http.Client{Transport: dispatch}}
			request := httptest.NewRequest("POST", Path+"/vercel/v1/chat/completions", strings.NewReader(`{"model":"openai/gpt-5.1","max_tokens":64,"messages":[]}`))
			response := httptest.NewRecorder()
			h.ServeHTTP(response, request)
			require.Equal(t, item.status, response.Code)
			require.Contains(t, response.Body.String(), item.kind)
			require.Contains(t, response.Body.String(), item.message)
			require.Zero(t, keys.reads)
			if item.status == 429 {
				seconds, err := strconv.Atoi(response.Header().Get("Retry-After"))
				require.NoError(t, err)
				require.Greater(t, seconds, 0)
				require.LessOrEqual(t, seconds, 24*60*60+1)
			}
		})
	}
}

func TestUntilNextUTCDay(t *testing.T) {
	require.Equal(t, "1", untilNextUTCDay(time.Date(2026, 10, 5, 23, 59, 59, 500, time.UTC)))
	require.Equal(t, "86401", untilNextUTCDay(time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC)))
	// 01:00 PDT is 08:00 UTC: sixteen hours remain.
	require.Equal(t, "57601", untilNextUTCDay(time.Date(2026, 10, 5, 1, 0, 0, 0, time.FixedZone("PDT", -7*60*60))))
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
			usage := &unitOwnerUsage{}
			h := &Handler{OwnerPaid: item.ownerPaid, Owner: usage, Keys: keys, Callers: &unitProxyCaller{}, Client: &http.Client{Transport: dispatch}}
			request := httptest.NewRequest("POST", Path+item.path, strings.NewReader(item.body))
			request.Header = item.header
			response := httptest.NewRecorder()
			h.ServeHTTP(response, request)
			require.Equal(t, item.status, response.Code)
			require.Contains(t, response.Body.String(), item.message)
			require.Zero(t, keys.reads)
			require.Empty(t, usage.calls, "a refused request records nothing")
		})
	}
}
