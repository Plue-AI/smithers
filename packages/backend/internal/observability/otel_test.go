package observability

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	oteltrace "go.opentelemetry.io/otel/trace"

	"github.com/smithersai/smithers/packages/backend/internal/config"
)

func TestBuildTraceSampler_AlwaysSample(t *testing.T) {
	// Sample rate of 1.0 should always sample
	sampler := BuildTraceSampler(1.0)
	require.NotNil(t, sampler)
	assert.Contains(t, sampler.Description(), "AlwaysOn")
}

func TestBuildTraceSampler_NeverSample(t *testing.T) {
	// Sample rate of 0.0 should never sample
	sampler := BuildTraceSampler(0.0)
	require.NotNil(t, sampler)
	assert.Contains(t, sampler.Description(), "AlwaysOff")
}

func TestBuildTraceSampler_RatioBased(t *testing.T) {
	// Sample rate between 0 and 1 should use TraceIDRatioBased for root spans
	// and defer only to local parent decisions otherwise.
	sampler := BuildTraceSampler(0.5)
	require.NotNil(t, sampler)
	assert.Contains(t, sampler.Description(), "ParentBased")
	assert.Contains(t, sampler.Description(), "TraceIDRatioBased")
}

// TestBuildTraceSampler_HonoursLocalParentDecision pins the contract the
// in-process instrumentation relies on: a local parent that is sampled is always
// exported, and one that is not sampled never is, regardless of the ratio.
func TestBuildTraceSampler_HonoursLocalParentDecision(t *testing.T) {
	// A trace ID whose low 8 bytes are all 0xff is above every ratio bound
	// below 1.0, so TraceIDRatioBased alone would drop it.
	traceID := oteltrace.TraceID{1, 2, 3, 4, 5, 6, 7, 8, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}
	spanID := oteltrace.SpanID{1, 2, 3, 4, 5, 6, 7, 8}
	sampler := BuildTraceSampler(0.01)

	cases := []struct {
		name  string
		flags oteltrace.TraceFlags
		want  trace.SamplingDecision
	}{
		{name: "sampled local parent", flags: oteltrace.FlagsSampled, want: trace.RecordAndSample},
		{name: "unsampled local parent", flags: 0, want: trace.Drop},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			parent := oteltrace.NewSpanContext(oteltrace.SpanContextConfig{
				TraceID:    traceID,
				SpanID:     spanID,
				TraceFlags: tc.flags,
				Remote:     false,
			})
			ctx := oteltrace.ContextWithSpanContext(context.Background(), parent)
			result := sampler.ShouldSample(trace.SamplingParameters{
				ParentContext: ctx,
				TraceID:       traceID,
				Name:          "GET /healthz",
				Kind:          oteltrace.SpanKindServer,
			})
			assert.Equal(t, tc.want, result.Decision)
		})
	}

	// Without a parent the ratio decides; the same high trace ID is dropped.
	root := sampler.ShouldSample(trace.SamplingParameters{
		ParentContext: context.Background(),
		TraceID:       traceID,
		Name:          "GET /healthz",
		Kind:          oteltrace.SpanKindServer,
	})
	assert.Equal(t, trace.Drop, root.Decision)
}

func TestBuildTraceSampler_Defaults(t *testing.T) {
	// Negative sample rate should default to NeverSample
	sampler := BuildTraceSampler(-0.1)
	require.NotNil(t, sampler)
	assert.Contains(t, sampler.Description(), "AlwaysOff")

	// Sample rate > 1 should default to AlwaysSample
	sampler = BuildTraceSampler(1.5)
	require.NotNil(t, sampler)
	assert.Contains(t, sampler.Description(), "AlwaysOn")
}

func TestBuildTextMapPropagator(t *testing.T) {
	propagator := BuildTextMapPropagator()
	require.NotNil(t, propagator)

	// Verify it supports trace context and baggage by extracting from a carrier
	carrier := propagation.MapCarrier{}
	carrier.Set("traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
	carrier.Set("baggage", "key=value")

	ctx := propagator.Extract(context.Background(), carrier)
	require.NotNil(t, ctx)
}

func TestInit_NoProjectID(t *testing.T) {
	ctx := context.Background()
	cfg := config.ObservabilityConfig{
		TraceSampleRate: 0.01,
		OTelExporter:    "none",
	}

	provider, err := Init(ctx, cfg)
	require.NoError(t, err)
	assert.Nil(t, provider)
}

func TestInit_WithProjectID(t *testing.T) {
	// This test verifies the function signature and basic behavior.
	// Full integration with Cloud Trace requires GCP credentials.
	ctx := context.Background()
	cfg := config.ObservabilityConfig{
		TraceSampleRate: 0.01,
	}

	// Should attempt to create a provider (may fail due to missing credentials)
	// but should not panic
	provider, err := Init(ctx, cfg)
	if err != nil {
		assert.Nil(t, provider)
	}
}

func TestInit_OTLPExporterRequiresEndpoint(t *testing.T) {
	provider, err := Init(context.Background(), config.ObservabilityConfig{
		OTelExporter:    "otlp",
		TraceSampleRate: 1,
	})

	require.Error(t, err)
	assert.Nil(t, provider)
	assert.ErrorContains(t, err, "SMITHERS_OTEL_EXPORTER_OTLP_ENDPOINT")
}

func TestInit_OTLPExporterCreatesProvider(t *testing.T) {
	originalProvider := otel.GetTracerProvider()
	originalPropagator := otel.GetTextMapPropagator()
	defer otel.SetTracerProvider(originalProvider)
	defer otel.SetTextMapPropagator(originalPropagator)

	provider, err := Init(context.Background(), config.ObservabilityConfig{
		OTelExporter:    "otlp",
		OTLPEndpoint:    "http://127.0.0.1:4318",
		TraceSampleRate: 1,
	})
	require.NoError(t, err)
	require.NotNil(t, provider)
	t.Cleanup(func() {
		require.NoError(t, provider.Shutdown(context.Background()))
	})
	assert.Same(t, provider, otel.GetTracerProvider())
}

func TestInit_RejectsUnknownExporter(t *testing.T) {
	provider, err := Init(context.Background(), config.ObservabilityConfig{
		OTelExporter:    "zipkin",
		TraceSampleRate: 1,
	})

	require.Error(t, err)
	assert.Nil(t, provider)
	assert.ErrorContains(t, err, "unsupported SMITHERS_OTEL_EXPORTER")
}

// ---------------------------------------------------------------------------
// URL credential redaction (release review 2026-09-13, R003)
//
// otelhttp records url.path at span start, before the desktop relay handler
// can authorize the smithers_desk_ token carried in the path. The provider
// Init installs must scrub that attribute before any exporter sees it.
// ---------------------------------------------------------------------------

const otelTestDesktopToken = "smithers_desk_0123456789abcdef0123456789abcdef"

func otelTestAttr(attrs []attribute.KeyValue, key attribute.Key) (string, bool) {
	for _, attr := range attrs {
		if attr.Key == key {
			return attr.Value.String(), true
		}
	}
	return "", false
}

func TestNewTracerProvider_RedactsDesktopTokenFromServerSpan(t *testing.T) {
	exporter := tracetest.NewInMemoryExporter()
	provider := NewTracerProvider(exporter, 1.0)
	t.Cleanup(func() { _ = provider.Shutdown(context.Background()) })

	handler := otelhttp.NewMiddleware("smithers-server", otelhttp.WithTracerProvider(provider))(
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusServiceUnavailable) }),
	)
	req := httptest.NewRequest(http.MethodGet,
		"/api/workspaces/ws1/desktop/"+otelTestDesktopToken+"/vnc.html?autoconnect=true&password=secretvnc", nil)
	handler.ServeHTTP(httptest.NewRecorder(), req)

	require.NoError(t, provider.ForceFlush(context.Background()))
	spans := exporter.GetSpans()
	require.Len(t, spans, 1, "the server span must be exported through the batcher")

	path, ok := otelTestAttr(spans[0].Attributes, "url.path")
	require.True(t, ok, "otelhttp records url.path on server spans")
	assert.Equal(t, "/api/workspaces/ws1/desktop/smithers_desk_REDACTED/vnc.html", path)
	for _, attr := range spans[0].Attributes {
		value := attr.Value.String()
		assert.NotContains(t, value, otelTestDesktopToken, "attribute %s leaks the desktop token", attr.Key)
		assert.NotContains(t, value, "secretvnc", "attribute %s leaks the VNC password", attr.Key)
	}
}

type otelTestRoundTripper struct{}

func (otelTestRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{},
		Body:       io.NopCloser(strings.NewReader("")),
		Request:    req,
	}, nil
}

func TestNewTracerProvider_RedactsDesktopTokenFromClientSpan(t *testing.T) {
	exporter := tracetest.NewInMemoryExporter()
	provider := NewTracerProvider(exporter, 1.0)
	t.Cleanup(func() { _ = provider.Shutdown(context.Background()) })

	client := &http.Client{Transport: otelhttp.NewTransport(otelTestRoundTripper{}, otelhttp.WithTracerProvider(provider))}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet,
		"http://relay.internal/api/workspaces/ws1/desktop/"+otelTestDesktopToken+"/websockify?path=x&password=secretvnc", nil)
	require.NoError(t, err)
	resp, err := client.Do(req)
	require.NoError(t, err)
	require.NoError(t, resp.Body.Close())

	require.NoError(t, provider.ForceFlush(context.Background()))
	spans := exporter.GetSpans()
	require.Len(t, spans, 1)

	full, ok := otelTestAttr(spans[0].Attributes, "url.full")
	require.True(t, ok, "otelhttp records url.full on client spans")
	assert.Equal(t, "http://relay.internal/api/workspaces/ws1/desktop/smithers_desk_REDACTED/websockify?path=REDACTED&password=REDACTED", full)
	for _, attr := range spans[0].Attributes {
		assert.NotContains(t, attr.Value.String(), otelTestDesktopToken, "attribute %s leaks the desktop token", attr.Key)
	}
}

func TestNewTracerProvider_RedactsEveryURLAttributeSpelling(t *testing.T) {
	exporter := tracetest.NewInMemoryExporter()
	provider := NewTracerProvider(exporter, 1.0)
	t.Cleanup(func() { _ = provider.Shutdown(context.Background()) })

	target := "/api/workspaces/ws1/desktop/" + otelTestDesktopToken + "/websockify?password=secretvnc&x=1"
	_, span := provider.Tracer("test").Start(context.Background(), "manual",
		oteltrace.WithAttributes(
			attribute.String("url.path", "/api/workspaces/ws1/desktop/"+otelTestDesktopToken+"/websockify"),
			attribute.String("url.query", "password=secretvnc&path=desktop%2F"+otelTestDesktopToken+"&%70assword=encodedsecret&x=1"),
			attribute.String("http.target", target),
			attribute.String("url.full", "https://api.jjhub.tech"+target),
			attribute.String("http.route", "/api/workspaces/{workspaceID}/desktop/{token}/*"),
			attribute.Int("http.response.status_code", 401),
		))
	span.End()

	require.NoError(t, provider.ForceFlush(context.Background()))
	spans := exporter.GetSpans()
	require.Len(t, spans, 1)
	got := map[attribute.Key]string{}
	for _, attr := range spans[0].Attributes {
		got[attr.Key] = attr.Value.String()
	}
	assert.Equal(t, "/api/workspaces/ws1/desktop/smithers_desk_REDACTED/websockify", got["url.path"])
	assert.Equal(t, "password=REDACTED&path=REDACTED&%70assword=REDACTED&x=1", got["url.query"])
	assert.Equal(t, "/api/workspaces/ws1/desktop/smithers_desk_REDACTED/websockify?password=REDACTED&x=1", got["http.target"])
	assert.Equal(t, "https://api.jjhub.tech/api/workspaces/ws1/desktop/smithers_desk_REDACTED/websockify?password=REDACTED&x=1", got["url.full"])
	assert.Equal(t, "/api/workspaces/{workspaceID}/desktop/{token}/*", got["http.route"], "non-URL attributes are untouched")
	assert.Equal(t, "401", got["http.response.status_code"])
	assert.Len(t, spans[0].Attributes, 6, "redaction overwrites in place and adds no duplicate keys")
}

// TestInit_InstallsRedactingProvider proves the provider Init builds for a
// real exporter carries the redactor: a recorder registered AFTER Init sees
// the span only once the redactor (registered first) has rewritten it.
func TestInit_InstallsRedactingProvider(t *testing.T) {
	originalProvider := otel.GetTracerProvider()
	originalPropagator := otel.GetTextMapPropagator()
	t.Cleanup(func() {
		otel.SetTracerProvider(originalProvider)
		otel.SetTextMapPropagator(originalPropagator)
	})

	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(collector.Close)

	provider, err := Init(context.Background(), config.ObservabilityConfig{
		OTelExporter:    "otlp",
		OTLPEndpoint:    collector.URL,
		TraceSampleRate: 1,
	})
	require.NoError(t, err)
	require.NotNil(t, provider)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = provider.Shutdown(ctx)
	})

	recorder := tracetest.NewSpanRecorder()
	provider.RegisterSpanProcessor(recorder)

	_, span := otel.Tracer("test").Start(context.Background(), "relay",
		oteltrace.WithAttributes(attribute.String("url.path", "/api/workspaces/ws1/desktop/"+otelTestDesktopToken+"/vnc.html")))
	span.End()

	ended := recorder.Ended()
	require.Len(t, ended, 1)
	path, ok := otelTestAttr(ended[0].Attributes(), "url.path")
	require.True(t, ok)
	assert.Equal(t, "/api/workspaces/ws1/desktop/smithers_desk_REDACTED/vnc.html", path)
}
