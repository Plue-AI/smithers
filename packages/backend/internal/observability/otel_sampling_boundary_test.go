package observability

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	oteltrace "go.opentelemetry.io/otel/trace"
)

func TestRemoteHTTPSamplingIsServerControlled(t *testing.T) {
	for _, rate := range []float64{0, 0.25, 1} {
		for _, id := range []string{"01020304050607080000000000000001", "0102030405060708ffffffffffffffff"} {
			for _, flags := range []string{"00", "01"} {
				t.Run(fmt.Sprintf("rate=%g/id=%s/flags=%s", rate, id, flags), func(t *testing.T) {
					exporter := tracetest.NewInMemoryExporter()
					provider := NewTracerProvider(exporter, rate)
					defer provider.Shutdown(context.Background())
					sampled := 0
					handler := otelhttp.NewHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						server := oteltrace.SpanContextFromContext(r.Context())
						require.Equal(t, id, server.TraceID().String(), "preserve correlation")
						if server.IsSampled() {
							sampled++
						}
						_, child := provider.Tracer("test").Start(r.Context(), "child")
						require.Equal(t, server.IsSampled(), child.SpanContext().IsSampled())
						child.End()
						w.WriteHeader(http.StatusNoContent)
					}), "test", otelhttp.WithTracerProvider(provider), otelhttp.WithPropagators(BuildTextMapPropagator()))
					for i := 0; i < 512; i++ {
						req := httptest.NewRequest(http.MethodGet, "/", nil)
						req.Header.Set("traceparent", "00-"+id+"-0102030405060708-"+flags)
						rec := httptest.NewRecorder()
						handler.ServeHTTP(rec, req)
						require.Equal(t, http.StatusNoContent, rec.Code)
						// Flush each request so the batcher's bounded queue cannot drop test spans.
						require.NoError(t, provider.ForceFlush(context.Background()))
					}
					switch rate {
					case 0:
						require.Zero(t, sampled)
					case 1:
						require.Equal(t, 512, sampled)
					default:
						// Wide bounds make random failure negligible while rejecting both bypasses.
						require.Greater(t, sampled, 40)
						require.Less(t, sampled, 220)
					}
					spans := exporter.GetSpans()
					require.Len(t, spans, sampled*2)
					for _, span := range spans {
						if span.Name == "test" {
							require.Equal(t, "0102030405060708", span.Parent.SpanID().String())
						}
					}
				})
			}
		}
	}
}
