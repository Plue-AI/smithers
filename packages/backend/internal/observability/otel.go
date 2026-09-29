// Package observability provides shared OpenTelemetry initialization for
// Smithers services (API server, repo-host). It wires an optional OTLP or injected
// exporter, a sample-rate-based sampler, and W3C TraceContext + Baggage
// propagation.
package observability

import (
	"context"
	"crypto/rand"
	"fmt"
	"log/slog"
	"net/url"
	"strings"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/trace"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// BuildTraceSampler applies the configured ratio independently to remote parents.
// Only local children inherit a sampling decision. Remote flags and trace IDs
// are untrusted and cannot force export or suppress server diagnostics.
func BuildTraceSampler(sampleRate float64) trace.Sampler {
	switch {
	case sampleRate <= 0.0:
		return trace.NeverSample()
	case sampleRate >= 1.0:
		return trace.AlwaysSample()
	default:
		ratio := trace.TraceIDRatioBased(sampleRate)
		remote := remoteRatioSampler{Sampler: ratio}
		return trace.ParentBased(ratio,
			trace.WithRemoteParentSampled(remote),
			trace.WithRemoteParentNotSampled(remote))
	}
}

// Use independent entropy for the decision, leaving the actual span's trace ID
// and parent intact. Hashing the incoming ID would still let clients pick IDs
// that always sample. crypto/rand.Read fills the buffer or terminates the process.
type remoteRatioSampler struct{ trace.Sampler }

func (s remoteRatioSampler) ShouldSample(p trace.SamplingParameters) trace.SamplingResult {
	rand.Read(p.TraceID[:])
	return s.Sampler.ShouldSample(p)
}

// BuildTextMapPropagator creates a composite text map propagator that supports
// W3C Trace Context and W3C Baggage propagation.
func BuildTextMapPropagator() propagation.TextMapPropagator {
	return propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	)
}

func traceExporterName(cfg config.ObservabilityConfig) string {
	name := strings.ToLower(strings.TrimSpace(cfg.OTelExporter))
	if name == "" {
		return "none"
	}
	return name
}

func buildTraceExporter(ctx context.Context, cfg config.ObservabilityConfig) (trace.SpanExporter, string, error) {
	switch exporterName := traceExporterName(cfg); exporterName {
	case "none":
		return nil, exporterName, nil
	case "cloudtrace":
		return nil, exporterName, fmt.Errorf("cloudtrace requires a deployment-provided trace exporter")
	case "otlp":
		endpoint := strings.TrimSpace(cfg.OTLPEndpoint)
		if endpoint == "" {
			return nil, exporterName, fmt.Errorf("SMITHERS_OTEL_EXPORTER=otlp requires SMITHERS_OTEL_EXPORTER_OTLP_ENDPOINT")
		}
		exporter, err := otlptracehttp.New(ctx, otlptracehttp.WithEndpointURL(endpoint))
		if err != nil {
			return nil, exporterName, fmt.Errorf("failed to create OTLP trace exporter: %w", err)
		}
		return exporter, exporterName, nil
	default:
		return nil, exporterName, fmt.Errorf("unsupported SMITHERS_OTEL_EXPORTER %q (valid: none, otlp; deployment exporters must be injected)", exporterName)
	}
}

// Init sets up the OpenTelemetry SDK with the configured trace exporter.
// Returns the trace provider, or nil if tracing is disabled.
// The returned provider's Shutdown must be called on application exit to flush spans.
func Init(ctx context.Context, cfg config.ObservabilityConfig) (*trace.TracerProvider, error) {
	return InitWithExporter(ctx, cfg, nil)
}

// InitWithExporter installs a deployment-owned exporter through the same sampling
// and credential-redaction pipeline. The returned provider owns its shutdown.
// A nil exporter selects the common none/OTLP configuration.
func InitWithExporter(ctx context.Context, cfg config.ObservabilityConfig, exporter trace.SpanExporter) (*trace.TracerProvider, error) {
	exporterName := "injected"
	if exporter == nil {
		var err error
		exporter, exporterName, err = buildTraceExporter(ctx, cfg)
		if err != nil {
			return nil, err
		}
	}
	if exporter == nil {
		slog.Info("OpenTelemetry: tracing disabled", "exporter", exporterName)
		return nil, nil
	}

	tp := NewTracerProvider(exporter, cfg.TraceSampleRate)

	// Set the global tracer provider and propagator
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(BuildTextMapPropagator())

	slog.Info(
		"OpenTelemetry initialized",
		"exporter", exporterName,
		"sample_rate", cfg.TraceSampleRate,
	)

	return tp, nil
}

// NewTracerProvider builds the tracer provider Init installs globally: the
// configured sampler, URL redaction, and batching export pipeline.
func NewTracerProvider(exporter trace.SpanExporter, sampleRate float64) *trace.TracerProvider {
	return trace.NewTracerProvider(
		trace.WithSpanProcessor(urlCredentialRedactor{}),
		trace.WithBatcher(urlRedactingExporter{SpanExporter: exporter}),
		trace.WithSampler(BuildTraceSampler(sampleRate)),
	)
}

// otelhttp server instrumentation supplies URL attributes at span start.
// Rewrite them before any subsequent processor can observe the credential.
type urlCredentialRedactor struct{}

func (urlCredentialRedactor) OnStart(_ context.Context, span trace.ReadWriteSpan) {
	span.SetAttributes(redactURLAttributes(span.Attributes())...)
}

func (urlCredentialRedactor) OnEnd(trace.ReadOnlySpan)         {}
func (urlCredentialRedactor) Shutdown(context.Context) error   { return nil }
func (urlCredentialRedactor) ForceFlush(context.Context) error { return nil }

// otelhttp clients attach url.full after Start. Redact the final snapshot too,
// without mutating the immutable span shared with other processors.
type urlRedactingExporter struct{ trace.SpanExporter }

func (e urlRedactingExporter) ExportSpans(ctx context.Context, spans []trace.ReadOnlySpan) error {
	clean := make([]trace.ReadOnlySpan, len(spans))
	for i, span := range spans {
		clean[i] = urlRedactedSpan{ReadOnlySpan: span, attrs: redactURLAttributes(span.Attributes())}
	}
	return e.SpanExporter.ExportSpans(ctx, clean)
}

type urlRedactedSpan struct {
	trace.ReadOnlySpan
	attrs []attribute.KeyValue
}

func (s urlRedactedSpan) Attributes() []attribute.KeyValue { return s.attrs }

func redactURLAttributes(attrs []attribute.KeyValue) []attribute.KeyValue {
	var clean []attribute.KeyValue
	for i, attr := range attrs {
		if attr.Value.Type() != attribute.STRING {
			continue
		}
		value := attr.Value.AsString()
		var redacted string
		switch attr.Key {
		case "url.path":
			redacted = middleware.RedactSecretPath(value)
		case "url.query":
			redacted = redactSecretQuery(value)
		case "url.full", "http.target":
			parsed, err := url.Parse(value)
			if err != nil {
				path, query, hasQuery := strings.Cut(value, "?")
				redacted = middleware.RedactSecretPath(path)
				if hasQuery {
					redacted += "?" + redactSecretQuery(query)
				}
			} else {
				path := middleware.RedactSecretPath(parsed.Path)
				if path != parsed.Path {
					parsed.Path, parsed.RawPath = path, ""
				}
				parsed.RawQuery = redactSecretQuery(parsed.RawQuery)
				if parsed.User != nil {
					parsed.User = url.User("REDACTED")
				}
				redacted = parsed.String()
			}
		default:
			continue
		}
		if redacted != value {
			if clean == nil {
				clean = append([]attribute.KeyValue(nil), attrs...)
			}
			clean[i] = attribute.String(string(attr.Key), redacted)
		}
	}
	if clean == nil {
		return attrs
	}
	return clean
}

// secretQueryKeys are query parameter names whose values are credentials or
// one-time grants. Outbound client spans record url.full including the query,
// and proxies forward user queries unchanged, so these never reach a trace.
var secretQueryKeys = map[string]struct{}{
	"password": {}, "path": {}, "token": {}, "access_token": {}, "refresh_token": {},
	"id_token": {}, "code": {}, "state": {}, "key": {}, "api_key": {}, "apikey": {},
	"sig": {}, "signature": {}, "x-goog-signature": {}, "x-goog-credential": {},
	"x-amz-signature": {}, "x-amz-credential": {}, "x-amz-security-token": {},
	"client_secret": {}, "secret": {}, "auth": {}, "authorization": {}, "ticket": {},
	"jwt": {}, "session": {},
}

func isSecretQueryKey(key string) bool {
	key = strings.ToLower(key)
	if _, ok := secretQueryKeys[key]; ok {
		return true
	}
	return strings.HasSuffix(key, "token") || strings.HasSuffix(key, "secret") ||
		strings.HasSuffix(key, "signature") || strings.HasSuffix(key, "password")
}

// Preserve query order and escaping while stripping credential values,
// including percent-encoded parameter names.
func redactSecretQuery(query string) string {
	pairs := strings.Split(query, "&")
	for i, pair := range pairs {
		key, _, hasValue := strings.Cut(pair, "=")
		decoded, err := url.QueryUnescape(key)
		if err == nil && hasValue && isSecretQueryKey(decoded) {
			pairs[i] = key + "=REDACTED"
		}
	}
	return strings.Join(pairs, "&")
}
