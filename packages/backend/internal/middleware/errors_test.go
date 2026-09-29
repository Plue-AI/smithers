package middleware

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	chiMiddleware "github.com/go-chi/chi/v5/middleware"
	promtestutil "github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type hijackableResponseRecorder struct {
	*httptest.ResponseRecorder
}

func (h *hijackableResponseRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	server, client := net.Pipe()
	_ = client.Close()
	return server, bufio.NewReadWriter(bufio.NewReader(server), bufio.NewWriter(server)), nil
}

// hijackOnlyWriter implements http.Hijacker but NOT http.Flusher.
// This triggers the timeoutWriterHijacker branch in newTimeoutWriter.
type hijackOnlyWriter struct {
	header     http.Header
	statusCode int
	body       []byte
}

func (w *hijackOnlyWriter) Header() http.Header {
	if w.header == nil {
		w.header = make(http.Header)
	}
	return w.header
}

func (w *hijackOnlyWriter) Write(b []byte) (int, error) {
	w.body = append(w.body, b...)
	return len(b), nil
}

func (w *hijackOnlyWriter) WriteHeader(code int) {
	w.statusCode = code
}

func (w *hijackOnlyWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	server, client := net.Pipe()
	_ = client.Close()
	return server, bufio.NewReadWriter(bufio.NewReader(server), bufio.NewWriter(server)), nil
}

func TestJSONAllowContentType(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name                  string
		path                  string
		body                  string
		contentType           string
		wantStatus            int
		wantMessage           string
		wantJSONContentType   bool
		wantNextHandlerCalled bool
	}{
		{
			name:                  "rejects unsupported content type for api body",
			path:                  "/api/user/repos",
			body:                  `{"name":"x"}`,
			contentType:           "text/plain",
			wantStatus:            http.StatusUnsupportedMediaType,
			wantMessage:           "unsupported content type",
			wantJSONContentType:   true,
			wantNextHandlerCalled: false,
		},
		{
			name:                  "allows empty body even without json content type",
			path:                  "/api/user/repos",
			body:                  "",
			contentType:           "text/plain",
			wantStatus:            http.StatusNoContent,
			wantNextHandlerCalled: true,
		},
		{
			name:                  "allows application json",
			path:                  "/api/user/repos",
			body:                  `{"name":"x"}`,
			contentType:           "application/json; charset=utf-8",
			wantStatus:            http.StatusNoContent,
			wantNextHandlerCalled: true,
		},
		{
			name:                  "allows git lfs vendor json with charset",
			path:                  "/api/repos/alice/demo/lfs/batch",
			body:                  `{"operation":"upload"}`,
			contentType:           "application/vnd.git-lfs+json; charset=utf-8",
			wantStatus:            http.StatusNoContent,
			wantNextHandlerCalled: true,
		},
		{
			name:                  "allows oauth2 token form body",
			path:                  "/api/oauth2/token",
			body:                  "grant_type=refresh_token",
			contentType:           "application/x-www-form-urlencoded",
			wantStatus:            http.StatusNoContent,
			wantNextHandlerCalled: true,
		},
		{
			name:                  "allows oauth2 revoke form body",
			path:                  "/api/oauth2/revoke",
			body:                  "token=demo",
			contentType:           "application/x-www-form-urlencoded",
			wantStatus:            http.StatusNoContent,
			wantNextHandlerCalled: true,
		},
		{
			name:                  "still rejects form body on non-oauth2 api route",
			path:                  "/api/user/repos",
			body:                  "name=x",
			contentType:           "application/x-www-form-urlencoded",
			wantStatus:            http.StatusUnsupportedMediaType,
			wantMessage:           "unsupported content type",
			wantJSONContentType:   true,
			wantNextHandlerCalled: false,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			nextCalled := false
			handler := JSONAllowContentType("application/json", "application/vnd.git-lfs+json")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				nextCalled = true
				w.WriteHeader(http.StatusNoContent)
			}))

			req := httptest.NewRequest(http.MethodPost, tc.path, strings.NewReader(tc.body))
			if tc.contentType != "" {
				req.Header.Set("Content-Type", tc.contentType)
			}
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			assert.Equal(t, tc.wantStatus, rec.Code)
			assert.Equal(t, tc.wantNextHandlerCalled, nextCalled)

			if tc.wantJSONContentType {
				assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))
				assert.Equal(t, tc.wantMessage, decodeMessage(t, rec))
			}
		})
	}
}

func TestJSONRecoverer_APIPanicReturnsAPIErrorJSON(t *testing.T) {
	t.Parallel()

	handler := JSONRecoverer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("boom")
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/_test/panic", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))
	assert.Equal(t, "internal server error", decodeMessage(t, rec))
}

func TestJSONRecoverer_RepanicsErrAbortHandler(t *testing.T) {
	t.Parallel()

	handler := JSONRecoverer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic(http.ErrAbortHandler)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/_test/panic", nil)
	rec := httptest.NewRecorder()

	defer func() {
		recovered := recover()
		require.Equal(t, http.ErrAbortHandler, recovered)
	}()

	handler.ServeHTTP(rec, req)
}

func TestJSONRecoverer_NonAPIPathUsesPlain500(t *testing.T) {
	t.Parallel()

	handler := JSONRecoverer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("boom")
	}))

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.NotEqual(t, "application/json", rec.Header().Get("Content-Type"))
	assert.Empty(t, strings.TrimSpace(rec.Body.String()))
}

func TestJSONTimeout_DeadlineExceededReturnsAPIErrorJSON(t *testing.T) {
	t.Parallel()

	handler := JSONTimeout(10 * time.Millisecond)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/_test/timeout", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusGatewayTimeout, rec.Code)
	assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))
	assert.Equal(t, "request timeout", decodeMessage(t, rec))
}

func TestJSONTimeout_NoTimeoutCallsNext(t *testing.T) {
	t.Parallel()

	nextCalled := false
	handler := JSONTimeout(1 * time.Second)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nextCalled = true
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/user/repos", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.True(t, nextCalled)
	assert.Equal(t, http.StatusNoContent, rec.Code)
}

func TestJSONTimeout_PreservesFlusherWhenUnderlyingSupportsIt(t *testing.T) {
	t.Parallel()

	supportsFlusher := false
	handler := JSONTimeout(1 * time.Second)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, supportsFlusher = w.(http.Flusher)
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/user/repos", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.True(t, supportsFlusher, "timeout middleware must preserve http.Flusher when underlying writer supports it")
	assert.Equal(t, http.StatusNoContent, rec.Code)
}

func TestJSONTimeout_PreservesHijackerWhenUnderlyingSupportsIt(t *testing.T) {
	t.Parallel()

	supportsHijacker := false
	handler := JSONTimeout(1 * time.Second)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, supportsHijacker = w.(http.Hijacker)
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/user/repos", nil)
	rec := &hijackableResponseRecorder{ResponseRecorder: httptest.NewRecorder()}
	handler.ServeHTTP(rec, req)

	assert.True(t, supportsHijacker, "timeout middleware must preserve http.Hijacker when underlying writer supports it")
	assert.Equal(t, http.StatusNoContent, rec.Code)
}

func TestJSONTimeout_PreservesHeadersWhenHandlerWritesNothing(t *testing.T) {
	t.Parallel()

	handler := JSONTimeout(1 * time.Second)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Smithers-Test", "header-only")
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/user/repos", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "header-only", rec.Header().Get("X-Smithers-Test"))
}

func TestJSONTimeout_NonAPIPathUsesPlain504(t *testing.T) {
	t.Parallel()

	handler := JSONTimeout(10 * time.Millisecond)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusGatewayTimeout, rec.Code)
	assert.NotEqual(t, "application/json", rec.Header().Get("Content-Type"))
	assert.Empty(t, strings.TrimSpace(rec.Body.String()))
}

func TestJSONTimeout_DeadlineExceededReturnsAPIErrorJSON_WhenHandlerIgnoresContext(t *testing.T) {
	t.Parallel()

	releaseHandler := make(chan struct{})
	handler := JSONTimeout(20 * time.Millisecond)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-releaseHandler
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/_test/timeout-ignore-context", nil)
	rec := httptest.NewRecorder()

	serveDone := make(chan struct{})
	go func() {
		handler.ServeHTTP(rec, req)
		close(serveDone)
	}()
	select {
	case <-serveDone:
	case <-time.After(2 * time.Second):
		close(releaseHandler)
		<-serveDone
		t.Fatal("timeout middleware waited for a handler that ignored its context")
	}
	close(releaseHandler)

	assert.Equal(t, http.StatusGatewayTimeout, rec.Code)
	assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))
	assert.Equal(t, "request timeout", decodeMessage(t, rec))
}

func TestJSONTimeout_NonAPIPathUsesPlain504_WhenHandlerIgnoresContext(t *testing.T) {
	t.Parallel()

	releaseHandler := make(chan struct{})
	handler := JSONTimeout(20 * time.Millisecond)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-releaseHandler
	}))

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()

	serveDone := make(chan struct{})
	go func() {
		handler.ServeHTTP(rec, req)
		close(serveDone)
	}()
	select {
	case <-serveDone:
	case <-time.After(2 * time.Second):
		close(releaseHandler)
		<-serveDone
		t.Fatal("timeout middleware waited for a handler that ignored its context")
	}
	close(releaseHandler)

	assert.Equal(t, http.StatusGatewayTimeout, rec.Code)
	assert.NotEqual(t, "application/json", rec.Header().Get("Content-Type"))
	assert.Empty(t, strings.TrimSpace(rec.Body.String()))
}

func TestJSONTimeout_DoesNotWrite504AfterResponseCommitted(t *testing.T) {
	t.Parallel()

	handler := JSONTimeout(20 * time.Millisecond)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
		// Keep running past timeout to prove middleware does not append timeout JSON/body.
		time.Sleep(60 * time.Millisecond)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/_test/timeout-committed", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusNoContent, rec.Code)
	assert.Empty(t, strings.TrimSpace(rec.Body.String()))
}

func TestJSONTimeout_LateWritesReturnErrHandlerTimeout(t *testing.T) {
	t.Parallel()

	writeErr := make(chan error, 1)
	handler := JSONTimeout(20 * time.Millisecond)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(80 * time.Millisecond)
		_, err := w.Write([]byte("late"))
		writeErr <- err
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/_test/timeout-late-write", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusGatewayTimeout, rec.Code)
	assert.Equal(t, "request timeout", decodeMessage(t, rec))

	select {
	case err := <-writeErr:
		assert.ErrorIs(t, err, http.ErrHandlerTimeout)
	case <-time.After(500 * time.Millisecond):
		t.Fatal("timed out waiting for late write result")
	}
}

func TestJSONTimeout_PanicInWorkerIsRecoveredAndDelegated(t *testing.T) {
	t.Parallel()

	handler := JSONRecoverer(JSONTimeout(200 * time.Millisecond)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("timeout worker panic")
	})))

	req := httptest.NewRequest(http.MethodGet, "/api/_test/timeout-panic", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))
	assert.Equal(t, "internal server error", decodeMessage(t, rec))
}

func TestJSONAllowContentType_NonAPIPathReturnsPlain415(t *testing.T) {
	t.Parallel()

	handler := JSONAllowContentType("application/json")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("next handler should not be called")
	}))

	req := httptest.NewRequest(http.MethodPost, "/health", strings.NewReader("body"))
	req.Header.Set("Content-Type", "text/plain")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusUnsupportedMediaType, rec.Code)
	// Non-API path should NOT return JSON error body
	assert.NotEqual(t, "application/json", rec.Header().Get("Content-Type"))
	assert.Empty(t, strings.TrimSpace(rec.Body.String()))
}

func TestJSONRecoverer_NoPanicCallsNext(t *testing.T) {
	t.Parallel()

	nextCalled := false
	handler := JSONRecoverer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nextCalled = true
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/user", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.True(t, nextCalled)
	assert.Equal(t, http.StatusOK, rec.Code)
}

func TestIsAPIRequest(t *testing.T) {
	t.Parallel()

	tests := []struct {
		path string
		want bool
	}{
		{"/api", true},
		{"/api/", true},
		{"/api/v1/repos", true},
		{"/api/user/repos", true},
		{"/health", false},
		{"/", false},
		{"/apiary", false},
		{"/apikeys", false},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.path, func(t *testing.T) {
			t.Parallel()

			r := httptest.NewRequest(http.MethodGet, tc.path, nil)
			assert.Equal(t, tc.want, isAPIRequest(r))
		})
	}
}

func TestJSONRecoverer_WithLogEntryCallsPanic(t *testing.T) {
	t.Parallel()

	// Chain chi's Logger middleware before JSONRecoverer to set a log entry in context
	loggerMW := chiMiddleware.Logger
	handler := loggerMW(JSONRecoverer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("logged boom")
	})))

	req := httptest.NewRequest(http.MethodGet, "/api/_test/panic", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	// Should still return 500 JSON error for API paths, but use logEntry.Panic path
	assert.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))
	assert.Equal(t, "internal server error", decodeMessage(t, rec))
}

func TestJSONRecoverer_WebSocketUpgradePanicSilentlyReturns(t *testing.T) {
	t.Parallel()

	handler := JSONRecoverer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("websocket boom")
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/_test/ws", nil)
	req.Header.Set("Connection", "Upgrade")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	// WebSocket upgrade panics should NOT write any response body or status
	// The handler returns early without writing — status defaults to 200 (no WriteHeader called)
	assert.Empty(t, strings.TrimSpace(rec.Body.String()), "should not write body for WebSocket upgrade panic")
	assert.NotEqual(t, "application/json", rec.Header().Get("Content-Type"), "should not set JSON content type for WebSocket upgrade")
}

func TestJSONTimeout_FlusherIsFunctional(t *testing.T) {
	t.Parallel()

	flushed := false
	handler := JSONTimeout(1 * time.Second)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("data: hello\n\n"))
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
			flushed = true
		}
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/events", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.True(t, flushed, "handler should be able to flush through timeout writer")
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), "data: hello")
}

func TestJSONTimeout_HijackIsFunctional(t *testing.T) {
	t.Parallel()

	hijacked := false
	handler := JSONTimeout(1 * time.Second)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if h, ok := w.(http.Hijacker); ok {
			conn, _, err := h.Hijack()
			if err == nil && conn != nil {
				hijacked = true
				conn.Close()
			}
		}
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/ws", nil)
	rec := &hijackableResponseRecorder{ResponseRecorder: httptest.NewRecorder()}
	handler.ServeHTTP(rec, req)

	assert.True(t, hijacked, "handler should be able to hijack through timeout writer")
}

func TestJSONTimeout_FlusherAndHijackerPreservedTogether(t *testing.T) {
	t.Parallel()

	supportsFlusher := false
	supportsHijacker := false
	handler := JSONTimeout(1 * time.Second)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, supportsFlusher = w.(http.Flusher)
		_, supportsHijacker = w.(http.Hijacker)
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
	// Use a writer that implements both Flusher and Hijacker
	rec := &hijackableResponseRecorder{ResponseRecorder: httptest.NewRecorder()}
	handler.ServeHTTP(rec, req)

	assert.True(t, supportsFlusher, "timeout writer must preserve Flusher when underlying supports both")
	assert.True(t, supportsHijacker, "timeout writer must preserve Hijacker when underlying supports both")
}

func TestJSONTimeout_FlushAfterTimeoutIsNoop(t *testing.T) {
	t.Parallel()

	flushErr := make(chan bool, 1)
	handler := JSONTimeout(20 * time.Millisecond)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(80 * time.Millisecond) // Wait for timeout
		if f, ok := w.(http.Flusher); ok {
			f.Flush() // Should be a no-op after timeout
			flushErr <- true
		} else {
			flushErr <- false
		}
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/events", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusGatewayTimeout, rec.Code)

	select {
	case ok := <-flushErr:
		assert.True(t, ok, "handler should have found Flusher interface")
	case <-time.After(500 * time.Millisecond):
		t.Fatal("timed out waiting for handler goroutine")
	}
}

func TestJSONTimeout_HijackAfterTimeoutReturnsError(t *testing.T) {
	t.Parallel()

	hijackErr := make(chan error, 1)
	releaseAfterTimeout := make(chan struct{})
	handler := JSONTimeout(20 * time.Millisecond)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
		// The outer middleware marks the writer timed out and returns before the
		// test releases this handler, so timer scheduling cannot invert the race.
		<-releaseAfterTimeout
		if h, ok := w.(http.Hijacker); ok {
			_, _, err := h.Hijack()
			hijackErr <- err
		} else {
			hijackErr <- nil
		}
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/ws", nil)
	rec := &hijackableResponseRecorder{ResponseRecorder: httptest.NewRecorder()}
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusGatewayTimeout, rec.Code)
	close(releaseAfterTimeout)

	select {
	case err := <-hijackErr:
		assert.ErrorIs(t, err, http.ErrHandlerTimeout, "hijack after timeout should return ErrHandlerTimeout")
	case <-time.After(500 * time.Millisecond):
		t.Fatal("timed out waiting for handler goroutine")
	}
}

func TestJSONTimeout_HijackWithoutUnderlyingHijackerReturnsError(t *testing.T) {
	t.Parallel()

	// Use standard recorder which doesn't implement Hijacker
	// But the timeout writer wraps it — so Hijacker interface should not be available
	supportsHijacker := false
	handler := JSONTimeout(1 * time.Second)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, supportsHijacker = w.(http.Hijacker)
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
	rec := httptest.NewRecorder() // Does NOT implement Hijacker
	handler.ServeHTTP(rec, req)

	assert.False(t, supportsHijacker, "timeout writer should not expose Hijacker when underlying doesn't support it")
}

func TestJSONTimeout_HijackOnlyWriterPreservesHijacker(t *testing.T) {
	t.Parallel()

	hijacked := false
	handler := JSONTimeout(1 * time.Second)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, hasFlusher := w.(http.Flusher)
		assert.False(t, hasFlusher, "hijack-only underlying writer should not expose Flusher")

		if h, ok := w.(http.Hijacker); ok {
			conn, _, err := h.Hijack()
			if err == nil && conn != nil {
				hijacked = true
				conn.Close()
			}
		}
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/ws", nil)
	w := &hijackOnlyWriter{}
	handler.ServeHTTP(w, req)

	assert.True(t, hijacked, "handler should be able to hijack through timeout writer with hijack-only writer")
}

func TestJSONTimeout_FlusherHijackerBothCallable(t *testing.T) {
	t.Parallel()

	flushed := false
	hijacked := false
	handler := JSONTimeout(1 * time.Second)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Flush first
		if f, ok := w.(http.Flusher); ok {
			w.WriteHeader(http.StatusOK)
			f.Flush()
			flushed = true
		}
		// Then hijack
		if h, ok := w.(http.Hijacker); ok {
			conn, _, err := h.Hijack()
			if err == nil && conn != nil {
				hijacked = true
				conn.Close()
			}
		}
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/ws", nil)
	rec := &hijackableResponseRecorder{ResponseRecorder: httptest.NewRecorder()}
	handler.ServeHTTP(rec, req)

	assert.True(t, flushed, "should be able to flush through FlusherHijacker wrapper")
	assert.True(t, hijacked, "should be able to hijack through FlusherHijacker wrapper")
}

func TestJSONTimeout_WriteHeaderNoopAfterTimeout(t *testing.T) {
	t.Parallel()

	writeHeaderDone := make(chan struct{}, 1)
	handler := JSONTimeout(20 * time.Millisecond)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(80 * time.Millisecond) // Wait for timeout
		w.WriteHeader(http.StatusCreated) // Should be ignored after timeout
		writeHeaderDone <- struct{}{}
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusGatewayTimeout, rec.Code, "should get timeout status, not the late WriteHeader")

	select {
	case <-writeHeaderDone:
		// OK — late WriteHeader was a no-op
	case <-time.After(500 * time.Millisecond):
		t.Fatal("timed out waiting for handler goroutine")
	}
}

func TestJSONTimeout_DoubleWriteHeaderIsIgnored(t *testing.T) {
	t.Parallel()

	handler := JSONTimeout(1 * time.Second)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.WriteHeader(http.StatusCreated) // Second call should be ignored (committed)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code, "first WriteHeader should win")
}

func TestJSONTimeout_WriteImplicitlyCommitsHeaders(t *testing.T) {
	t.Parallel()

	handler := JSONTimeout(1 * time.Second)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Smithers-Test", "implicit-commit")
		// Write without explicit WriteHeader → should commit as 200
		w.Write([]byte("hello"))
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "implicit-commit", rec.Header().Get("X-Smithers-Test"))
	assert.Equal(t, "hello", rec.Body.String())
}

func TestJSONTimeout_FlushBeforeWriteHeaderCommitsAs200(t *testing.T) {
	t.Parallel()

	handler := JSONTimeout(1 * time.Second)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Smithers-Test", "early-flush")
		if f, ok := w.(http.Flusher); ok {
			f.Flush() // Flush without WriteHeader → should commit with 200
		}
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "early-flush", rec.Header().Get("X-Smithers-Test"))
}

// plainWriter implements only http.ResponseWriter (no Flusher, no Hijacker).
// This triggers the default branch in newTimeoutWriter.
type plainWriter struct {
	header     http.Header
	statusCode int
	body       []byte
}

func (w *plainWriter) Header() http.Header {
	if w.header == nil {
		w.header = make(http.Header)
	}
	return w.header
}

func (w *plainWriter) Write(b []byte) (int, error) {
	w.body = append(w.body, b...)
	return len(b), nil
}

func (w *plainWriter) WriteHeader(code int) {
	w.statusCode = code
}

func TestJSONTimeout_PlainWriterNoFlusherNoHijacker(t *testing.T) {
	t.Parallel()

	hasFlusher := false
	hasHijacker := false
	handler := JSONTimeout(1 * time.Second)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, hasFlusher = w.(http.Flusher)
		_, hasHijacker = w.(http.Hijacker)
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
	w := &plainWriter{}
	handler.ServeHTTP(w, req)

	assert.False(t, hasFlusher, "plain writer should not expose Flusher")
	assert.False(t, hasHijacker, "plain writer should not expose Hijacker")
	assert.Equal(t, http.StatusNoContent, w.statusCode)
}

func TestMaxBodySize_AllowsRequestUnderLimit(t *testing.T) {
	t.Parallel()

	nextCalled := false
	handler := MaxBodySize(1024)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nextCalled = true
		// Read the body to verify it's still accessible
		var buf [64]byte
		n, _ := r.Body.Read(buf[:])
		w.WriteHeader(http.StatusOK)
		w.Write(buf[:n])
	}))

	body := `{"name":"demo"}`
	req := httptest.NewRequest(http.MethodPost, "/api/user/repos", strings.NewReader(body))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.True(t, nextCalled, "next handler must be called for small bodies")
	assert.Equal(t, http.StatusOK, rec.Code)
}

func TestMaxBodySize_RejectsRequestOverLimit(t *testing.T) {
	t.Parallel()

	nextCalled := false
	handler := MaxBodySize(16)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nextCalled = true
		// Try to read the full body — this should trigger the max bytes error
		buf := make([]byte, 1024)
		_, err := r.Body.Read(buf)
		if IsMaxBytesError(err) {
			w.WriteHeader(http.StatusRequestEntityTooLarge)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))

	// Send a body larger than the 16-byte limit
	bigBody := strings.Repeat("x", 100)
	req := httptest.NewRequest(http.MethodPost, "/api/user/repos", strings.NewReader(bigBody))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.True(t, nextCalled, "next handler is still called — it's the handler that reads and gets the error")
	assert.Equal(t, http.StatusRequestEntityTooLarge, rec.Code)
}

func TestMaxBodySize_NoBodyPassesThrough(t *testing.T) {
	t.Parallel()

	nextCalled := false
	handler := MaxBodySize(1024)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nextCalled = true
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/user/repos", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	assert.True(t, nextCalled)
	assert.Equal(t, http.StatusNoContent, rec.Code)
}

func TestMaxBodySizeForRequest_SelectsBound(t *testing.T) {
	body := strings.Repeat("x", int(MaxRequestBodySize)+1)
	for _, tc := range []struct {
		path string
		want int
	}{
		{"/larger", http.StatusOK},
		{"/default", http.StatusRequestEntityTooLarge},
	} {
		t.Run(tc.path, func(t *testing.T) {
			handler := MaxBodySizeForRequest(func(r *http.Request) int64 {
				if r.URL.Path == "/larger" {
					return MaxAgentEnvironmentBodySize
				}
				return MaxRequestBodySize
			})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, err := io.ReadAll(r.Body)
				if IsMaxBytesError(err) {
					w.WriteHeader(http.StatusRequestEntityTooLarge)
					return
				}
				w.WriteHeader(http.StatusOK)
			}))
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodPut, tc.path, strings.NewReader(body)))
			assert.Equal(t, tc.want, response.Code)
		})
	}
}

func TestIsMaxBytesError_TrueForMaxBytesError(t *testing.T) {
	t.Parallel()

	// Create a MaxBytesReader with a tiny limit and read past it
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(strings.Repeat("x", 100)))
	rec := httptest.NewRecorder()
	r.Body = http.MaxBytesReader(rec, r.Body, 10)

	buf := make([]byte, 200)
	_, err := r.Body.Read(buf)

	assert.True(t, IsMaxBytesError(err), "should detect MaxBytesError from MaxBytesReader")
}

func TestIsMaxBytesError_FalseForOtherErrors(t *testing.T) {
	t.Parallel()

	assert.False(t, IsMaxBytesError(nil))
	assert.False(t, IsMaxBytesError(http.ErrHandlerTimeout))
	assert.False(t, IsMaxBytesError(assert.AnError))
}

func decodeMessage(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()

	var payload struct {
		Message string `json:"message"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	return payload.Message
}

// A panic must reach the request's structured logger as one Error record with
// the stack, so it pages and correlates with the request, and must be counted.
func TestJSONRecoverer_LogsPanicToRequestLogger(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&buf, nil))
	handler := JSONRecoverer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("structured boom")
	}))
	req := httptest.NewRequest(http.MethodPost, "/api/_test/panic", nil)
	req = req.WithContext(context.WithValue(req.Context(), loggerContextKey, logger))
	before := promtestutil.ToFloat64(HandlerPanics)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusInternalServerError, rec.Code)
	require.Equal(t, before+1, promtestutil.ToFloat64(HandlerPanics))
	var record map[string]any
	require.NoError(t, json.Unmarshal(buf.Bytes(), &record), "exactly one JSON log record: %s", buf.String())
	assert.Equal(t, "ERROR", record["level"])
	assert.Equal(t, "handler panic", record["msg"])
	assert.Equal(t, "structured boom", record["panic"])
	assert.Equal(t, "/api/_test/panic", record["path"])
	assert.Equal(t, http.MethodPost, record["method"])
	assert.Contains(t, record["stack"], "TestJSONRecoverer_LogsPanicToRequestLogger")
}
