package modelproxy

import (
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/modelprice"
	"github.com/stretchr/testify/require"
)

func TestParametersUnitDefaultOutputCeilingsByProviderAndPath(t *testing.T) {
	for _, item := range []struct{ provider, path, model, field string }{
		{"openai", "v1/responses", "gpt-6-sol", "max_output_tokens"},
		{"openai", "v1/chat/completions", "gpt-6-sol", "max_completion_tokens"},
		{"cerebras", "v1/chat/completions", "gpt-oss-120b", "max_completion_tokens"},
		{"openrouter", "v1/chat/completions", "openai/gpt-oss-120b", "max_tokens"},
	} {
		t.Run(item.provider+item.path, func(t *testing.T) {
			raw := []byte(fmt.Sprintf(`{"model":%q,"messages":[]}`, item.model))
			parsed, err := parseRequest(item.provider, item.path, http.Header{}, raw)
			require.NoError(t, err)
			require.JSONEq(t, fmt.Sprintf(`{"model":%q,"messages":[],%q:32768}`, item.model, item.field), string(parsed.body))
			_, price, ok := Price(item.provider, item.model)
			require.True(t, ok)
			require.Equal(t, int64(32768), parsed.maximum(price).OutputTokens)
			require.Equal(t, fmt.Sprintf(`{"model":%q,"messages":[]}`, item.model), string(raw))
		})
	}
	parsed, err := parseRequest("anthropic", "v1/messages", http.Header{}, []byte(`{"model":"claude-haiku-4-5","messages":[]}`))
	require.EqualError(t, err, "max_tokens is required")
	require.Nil(t, parsed.maximum)
}

func TestParametersUnitStreamingChatRequiresUsageAndPreservesOptions(t *testing.T) {
	for _, options := range []string{"", `,"stream_options":null`, `,"stream_options":{"include_usage":false,"include_obfuscation":false}`} {
		raw := []byte(`{"model":"gpt-6-sol","max_completion_tokens":3,"stream":true` + options + `}`)
		parsed, err := parseRequest("openai", "v1/chat/completions", http.Header{}, raw)
		require.NoError(t, err)
		extra := ""
		if strings.Contains(options, "include_obfuscation") {
			extra = `,"include_obfuscation":false`
		}
		require.JSONEq(t, `{"model":"gpt-6-sol","max_completion_tokens":3,"stream":true,"stream_options":{"include_usage":true`+extra+`}}`, string(parsed.body))
		require.Equal(t, `{"model":"gpt-6-sol","max_completion_tokens":3,"stream":true`+options+`}`, string(raw))
	}
	for _, options := range []string{`[]`, `true`, `1`, `"usage"`} {
		parsed, err := parseRequest("openai", "v1/chat/completions", http.Header{}, []byte(`{"model":"gpt-6-sol","stream":true,"stream_options":`+options+`}`))
		require.EqualError(t, err, "stream_options must be an object")
		require.Nil(t, parsed.maximum)
	}
	// Non-streaming requests do not acquire streaming semantics or rewrite an
	// explicit output ceiling merely because options are present.
	raw := []byte(`{"model":"gpt-6-sol","max_completion_tokens":3,"stream":false,"stream_options":{"include_usage":false}}`)
	parsed, err := parseRequest("openai", "v1/chat/completions", http.Header{}, raw)
	require.NoError(t, err)
	require.Equal(t, raw, parsed.body)
}

func TestParametersUnitServiceModifierAdmission(t *testing.T) {
	for _, field := range []string{`"service_tier":"auto"`, `"service_tier":"default"`, `"service_tier":"flex"`, `"service_tier":"standard_only"`, `"speed":"standard"`, `"service_tier":null`, `"speed":null`} {
		parsed, err := requestContent(field)
		require.NoError(t, err, field)
		require.NotNil(t, parsed.maximum)
	}
	for _, item := range []struct{ field, message string }{
		{`"service_tier":"priority"`, `service_tier "priority" is not offered on platform keys`},
		{`"service_tier":1`, `service_tier 1 is not offered on platform keys`},
		{`"speed":"fast"`, `speed "fast" is not offered on platform keys`},
		{`"speed":true`, `speed true is not offered on platform keys`},
	} {
		parsed, err := requestContent(item.field)
		require.EqualError(t, err, item.message)
		require.Nil(t, parsed.maximum)
	}
}

func TestParametersUnitOutputCeilingsUseLargestPositiveInteger(t *testing.T) {
	raw := []byte(`{"model":"gpt-6-sol","max_tokens":3,"max_output_tokens":9,"max_completion_tokens":5}`)
	parsed, err := parseRequest("openai", "v1/responses", http.Header{}, raw)
	require.NoError(t, err)
	_, price, ok := Price("openai", "gpt-6-sol")
	require.True(t, ok)
	require.Equal(t, int64(9), parsed.maximum(price).OutputTokens)
	require.Equal(t, raw, parsed.body)
	for _, field := range []string{"max_tokens", "max_output_tokens", "max_completion_tokens"} {
		for _, value := range []string{"0", "-1", "1.5", `"3"`, "true"} {
			other := "max_output_tokens"
			if field == other {
				other = "max_tokens"
			}
			parsed, err := parseRequest("openai", "v1/responses", http.Header{}, []byte(fmt.Sprintf(`{"model":"gpt-6-sol",%q:9,%q:%s}`, other, field, value)))
			// Another larger ceiling never makes an invalid ceiling admissible.
			require.EqualError(t, err, field+" must be a positive integer")
			require.Nil(t, parsed.maximum)
		}
	}
}

func TestParametersUnitUnboundedFeaturesRequireAbsentOrDisabledValues(t *testing.T) {
	// Literal API fields keep the oracle independent of the production refusal
	// list: removing one guard must not silently remove its test case.
	for _, field := range []string{"previous_response_id", "conversation", "prompt", "background", "mcp_servers", "container", "audio", "modalities", "models", "plugins", "route", "inference_geo"} {
		t.Run(field, func(t *testing.T) {
			parsed, err := requestContent(fmt.Sprintf(`%q:true`, field))
			require.EqualError(t, err, field+" is not offered on platform keys")
			require.Nil(t, parsed.maximum)
			for _, value := range []string{"false", "null"} {
				parsed, err := requestContent(fmt.Sprintf(`%q:%s`, field, value))
				require.NoError(t, err)
				require.NotNil(t, parsed.maximum)
			}
		})
	}
}

func TestParametersUnitProviderSpecificAndJSONAdmission(t *testing.T) {
	for _, item := range []struct {
		provider, path, body, message string
		header                        http.Header
	}{
		{"vercel", "v4/ai/evaluation-model", `{}`, "ai-model-id must be typesafe-ai/jev", http.Header{}},
		{"vercel", "v4/ai/evaluation-model", `{`, "request body must be JSON", http.Header{"Ai-Model-Id": []string{"typesafe-ai/jev"}}},
		{"anthropic", "v1/messages", `{"model":"claude-haiku-4-5","max_tokens":3}`, "the long-context beta is not offered on platform keys", http.Header{"Anthropic-Beta": []string{"ConText-1M-2025"}}},
		{"openrouter", "v1/responses", `{"model":"openai/gpt-6-sol:free"}`, "model variants are not offered on platform keys", http.Header{}},
		{"openai", "v1/responses", `null`, "request body must be a JSON object", http.Header{}},
		{"openai", "v1/responses", `[]`, "request body must be a JSON object", http.Header{}},
		{"openai", "v1/responses", `{}`, "model is required", http.Header{}},
		{"openai", "v1/responses", `{"model":"gpt-6-sol","stream":1}`, "stream must be a boolean", http.Header{}},
	} {
		parsed, err := parseRequest(item.provider, item.path, item.header, []byte(item.body))
		require.EqualError(t, err, item.message)
		require.Nil(t, parsed.maximum)
	}
}

func TestParametersUnitVercelJevReservesItsRequestCeiling(t *testing.T) {
	raw := []byte(`{"questions":{"1":"hello"}}`)
	parsed, err := parseRequest("vercel", "v4/ai/evaluation-model", http.Header{"Ai-Model-Id": []string{" typesafe-ai/jev "}}, raw)
	require.NoError(t, err)
	require.Equal(t, "typesafe-ai/jev", parsed.model)
	require.Equal(t, raw, parsed.body)
	_, price, ok := Price("vercel", "typesafe-ai/jev")
	require.True(t, ok)
	maximum := parsed.maximum(price)
	require.Equal(t, int64(JevMaxRequestTokens), maximum.PromptTokens())
	require.Zero(t, maximum.OutputTokens)
	bound, err := Bound(price, maximum)
	require.NoError(t, err)
	require.Equal(t, int64(2_688_000), bound, "64,000 input tokens at 0.042 USD per million")
}

func TestParametersUnitJevCamelCaseUsageIsPriced(t *testing.T) {
	usage, ok := usageFromJSON([]byte(`{"answers":{},"usage":{"inputTokens":120,"outputTokens":3}}`))
	require.True(t, ok)
	require.Equal(t, modelprice.Usage{InputTokens: 120, OutputTokens: 3}, usage)
	_, price, _ := Price("vercel", "typesafe-ai/jev")
	cost, err := modelprice.CostNanos(price, usage)
	require.NoError(t, err)
	require.Equal(t, int64(5_040), cost)
	// Snake case wins when a body carries both spellings.
	usage, ok = usageFromJSON([]byte(`{"usage":{"input_tokens":7,"inputTokens":120,"outputTokens":3}}`))
	require.True(t, ok)
	require.Equal(t, modelprice.Usage{InputTokens: 7, OutputTokens: 3}, usage)
	_, ok = usageFromJSON([]byte(`{"usage":{"inputTokens":"120","outputTokens":3}}`))
	require.False(t, ok)
}

func TestParametersUnitMalformedProviderReportsCannotProveUsageOrSpendCap(t *testing.T) {
	for _, raw := range []string{
		`{"usage":{"input_tokens":"seven","output_tokens":2}}`,
		`{"usage":{"input_tokens":true}}`,
		`{"response":{"usage":{"output_tokens":[]}}}`,
	} {
		usage, ok := usageFromJSON([]byte(raw))
		require.False(t, ok, raw)
		require.Zero(t, usage.PromptTokens())
		require.Zero(t, usage.OutputTokens)
	}
	for _, raw := range []string{`<html>temporary rate limit</html>`, ``, `{"error":{"code":123}}`, `{"error":{"type":"rate_limit_error"}}`} {
		require.False(t, ProviderSpendCap([]byte(raw)), raw)
	}
	usage, ok := usageFromJSON([]byte(`{"usage":{"input_tokens":7,"output_tokens":2}}`))
	require.True(t, ok)
	require.Equal(t, int64(7), usage.InputTokens)
	require.Equal(t, int64(2), usage.OutputTokens)
	require.True(t, ProviderSpendCap([]byte(`{"error":{"code":"insufficient_quota"}}`)))
}
