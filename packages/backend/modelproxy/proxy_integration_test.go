package modelproxy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/modelprice"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

const platformKey = "sk-platform-SECRET-do-not-leak"

type fixedCaller struct{ caller Caller }

func (f fixedCaller) ResolveModelCaller(*http.Request) (Caller, error) { return f.caller, nil }

type proxyFixture struct {
	t       *testing.T
	pool    *pgxpool.Pool
	ledger  credits.Ledger
	account int64
	handler *Handler
	server  *httptest.Server
	hits    atomic.Int64
	// upstream answers every provider call.
	upstream func(w http.ResponseWriter, r *http.Request, body []byte)
	mu       sync.Mutex
	seen     []*http.Request
	bodies   [][]byte
	logs     *lockedBuffer
}

type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func newProxyFixture(t *testing.T) *proxyFixture {
	t.Helper()
	pool, _ := postgresfixture.NewProductDatabase(t)
	f := &proxyFixture{t: t, pool: pool, ledger: credits.Ledger{DB: pool}, logs: &lockedBuffer{}}
	var err error
	f.account, err = f.ledger.EnsureAccount(context.Background(), "user", 7)
	require.NoError(t, err)
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(f.logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(previous) })
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		f.hits.Add(1)
		f.mu.Lock()
		f.seen = append(f.seen, r.Clone(context.Background()))
		f.bodies = append(f.bodies, body)
		f.mu.Unlock()
		f.upstream(w, r, body)
	}))
	t.Cleanup(f.server.Close)
	upstreams := map[string]string{}
	for provider := range routes {
		upstreams[provider] = f.server.URL
	}
	keys := StaticKeys{}
	for _, seat := range Seats {
		keys[seat.Provider] = platformKey
	}
	f.handler = &Handler{
		Meter:     Meter{Ledger: f.ledger},
		Keys:      keys,
		Callers:   fixedCaller{Caller{OwnerType: "user", OwnerID: 7, UserID: 7, RepositoryID: 3, Source: SourceWorkspace, WorkspaceID: "ws-1"}},
		Upstreams: upstreams,
		Client:    &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
	}
	return f
}

func (f *proxyFixture) grant(nanos int64) {
	f.t.Helper()
	require.NoError(f.t, f.ledger.Grant(context.Background(), f.account, fmt.Sprintf("grant-%d", time.Now().UnixNano()), nanos, nil))
}

func (f *proxyFixture) balance() int64 {
	f.t.Helper()
	n, err := f.ledger.Balance(context.Background(), f.account)
	require.NoError(f.t, err)
	return n
}

func (f *proxyFixture) call(path, body string, header ...string) *httptest.ResponseRecorder {
	f.t.Helper()
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer caller-smithers-credential")
	for i := 0; i+1 < len(header); i += 2 {
		request.Header.Set(header[i], header[i+1])
	}
	recorder := httptest.NewRecorder()
	f.handler.ServeHTTP(recorder, request)
	return recorder
}

type usageRow struct {
	outcome                                 string
	input, output, cacheRead, cacheWrite    int64
	cacheWrite1h                            int64
	cost                                    *int64
	reserved, charged                       int64
	status                                  string
	provider, model, source, workspace, ref string
}

func (f *proxyFixture) rows() []usageRow {
	f.t.Helper()
	rows, err := f.pool.Query(context.Background(), `SELECT u.outcome, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens, u.cache_write_1h_tokens,
			u.cost_nanos, r.reserved_nanos, COALESCE(r.charged_nanos, -1), r.status, u.provider, u.model, u.source, COALESCE(u.workspace_id, ''), u.reference
		FROM model_usage u JOIN credit_reservations r ON r.id = u.reservation_id ORDER BY u.id`)
	require.NoError(f.t, err)
	defer rows.Close()
	var out []usageRow
	for rows.Next() {
		var row usageRow
		require.NoError(f.t, rows.Scan(&row.outcome, &row.input, &row.output, &row.cacheRead, &row.cacheWrite, &row.cacheWrite1h, &row.cost,
			&row.reserved, &row.charged, &row.status, &row.provider, &row.model, &row.source, &row.workspace, &row.ref))
		out = append(out, row)
	}
	require.NoError(f.t, rows.Err())
	return out
}

func anthropicBody(maxTokens int) string {
	return fmt.Sprintf(`{"model":"claude-haiku-4-5","max_tokens":%d,"messages":[{"role":"user","content":"hi"}]}`, maxTokens)
}

func boundFor(t *testing.T, provider, path, body string) int64 {
	t.Helper()
	parsed, err := parseRequest(provider, path, http.Header{}, []byte(body))
	require.NoError(t, err)
	_, price, ok := Price(provider, parsed.model)
	require.True(t, ok)
	bound, err := Bound(price, parsed.maximum(price))
	require.NoError(t, err)
	return bound
}

func costOf(t *testing.T, model string, usage modelprice.Usage) int64 {
	t.Helper()
	price, ok := modelprice.Lookup(model)
	require.True(t, ok)
	n, err := modelprice.CostNanos(price, usage)
	require.NoError(t, err)
	return n
}

// Concurrent calls against a small balance: exactly as many calls reach the
// provider as the balance covers at their bound, and nothing is overspent.
func TestProxy_ConcurrentCallsNeverOverspend(t *testing.T) {
	f := newProxyFixture(t)
	body := anthropicBody(1000)
	bound := boundFor(t, ProviderAnthropic, "v1/messages", body)
	const covered, callers = 5, 24
	f.grant(bound*covered + bound/2)
	var refused atomic.Int64
	f.upstream = func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		// Hold every admitted call until the rest were refused, so all
		// reservations overlap.
		deadline := time.Now().Add(20 * time.Second)
		for f.hits.Load()+refused.Load() < callers && time.Now().Before(deadline) {
			time.Sleep(5 * time.Millisecond)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"type":"message","usage":{"input_tokens":10,"output_tokens":20}}`))
	}
	var wg sync.WaitGroup
	codes := make(chan int, callers)
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			recorder := f.call("/model-proxy/anthropic/v1/messages", body)
			if recorder.Code == http.StatusPaymentRequired {
				refused.Add(1)
				assert.Contains(t, recorder.Body.String(), `"code":"out_of_credit"`)
			}
			codes <- recorder.Code
		}()
	}
	wg.Wait()
	close(codes)
	served := 0
	for code := range codes {
		if code == http.StatusOK {
			served++
		}
	}
	require.Equal(t, int64(covered), f.hits.Load(), "exactly the calls the balance covers reach the provider")
	require.Equal(t, covered, served)
	actual := costOf(t, "claude-haiku-4-5", modelprice.Usage{InputTokens: 10, OutputTokens: 20})
	require.Equal(t, bound*covered+bound/2-actual*covered, f.balance())
	rows := f.rows()
	require.Len(t, rows, covered)
	for _, row := range rows {
		require.Equal(t, "succeeded", row.outcome)
		require.Equal(t, actual, row.charged)
		require.Equal(t, bound, row.reserved)
	}
	var debt int64
	require.NoError(t, f.pool.QueryRow(context.Background(), `SELECT debt_nanos FROM credit_accounts WHERE id = $1`, f.account).Scan(&debt))
	require.Zero(t, debt)
}

// A streamed call settles from its final usage frame, and the caller receives
// every frame as the provider sent it.
func TestProxy_StreamSettlesFromTheFinalUsageFrame(t *testing.T) {
	f := newProxyFixture(t)
	f.grant(1_000_000_000)
	frames := []string{
		`event: message_start` + "\n" + `data: {"type":"message_start","message":{"usage":{"input_tokens":120,"cache_read_input_tokens":40,"cache_creation_input_tokens":8,"output_tokens":1}}}`,
		`event: content_block_delta` + "\n" + `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}`,
		`event: message_delta` + "\n" + `data: {"type":"message_delta","usage":{"output_tokens":15}}`,
		`event: message_delta` + "\n" + `data: {"type":"message_delta","usage":{"output_tokens":33}}`,
		`event: message_stop` + "\n" + `data: {"type":"message_stop"}`,
	}
	f.upstream = func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		w.Header().Set("Content-Type", "text/event-stream")
		for _, frame := range frames {
			_, _ = io.WriteString(w, frame+"\n\n")
			w.(http.Flusher).Flush()
		}
	}
	before := f.balance()
	recorder := f.call("/model-proxy/anthropic/v1/messages", `{"model":"claude-haiku-4-5","max_tokens":2000,"stream":true,"messages":[{"role":"user","content":"hi"}]}`)
	require.Equal(t, http.StatusOK, recorder.Code)
	for _, frame := range frames {
		require.Contains(t, recorder.Body.String(), frame)
	}
	usage := modelprice.Usage{InputTokens: 120, OutputTokens: 33, CacheReadTokens: 40, CacheWriteTokens: 8}
	actual := costOf(t, "claude-haiku-4-5", usage)
	require.Equal(t, before-actual, f.balance())
	rows := f.rows()
	require.Len(t, rows, 1)
	require.Equal(t, "succeeded", rows[0].outcome)
	require.Equal(t, []int64{120, 33, 40, 8}, []int64{rows[0].input, rows[0].output, rows[0].cacheRead, rows[0].cacheWrite})
	require.Equal(t, actual, *rows[0].cost)
	require.Equal(t, actual, rows[0].charged)
	require.Equal(t, []string{"anthropic", "claude-haiku-4-5", "workspace", "ws-1"}, []string{rows[0].provider, rows[0].model, rows[0].source, rows[0].workspace})
}

// A 1-hour cache request is admitted, reserved at the 1-hour write rate, and
// settled with its 5-minute and 1-hour writes priced apart, streamed or not.
func TestProxy_AnthropicOneHourCacheWritesSettleAtTheirOwnRate(t *testing.T) {
	split := `"cache_creation_input_tokens":200,"cache_creation":{"ephemeral_5m_input_tokens":100,"ephemeral_1h_input_tokens":100}`
	for _, stream := range []bool{false, true} {
		t.Run(fmt.Sprint("stream=", stream), func(t *testing.T) {
			f := newProxyFixture(t)
			f.grant(1_000_000_000)
			f.upstream = func(w http.ResponseWriter, _ *http.Request, _ []byte) {
				if !stream {
					w.Header().Set("Content-Type", "application/json")
					_, _ = io.WriteString(w, `{"type":"message","usage":{"input_tokens":10,"output_tokens":5,`+split+`}}`)
					return
				}
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(w, `data: {"type":"message_start","message":{"usage":{"input_tokens":10,`+split+`}}}`+"\n\n")
				_, _ = io.WriteString(w, `data: {"type":"message_delta","usage":{"output_tokens":5,"cache_creation_input_tokens":200}}`+"\n\n")
				_, _ = io.WriteString(w, `data: {"type":"message_stop"}`+"\n\n")
			}
			body := fmt.Sprintf(`{"model":"claude-haiku-4-5","max_tokens":10,"stream":%t,"system":[{"type":"text","text":"x","cache_control":{"type":"ephemeral","ttl":"1h"}}],"messages":[{"role":"user","content":"hi"}]}`, stream)
			bound := boundFor(t, ProviderAnthropic, "v1/messages", body)
			before := f.balance()
			recorder := f.call("/model-proxy/anthropic/v1/messages", body)
			require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
			actual := costOf(t, "claude-haiku-4-5", modelprice.Usage{InputTokens: 10, OutputTokens: 5, CacheWriteTokens: 200, CacheWrite1hTokens: 100})
			require.Equal(t, int64(10*1000+5*5000+325_000), actual, "100 writes at $1.25 and 100 at $2 per million")
			require.Equal(t, before-actual, f.balance())
			rows := f.rows()
			require.Len(t, rows, 1)
			require.Equal(t, "succeeded", rows[0].outcome)
			require.Equal(t, []int64{10, 5, 0, 200, 100}, []int64{rows[0].input, rows[0].output, rows[0].cacheRead, rows[0].cacheWrite, rows[0].cacheWrite1h})
			require.Equal(t, actual, *rows[0].cost)
			require.Equal(t, bound, rows[0].reserved)
		})
	}
}

// Chat Completions streams are asked for their usage chunk, and OpenAI's
// cached tokens are not billed twice.
func TestProxy_ChatStreamRequestsUsageAndSettlesOnDone(t *testing.T) {
	f := newProxyFixture(t)
	f.grant(5_000_000_000)
	f.upstream = func(w http.ResponseWriter, _ *http.Request, body []byte) {
		var doc struct {
			StreamOptions struct {
				IncludeUsage bool `json:"include_usage"`
			} `json:"stream_options"`
			MaxCompletionTokens int `json:"max_completion_tokens"`
		}
		require.NoError(t, json.Unmarshal(body, &doc))
		assert.True(t, doc.StreamOptions.IncludeUsage)
		assert.Equal(t, DefaultOutputCap, doc.MaxCompletionTokens, "an uncapped request gets a provider-enforced ceiling")
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}],\"usage\":null}\n\n")
		_, _ = io.WriteString(w, "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":7,\"prompt_tokens_details\":{\"cached_tokens\":60}}}\n\n")
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	}
	before := f.balance()
	recorder := f.call("/model-proxy/openai/v1/chat/completions", `{"model":"gpt-5.5","stream":true,"messages":[{"role":"user","content":"hi"}]}`)
	require.Equal(t, http.StatusOK, recorder.Code)
	actual := costOf(t, "gpt-5.5", modelprice.Usage{InputTokens: 40, CacheReadTokens: 60, OutputTokens: 7})
	require.Equal(t, before-actual, f.balance())
	require.Equal(t, "succeeded", f.rows()[0].outcome)
}

// A refused call is released in full and the provider's answer relayed.
func TestProxy_ProviderFailureReleases(t *testing.T) {
	f := newProxyFixture(t)
	f.grant(1_000_000_000)
	f.upstream = func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"type":"error","error":{"type":"overloaded_error","message":"busy"}}`))
	}
	before := f.balance()
	recorder := f.call("/model-proxy/anthropic/v1/messages", anthropicBody(1000))
	require.Equal(t, http.StatusServiceUnavailable, recorder.Code)
	require.Contains(t, recorder.Body.String(), "overloaded_error")
	require.Equal(t, before, f.balance())
	rows := f.rows()
	require.Equal(t, "failed", rows[0].outcome)
	require.Equal(t, "released", rows[0].status)
	require.Zero(t, rows[0].charged)

	// A provider that cannot be reached never received the call.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	closed := "http://" + listener.Addr().String()
	require.NoError(t, listener.Close())
	f.handler.Upstreams[ProviderAnthropic] = closed
	recorder = f.call("/model-proxy/anthropic/v1/messages", anthropicBody(1000))
	require.Equal(t, http.StatusBadGateway, recorder.Code)
	require.Equal(t, before, f.balance())
	require.Equal(t, "failed", f.rows()[1].outcome)
}

// A provider spend cap on the platform key is released, relayed in the
// provider's own shape, and re-checked hourly; an ordinary rate limit keeps
// the provider's Retry-After (smithersai/plue#528, plue 67f084ea1).
func TestProxy_ProviderSpendCapParksHourly(t *testing.T) {
	f := newProxyFixture(t)
	f.grant(1_000_000_000_000)
	before := f.balance()
	for _, tc := range []struct {
		path, body, answer, retry string
	}{
		{"/model-proxy/anthropic/v1/messages", anthropicBody(1000),
			`{"type":"error","error":{"type":"rate_limit_error","message":"You will regain access on 2099-10-01 at 00:00 UTC.","details":{"error_code":"enforced_spend_limit_reached"}}}`, "3600"},
		{"/model-proxy/openai/v1/chat/completions", `{"model":"gpt-5.5","messages":[{"role":"user","content":"hi"}]}`,
			`{"error":{"type":"insufficient_quota","code":"insufficient_quota","message":"You exceeded your current quota."}}`, "3600"},
		{"/model-proxy/anthropic/v1/messages", anthropicBody(1000),
			`{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}`, "7"},
	} {
		f.upstream = func(w http.ResponseWriter, _ *http.Request, _ []byte) {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Retry-After", "7")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(tc.answer))
		}
		recorder := f.call(tc.path, tc.body)
		require.Equal(t, http.StatusTooManyRequests, recorder.Code)
		require.Equal(t, tc.retry, recorder.Header().Get("Retry-After"))
		require.JSONEq(t, tc.answer, recorder.Body.String())
	}
	require.Equal(t, before, f.balance())
	for _, row := range f.rows() {
		require.Equal(t, "released", row.status)
	}
	require.Contains(t, f.logs.String(), "spend cap reached")
}

// A call whose usage cannot be read is charged its full bound: a stream cut
// before its final frame, and a success with no usage.
func TestProxy_UnknownOutcomeChargesTheBound(t *testing.T) {
	f := newProxyFixture(t)
	f.grant(1_000_000_000)
	f.upstream = func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, `data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}`+"\n\n")
		w.(http.Flusher).Flush()
		connection, _, err := w.(http.Hijacker).Hijack()
		if err == nil {
			_ = connection.Close()
		}
	}
	body := `{"model":"claude-haiku-4-5","max_tokens":1000,"stream":true,"messages":[{"role":"user","content":"hi"}]}`
	bound := boundFor(t, ProviderAnthropic, "v1/messages", body)
	before := f.balance()
	f.call("/model-proxy/anthropic/v1/messages", body)
	require.Equal(t, before-bound, f.balance())
	rows := f.rows()
	require.Equal(t, "unknown", rows[0].outcome)
	require.Equal(t, bound, rows[0].charged)
	require.Nil(t, rows[0].cost)

	f.upstream = func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"type":"message","content":[]}`))
	}
	before = f.balance()
	recorder := f.call("/model-proxy/anthropic/v1/messages", anthropicBody(1000))
	require.Equal(t, http.StatusOK, recorder.Code)
	require.Equal(t, before-boundFor(t, ProviderAnthropic, "v1/messages", anthropicBody(1000)), f.balance())
	require.Equal(t, "unknown", f.rows()[1].outcome)
}

// A model without a price, or a request the size cannot bound, never reaches
// the provider and reserves nothing.
func TestProxy_RefusesUnpricedAndUnboundedCalls(t *testing.T) {
	f := newProxyFixture(t)
	f.grant(1_000_000_000)
	f.upstream = func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		t.Error("refused calls must not reach the provider")
	}
	for _, tc := range []struct{ path, body string }{
		{"/model-proxy/anthropic/v1/messages", `{"model":"claude-imaginary-9","max_tokens":10,"messages":[]}`},
		{"/model-proxy/cerebras/v1/chat/completions", `{"model":"claude-haiku-4-5","max_tokens":10,"messages":[]}`},
		{"/model-proxy/cerebras/v1/chat/completions", `{"model":"qwen-3-coder-480b","max_tokens":10,"messages":[]}`},
		{"/model-proxy/anthropic/v1/messages", `{"model":"claude-haiku-4-5","messages":[]}`},
		{"/model-proxy/openai/v1/responses", `{"model":"gpt-5.5","previous_response_id":"resp_1","input":"hi"}`},
		{"/model-proxy/openai/v1/responses", `{"model":"gpt-5.5","input":[{"role":"user","content":[{"type":"input_file","file_id":"file_1"}]}]}`},
		{"/model-proxy/openai/v1/responses", `{"model":"gpt-5.5","input":"hi","tools":[{"type":"web_search"}]}`},
		{"/model-proxy/openai/v1/responses", `{"model":"gpt-5.5","input":"hi","service_tier":"priority"}`},
		{"/model-proxy/anthropic/v1/messages", `{"model":"claude-haiku-4-5","max_tokens":10,"messages":[{"role":"user","content":[{"type":"image","source":{"type":"url","url":"https://example.com/a.png"}}]}]}`},
		{"/model-proxy/anthropic/v1/messages", `{"model":"claude-haiku-4-5","max_tokens":10,"system":[{"type":"text","text":"x","cache_control":{"type":"ephemeral","ttl":"24h"}}],"messages":[]}`},
		{"/model-proxy/openrouter/v1/chat/completions", `{"model":"anthropic/claude-haiku-4-5","max_tokens":10,"messages":[{"role":"user","content":[{"type":"text","text":"x","cache_control":{"type":"ephemeral","ttl":"1h"}}]}]}`},
		{"/model-proxy/openrouter/v1/chat/completions", `{"model":"openai/gpt-oss-120b:online","messages":[]}`},
		{"/model-proxy/vercel/v4/ai/evaluation-model", `{"questions":{}}`},
	} {
		recorder := f.call(tc.path, tc.body)
		require.Equal(t, http.StatusBadRequest, recorder.Code, tc.body+" -> "+recorder.Body.String())
	}
	require.Zero(t, f.hits.Load())
	var reservations int
	require.NoError(t, f.pool.QueryRow(context.Background(), `SELECT count(*) FROM credit_reservations`).Scan(&reservations))
	require.Zero(t, reservations)
}

// Usage above the bound is owed as debt, and debt blocks the next call.
func TestProxy_DebtBlocksNewSpend(t *testing.T) {
	f := newProxyFixture(t)
	body := anthropicBody(10)
	bound := boundFor(t, ProviderAnthropic, "v1/messages", body)
	f.grant(bound * 3)
	f.upstream = func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"usage":{"input_tokens":5000000,"output_tokens":10}}`))
	}
	require.Equal(t, http.StatusOK, f.call("/model-proxy/anthropic/v1/messages", body).Code)
	var debt int64
	require.NoError(t, f.pool.QueryRow(context.Background(), `SELECT debt_nanos FROM credit_accounts WHERE id = $1`, f.account).Scan(&debt))
	require.Positive(t, debt)
	recorder := f.call("/model-proxy/anthropic/v1/messages", body)
	require.Equal(t, http.StatusPaymentRequired, recorder.Code)
	require.Equal(t, int64(1), f.hits.Load())
}

// The platform key reaches only the provider: never the caller, a usage row,
// or a log line; the caller's own credential never reaches the provider.
func TestProxy_NeverLeaksTheKey(t *testing.T) {
	f := newProxyFixture(t)
	f.grant(1_000_000_000)
	f.upstream = func(w http.ResponseWriter, r *http.Request, _ []byte) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Echo", r.Header.Get("X-Api-Key"))
		if r.Header.Get("Ai-Model-Id") != "" {
			_, _ = w.Write([]byte(`{"answers":{}}`))
			return
		}
		if strings.Contains(r.URL.Path, "chat") {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":{"message":"bad key"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"usage":{"input_tokens":1,"output_tokens":1}}`))
	}
	responses := []*httptest.ResponseRecorder{
		f.call("/model-proxy/anthropic/v1/messages", anthropicBody(10)),
		f.call("/api/model/cerebras/v1/chat/completions", `{"model":"gpt-oss-120b","messages":[]}`),
		f.call("/model-proxy/vercel/v4/ai/evaluation-model", `{"questions":{}}`, "Ai-Model-Id", JevModel),
		f.call("/model-proxy/openrouter/v1/chat/completions", `{"model":"openai/gpt-oss-120b","messages":[]}`),
	}
	for _, recorder := range responses {
		require.NotContains(t, recorder.Body.String(), platformKey)
		for _, values := range recorder.Header() {
			for _, value := range values {
				require.NotContains(t, value, platformKey)
			}
		}
	}
	require.Equal(t, int64(4), f.hits.Load())
	f.mu.Lock()
	for i, request := range f.seen {
		assert.NotContains(t, request.Header.Get("Authorization"), "caller-smithers-credential")
		switch {
		case strings.HasSuffix(request.URL.Path, "/messages"):
			assert.Equal(t, platformKey, request.Header.Get("X-Api-Key"))
		default:
			assert.Equal(t, "Bearer "+platformKey, request.Header.Get("Authorization"))
		}
		if strings.Contains(request.URL.Path, "openrouter") || i == 3 {
			assert.Contains(t, string(f.bodies[i]), `"max_price"`, "OpenRouter is held to the reserved rate")
		}
	}
	f.mu.Unlock()
	var dump string
	require.NoError(t, f.pool.QueryRow(context.Background(), `SELECT string_agg(row_to_json(u)::text, ' ') FROM model_usage u`).Scan(&dump))
	require.NotContains(t, dump, platformKey)
	require.NotContains(t, f.logs.String(), platformKey)
	rows := f.rows()
	require.Equal(t, "failed", rows[1].outcome, "the provider's 401 is released")
	require.Equal(t, "succeeded", rows[2].outcome, "Jev is priced per call")
	require.Equal(t, int64(2_000_000), rows[2].charged)
}

// A gateway status can arrive after the model ran, so it is charged the bound;
// a provider 401 is answered without the provider's body.
func TestProxy_GatewayStatusIsUnknownAndKeyRefusalIsOpaque(t *testing.T) {
	f := newProxyFixture(t)
	f.grant(1_000_000_000)
	status := http.StatusBadGateway
	f.upstream = func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"error":{"message":"Incorrect API key provided: sk-pl***leak"}}`))
	}
	body := anthropicBody(1000)
	before := f.balance()
	require.Equal(t, http.StatusBadGateway, f.call("/model-proxy/anthropic/v1/messages", body).Code)
	require.Equal(t, before-boundFor(t, ProviderAnthropic, "v1/messages", body), f.balance())
	require.Equal(t, "unknown", f.rows()[0].outcome)

	status = http.StatusUnauthorized
	before = f.balance()
	recorder := f.call("/model-proxy/anthropic/v1/messages", body)
	require.NotContains(t, recorder.Body.String(), "leak")
	require.Equal(t, before, f.balance())
	require.Equal(t, "failed", f.rows()[1].outcome)
}

// A call whose prompt crosses the long-context threshold is reserved and
// settled at the long rates; one below it at the standard rates.
func TestProxy_LongContextPromptIsReservedAndSettledAtTheLongRates(t *testing.T) {
	f := newProxyFixture(t)
	f.grant(100_000_000_000)
	price, ok := modelprice.Lookup("gpt-6.1-sol")
	require.True(t, ok)
	for _, tc := range []struct {
		name   string
		prompt int64
		rates  modelprice.Rates
	}{
		{"below", modelprice.OpenAILongContextFrom - 1, price.Rates},
		{"at", modelprice.OpenAILongContextFrom, price.LongContext},
		{"above", modelprice.OpenAILongContextFrom + 1, price.LongContext},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cached, written := tc.prompt/2, int64(1000)
			f.upstream = func(w http.ResponseWriter, _ *http.Request, _ []byte) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = fmt.Fprintf(w, `{"object":"response","usage":{"input_tokens":%d,"output_tokens":700,"input_tokens_details":{"cached_tokens":%d,"cache_write_tokens":%d}}}`,
					tc.prompt, cached, written)
			}
			before := len(f.rows())
			body := responsesBody("gpt-6.1-sol", int(tc.prompt))
			recorder := f.call("/model-proxy/openai/v1/responses", body)
			require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
			rows := f.rows()
			require.Len(t, rows, before+1)
			row := rows[len(rows)-1]
			uncached := tc.prompt - cached - written
			want := (uncached*tc.rates.InputPerMTok + cached*tc.rates.CacheReadPerMTok + written*tc.rates.CacheWritePerMTok + 700*tc.rates.OutputPerMTok + 999) / 1000
			require.Equal(t, "succeeded", row.outcome)
			require.Equal(t, want, row.charged)
			require.Equal(t, uncached, row.input)
			require.Equal(t, cached, row.cacheRead)
			require.Equal(t, written, row.cacheWrite)
			// The body is at least as long as the prompt, so the bound is at
			// the long rates in every case and covers the charge.
			require.Equal(t, boundFor(t, ProviderOpenAI, "v1/responses", body), row.reserved)
			require.GreaterOrEqual(t, row.reserved, row.charged)
		})
	}
}
