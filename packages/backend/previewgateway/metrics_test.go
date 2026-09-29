package previewgateway

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Operators must see a relay-token misconfiguration before users report
// broken previews: every request outcome is counted, and a refused relay
// credential is logged with its domain but never its value.
func TestHandlerCountsEveryOutcomeAndLogsRelayDenials(t *testing.T) {
	registry := prometheus.NewRegistry()
	metrics := NewMetrics(registry)
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, nil))
	suffixes := []string{".preview.jjhub.tech"}
	serve := func(handler *Handler, path string, header http.Header) int {
		handler.SetMetrics(metrics)
		request := httptest.NewRequest(http.MethodGet, path, nil)
		for key, values := range header {
			request.Header[key] = values
		}
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		return recorder.Code
	}

	relay := http.Header{RelayTokenHeader: []string{"relay-secret"}}
	withToken := func(handler *Handler) *Handler { handler.SetRelayToken("relay-secret"); return handler }
	served := withToken(NewHandler(&testDialer{}, suffixes, logger))
	require.Equal(t, http.StatusOK, serve(served, "/__preview/demo.preview.jjhub.tech/", relay))
	require.Equal(t, http.StatusNotFound, serve(served, "/__preview/metadata.google.internal/", nil))
	forged := http.Header{RelayTokenHeader: []string{"forged-token-value"}}
	require.Equal(t, http.StatusUnauthorized, serve(served, "/__preview/smithers-gw-vm-1.preview.jjhub.tech/health", forged))
	require.Equal(t, http.StatusServiceUnavailable, serve(withToken(NewHandler(nil, suffixes, logger)), "/__preview/demo.preview.jjhub.tech/", relay))
	require.Equal(t, http.StatusServiceUnavailable, serve(withToken(NewHandler(failingDialer{}, suffixes, logger)), "/__preview/demo.preview.jjhub.tech/", relay))

	for outcome, want := range map[string]float64{
		outcomeServed: 1, outcomeNotFound: 1, outcomeUnauthorized: 1, outcomeUnavailable: 1, outcomeUpstreamError: 1,
	} {
		assert.Equal(t, want, testutil.ToFloat64(metrics.requests.WithLabelValues(outcome)), outcome)
	}
	assert.Equal(t, 5, testutil.CollectAndCount(metrics.latency))
	assert.Contains(t, logs.String(), "preview relay credential refused")
	assert.Contains(t, logs.String(), "smithers-gw-vm-1.preview.jjhub.tech")
	assert.NotContains(t, logs.String(), "forged-token-value")
	assert.NotContains(t, logs.String(), "relay-secret")
}

func TestHandlerWithoutMetricsStillServes(t *testing.T) {
	handler := NewHandler(&testDialer{}, []string{".preview.jjhub.tech"}, nil)
	handler.SetRelayToken("relay-secret")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, relayRequest("/__preview/demo.preview.jjhub.tech/"))
	assert.Equal(t, http.StatusOK, recorder.Code)
}
