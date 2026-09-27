package middleware

import (
	"bufio"
	"fmt"
	"net"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	chiMiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/prometheus/client_golang/prometheus"
)

// HTTPMetricsRecorder is the interface that the HTTP metrics middleware requires.
// routes.SmithersMetrics satisfies this interface.
type HTTPMetricsRecorder interface {
	// RequestsTotal returns the CounterVec for smithers_http_requests_total.
	RequestsTotal() *prometheus.CounterVec
	// RequestDurationSeconds returns the HistogramVec for smithers_http_request_duration_seconds.
	RequestDurationSeconds() *prometheus.HistogramVec
}

const (
	unmatchedRoutePathLabel = "__unmatched__"
	unknownHTTPMethodLabel  = "other"
)

// statusRecorder wraps http.ResponseWriter to capture the HTTP status code
// written by the handler. This is needed because http.ResponseWriter does not
// expose the written status code after the fact.
//
// wroteHeader records whether the handler committed a status (explicitly via
// WriteHeader or implicitly via the first Write). HTTPMetrics uses it to tell
// a panic that unwound before any response was committed (the outer
// JSONRecoverer then answers 500) from a panic after the status was already
// on the wire (the client saw that status, so that is what gets recorded).
type statusRecorder struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

type hijackStatusRecorder struct {
	*statusRecorder
	hijacker http.Hijacker
}

func newStatusRecorder(w http.ResponseWriter) (http.ResponseWriter, *statusRecorder) {
	rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}

	if h, ok := w.(http.Hijacker); ok {
		return &hijackStatusRecorder{statusRecorder: rec, hijacker: h}, rec
	}

	return rec, rec
}

// Unwrap lets http.ResponseController reach the connection underneath, so a
// handler can move its own deadlines (the git receive-pack route does).
func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

func (r *statusRecorder) WriteHeader(code int) {
	r.ResponseWriter.WriteHeader(code)
	// Informational responses do not commit the final status. Ignore later
	// headers once a final status has been sent, just as net/http does.
	if !r.wroteHeader && (code >= 200 || code == http.StatusSwitchingProtocols) {
		r.status = code
		r.wroteHeader = true
	}
}

// Write marks the implicit 200 that net/http commits when a handler writes a
// body without calling WriteHeader first.
func (r *statusRecorder) Write(b []byte) (int, error) {
	if !r.wroteHeader {
		r.status = http.StatusOK
		r.wroteHeader = true
	}
	return r.ResponseWriter.Write(b)
}

// Flush implements http.Flusher by delegating to the underlying ResponseWriter
// if it supports flushing. This is required for SSE (Server-Sent Events) streams
// to function correctly when the HTTPMetrics middleware is active.
func (r *statusRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		if !r.wroteHeader {
			r.WriteHeader(http.StatusOK)
		}
		f.Flush()
	}
}

func (r *hijackStatusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return r.hijacker.Hijack()
}

// HTTPMetrics returns a middleware that records every HTTP request into the
// provided HTTPMetricsRecorder. It increments smithers_http_requests_total and
// observes smithers_http_request_duration_seconds for each request.
//
// The route template path (e.g. /api/v1/repos/{owner}/{name}) is used as the
// path label rather than the raw URL to prevent label cardinality explosion
// from per-repo or per-user paths.
//
// This middleware must be added to the Chi router AFTER the routing middleware
// so that chi.RouteContext is available and the route template can be resolved.
//
// Recording happens in a defer so a handler panic is counted too: the
// production router mounts JSONRecoverer OUTSIDE this middleware, and before
// this change a panic unwound past the increment and the 500 the recoverer
// wrote never reached smithers_http_requests_total. The panic itself is not
// recovered here (no recover()) so the recoverer still owns the response.
func HTTPMetrics(m HTTPMetricsRecorder) func(http.Handler) http.Handler {
	if m == nil {
		// No-op if metrics are not configured.
		return func(next http.Handler) http.Handler { return next }
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()

			wrapped, rec := newStatusRecorder(w)
			completed := false
			defer func() {
				duration := time.Since(start)

				// Use route template path to prevent label cardinality explosion.
				// chi.RouteContext contains the matched route pattern after routing.
				path := unmatchedRoutePathLabel
				if rctx := chi.RouteContext(r.Context()); rctx != nil {
					if rctx.RoutePattern() != "" {
						path = rctx.RoutePattern()
					}
				}

				status := rec.status
				if !completed && !rec.wroteHeader {
					// The handler panicked before committing a response; the
					// outer recoverer answers with 500 (see JSONRecoverer).
					status = http.StatusInternalServerError
				}

				method := normalizedHTTPMethod(r.Method)
				statusStr := fmt.Sprintf("%d", status)

				m.RequestsTotal().WithLabelValues(method, path, statusStr).Inc()
				m.RequestDurationSeconds().WithLabelValues(method, path).Observe(duration.Seconds())
			}()

			next.ServeHTTP(wrapped, r)
			completed = true
		})
	}
}

func normalizedHTTPMethod(method string) string {
	switch method {
	case http.MethodConnect,
		http.MethodDelete,
		http.MethodGet,
		http.MethodHead,
		http.MethodOptions,
		http.MethodPatch,
		http.MethodPost,
		http.MethodPut,
		http.MethodTrace:
		return method
	default:
		return unknownHTTPMethodLabel
	}
}

// RequestIDEcho echoes the X-Request-ID header back in the response.
// This allows upstream edge proxies and load balancers to correlate their
// access logs with the API server logs using the same request ID.
//
// chi's RequestID middleware generates or preserves the request ID but does
// not automatically echo it in the response. This middleware fills that gap.
func RequestIDEcho(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reqID := chiMiddleware.GetReqID(r.Context())
		if reqID != "" {
			w.Header().Set("X-Request-Id", reqID)
		}
		next.ServeHTTP(w, r)
	})
}
