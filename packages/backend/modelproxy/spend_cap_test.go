package modelproxy

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
)

// The daily spend cap counts every owner's platform-key spend since 00:00
// UTC: a settled call at its charge, an open reservation at its bound, a
// released call at nothing. A call whose bound would pass the cap is refused
// before any reservation, in the provider's exhausted-quota shape, so the
// run parks and retries hourly; the refusal logs the line the spend-cap alert
// counts (smithersai/plue#414).
func TestProxy_DailySpendCapRefusesEveryOwnerOnceReached(t *testing.T) {
	f := newProxyFixture(t)
	f.grant(1_000_000_000_000)
	body := anthropicBody(1000)
	bound := boundFor(t, ProviderAnthropic, "v1/messages", body)
	f.upstream = func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"type":"message","usage":{"input_tokens":10,"output_tokens":20}}`))
	}

	// No cap: the first call runs and settles at its charge.
	require.Equal(t, http.StatusOK, f.call("/model-proxy/anthropic/v1/messages", body).Code)
	spent := f.rows()[0].charged
	require.Positive(t, spent)

	// Exactly enough room for one more bound: admitted.
	f.handler.Meter.DailyCapNanos = spent + bound
	require.Equal(t, http.StatusOK, f.call("/model-proxy/anthropic/v1/messages", body).Code)
	spent += f.rows()[1].charged

	// One nano short of the next bound: refused for another owner too.
	f.handler.Meter.DailyCapNanos = spent + bound - 1
	f.handler.Callers = fixedCaller{Caller{OwnerType: "user", OwnerID: 8, UserID: 8, Source: SourceWorkspace}}
	hits, before := f.hits.Load(), f.balance()
	for _, tc := range []struct{ path, body string }{
		{"/model-proxy/anthropic/v1/messages", body},
		{"/model-proxy/openai/v1/chat/completions", `{"model":"gpt-5.5","messages":[{"role":"user","content":"hi"}]}`},
	} {
		recorder := f.call(tc.path, tc.body)
		require.Equal(t, http.StatusTooManyRequests, recorder.Code, tc.path)
		require.Equal(t, "3600", recorder.Header().Get("Retry-After"))
		require.Contains(t, recorder.Body.String(), `"type":"insufficient_quota"`)
	}
	require.Equal(t, hits, f.hits.Load(), "a refused call must not reach the provider")
	require.Equal(t, before, f.balance())
	require.Len(t, f.rows(), 2, "a refused call reserves nothing")
	require.Contains(t, f.logs.String(), "model provider spend cap reached: platform model calls are parked")
	require.Contains(t, f.logs.String(), "provider=openai")

	// An open reservation counts at its bound; the refused calls counted
	// nothing.
	f.handler.Callers = fixedCaller{Caller{OwnerType: "user", OwnerID: 7, UserID: 7, Source: SourceWorkspace}}
	f.handler.Meter.DailyCapNanos = spent + bound + bound
	_, err := f.pool.Exec(context.Background(), `INSERT INTO credit_reservations (account_id, request_key, reserved_nanos) VALUES ($1, 'open-call', $2)`, f.account, bound)
	require.NoError(t, err)
	_, err = f.pool.Exec(context.Background(), `INSERT INTO model_usage (request_key, credit_account_id, reservation_id, owner_type, owner_id, source, provider, model)
		SELECT 'open-call', $1, id, 'user', 7, 'workspace', 'anthropic', 'claude-haiku-4-5' FROM credit_reservations WHERE request_key = 'open-call'`, f.account)
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, f.call("/model-proxy/anthropic/v1/messages", body).Code)
	require.Equal(t, http.StatusTooManyRequests, f.call("/model-proxy/anthropic/v1/messages", body).Code, "the open reservation still counts")

	// A released reservation counts nothing.
	_, err = f.pool.Exec(context.Background(), `UPDATE credit_reservations SET status = 'released', charged_nanos = 0, settled_at = now() WHERE request_key = 'open-call'`)
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, f.call("/model-proxy/anthropic/v1/messages", body).Code)

	// Yesterday's spend does not count.
	_, err = f.pool.Exec(context.Background(), `UPDATE model_usage SET created_at = date_trunc('day', now(), 'UTC') - interval '1 second'`)
	require.NoError(t, err)
	f.handler.Meter.DailyCapNanos = bound
	require.Equal(t, http.StatusOK, f.call("/model-proxy/anthropic/v1/messages", body).Code)
}

func TestParseDailySpendCap(t *testing.T) {
	for value, want := range map[string]int64{
		"":         0,
		"  ":       0,
		"250":      250_000_000_000,
		" 12.5 ":   12_500_000_000,
		"0.000001": 1_000,
	} {
		got, err := ParseDailySpendCap(value)
		require.NoError(t, err, value)
		require.Equal(t, want, got, value)
	}
	for _, value := range []string{"0", "-1", "abc", "NaN", "Inf", "1e30", "$5", "0.0000000001"} {
		_, err := ParseDailySpendCap(value)
		require.ErrorContains(t, err, DailySpendCapEnv, value)
	}
}
