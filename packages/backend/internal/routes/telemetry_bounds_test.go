package routes

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTelemetryBounds_PostClientErrorLoggedStrings(t *testing.T) {
	// slog's default logger is process-wide. Keep this test sequential.
	previousLogger := slog.Default()
	t.Cleanup(func() { slog.SetDefault(previousLogger) })

	fields := []struct {
		logKey  string
		jsonKey string
		group   string
		bound   int
	}{
		{"error_message", "message", "error", 512},
		{"error_stack", "stack", "error", 4096},
		{"error_type", "type", "error", 128},
		{"version", "version", "", 128},
		{"url", "url", "context", 2048},
		{"user_agent", "user_agent", "context", 512},
		{"username", "username", "context", 128},
		{"command", "command", "context", 512},
		{"os", "os", "context", 64},
		{"arch", "arch", "context", 64},
	}
	cases := []struct {
		name  string
		value func(int) (input, want string)
	}{
		{"empty", func(int) (string, string) { return "", "" }},
		{"exact_ascii", func(bound int) (string, string) {
			value := strings.Repeat("a", bound)
			return value, value
		}},
		{"over_ascii", func(bound int) (string, string) {
			return strings.Repeat("a", bound+1), strings.Repeat("a", bound)
		}},
		{"unicode_crossing_bound", func(bound int) (string, string) {
			prefix := strings.Repeat("a", bound-1)
			return prefix + "界" + "tail", prefix
		}},
		{"unicode_exact_bound", func(bound int) (string, string) {
			value := strings.Repeat("a", bound-4) + "😀"
			return value, value
		}},
		{"unicode_whole_prefix", func(bound int) (string, string) {
			prefix := strings.Repeat("a", bound-4) + "😀"
			return prefix + "tail", prefix
		}},
		{"unicode_four_byte_crossing", func(bound int) (string, string) {
			prefix := strings.Repeat("a", bound-3)
			return prefix + "😀", prefix
		}},
	}

	metrics := NewSmithersMetrics()
	handler := &TelemetryHandler{Metrics: metrics}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			input := map[string]any{
				"client":  "web",
				"error":   map[string]any{},
				"context": map[string]any{},
			}
			want := make(map[string]string, len(fields))
			for _, field := range fields {
				value, expected := tc.value(field.bound)
				if field.group == "" {
					input[field.jsonKey] = value
				} else {
					input[field.group].(map[string]any)[field.jsonKey] = value
				}
				want[field.logKey] = expected
			}

			body, err := json.Marshal(input)
			require.NoError(t, err)
			var logOutput bytes.Buffer
			slog.SetDefault(slog.New(slog.NewJSONHandler(&logOutput, nil)))
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPost, "/api/telemetry/errors", bytes.NewReader(body))
			handler.PostClientError(recorder, request)

			require.Equal(t, http.StatusNoContent, recorder.Code)
			var logged map[string]any
			require.NoError(t, json.Unmarshal(logOutput.Bytes(), &logged), "expected one structured log record")
			for _, field := range fields {
				value, ok := logged[field.logKey].(string)
				require.True(t, ok, "%s missing or not a string", field.logKey)
				assert.True(t, utf8.ValidString(value), "%s is invalid UTF-8", field.logKey)
				assert.LessOrEqual(t, len(value), field.bound, "%s exceeds its byte bound", field.logKey)
				assert.Equal(t, want[field.logKey], value, "%s is not the expected prefix", field.logKey)
			}
		})
	}

	require.Contains(t, telemetryCovScrape(t, metrics), `smithers_client_errors_total{client="web",error_type="other"} 7`)
}
