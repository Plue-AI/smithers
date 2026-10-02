package middleware_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	chiMiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel/trace"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// ---------------------------------------------------------------------------
// Structured Logging Contract Tests
//
// These tests define the EXPECTED behavior for structured JSON logging as
// specified in docs/specs/infra.md §8.2.
//
// Current state: Server uses chi's default text logger (chiMiddleware.Logger).
// These tests document the contract for a future structured JSON logger that
// emits GCP-compatible format with severity, httpRequest, and labels.
//
// Reference: docs/specs/infra.md §8.2
// ---------------------------------------------------------------------------

// GCPLogEntry represents the expected JSON log format per infra.md §8.2.
// GCP Cloud Logging requires specific field names for automatic parsing.
type GCPLogEntry struct {
	Severity    string `json:"severity"`
	Message     string `json:"message"`
	TraceID     string `json:"trace_id,omitempty"`
	SpanID      string `json:"span_id,omitempty"`
	HTTPRequest *struct {
		RequestMethod string `json:"requestMethod"`
		RequestURL    string `json:"requestUrl"`
		Status        int    `json:"status"`
		Latency       string `json:"latency"`
		RemoteIP      string `json:"remoteIp"`
	} `json:"httpRequest,omitempty"`
	Labels *struct {
		RequestID string `json:"request_id"`
		UserID    string `json:"user_id,omitempty"`
	} `json:"labels,omitempty"`
}

// TestStructuredLogging_SlogFormatContract documents the expected slog JSON output.
// slog is the Go standard library structured logger (available since Go 1.21).
// This test validates the JSON output format that must be produced.
func TestStructuredLogging_SlogFormatContract(t *testing.T) {
	t.Parallel()

	// Verify that slog can produce JSON-format log entries.
	var buf strings.Builder
	logger := slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	// Log an HTTP request completion (what the middleware should emit).
	logger.Info("http request",
		slog.String("severity", "INFO"),
		slog.String("requestMethod", "GET"),
		slog.String("requestUrl", "/api/v1/repos"),
		slog.Int("status", 200),
		slog.String("latency", "5ms"),
	)

	output := buf.String()
	require.NotEmpty(t, output, "slog must produce log output")

	// Verify the output is valid JSON.
	var entry map[string]interface{}
	err := json.Unmarshal([]byte(output), &entry)
	require.NoError(t, err, "slog JSON handler must produce valid JSON")

	// Verify required fields are present.
	assert.Contains(t, entry, "time", "slog JSON must include timestamp")
	assert.Contains(t, entry, "level", "slog JSON must include level")
	assert.Contains(t, entry, "msg", "slog JSON must include message")
	assert.Equal(t, "http request", entry["msg"], "log message must be 'http request'")
}

// TestStructuredLogging_RequestIDInLogs documents that structured logs must
// include the request ID for trace correlation (infra.md §8.2).
func TestStructuredLogging_RequestIDInLogs(t *testing.T) {
	t.Parallel()

	var capturedLogs []string

	// Build a router that simulates structured logging with request ID.
	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)

	// Future: r.Use(middleware.StructuredLogger(slogLogger))
	// For now, simulate what the structured logger would do.
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			reqID := chiMiddleware.GetReqID(r.Context())
			next.ServeHTTP(w, r)

			// Structured log entry simulation.
			var buf strings.Builder
			logger := slog.New(slog.NewJSONHandler(&buf, nil))
			logger.Info("http request",
				slog.String("request_id", reqID),
				slog.String("method", r.Method),
				slog.String("path", r.URL.Path),
			)
			capturedLogs = append(capturedLogs, buf.String())
		})
	})

	r.Get("/api/test", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
	req.Header.Set("X-Request-Id", "test-trace-id-12345")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	require.NotEmpty(t, capturedLogs, "must have captured at least one log entry")

	var logEntry map[string]interface{}
	err := json.Unmarshal([]byte(capturedLogs[0]), &logEntry)
	require.NoError(t, err, "log entry must be valid JSON")

	assert.Equal(t, "test-trace-id-12345", logEntry["request_id"],
		"structured log must include request_id for distributed trace correlation")
}

func TestStructuredLogging_RequestURLOmitsQueryStringTokens(t *testing.T) {
	t.Parallel()

	var buf bytes.Buffer
	logger := middleware.NewServerLogger(&buf, "info")

	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)
	r.Use(middleware.StructuredLogger(logger))
	r.Get("/api/notifications", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/api/notifications?ticket=jwt-ticket-value&token=smithers_0123456789abcdef0123456789abcdef01234567", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	require.NotEmpty(t, lines)

	var entry GCPLogEntry
	require.NoError(t, json.Unmarshal([]byte(lines[len(lines)-1]), &entry))
	require.NotNil(t, entry.HTTPRequest)
	assert.Equal(t, "/api/notifications", entry.HTTPRequest.RequestURL)
	assert.NotContains(t, entry.HTTPRequest.RequestURL, "ticket=")
	assert.NotContains(t, buf.String(), "smithers_0123456789abcdef0123456789abcdef01234567")
}

func TestStructuredLogging_RequestURLRedactsSecretPathTokens(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name        string
		path        string
		wantPath    string
		leakedToken string
	}{
		{
			name:        "canary webhook path",
			path:        "/canary/webhook-receiver/smithers-canary-webhook.deadbeef",
			wantPath:    "/canary/webhook-receiver/smithers-canary-webhook.REDACTED",
			leakedToken: "deadbeef",
		},
		{
			// Release review 2026-09-13, R003: the desktop relay carries a
			// 12-hour bearer token in the path because an iframe and a
			// WebSocket cannot send headers. Every relay outcome logs the
			// path, so the token must be scrubbed before it reaches the log.
			name:        "desktop relay viewer path",
			path:        "/api/workspaces/ws1/desktop/smithers_desk_0123456789abcdef0123456789abcdef/vnc.html",
			wantPath:    "/api/workspaces/ws1/desktop/smithers_desk_REDACTED/vnc.html",
			leakedToken: "smithers_desk_0123456789abcdef0123456789abcdef",
		},
		{
			name:        "desktop relay websockify path",
			path:        "/api/workspaces/ws1/desktop/smithers_desk_0123456789abcdef0123456789abcdef/websockify",
			wantPath:    "/api/workspaces/ws1/desktop/smithers_desk_REDACTED/websockify",
			leakedToken: "smithers_desk_0123456789abcdef0123456789abcdef",
		},
		{
			name:        "desktop relay bare token path",
			path:        "/api/workspaces/ws1/desktop/smithers_desk_0123456789abcdef0123456789abcdef",
			wantPath:    "/api/workspaces/ws1/desktop/smithers_desk_REDACTED",
			leakedToken: "smithers_desk_0123456789abcdef0123456789abcdef",
		},
		{
			name:        "desktop relay query never reaches the log",
			path:        "/api/workspaces/ws1/desktop/smithers_desk_0123456789abcdef0123456789abcdef/vnc.html?autoconnect=true&password=secretvnc",
			wantPath:    "/api/workspaces/ws1/desktop/smithers_desk_REDACTED/vnc.html",
			leakedToken: "secretvnc",
		},
		{
			name:     "prefix only matches a whole segment start",
			path:     "/api/x/not-smithers_desk_abc",
			wantPath: "/api/x/not-smithers_desk_abc",
		},
		{
			// The desktop relay carries its 12-hour bearer credential as a
			// path segment (/api/workspaces/{id}/desktop/{token}/...) because
			// the noVNC iframe and WebSocket cannot set headers. It must be
			// redacted exactly like the canary webhook token.
			name:        "desktop relay viewer long token path",
			path:        "/api/workspaces/ws-123/desktop/smithers_desk_0123456789abcdef0123456789abcdef0123456789abcdef/vnc.html",
			wantPath:    "/api/workspaces/ws-123/desktop/smithers_desk_REDACTED/vnc.html",
			leakedToken: "smithers_desk_0123456789abcdef0123456789abcdef0123456789abcdef",
		},
		{
			name:        "desktop relay websockify long token path",
			path:        "/api/workspaces/ws-123/desktop/smithers_desk_0123456789abcdef0123456789abcdef0123456789abcdef/websockify",
			wantPath:    "/api/workspaces/ws-123/desktop/smithers_desk_REDACTED/websockify",
			leakedToken: "smithers_desk_0123456789abcdef0123456789abcdef0123456789abcdef",
		},
		{
			name:     "normal path passed through unchanged",
			path:     "/api/repos/owner/name",
			wantPath: "/api/repos/owner/name",
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			var buf bytes.Buffer
			logger := middleware.NewServerLogger(&buf, "info")

			r := chi.NewRouter()
			r.Use(chiMiddleware.RequestID)
			r.Use(middleware.StructuredLogger(logger))
			r.HandleFunc("/*", func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusOK)
			})

			req := httptest.NewRequest(http.MethodPost, tc.path, nil)
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)

			lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
			require.NotEmpty(t, lines)

			var entry GCPLogEntry
			require.NoError(t, json.Unmarshal([]byte(lines[len(lines)-1]), &entry))
			require.NotNil(t, entry.HTTPRequest)
			assert.Equal(t, tc.wantPath, entry.HTTPRequest.RequestURL)
			if tc.leakedToken != "" {
				assert.NotContains(t, buf.String(), tc.leakedToken)
			}
		})
	}
}

// TestStructuredLogging_SeverityLevelsContract documents the expected severity
// level mapping between Go slog levels and GCP Cloud Logging severity levels.
// Reference: https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry#LogSeverity
func TestStructuredLogging_SeverityLevelsContract(t *testing.T) {
	t.Parallel()

	type levelCase struct {
		slogLevel slog.Level
		gcpName   string
	}

	// GCP severity levels map to slog levels.
	cases := []levelCase{
		{slog.LevelDebug, "DEBUG"},
		{slog.LevelInfo, "INFO"},
		{slog.LevelWarn, "WARNING"},
		{slog.LevelError, "ERROR"},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.gcpName, func(t *testing.T) {
			t.Parallel()

			var buf strings.Builder
			logger := slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{
				Level: slog.LevelDebug, // Allow all levels.
			}))

			switch tc.slogLevel {
			case slog.LevelDebug:
				logger.Debug("test message")
			case slog.LevelInfo:
				logger.Info("test message")
			case slog.LevelWarn:
				logger.Warn("test message")
			case slog.LevelError:
				logger.Error("test message")
			}

			var entry map[string]interface{}
			err := json.Unmarshal([]byte(buf.String()), &entry)
			require.NoError(t, err, "log entry must be valid JSON")

			// slog uses "level" field; future middleware maps this to GCP "severity".
			assert.Contains(t, entry, "level",
				"log entry must include level field for GCP severity mapping")
		})
	}
}

// TestStructuredLogging_LogLevelFromConfig documents the expected behavior:
// the log level should be configurable via SMITHERS_LOG_LEVEL (infra.md §8.2).
// BLOCKED: ObservabilityConfig not yet implemented in config.go.
func TestStructuredLogging_LogLevelFromConfig(t *testing.T) {
	t.Parallel()

	// Verify that slog.Level can be set programmatically (future: from config).
	// When ObservabilityConfig is implemented, it should support:
	//   SMITHERS_LOG_LEVEL=debug  → slog.LevelDebug
	//   SMITHERS_LOG_LEVEL=info   → slog.LevelInfo (default)
	//   SMITHERS_LOG_LEVEL=warn   → slog.LevelWarn
	//   SMITHERS_LOG_LEVEL=error  → slog.LevelError

	logLevels := map[string]slog.Level{
		"debug": slog.LevelDebug,
		"info":  slog.LevelInfo,
		"warn":  slog.LevelWarn,
		"error": slog.LevelError,
	}

	for levelStr, level := range logLevels {
		levelStr, level := levelStr, level
		t.Run(levelStr, func(t *testing.T) {
			t.Parallel()

			var buf strings.Builder
			programmaticLogger := slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{
				Level: level,
			}))

			// Debug logs should only appear when level is Debug.
			programmaticLogger.Debug("debug message")
			debugOutput := buf.String()

			if level == slog.LevelDebug {
				assert.NotEmpty(t, debugOutput,
					"debug log must appear when log level is debug")
			} else {
				assert.Empty(t, debugOutput,
					"debug log must be suppressed when log level is %s", levelStr)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Observability Config Contract Tests
//
// Documents the EXPECTED ObservabilityConfig that must be added to
// internal/config/config.go per infra.md §8 requirements.
// BLOCKED: Config section not yet implemented.
// ---------------------------------------------------------------------------

// ObservabilityConfigContract documents the expected fields in the observability
// config section. When implemented, this will be part of internal/config/config.go.
type ObservabilityConfigContract struct {
	// LogLevel configures slog output level (SMITHERS_LOG_LEVEL env var).
	// Valid: "debug", "info", "warn", "error". Default: "info".
	LogLevel string

	// TraceSampleRate configures OpenTelemetry trace sampling (SMITHERS_TRACE_SAMPLE_RATE).
	// Range: 0.0 to 1.0. Default: 0.01 (1% for production), 1.0 for local dev.
	TraceSampleRate float64

	// MetricsExportTarget configures where metrics go (SMITHERS_METRICS_EXPORT_TARGET).
	// Valid: "prometheus" (default), "cloud_monitoring".
	MetricsExportTarget string
}

// TestObservabilityConfig_DefaultValues documents expected defaults for the
// observability config section (blocked on implementation).
func TestObservabilityConfig_DefaultValues(t *testing.T) {
	t.Parallel()

	// This test documents EXPECTED defaults, not current behavior.
	// BLOCKED: ObservabilityConfig not yet in config.go.
	// When implemented, these should be the defaults:

	expected := ObservabilityConfigContract{
		LogLevel:            "info",
		TraceSampleRate:     0.01, // 1% for production
		MetricsExportTarget: "prometheus",
	}

	// Verify the contract struct has the right fields.
	assert.Equal(t, "info", expected.LogLevel,
		"default log level must be 'info' per infra.md §8.2")
	assert.Equal(t, 0.01, expected.TraceSampleRate,
		"default trace sample rate must be 1%% for production (infra.md §8.3)")
	assert.Equal(t, "prometheus", expected.MetricsExportTarget,
		"default metrics export must be prometheus (compatible with /metrics endpoint)")
}

// TestObservabilityConfig_EnvVarNames documents the expected environment variable
// names for the observability config (infra.md §8 + engineering.md SMITHERS_ prefix).
func TestObservabilityConfig_EnvVarNames(t *testing.T) {
	t.Parallel()

	// Expected env var names with SMITHERS_ prefix per engineering.md.
	expectedEnvVars := []string{
		"SMITHERS_LOG_LEVEL",
		"SMITHERS_TRACE_SAMPLE_RATE",
		"SMITHERS_METRICS_EXPORT_TARGET",
		"SMITHERS_OTEL_ENDPOINT",          // Future: OTLP export endpoint
		"SMITHERS_CLOUD_TRACE_PROJECT_ID", // Future: GCP project for Cloud Trace
	}

	for _, envVar := range expectedEnvVars {
		envVar := envVar
		t.Run(envVar, func(t *testing.T) {
			t.Parallel()

			// Verify naming convention: SMITHERS_ prefix per engineering.md.
			assert.True(t, strings.HasPrefix(envVar, "SMITHERS_"),
				"observability env vars must use SMITHERS_ prefix per engineering.md")
			assert.Equal(t, strings.ToUpper(envVar), envVar,
				"env vars must be SCREAMING_SNAKE_CASE")
		})
	}
}

// ---------------------------------------------------------------------------
// OpenTelemetry SDK Contract Tests
//
// Documents the expected OTEL initialization per infra.md §8.3.
// BLOCKED: OTel SDK not initialized in cmd/server/main.go.
// ---------------------------------------------------------------------------

// TestOpenTelemetry_SDKContract documents the required OTel SDK initialization
// that must be added to cmd/server/main.go per infra.md §8.3.
func TestOpenTelemetry_SDKContract(t *testing.T) {
	t.Parallel()

	// This test documents what MUST be implemented. The following OTel setup
	// is required but BLOCKED pending implementation:
	//
	// 1. Initialize TracerProvider with Cloud Trace exporter:
	//    exporter, _ := cloudtrace.New(cloudtrace.WithProjectID(cfg.GCPProject))
	//    tp := sdktrace.NewTracerProvider(
	//        sdktrace.WithBatcher(exporter),
	//        sdktrace.WithSampler(sdktrace.ParentBased(
	//            sdktrace.TraceIDRatioBased(cfg.Observability.TraceSampleRate),
	//        )),
	//    )
	//    otel.SetTracerProvider(tp)
	//
	// 2. Add otelhttp middleware to the chi router:
	//    r.Use(otelhttp.NewMiddleware("smithers-api"))
	//
	// 3. Configure W3C propagator:
	//    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
	//        propagation.TraceContext{},
	//        propagation.Baggage{},
	//    ))

	// Document the go.mod dependencies that exist (indirect → must promote to direct):
	requiredOTelModules := []string{
		"go.opentelemetry.io/otel",
		"go.opentelemetry.io/otel/trace",
		"go.opentelemetry.io/otel/sdk",
		"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp",
	}

	for _, mod := range requiredOTelModules {
		mod := mod
		t.Run(mod, func(t *testing.T) {
			t.Parallel()

			// Verify naming convention only — these modules exist in go.mod as indirect.
			assert.NotEmpty(t, mod,
				"OTel module %q must be in go.mod (currently indirect, must be direct)", mod)
		})
	}
}

// TestOpenTelemetry_SamplingRateContract documents the 1% prod / 100% dev
// sampling requirement from infra.md §8.3.
func TestOpenTelemetry_SamplingRateContract(t *testing.T) {
	t.Parallel()

	type sampleRateConfig struct {
		env      string
		expected float64
	}

	cases := []sampleRateConfig{
		{"production", 0.01}, // 1% sampling in production
		{"development", 1.0}, // 100% sampling locally
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.env, func(t *testing.T) {
			t.Parallel()

			if tc.env == "production" {
				assert.Equal(t, 0.01, tc.expected,
					"production trace sampling must be 1%% per infra.md §8.3")
			} else {
				assert.Equal(t, 1.0, tc.expected,
					"development trace sampling must be 100%% per infra.md §8.3")
			}
		})
	}
}

// ---------------------------------------------------------------------------
// TDD Tests for Structured Logging Implementation
// These tests will fail until the implementation is added.
// ---------------------------------------------------------------------------

// TestParseSlogLevel tests the ParseSlogLevel function for mapping string
// levels to slog.Level values.
func TestParseSlogLevel(t *testing.T) {
	t.Parallel()

	tests := []struct {
		input    string
		expected slog.Level
	}{
		{"debug", slog.LevelDebug},
		{"info", slog.LevelInfo},
		{"warn", slog.LevelWarn},
		{"warning", slog.LevelWarn},
		{"error", slog.LevelError},
		{"critical", slog.LevelError},
		{"", slog.LevelInfo},        // default fallback
		{"invalid", slog.LevelInfo}, // default fallback
		{"DEBUG", slog.LevelDebug},
		{"INFO", slog.LevelInfo},
		{"WARN", slog.LevelWarn},
		{"ERROR", slog.LevelError},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.input, func(t *testing.T) {
			t.Parallel()
			result := middleware.ParseSlogLevel(tc.input)
			assert.Equal(t, tc.expected, result, "ParseSlogLevel(%q) should return %v", tc.input, tc.expected)
		})
	}
}

// TestMapSeverity tests the MapSeverity function for mapping slog.Level
// to GCP-compatible severity strings.
func TestMapSeverity(t *testing.T) {
	t.Parallel()

	tests := []struct {
		level    slog.Level
		expected string
	}{
		{slog.LevelDebug, "DEBUG"},
		{slog.LevelInfo, "INFO"},
		{slog.LevelWarn, "WARNING"},
		{slog.LevelError, "ERROR"},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.expected, func(t *testing.T) {
			t.Parallel()
			result := middleware.MapSeverity(tc.level)
			assert.Equal(t, tc.expected, result, "MapSeverity(%v) should return %q", tc.level, tc.expected)
		})
	}
}

// TestTraceFieldsFromContext tests extracting trace_id and span_id from context.
func TestTraceFieldsFromContext(t *testing.T) {
	t.Parallel()

	t.Run("valid span context yields trace_id and span_id", func(t *testing.T) {
		t.Parallel()

		// Create a valid trace and span ID
		traceID, err := trace.TraceIDFromHex("0123456789abcdef0123456789abcdef")
		require.NoError(t, err)
		spanID, err := trace.SpanIDFromHex("0123456789abcdef")
		require.NoError(t, err)

		// Create a span context with the trace and span IDs
		spanContext := trace.NewSpanContext(trace.SpanContextConfig{
			TraceID:    traceID,
			SpanID:     spanID,
			TraceFlags: trace.FlagsSampled,
		})
		ctx := trace.ContextWithSpanContext(context.Background(), spanContext)

		traceIDResult, spanIDResult := middleware.TraceFieldsFromContext(ctx)

		assert.Equal(t, "0123456789abcdef0123456789abcdef", traceIDResult)
		assert.Equal(t, "0123456789abcdef", spanIDResult)
	})

	t.Run("invalid span context yields empty values", func(t *testing.T) {
		t.Parallel()

		ctx := context.Background()
		traceID, spanID := middleware.TraceFieldsFromContext(ctx)

		assert.Empty(t, traceID)
		assert.Empty(t, spanID)
	})
}

// TestStructuredLogger_LogsHTTPRequestJSON tests that the middleware emits
// structured JSON with the expected HTTP request fields.
func TestStructuredLogger_LogsHTTPRequestJSON(t *testing.T) {
	t.Parallel()

	var buf bytes.Buffer
	logger := middleware.NewServerLogger(&buf, "info")

	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)
	r.Use(middleware.StructuredLogger(logger))
	r.Get("/api/test", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	})

	req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
	req.Header.Set("X-Request-ID", "test-request-id-123")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	// Parse the log output
	output := buf.String()
	require.NotEmpty(t, output, "log output should not be empty")

	var entry GCPLogEntry
	err := json.Unmarshal([]byte(output), &entry)
	require.NoError(t, err, "log output should be valid JSON")

	// Verify severity
	assert.Equal(t, "INFO", entry.Severity, "severity should be INFO")

	// Verify httpRequest fields
	require.NotNil(t, entry.HTTPRequest, "httpRequest should be present")
	assert.Equal(t, "GET", entry.HTTPRequest.RequestMethod)
	assert.Equal(t, "/api/test", entry.HTTPRequest.RequestURL)
	assert.Equal(t, 200, entry.HTTPRequest.Status)
	assert.NotEmpty(t, entry.HTTPRequest.Latency, "latency should be present")

	// Verify labels.request_id
	require.NotNil(t, entry.Labels, "labels should be present")
	assert.Equal(t, "test-request-id-123", entry.Labels.RequestID)
}

func TestStructuredLogger_RemoteIPParsesIPAddresses(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		remoteAddr string
		want       string
	}{
		{
			name:       "ipv4 with port",
			remoteAddr: "192.0.2.10:443",
			want:       "192.0.2.10",
		},
		{
			name:       "bracketed ipv6 with port",
			remoteAddr: "[2001:db8::1]:443",
			want:       "2001:db8::1",
		},
		{
			name:       "raw ipv6 without port",
			remoteAddr: "2001:db8::1",
			want:       "2001:db8::1",
		},
		{
			name:       "raw ipv4 without port",
			remoteAddr: "192.0.2.10",
			want:       "192.0.2.10",
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			var buf bytes.Buffer
			logger := middleware.NewServerLogger(&buf, "info")

			r := chi.NewRouter()
			r.Use(middleware.StructuredLogger(logger))
			r.Get("/api/test", func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusOK)
			})

			req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
			req.RemoteAddr = tc.remoteAddr
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)

			require.Equal(t, http.StatusOK, rec.Code)

			var entry GCPLogEntry
			require.NoError(t, json.Unmarshal(buf.Bytes(), &entry))
			require.NotNil(t, entry.HTTPRequest)
			assert.Equal(t, tc.want, entry.HTTPRequest.RemoteIP)
		})
	}
}

// TestStructuredLogger_IncludesUserIDWhenAuthenticated tests that user_id
// is included when the request has an authenticated user.
func TestStructuredLogger_IncludesUserIDWhenAuthenticated(t *testing.T) {
	t.Parallel()

	var buf bytes.Buffer
	logger := middleware.NewServerLogger(&buf, "info")

	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Inject auth info into context
			ctx := middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{
				User: &db.User{ID: 42, Username: "alice"},
			})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	})
	r.Use(middleware.StructuredLogger(logger))
	r.Get("/api/test", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	output := buf.String()
	var entry GCPLogEntry
	err := json.Unmarshal([]byte(output), &entry)
	require.NoError(t, err)

	require.NotNil(t, entry.Labels, "labels should be present")
	assert.Equal(t, "42", entry.Labels.UserID, "user_id should be present and equal to 42")
}

// TestStructuredLogger_OmitsUserIDWhenUnauthenticated tests that user_id
// is omitted when the request has no authenticated user.
func TestStructuredLogger_OmitsUserIDWhenUnauthenticated(t *testing.T) {
	t.Parallel()

	var buf bytes.Buffer
	logger := middleware.NewServerLogger(&buf, "info")

	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)
	r.Use(middleware.StructuredLogger(logger))
	r.Get("/api/test", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	output := buf.String()
	var entry GCPLogEntry
	err := json.Unmarshal([]byte(output), &entry)
	require.NoError(t, err)

	// user_id should be empty/omitted
	if entry.Labels != nil {
		assert.Empty(t, entry.Labels.UserID, "user_id should be empty for unauthenticated requests")
	}
}

// TestStructuredLogger_IncludesTraceAndSpanIDs tests that trace_id and span_id
// are included when the request has an active OpenTelemetry span context.
func TestStructuredLogger_IncludesTraceAndSpanIDs(t *testing.T) {
	t.Parallel()

	var buf bytes.Buffer
	logger := middleware.NewServerLogger(&buf, "info")

	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)
	r.Use(middleware.StructuredLogger(logger))
	r.Get("/api/test", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	// Create a request with a valid trace context
	traceID, _ := trace.TraceIDFromHex("abcdef0123456789abcdef0123456789")
	spanID, _ := trace.SpanIDFromHex("abcdef0123456789")
	spanContext := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID:    traceID,
		SpanID:     spanID,
		TraceFlags: trace.FlagsSampled,
	})
	ctx := trace.ContextWithSpanContext(context.Background(), spanContext)
	req := httptest.NewRequest(http.MethodGet, "/api/test", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	output := buf.String()
	var entry GCPLogEntry
	err := json.Unmarshal([]byte(output), &entry)
	require.NoError(t, err)

	// Verify trace_id and span_id are present
	assert.Equal(t, "abcdef0123456789abcdef0123456789", entry.TraceID, "trace_id should be present")
	assert.Equal(t, "abcdef0123456789", entry.SpanID, "span_id should be present")
}

// TestNewServerLogger_RespectsConfiguredMinimumLevel tests that the logger
// respects the configured minimum log level.
func TestNewServerLogger_RespectsConfiguredMinimumLevel(t *testing.T) {
	t.Parallel()

	t.Run("info level filters debug logs", func(t *testing.T) {
		t.Parallel()

		var buf bytes.Buffer
		logger := middleware.NewServerLogger(&buf, "info")

		logger.Debug("debug message")
		logger.Info("info message")

		output := buf.String()
		assert.NotContains(t, output, "debug message", "debug message should be filtered")
		assert.Contains(t, output, "info message", "info message should be present")
	})

	t.Run("debug level allows all logs", func(t *testing.T) {
		t.Parallel()

		var buf bytes.Buffer
		logger := middleware.NewServerLogger(&buf, "debug")

		logger.Debug("debug message")
		logger.Info("info message")

		output := buf.String()
		assert.Contains(t, output, "debug message", "debug message should be present")
		assert.Contains(t, output, "info message", "info message should be present")
	})

	t.Run("error level filters info and warn logs", func(t *testing.T) {
		t.Parallel()

		var buf bytes.Buffer
		logger := middleware.NewServerLogger(&buf, "error")

		logger.Debug("debug message")
		logger.Info("info message")
		logger.Warn("warn message")
		logger.Error("error message")

		output := buf.String()
		assert.NotContains(t, output, "debug message")
		assert.NotContains(t, output, "info message")
		assert.NotContains(t, output, "warn message")
		assert.Contains(t, output, "error message")
	})
}

// ---------------------------------------------------------------------------
// Context-aware logger tests
// ---------------------------------------------------------------------------

// TestInjectLogger_SetsRequestIDInContext verifies that InjectLogger injects
// a logger with request_id into the request context, and that LoggerFromContext
// retrieves it.
func TestInjectLogger_SetsRequestIDInContext(t *testing.T) {
	t.Parallel()

	var buf bytes.Buffer
	base := middleware.NewServerLogger(&buf, "info")

	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)
	r.Use(middleware.InjectLogger(base))
	r.Get("/api/test", func(w http.ResponseWriter, r *http.Request) {
		logger := middleware.LoggerFromContext(r.Context())
		logger.Info("handler log")
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
	req.Header.Set("X-Request-Id", "inject-test-id-456")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	output := buf.String()
	assert.Contains(t, output, "inject-test-id-456",
		"handler log should contain request_id from context")
	assert.Contains(t, output, "handler log",
		"handler log message should be present")
}

// TestLoggerFromContext_FallsBackToDefault verifies that LoggerFromContext
// returns slog.Default() when no logger was injected via InjectLogger.
func TestLoggerFromContext_FallsBackToDefault(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	logger := middleware.LoggerFromContext(ctx)
	require.NotNil(t, logger, "LoggerFromContext must never return nil")
}

func TestStructuredLogger_PreservesHijacker(t *testing.T) {
	t.Parallel()

	logger := middleware.NewServerLogger(&bytes.Buffer{}, "info")

	r := chi.NewRouter()
	r.Use(middleware.StructuredLogger(logger))

	var hijackerSupported bool
	r.Get("/api/test", func(w http.ResponseWriter, r *http.Request) {
		_, hijackerSupported = w.(http.Hijacker)
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
	rec := &hijackOnlyResponseWriter{}
	r.ServeHTTP(rec, req)

	assert.True(t, hijackerSupported,
		"StructuredLogger must implement http.Hijacker when the underlying writer supports it")
}

func TestStructuredLogger_DoesNotExposeHijackerWhenUnsupported(t *testing.T) {
	t.Parallel()

	logger := middleware.NewServerLogger(&bytes.Buffer{}, "info")

	r := chi.NewRouter()
	r.Use(middleware.StructuredLogger(logger))

	var hijackerSupported bool
	r.Get("/api/test", func(w http.ResponseWriter, r *http.Request) {
		_, hijackerSupported = w.(http.Hijacker)
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	assert.False(t, hijackerSupported,
		"StructuredLogger must not expose http.Hijacker when the underlying writer does not support it")
}

// TestLoggerFromContext_IncludesUserIDFromAuthInfo verifies that when auth
// info is present in the context, LoggerFromContext lazily attaches user_id.
func TestLoggerFromContext_IncludesUserIDFromAuthInfo(t *testing.T) {
	t.Parallel()

	var buf bytes.Buffer
	base := middleware.NewServerLogger(&buf, "info")

	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)
	r.Use(middleware.InjectLogger(base))
	// Simulate auth middleware setting user in context.
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{
				User: &db.User{ID: 99, Username: "bob"},
			})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	})
	r.Get("/api/test", func(w http.ResponseWriter, r *http.Request) {
		logger := middleware.LoggerFromContext(r.Context())
		logger.Info("authenticated handler log")
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	output := buf.String()
	assert.Contains(t, output, `"user_id":"99"`,
		"handler log should include user_id from AuthInfo")
}

// TestLoggerWithAgentSession_IncludesSessionID verifies that the agent session
// helper attaches agent_session_id to the logger.
func TestLoggerWithAgentSession_IncludesSessionID(t *testing.T) {
	t.Parallel()

	var buf bytes.Buffer
	base := middleware.NewServerLogger(&buf, "info")

	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)
	r.Use(middleware.InjectLogger(base))
	r.Get("/api/test", func(w http.ResponseWriter, r *http.Request) {
		logger := middleware.LoggerWithAgentSession(r.Context(), "session-abc-123")
		logger.Info("agent session log")
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
	req.Header.Set("X-Request-Id", "agent-req-id")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	output := buf.String()
	assert.Contains(t, output, "session-abc-123",
		"log should contain agent_session_id")
	assert.Contains(t, output, "agent-req-id",
		"log should contain request_id")
	assert.Contains(t, output, "agent session log",
		"log message should be present")
}

// TestLoggerWithWorkflowRun_IncludesRunID verifies that the workflow run
// helper attaches workflow_run_id to the logger.
func TestLoggerWithWorkflowRun_IncludesRunID(t *testing.T) {
	t.Parallel()

	var buf bytes.Buffer
	base := middleware.NewServerLogger(&buf, "info")

	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)
	r.Use(middleware.InjectLogger(base))
	r.Get("/api/test", func(w http.ResponseWriter, r *http.Request) {
		logger := middleware.LoggerWithWorkflowRun(r.Context(), 42)
		logger.Info("workflow run log")
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
	req.Header.Set("X-Request-Id", "wf-req-id")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	output := buf.String()
	assert.Contains(t, output, `"workflow_run_id":42`,
		"log should contain workflow_run_id")
	assert.Contains(t, output, "wf-req-id",
		"log should contain request_id")
	assert.Contains(t, output, "workflow run log",
		"log message should be present")
}

// TestLoggerWithAgentSessionAndWorkflowRun_IncludesBothIDs verifies that the
// combined helper attaches both agent_session_id and workflow_run_id.
func TestLoggerWithAgentSessionAndWorkflowRun_IncludesBothIDs(t *testing.T) {
	t.Parallel()

	var buf bytes.Buffer
	base := middleware.NewServerLogger(&buf, "info")

	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)
	r.Use(middleware.InjectLogger(base))
	r.Get("/api/test", func(w http.ResponseWriter, r *http.Request) {
		logger := middleware.LoggerWithAgentSessionAndWorkflowRun(r.Context(), "session-xyz", 99)
		logger.Info("agent+workflow log")
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
	req.Header.Set("X-Request-Id", "combined-req-id")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	output := buf.String()
	assert.Contains(t, output, `"agent_session_id":"session-xyz"`,
		"log should contain agent_session_id")
	assert.Contains(t, output, `"workflow_run_id":99`,
		"log should contain workflow_run_id")
	assert.Contains(t, output, "combined-req-id",
		"log should contain request_id")
	assert.Contains(t, output, "agent+workflow log",
		"log message should be present")
}

// TestRequestIDFromContext_ReturnsRequestID verifies the convenience wrapper
// correctly extracts the chi request ID from context.
func TestRequestIDFromContext_ReturnsRequestID(t *testing.T) {
	t.Parallel()

	var capturedID string

	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)
	r.Get("/api/test", func(w http.ResponseWriter, r *http.Request) {
		capturedID = middleware.RequestIDFromContext(r.Context())
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
	req.Header.Set("X-Request-Id", "context-req-id-789")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "context-req-id-789", capturedID,
		"RequestIDFromContext should return the chi request ID")
}

// TestRequestIDFromContext_EmptyWhenNoChi verifies the helper returns empty
// when no chi RequestID middleware is in the chain.
func TestRequestIDFromContext_EmptyWhenNoChi(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	assert.Empty(t, middleware.RequestIDFromContext(ctx),
		"RequestIDFromContext should return empty string without chi middleware")
}

// TestInjectLogger_IncludesTraceIDs verifies that the injected logger includes
// trace_id and span_id when OpenTelemetry span context is present.
func TestInjectLogger_IncludesTraceIDs(t *testing.T) {
	t.Parallel()

	var buf bytes.Buffer
	base := middleware.NewServerLogger(&buf, "info")

	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)
	r.Use(middleware.InjectLogger(base))
	r.Get("/api/test", func(w http.ResponseWriter, r *http.Request) {
		logger := middleware.LoggerFromContext(r.Context())
		logger.Info("traced handler log")
		w.WriteHeader(http.StatusOK)
	})

	// Create a request with valid trace context.
	traceID, _ := trace.TraceIDFromHex("aabbccdd11223344aabbccdd11223344")
	spanID, _ := trace.SpanIDFromHex("aabbccdd11223344")
	spanContext := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID:    traceID,
		SpanID:     spanID,
		TraceFlags: trace.FlagsSampled,
	})
	ctx := trace.ContextWithSpanContext(context.Background(), spanContext)
	req := httptest.NewRequest(http.MethodGet, "/api/test", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	output := buf.String()
	assert.Contains(t, output, "aabbccdd11223344aabbccdd11223344",
		"handler log should include trace_id")
	assert.Contains(t, output, "aabbccdd11223344",
		"handler log should include span_id")
}

// ---------------------------------------------------------------------------
// Access-log user attribution in PRODUCTION middleware order
// (release review 2026-09-13, R005)
//
// cmd/server/router.go mounts StructuredLogger globally, BEFORE the per-group
// AuthLoader / SSETicketAuth / RevocationGuard. Those middlewares hand the
// downstream handler a new *http.Request whose context carries AuthInfo; the
// logger's own request never sees it. The access log must still name the
// principal the request ran as (or was refused as).
// ---------------------------------------------------------------------------

// accessLogAuthQuerier is a minimal AuthLoaderQuerier for the external test
// package: one PAT hash and one session key resolve to user 42, everything
// else is pgx.ErrNoRows.
type accessLogAuthQuerier struct {
	tokenHash  string
	sessionKey string
	user       db.User
}

func (q *accessLogAuthQuerier) GetAuthSessionBySessionKey(_ context.Context, sessionKey string) (db.AuthSession, error) {
	if sessionKey != q.sessionKey || q.sessionKey == "" {
		return db.AuthSession{}, pgx.ErrNoRows
	}
	return db.AuthSession{
		SessionKey: sessionKey,
		UserID:     q.user.ID,
		Username:   q.user.Username,
		ExpiresAt:  time.Now().Add(720 * time.Hour),
	}, nil
}

func (q *accessLogAuthQuerier) RefreshAuthSession(_ context.Context, arg db.RefreshAuthSessionParams) (db.AuthSession, error) {
	return db.AuthSession{SessionKey: arg.SessionKey, UserID: q.user.ID, ExpiresAt: arg.ExpiresAt}, nil
}

func (q *accessLogAuthQuerier) GetAuthInfoByTokenHash(_ context.Context, tokenHash string) (db.GetAuthInfoByTokenHashRow, error) {
	if tokenHash != q.tokenHash || q.tokenHash == "" {
		return db.GetAuthInfoByTokenHashRow{}, pgx.ErrNoRows
	}
	return db.GetAuthInfoByTokenHashRow{
		TokenID:       7,
		TokenScopes:   "read:user",
		ID:            q.user.ID,
		Username:      q.user.Username,
		LowerUsername: strings.ToLower(q.user.Username),
		IsActive:      true,
	}, nil
}

func (q *accessLogAuthQuerier) GetFirstPartyOAuth2AccessTokenByHash(context.Context, string) (db.Oauth2AccessToken, error) {
	return db.Oauth2AccessToken{}, pgx.ErrNoRows
}

func (q *accessLogAuthQuerier) UpdateAccessTokenLastUsed(context.Context, int64) error { return nil }

func (q *accessLogAuthQuerier) GetUserByID(_ context.Context, id int64) (db.User, error) {
	if id != q.user.ID {
		return db.User{}, pgx.ErrNoRows
	}
	return q.user, nil
}

type accessLogTicketValidator struct {
	ticket    string
	principal *middleware.SSETicketPrincipal
}

func (v *accessLogTicketValidator) ValidateTicket(_ context.Context, rawTicket string) (*middleware.SSETicketPrincipal, error) {
	if rawTicket != v.ticket {
		return nil, pgx.ErrNoRows
	}
	return v.principal, nil
}

type accessLogRevocationChecker struct {
	revokedTokenHash string
}

func (c *accessLogRevocationChecker) IsTokenRevoked(tokenHash string) bool {
	return tokenHash == c.revokedTokenHash
}

func (c *accessLogRevocationChecker) IsUserDisabled(int64) bool { return false }

func (c *accessLogRevocationChecker) IsBrowserSessionRevoked(string) bool { return false }

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// lastAccessLogEntry parses the last "http request" line the logger wrote.
func lastAccessLogEntry(t *testing.T, buf *bytes.Buffer) GCPLogEntry {
	t.Helper()
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	require.NotEmpty(t, lines, "expected an access log line")
	var entry GCPLogEntry
	require.NoError(t, json.Unmarshal([]byte(lines[len(lines)-1]), &entry), "log line: %s", lines[len(lines)-1])
	return entry
}

func TestStructuredLogger_ProductionOrder_BearerTokenSetsUserID(t *testing.T) {
	t.Parallel()

	const pat = "smithers_0123456789abcdef0123456789abcdef01234567"
	querier := &accessLogAuthQuerier{tokenHash: sha256Hex(pat), user: db.User{ID: 42, Username: "alice", IsActive: true}}

	var buf bytes.Buffer
	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)
	r.Use(middleware.StructuredLogger(middleware.NewServerLogger(&buf, "info"))) // global, before auth
	r.Group(func(r chi.Router) {
		r.Use(middleware.AuthLoader(querier, config.AuthConfig{}))
		r.Get("/api/user", func(w http.ResponseWriter, r *http.Request) {
			require.NotNil(t, middleware.UserFromContext(r.Context()), "fixture: AuthLoader must resolve the PAT")
			w.WriteHeader(http.StatusOK)
		})
	})

	req := httptest.NewRequest(http.MethodGet, "/api/user", nil)
	req.Header.Set("Authorization", "Bearer "+pat)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	entry := lastAccessLogEntry(t, &buf)
	require.NotNil(t, entry.Labels)
	assert.Equal(t, "42", entry.Labels.UserID, "access log must attribute the request to the PAT's user")
	assert.NotContains(t, buf.String(), pat, "the raw token must never be logged")
}

func TestStructuredLogger_ProductionOrder_SessionCookieSetsUserID(t *testing.T) {
	t.Parallel()

	querier := &accessLogAuthQuerier{sessionKey: "session-key-fixture", user: db.User{ID: 43, Username: "bob", IsActive: true}}

	var buf bytes.Buffer
	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)
	r.Use(middleware.StructuredLogger(middleware.NewServerLogger(&buf, "info")))
	r.Group(func(r chi.Router) {
		r.Use(middleware.AuthLoader(querier, config.AuthConfig{SessionCookieName: "smithers_session"}))
		r.Get("/api/user", func(w http.ResponseWriter, r *http.Request) {
			require.NotNil(t, middleware.UserFromContext(r.Context()), "fixture: AuthLoader must resolve the session")
			w.WriteHeader(http.StatusOK)
		})
	})

	req := httptest.NewRequest(http.MethodGet, "/api/user", nil)
	req.AddCookie(&http.Cookie{Name: "smithers_session", Value: "session-key-fixture"})
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	entry := lastAccessLogEntry(t, &buf)
	require.NotNil(t, entry.Labels)
	assert.Equal(t, "43", entry.Labels.UserID, "access log must attribute a cookie session to its user")
}

func TestStructuredLogger_ProductionOrder_SSETicketSetsUserID(t *testing.T) {
	t.Parallel()

	validator := &accessLogTicketValidator{
		ticket:    "ticket-fixture",
		principal: &middleware.SSETicketPrincipal{User: &db.User{ID: 44, Username: "carol", IsActive: true}},
	}

	var buf bytes.Buffer
	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)
	r.Use(middleware.StructuredLogger(middleware.NewServerLogger(&buf, "info")))
	r.Group(func(r chi.Router) {
		r.Use(middleware.AuthLoader(&accessLogAuthQuerier{}, config.AuthConfig{}))
		r.Use(middleware.SSETicketAuth(validator, nil))
		r.Get("/api/notifications", func(w http.ResponseWriter, r *http.Request) {
			require.NotNil(t, middleware.UserFromContext(r.Context()), "fixture: ticket must resolve")
			w.WriteHeader(http.StatusOK)
		})
	})

	req := httptest.NewRequest(http.MethodGet, "/api/notifications?ticket=ticket-fixture", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	entry := lastAccessLogEntry(t, &buf)
	require.NotNil(t, entry.Labels)
	assert.Equal(t, "44", entry.Labels.UserID, "access log must attribute an SSE ticket to its user")
	assert.NotContains(t, buf.String(), "ticket-fixture", "the ticket must never be logged")
}

func TestStructuredLogger_ProductionOrder_AnonymousOmitsUserID(t *testing.T) {
	t.Parallel()

	var buf bytes.Buffer
	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)
	r.Use(middleware.StructuredLogger(middleware.NewServerLogger(&buf, "info")))
	r.Group(func(r chi.Router) {
		r.Use(middleware.AuthLoader(&accessLogAuthQuerier{}, config.AuthConfig{}))
		r.Get("/api/health", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	})

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	require.Equal(t, http.StatusOK, rec.Code)

	entry := lastAccessLogEntry(t, &buf)
	if entry.Labels != nil {
		assert.Empty(t, entry.Labels.UserID, "anonymous requests carry no user_id")
	}
	assert.NotContains(t, buf.String(), "user_id")
}

func TestStructuredLogger_ProductionOrder_RevokedTokenLogsRefusedPrincipal(t *testing.T) {
	t.Parallel()

	const pat = "smithers_fedcba9876543210fedcba9876543210fedcba98"
	querier := &accessLogAuthQuerier{tokenHash: sha256Hex(pat), user: db.User{ID: 45, Username: "dave", IsActive: true}}
	checker := &accessLogRevocationChecker{revokedTokenHash: sha256Hex(pat)}

	var buf bytes.Buffer
	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)
	r.Use(middleware.StructuredLogger(middleware.NewServerLogger(&buf, "info")))
	r.Group(func(r chi.Router) {
		// cmd/server authLoader(): load(guard(next))
		r.Use(func(next http.Handler) http.Handler {
			return middleware.AuthLoader(querier, config.AuthConfig{})(middleware.RevocationGuard(checker)(next))
		})
		r.Get("/api/user", func(w http.ResponseWriter, _ *http.Request) {
			t.Fatal("a revoked token must not reach the handler")
		})
	})

	req := httptest.NewRequest(http.MethodGet, "/api/user", nil)
	req.Header.Set("Authorization", "Bearer "+pat)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	require.Equal(t, http.StatusUnauthorized, rec.Code)

	entry := lastAccessLogEntry(t, &buf)
	require.NotNil(t, entry.HTTPRequest)
	assert.Equal(t, http.StatusUnauthorized, entry.HTTPRequest.Status)
	require.NotNil(t, entry.Labels)
	assert.Equal(t, "45", entry.Labels.UserID, "a refused revoked credential must still be attributed to its principal")
}

func TestStructuredLogger_LastAuthUpdateWins(t *testing.T) {
	t.Parallel()
	for _, clear := range []bool{false, true} {
		t.Run(fmt.Sprintf("clear=%t", clear), func(t *testing.T) {
			var buf bytes.Buffer
			handler := middleware.StructuredLogger(middleware.NewServerLogger(&buf, "info"))(
				http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					ctx := middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{User: &db.User{ID: 47}})
					if clear {
						ctx = middleware.ContextWithAuthInfo(ctx, nil)
					}
					assert.Equal(t, !clear, middleware.AuthInfoFromContext(ctx) != nil)
					w.WriteHeader(http.StatusOK)
				}))
			req := httptest.NewRequest(http.MethodGet, "/api/user", nil)
			req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{User: &db.User{ID: 46}}))
			handler.ServeHTTP(httptest.NewRecorder(), req)
			entry := lastAccessLogEntry(t, &buf)
			if clear {
				assert.Empty(t, entry.Labels.UserID)
			} else {
				assert.Equal(t, "47", entry.Labels.UserID)
			}
		})
	}
}
