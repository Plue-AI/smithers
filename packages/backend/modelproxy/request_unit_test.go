package modelproxy

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestRequestUnitChoiceBoundPreservesExactPositiveCeiling(t *testing.T) {
	_, price, ok := Price("openai", "gpt-6-sol")
	require.True(t, ok)
	for _, item := range []struct {
		name                   string
		cap, choices, expected int64
	}{
		{"single output", 1, 1, 1},
		{"maximum choices", 32768, 16, 524288},
		{"largest representable sixteen-choice ceiling", 576460752303423487, 16, 9223372036854775792},
		{"largest representable four-choice ceiling", 2305843009213693951, 4, 9223372036854775804},
	} {
		t.Run(item.name, func(t *testing.T) {
			raw := []byte(fmt.Sprintf(`{"model":"gpt-6-sol","max_output_tokens":%d,"n":%d}`, item.cap, item.choices))
			parsed, err := parseRequest("openai", "v1/responses", http.Header{}, raw)
			require.NoError(t, err)
			require.Equal(t, item.expected, parsed.maximum(price).OutputTokens)
		})
	}
}

func TestRequestUnitRefusesUnrepresentableCombinedOutputCeiling(t *testing.T) {
	for _, item := range []struct {
		name         string
		cap, choices int64
	}{
		{"one above four-choice range", 2305843009213693952, 4},
		{"wraps to a small positive bound", 4611686018427387905, 4},
		{"maximum integer with two choices", 9223372036854775807, 2},
		{"one above sixteen-choice range", 576460752303423488, 16},
	} {
		t.Run(item.name, func(t *testing.T) {
			raw := []byte(fmt.Sprintf(`{"model":"gpt-6-sol","max_output_tokens":%d,"n":%d}`, item.cap, item.choices))
			parsed, err := parseRequest("openai", "v1/responses", http.Header{}, raw)
			if err == nil {
				_, price, offered := Price("openai", "gpt-6-sol")
				require.True(t, offered)
				t.Logf("admitted combined output ceiling: %d", parsed.maximum(price).OutputTokens)
			}
			require.Error(t, err, "an output bound must not wrap to negative or smaller positive usage")
			var refusal errRefused
			require.ErrorAs(t, err, &refusal)
			require.Equal(t, "combined output token limit is too large", refusal.message)
			require.Nil(t, parsed.maximum)
		})
	}
}

func TestRequestUnitNormalizesAbsentAndNullChoiceCount(t *testing.T) {
	_, price, ok := Price("openai", "gpt-6-sol")
	require.True(t, ok)
	for _, item := range []struct {
		name, raw string
		output    int64
	}{
		{"absent choices", `{"model":"gpt-6-sol","max_output_tokens":5}`, 5},
		{"null choices", `{"model":"gpt-6-sol","max_output_tokens":5,"n":null}`, 5},
		{"default output", `{"model":"gpt-6-sol","input":"hi"}`, 32768},
		{"default output and sixteen choices", `{"model":"gpt-6-sol","input":"hi","n":16}`, 524288},
	} {
		t.Run(item.name, func(t *testing.T) {
			parsed, err := parseRequest("openai", "v1/responses", http.Header{}, []byte(item.raw))
			require.NoError(t, err)
			require.Equal(t, item.output, parsed.maximum(price).OutputTokens)
		})
	}
	for _, n := range []string{"0", "-1", "17", "1.5", `"2"`, `true`} {
		t.Run("invalid choices "+n, func(t *testing.T) {
			parsed, err := parseRequest("openai", "v1/responses", http.Header{}, []byte(`{"model":"gpt-6-sol","n":`+n+`}`))
			require.EqualError(t, err, "n must be an integer from 1 to 16")
			require.Nil(t, parsed.maximum)
		})
	}
}
