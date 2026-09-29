package middleware

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"maps"
	"net"
	"net/http"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	apierrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// MaxRequestBodySize is the default limit (1 MB) applied to API request bodies
// to prevent denial-of-service via oversized payloads.
const MaxRequestBodySize int64 = 1 << 20

// MaxAgentEnvironmentBodySize bounds the combined repository environment PUT.
const MaxAgentEnvironmentBodySize int64 = 16 << 20

// JSONAllowContentType mirrors chi's content-type enforcement but returns APIError JSON for API routes.
func JSONAllowContentType(contentTypes ...string) func(http.Handler) http.Handler {
	allowedContentTypes := make(map[string]struct{}, len(contentTypes))
	for _, ctype := range contentTypes {
		allowedContentTypes[strings.TrimSpace(strings.ToLower(ctype))] = struct{}{}
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.ContentLength == 0 {
				next.ServeHTTP(w, r)
				return
			}

			s := strings.ToLower(strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0]))
			if _, ok := allowedContentTypes[s]; ok {
				next.ServeHTTP(w, r)
				return
			}
			if allowsOAuth2FormEncodedBody(r, s) {
				next.ServeHTTP(w, r)
				return
			}

			if isAPIRequest(r) {
				apierrors.WriteError(w, apierrors.UnsupportedMediaType("unsupported content type"))
				return
			}

			w.WriteHeader(http.StatusUnsupportedMediaType)
		})
	}
}

func allowsOAuth2FormEncodedBody(r *http.Request, contentType string) bool {
	if contentType != "application/x-www-form-urlencoded" {
		return false
	}
	switch r.URL.Path {
	case "/api/oauth2/token", "/api/oauth2/revoke", "/api/oauth2/authorize":
		return true
	default:
		return false
	}
}

// HandlerPanics counts handler panics JSONRecoverer recovered. compose
// registers it on the Smithers registry.
var HandlerPanics = prometheus.NewCounter(prometheus.CounterOpts{
	Name: "smithers_http_handler_panics_total",
	Help: "HTTP handler panics recovered by JSONRecoverer.",
})

// JSONRecoverer mirrors chi's Recoverer but returns APIError JSON for API routes.
func JSONRecoverer(next http.Handler) http.Handler {
	fn := func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rvr := recover(); rvr != nil {
				if rvr == http.ErrAbortHandler {
					panic(rvr)
				}

				// One structured Error record on the request logger, so the
				// panic pages and carries request_id, trace and user_id.
				HandlerPanics.Inc()
				LoggerFromContext(r.Context()).Error("handler panic",
					"panic", fmt.Sprint(rvr),
					"stack", string(debug.Stack()),
					"method", r.Method,
					"path", r.URL.Path,
					"request_id", RequestIDFromContext(r.Context()),
				)

				if r.Header.Get("Connection") == "Upgrade" {
					return
				}

				if isAPIRequest(r) {
					apierrors.WriteError(w, apierrors.Internal("internal server error"))
					return
				}

				w.WriteHeader(http.StatusInternalServerError)
			}
		}()

		next.ServeHTTP(w, r)
	}

	return http.HandlerFunc(fn)
}

// JSONTimeout mirrors chi's Timeout but returns APIError JSON for API routes.
func JSONTimeout(timeout time.Duration) func(next http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		fn := func(w http.ResponseWriter, r *http.Request) {
			ctx, cancel := context.WithTimeout(r.Context(), timeout)
			defer cancel()

			tw := newTimeoutWriter(w)
			resultCh := make(chan any, 1)

			go func() {
				defer func() {
					if p := recover(); p != nil {
						resultCh <- p
						return
					}
					resultCh <- nil
				}()

				next.ServeHTTP(tw, r.WithContext(ctx))
			}()

			select {
			case p := <-resultCh:
				if p != nil {
					panic(p)
				}
				tw.flushPendingHeaders()
			case <-ctx.Done():
				tw.markTimedOut()
				if tw.hasCommitted() {
					return
				}

				if isAPIRequest(r) {
					apierrors.WriteError(w, apierrors.GatewayTimeout("request timeout"))
					return
				}

				w.WriteHeader(http.StatusGatewayTimeout)
			}
		}

		return http.HandlerFunc(fn)
	}
}

type timeoutResponseWriter interface {
	http.ResponseWriter
	flushPendingHeaders()
	hasCommitted() bool
	markTimedOut() bool
}

type timeoutWriter struct {
	w   http.ResponseWriter
	hdr http.Header

	mu        sync.Mutex
	committed bool
	timedOut  bool

	flusher  http.Flusher
	hijacker http.Hijacker
}

func newTimeoutWriter(w http.ResponseWriter) timeoutResponseWriter {
	tw := &timeoutWriter{
		w:   w,
		hdr: make(http.Header),
	}

	if f, ok := w.(http.Flusher); ok {
		tw.flusher = f
	}
	if h, ok := w.(http.Hijacker); ok {
		tw.hijacker = h
	}

	switch {
	case tw.flusher != nil && tw.hijacker != nil:
		return &timeoutWriterFlusherHijacker{timeoutWriter: tw}
	case tw.flusher != nil:
		return &timeoutWriterFlusher{timeoutWriter: tw}
	case tw.hijacker != nil:
		return &timeoutWriterHijacker{timeoutWriter: tw}
	default:
		return tw
	}
}

func (tw *timeoutWriter) Header() http.Header {
	return tw.hdr
}

func (tw *timeoutWriter) WriteHeader(code int) {
	tw.mu.Lock()
	defer tw.mu.Unlock()

	if tw.timedOut || tw.committed {
		return
	}

	tw.writeHeaderLocked(code)
}

func (tw *timeoutWriter) Write(p []byte) (int, error) {
	tw.mu.Lock()
	defer tw.mu.Unlock()

	if tw.timedOut {
		return 0, http.ErrHandlerTimeout
	}

	if !tw.committed {
		tw.writeHeaderLocked(http.StatusOK)
	}

	return tw.w.Write(p)
}

func (tw *timeoutWriter) markTimedOut() bool {
	tw.mu.Lock()
	defer tw.mu.Unlock()

	if tw.timedOut {
		return false
	}

	tw.timedOut = true
	return true
}

func (tw *timeoutWriter) hasCommitted() bool {
	tw.mu.Lock()
	defer tw.mu.Unlock()

	return tw.committed
}

func (tw *timeoutWriter) flushPendingHeaders() {
	tw.mu.Lock()
	defer tw.mu.Unlock()

	if tw.timedOut || tw.committed || len(tw.hdr) == 0 {
		return
	}

	tw.writeHeaderLocked(http.StatusOK)
}

func (tw *timeoutWriter) flush() {
	tw.mu.Lock()
	if tw.timedOut {
		tw.mu.Unlock()
		return
	}
	if !tw.committed {
		tw.writeHeaderLocked(http.StatusOK)
	}
	flusher := tw.flusher
	tw.mu.Unlock()

	if flusher != nil {
		flusher.Flush()
	}
}

func (tw *timeoutWriter) hijack() (net.Conn, *bufio.ReadWriter, error) {
	tw.mu.Lock()
	defer tw.mu.Unlock()

	if tw.timedOut {
		return nil, nil, http.ErrHandlerTimeout
	}
	if tw.hijacker == nil {
		return nil, nil, http.ErrNotSupported
	}
	if !tw.committed {
		maps.Copy(tw.w.Header(), tw.hdr)
	}
	tw.committed = true

	return tw.hijacker.Hijack()
}

func (tw *timeoutWriter) writeHeaderLocked(code int) {
	maps.Copy(tw.w.Header(), tw.hdr)
	tw.w.WriteHeader(code)
	// Informational headers leave the final response open, including a timeout
	// refusal. A protocol upgrade is final even though its status is 1xx.
	tw.committed = code >= 200 || code == http.StatusSwitchingProtocols
}

type timeoutWriterFlusher struct {
	*timeoutWriter
}

func (tw *timeoutWriterFlusher) Flush() {
	tw.timeoutWriter.flush()
}

type timeoutWriterHijacker struct {
	*timeoutWriter
}

func (tw *timeoutWriterHijacker) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return tw.timeoutWriter.hijack()
}

type timeoutWriterFlusherHijacker struct {
	*timeoutWriter
}

func (tw *timeoutWriterFlusherHijacker) Flush() {
	tw.timeoutWriter.flush()
}

func (tw *timeoutWriterFlusherHijacker) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return tw.timeoutWriter.hijack()
}

// MaxBodySize wraps r.Body with http.MaxBytesReader to enforce a body size
// limit. Handlers that decode the body will receive an error when the limit is
// exceeded. Use IsMaxBytesError to detect this condition and return 413.
func MaxBodySize(n int64) func(http.Handler) http.Handler {
	return MaxBodySizeForRequest(func(*http.Request) int64 { return n })
}

// MaxBodySizeForRequest keeps the same read bound while allowing a route to
// choose its own cap before the handler decodes the body.
func MaxBodySizeForRequest(limit func(*http.Request) int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r.Body = http.MaxBytesReader(w, r.Body, limit(r))
			next.ServeHTTP(w, r)
		})
	}
}

// IsMaxBytesError reports whether err was caused by http.MaxBytesReader
// exceeding its limit.
func IsMaxBytesError(err error) bool {
	if err == nil {
		return false
	}
	// Go 1.19+ exposes *http.MaxBytesError; use errors.As for unwrapping.
	var maxBytesErr *http.MaxBytesError
	return errors.As(err, &maxBytesErr)
}

func isAPIRequest(r *http.Request) bool {
	path := r.URL.Path
	return path == "/api" || strings.HasPrefix(path, "/api/")
}
