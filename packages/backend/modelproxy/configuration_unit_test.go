package modelproxy

import (
	"context"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/modelprice"
	"github.com/stretchr/testify/require"
)

func TestConfigurationUnitSeatOrderAndGuestEnvironment(t *testing.T) {
	require.Nil(t, OfferedSeats(nil))
	require.Empty(t, OfferedSeats(StaticKeys{"unknown": "unit-key"}))
	keys := StaticKeys{"vercel": "unit-v", "openai": "unit-o", "anthropic": "unit-a", "unknown": "unit-unknown"}
	seats := OfferedSeats(keys)
	require.Equal(t, []Seat{
		{"anthropic", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "/anthropic"},
		{"openai", "OPENAI_API_KEY", "OPENAI_BASE_URL", "/openai/v1"},
		{"vercel", "AI_GATEWAY_API_KEY", "SMITHERS_EVALUATOR_BASE_URL", "/vercel/v4/ai/evaluation-model"},
	}, seats, "deployment map order does not change the stable SDK seat order")
	require.Equal(t, map[string]string{
		"ANTHROPIC_BASE_URL":             "https://proxy.invalid/model-proxy/anthropic",
		"OPENAI_BASE_URL":                "https://proxy.invalid/model-proxy/openai/v1",
		"SMITHERS_EVALUATOR_BASE_URL":    "https://proxy.invalid/model-proxy/vercel/v4/ai/evaluation-model",
		"SMITHERS_MODEL_PROXY_URL":       "https://proxy.invalid/model-proxy",
		"SMITHERS_MODEL_PROXY_PROVIDERS": "anthropic,openai,vercel",
	}, GuestEnvironment("  https://proxy.invalid/model-proxy///  ", seats))
	require.Empty(t, GuestEnvironment("  ", seats))
	require.Empty(t, GuestEnvironment("https://proxy.invalid/model-proxy", nil))
	key, err := keys.PlatformModelKey(context.Background(), "openai")
	require.NoError(t, err)
	require.Equal(t, "unit-o", key)
	key, err = keys.PlatformModelKey(context.Background(), "cerebras")
	require.ErrorIs(t, err, ErrKeyMissing)
	require.Empty(t, key)
}

func TestConfigurationUnitRotationDoesNotOfferRemovedOrPlaceholderKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keys.json")
	writeKeys(t, path, `{"openai":"unit-initial-key"}`, 0o600)
	keys, err := OpenKeysFile(path)
	require.NoError(t, err)
	for _, body := range []string{`{"anthropic":"unit-other-key"}`, `{"openai":" "}`, `{"openai":"replace-me-private-fixture"}`} {
		writeKeys(t, path, body, 0o600)
		key, err := keys.PlatformModelKey(context.Background(), "openai")
		require.ErrorIs(t, err, ErrKeyMissing)
		require.Empty(t, key)
		require.EqualError(t, err, "modelproxy: platform model key is not configured")
		require.Equal(t, []string{"openai"}, keys.PlatformModelProviders(), "startup provider inventory is stable while values are reread")
	}
	writeKeys(t, path, `{"openai":"  unit-restored-key  "}`, 0o600)
	key, err := keys.PlatformModelKey(context.Background(), "openai")
	require.NoError(t, err)
	require.Equal(t, "unit-restored-key", key)
	_, err = OpenKeysFile(" \t\n")
	require.EqualError(t, err, "modelproxy: platform model key file path is empty")
}

func TestConfigurationUnitPriceAliasesAndProviderAuthority(t *testing.T) {
	for _, item := range []struct {
		provider, model, key, priceProvider string
		input, output                       int64
	}{
		{"anthropic", "  claude-haiku-4-5-20251001  ", "claude-haiku-4-5", "anthropic", 1000000, 5000000},
		{"anthropic", "anthropic/claude-haiku-4-5", "claude-haiku-4-5", "anthropic", 1000000, 5000000},
		{"openrouter", "anthropic/claude-haiku-4-5", "claude-haiku-4-5", "anthropic", 1000000, 5000000},
		{"openrouter", "openai/gpt-oss-120b", "gpt-oss-120b@openrouter", "openrouter", 350000, 750000},
	} {
		t.Run(item.provider+item.model, func(t *testing.T) {
			key, price, ok := Price(item.provider, item.model)
			require.True(t, ok)
			require.Equal(t, item.key, key)
			require.Equal(t, item.priceProvider, price.Provider)
			require.Equal(t, item.input, price.InputPerMTok)
			require.Equal(t, item.output, price.OutputPerMTok)
		})
	}
	for _, item := range []struct{ provider, model string }{
		{"openai", "claude-haiku-4-5"}, {"anthropic", "gpt-6-sol"}, {"openrouter", "typesafe-ai/jev"},
		{"openai", " "}, {"openai", "unknown-unit-model-20251001"},
	} {
		t.Run("refuse "+item.provider+item.model, func(t *testing.T) {
			key, price, ok := Price(item.provider, item.model)
			require.False(t, ok)
			require.Empty(t, key)
			require.Equal(t, modelprice.Price{}, price)
		})
	}
}

func TestConfigurationUnitProviderErrorEnvelopes(t *testing.T) {
	for _, item := range []struct{ provider, kind, expected string }{
		{"openai", "api_error", `{"error":{"type":"api_error","message":"safe refusal"}}`},
		{"anthropic", "api_error", `{"type":"error","error":{"type":"api_error","message":"safe refusal"}}`},
		{"openai", "out_of_credit", `{"code":"out_of_credit","error":{"type":"out_of_credit","message":"safe refusal"}}`},
		{"anthropic", "out_of_credit", `{"type":"error","code":"out_of_credit","error":{"type":"out_of_credit","message":"safe refusal"}}`},
	} {
		t.Run(item.provider+item.kind, func(t *testing.T) {
			response := httptest.NewRecorder()
			WriteError(response, item.provider, 402, item.kind, "safe refusal")
			require.Equal(t, 402, response.Code)
			require.Equal(t, "application/json", response.Header().Get("Content-Type"))
			require.Equal(t, "private, no-store", response.Header().Get("Cache-Control"))
			require.JSONEq(t, item.expected, response.Body.String())
		})
	}
}

func TestConfigurationUnitAdmittedRequestWithoutLedgerRefusesBeforeProvider(t *testing.T) {
	keys := &unitProxyKeys{providers: []string{"openai"}}
	caller := &unitProxyCaller{}
	response := httptest.NewRecorder()
	(&Handler{Keys: keys, Callers: caller}).ServeHTTP(response,
		httptest.NewRequest("POST", Path+"/openai/v1/responses", strings.NewReader(`{"model":"gpt-6-sol","max_output_tokens":3}`)))
	require.Equal(t, 503, response.Code)
	require.JSONEq(t, `{"error":{"type":"api_error","message":"Model credit is unavailable."}}`, response.Body.String())
	require.Equal(t, 1, caller.calls)
	require.Zero(t, keys.reads, "an admitted body still cannot reach a provider without credit admission")
}
