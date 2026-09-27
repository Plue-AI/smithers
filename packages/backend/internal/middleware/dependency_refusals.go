package middleware

import (
	"bufio"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"

	apierrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// DependencyRefusals answers a request with the refusal a dependency recorded
// on it (apierrors.RecordRefusal), such as repo-host holding a repository,
// whenever the handler would answer with a generic server error (500 or 502,
// a panic included): whatever each call site made of the dependency's error,
// the client gets the dependency's verdict, its status, code and Retry-After.
// A plain-text response (git's) stays plain text. Success, client errors and
// a handler's own deliberate 503 or 504 are left as they are.
func DependencyRefusals(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r = r.WithContext(apierrors.WithRefusalRecorder(r.Context()))
		next.ServeHTTP(&refusalWriter{ResponseWriter: w, r: r}, r)
	})
}

// refusalWriter replaces a server error with the request's recorded refusal.
type refusalWriter struct {
	http.ResponseWriter
	r           *http.Request
	wroteHeader bool
	replaced    bool
}

func (w *refusalWriter) WriteHeader(status int) {
	if w.wroteHeader {
		return
	}
	w.wroteHeader = true
	refusal := apierrors.RecordedRefusal(w.r.Context())
	if (status != http.StatusInternalServerError && status != http.StatusBadGateway) || refusal == nil {
		w.ResponseWriter.WriteHeader(status)
		return
	}
	w.replaced = true
	header := w.Header()
	header.Del("Content-Length")
	header.Del("Retry-After")
	header.Set("X-Smithers-Error-Code", string(refusal.Code))
	if strings.HasPrefix(header.Get("Content-Type"), "text/plain") {
		if refusal.RetryAfter > 0 {
			header.Set("Retry-After", strconv.Itoa(refusal.RetryAfter))
		}
		w.ResponseWriter.WriteHeader(refusal.Status)
		_, _ = io.WriteString(w.ResponseWriter, refusal.Message+"\n")
		return
	}
	apierrors.WriteError(w.ResponseWriter, refusal)
}

func (w *refusalWriter) Write(p []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	if w.replaced {
		return len(p), nil
	}
	return w.ResponseWriter.Write(p)
}

func (w *refusalWriter) Flush() {
	if w.replaced {
		return
	}
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	_ = http.NewResponseController(w.ResponseWriter).Flush()
}

func (w *refusalWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return http.NewResponseController(w.ResponseWriter).Hijack()
}

// Unwrap lets http.ResponseController reach the connection underneath.
func (w *refusalWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
