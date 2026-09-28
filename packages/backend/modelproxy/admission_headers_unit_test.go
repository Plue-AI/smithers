package modelproxy

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/modelprice"
	"github.com/stretchr/testify/require"
)

func TestRequestHeaderUnitForwardsProviderMetadataButNoCallerCredentials(t *testing.T) {
	allowed := map[string]string{
		"Content-Type": "application/vendor+json", "Accept": "text/event-stream", "Anthropic-Version": "2023-06-01",
		"Anthropic-Beta": "bounded-feature", "OpenAI-Beta": "responses=v1", "User-Agent": "unit-sdk/1",
		"Ai-Gateway-Protocol-Version": "1", "Ai-Evaluation-Model-Specification-Version": "2", "Ai-Model-Id": "typesafe-ai/jev",
	}
	source := make(http.Header)
	for key, value := range allowed {
		source.Set(key, value)
	}
	for _, key := range []string{"Authorization", "Proxy-Authorization", "Cookie", "X-Api-Key", "X-Smithers-Token", "X-Unrecognized"} {
		source.Set(key, "private-unit-fixture")
	}
	before := source.Clone()
	destination := make(http.Header)
	copyRequestHeaders(destination, source)
	require.Len(t, destination, 9)
	for key, value := range allowed {
		require.Equal(t, value, destination.Get(key), key)
	}
	for _, key := range []string{"Authorization", "Proxy-Authorization", "Cookie", "X-Api-Key", "X-Smithers-Token", "X-Unrecognized"} {
		require.Empty(t, destination.Get(key), key)
	}
	require.Equal(t, before, source, "copying headers does not edit the caller request")
	defaultHeaders := make(http.Header)
	copyRequestHeaders(defaultHeaders, http.Header{})
	require.Equal(t, http.Header{"Content-Type": []string{"application/json"}}, defaultHeaders)
}

func TestResponseHeaderUnitDoesNotForwardProviderCredentialsOrCookies(t *testing.T) {
	allowed := map[string]string{"Content-Type": "application/json", "Cache-Control": "no-store", "Request-Id": "request-1", "X-Request-Id": "request-2", "Retry-After": "3600"}
	source := make(http.Header)
	for key, value := range allowed {
		source.Set(key, value)
	}
	for _, key := range []string{"Authorization", "X-Api-Key", "Set-Cookie", "Location", "X-Unrecognized"} {
		source.Set(key, "private-upstream-fixture")
	}
	before := source.Clone()
	destination := make(http.Header)
	copyResponseHeaders(destination, source)
	require.Len(t, destination, 5)
	for key, value := range allowed {
		require.Equal(t, value, destination.Get(key), key)
	}
	for _, key := range []string{"Authorization", "X-Api-Key", "Set-Cookie", "Location", "X-Unrecognized"} {
		require.Empty(t, destination.Get(key), key)
	}
	require.Equal(t, before, source)
}

func requestContent(fields string) (parsedCall, error) {
	return parseRequest("openai", "v1/responses", http.Header{}, []byte(`{"model":"gpt-6-sol","max_output_tokens":3,`+fields+`}`))
}

func TestContentUnitRefusesUnboundedExternalInputs(t *testing.T) {
	for _, item := range []struct{ name, fields, message string }{
		{"stored file", `"input":[{"file_id":"file-1"}]`, "files are not offered on platform keys"},
		{"remote file", `"input":[{"file_url":"https://example.invalid/file"}]`, "files are not offered on platform keys"},
		{"inline document", `"input":[{"file_data":"data:application/pdf;base64,AAAA"}]`, "files are not offered on platform keys"},
		{"input audio", `"input":[{"type":"input_audio"}]`, "content of type input_audio is not offered on platform keys"},
		{"video content", `"input":[{"type":"video"}]`, "content of type video is not offered on platform keys"},
		{"video URL field", `"input":[{"video_url":"https://example.invalid/video"}]`, "video is not offered on platform keys"},
		{"remote image string", `"input":[{"type":"input_image","image_url":"https://example.invalid/image"}]`, "images by URL are not offered on platform keys"},
		{"remote image object", `"input":[{"type":"image_url","image_url":{"url":"https://example.invalid/image"}}]`, "images by URL are not offered on platform keys"},
		{"PDF document", `"input":[{"type":"document","source":{"type":"base64"}}]`, "documents are offered on platform keys as text only"},
		{"paid cache lifetime", `"input":[{"cache_control":{"ttl":"1h"}}]`, "cache lifetime 1h is not offered on platform keys"},
		{"deeply nested audio", `"input":[{"content":[{"type":"audio"}]}]`, "content of type audio is not offered on platform keys"},
	} {
		t.Run(item.name, func(t *testing.T) {
			parsed, err := requestContent(item.fields)
			require.EqualError(t, err, item.message)
			require.Nil(t, parsed.maximum)
		})
	}
}

func TestContentUnitDistinguishesOpaqueToolDataFromModelInput(t *testing.T) {
	for _, fields := range []string{
		`"input":[{"type":"document","source":{"type":"text","data":"plain text"}}]`,
		`"input":[{"type":"document","source":{"type":"content","content":[{"type":"text","text":"hello"}]}}]`,
		`"input":[{"type":"text","text":"hello","cache_control":{"ttl":"5m"}}]`,
		`"input":[{"type":"tool_use","input":{"type":"file","file_url":"opaque-tool-argument"}}]`,
		`"metadata":{"type":"file","file_id":"opaque"}`,
		`"tools":[{"type":"function","function":{"name":"echo","parameters":{"type":"file","file_url":"opaque-schema-property"}}}]`,
	} {
		t.Run(fields, func(t *testing.T) {
			parsed, err := requestContent(fields)
			require.NoError(t, err)
			require.NotNil(t, parsed.maximum)
		})
	}
	plain, err := requestContent(`"input":[]`)
	require.NoError(t, err)
	image, err := requestContent(`"input":[{"type":"input_image","image_url":"data:image/png;base64,AAAA"},{"type":"image_url","image_url":{"url":"data:image/png;base64,BBBB"}}]`)
	require.NoError(t, err)
	_, price, ok := Price("openai", "gpt-6-sol")
	require.True(t, ok)
	// Inline images add exactly 12,000 prompt tokens each beyond the byte bound.
	require.Equal(t, int64(len(image.body)-len(plain.body))+24000, image.maximum(price).PromptTokens()-plain.maximum(price).PromptTokens())
	require.Equal(t, int64(3), image.maximum(price).OutputTokens)
}

func TestToolsUnitRefusesPricedServerToolsAndMalformedContainers(t *testing.T) {
	for _, kind := range []string{"web_search_preview", "web_fetch", "code_execution_20250825", "code_interpreter", "file_search", "image_generation", "mcp", "tool_search"} {
		t.Run(kind, func(t *testing.T) {
			parsed, err := requestContent(fmt.Sprintf(`"tools":[{"type":%q}]`, kind))
			require.EqualError(t, err, "tool "+kind+" is not offered on platform keys")
			require.Nil(t, parsed.maximum)
		})
	}
	for _, raw := range []string{`{}`, `1`, `true`, `"function"`, `[1]`, `["function"]`} {
		t.Run("malformed "+raw, func(t *testing.T) {
			parsed, err := requestContent(`"tools":` + raw)
			require.EqualError(t, err, "tools must be an array of objects")
			require.Nil(t, parsed.maximum)
		})
	}
	for _, raw := range []string{`null`, `[]`, `[{"type":"function","function":{"name":"local"}}]`} {
		parsed, err := requestContent(`"tools":` + raw)
		require.NoError(t, err)
		require.NotNil(t, parsed.maximum)
	}
}

func TestOpenRouterCeilingUnitPinsExactRatesAndPreservesRoutingOptions(t *testing.T) {
	for _, item := range []struct {
		name               string
		input, output      int64
		prompt, completion string
	}{
		{"fractional dollars", 1250000, 4500000, "1.25", "4.5"},
		{"smallest micro-dollar", 1, 2, "0.000001", "0.000002"},
		{"zero token rates", 0, 0, "0", "0"},
	} {
		for _, provider := range []string{"", `,"provider":null`, `,"provider":{"order":["preferred"],"allow_fallbacks":false,"max_price":{"prompt":999,"completion":999}}`} {
			t.Run(item.name+provider, func(t *testing.T) {
				body := []byte(`{"model":"vendor/model","input":"hello"` + provider + `}`)
				forwarded, err := withPriceCeiling(body, modelprice.Price{Context: modelprice.ContextFlat, Rates: modelprice.Rates{InputPerMTok: item.input, OutputPerMTok: item.output}})
				require.NoError(t, err)
				var fields map[string]json.RawMessage
				require.NoError(t, json.Unmarshal(forwarded, &fields))
				require.Equal(t, `"vendor/model"`, string(fields["model"]))
				require.Equal(t, `"hello"`, string(fields["input"]))
				options := `"max_price":{"prompt":` + item.prompt + `,"completion":` + item.completion + `,"request":0,"image":0}`
				if provider != "" && provider != `,"provider":null` {
					options += `,"order":["preferred"],"allow_fallbacks":false`
				}
				require.JSONEq(t, "{"+options+"}", string(fields["provider"]))
				require.Equal(t, `{"model":"vendor/model","input":"hello"`+provider+`}`, string(body))
			})
		}
	}
	for _, provider := range []string{`[]`, `true`, `1`, `"preferred"`} {
		t.Run("malformed provider "+provider, func(t *testing.T) {
			forwarded, err := withPriceCeiling([]byte(`{"model":"vendor/model","provider":`+provider+`}`), modelprice.Price{})
			require.EqualError(t, err, "provider must be an object")
			require.Nil(t, forwarded)
		})
	}
}

func TestAdmissionUnitPublicRefusalsPrecedeReservationAndCredentialRead(t *testing.T) {
	for _, item := range []struct{ name, provider, body, message string }{
		{"external image", "openai", `{"model":"gpt-6-sol","input":[{"image_url":"https://example.invalid/image"}]}`, "images by URL are not offered on platform keys"},
		{"server tool", "openai", `{"model":"gpt-6-sol","tools":[{"type":"web_search"}]}`, "tool web_search is not offered on platform keys"},
		{"invalid routing options", "openrouter", `{"model":"openai/gpt-6-sol","provider":[]}`, "Invalid request."},
	} {
		t.Run(item.name, func(t *testing.T) {
			keys := &unitProxyKeys{providers: []string{item.provider}}
			caller := &unitProxyCaller{}
			response := httptest.NewRecorder()
			// The unconfigured ledger returns 503 if reached: a 400 proves the
			// request is refused before reservation, without a fake SQL ledger.
			(&Handler{Keys: keys, Callers: caller}).ServeHTTP(response,
				httptest.NewRequest("POST", Path+"/"+item.provider+"/v1/responses", strings.NewReader(item.body)))
			require.Equal(t, http.StatusBadRequest, response.Code)
			require.JSONEq(t, fmt.Sprintf(`{"error":{"type":"invalid_request_error","message":%q}}`, item.message), response.Body.String())
			require.Equal(t, 1, caller.calls)
			require.Zero(t, keys.reads)
		})
	}
}
