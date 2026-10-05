package repohost

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptrace"
	"net/textproto"
	"os"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
)

// NewLocalClient uses the same repository client and server protocol in the
// process that owns the repository. It does not bind a port or resolve a
// storage set. Git's public HTTP handler can be mounted separately.
func NewLocalClient(handler http.Handler, authToken string, metrics ...RepoHostOperationDurationObserver) *Client {
	client := NewClient(&StaticStorageSetResolver{URL: "http://repository.local"}, authToken, metrics...)
	client.httpClient = &http.Client{Transport: refusalTransport{next: &handlerTransport{handler: handler}}}
	client.inProcess = true
	return client
}

// InProcess reports whether the client calls an embedded repository handler
// rather than a repo-host service over the network. Only an in-process client
// replaces the repo_host.url requirement and the network readiness probe.
func (c *Client) InProcess() bool { return c != nil && c.inProcess }

// NewLocalClientWithStagingEndpoint keeps control requests in process while
// giving Git subprocesses a reachable, token-scoped staging URL.
// installMainMirror is the engine's own install fact (repohostserver.Config),
// which the API's push, bookmark and landing doors read from this client.
func NewLocalClientWithStagingEndpoint(handler http.Handler, authToken, stagingBaseURL string, installMainMirror bool) *Client {
	client := NewLocalClient(handler, authToken)
	client.localStagingBaseURL = stagingBaseURL
	client.installMainMirror = installMainMirror
	return client
}

// InstallMainMirror reports whether the engine behind this client is an
// install's, where only the GitHub sync writes main and the default bookmark
// (repohost.RequireInstallMainMirror). It is the one install fact every door
// in front of the engine applies, so no door can disagree with the engine.
func (c *Client) InstallMainMirror() bool { return c != nil && c.installMainMirror }

// handlerTransport streams responses through a pipe. A recorder would buffer
// diffs and repository contents without a bound before returning to Client.
type handlerTransport struct{ handler http.Handler }

func (t *handlerTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Scheme != "http" || req.URL.Host != "repository.local" {
		return nil, errors.New("local repository request escaped its handler")
	}
	// A local client may be called inside an API chi route. Give the embedded
	// repository router its own route context while retaining cancellation and
	// tracing from the caller.
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, chi.NewRouteContext()))
	reader, writer := io.Pipe()
	ready := make(chan localResponse, 1)
	done := make(chan struct{})
	if req.Body == nil {
		req.Body = http.NoBody
	}
	body := &deadlineRequestBody{ReadCloser: req.Body, contextDone: req.Context().Done(), contextErr: req.Context().Err}
	req.Body = body
	w := &handlerResponseWriter{header: make(http.Header), writer: writer, reader: reader, ready: ready, request: req, body: body}
	go func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				err := fmt.Errorf("local repository handler aborted: %v", recovered)
				_ = writer.CloseWithError(err)
				select {
				case ready <- localResponse{err: err}:
				default:
				}
			} else {
				if err := req.Context().Err(); err != nil {
					_ = writer.CloseWithError(err)
				} else {
					_ = writer.Close()
				}
			}
			_ = w.SetWriteDeadline(time.Time{})
			close(done)
		}()
		t.handler.ServeHTTP(w, req)
		w.WriteHeader(http.StatusOK)
	}()
	go func() {
		select {
		case <-req.Context().Done():
			_ = reader.CloseWithError(req.Context().Err())
			_ = body.Close()
		case <-done:
		}
	}()
	select {
	case result := <-ready:
		return result.response, result.err
	case <-req.Context().Done():
		_ = reader.CloseWithError(req.Context().Err())
		_ = body.Close()
		return nil, req.Context().Err()
	}
}

type localResponse struct {
	response *http.Response
	err      error
}

type handlerResponseWriter struct {
	header           http.Header
	writer           *io.PipeWriter
	reader           *io.PipeReader
	ready            chan localResponse
	request          *http.Request
	body             *deadlineRequestBody
	once             sync.Once
	mu               sync.Mutex
	writeTimer       *time.Timer
	writeDeadlineErr error
}

func (w *handlerResponseWriter) Header() http.Header { return w.header }

func (w *handlerResponseWriter) WriteHeader(status int) {
	if status >= 100 && status < 200 && status != http.StatusSwitchingProtocols {
		// Informational, as over the network: the caller's trace sees it.
		if trace := httptrace.ContextClientTrace(w.request.Context()); trace != nil && trace.Got1xxResponse != nil {
			_ = trace.Got1xxResponse(status, textproto.MIMEHeader(w.header.Clone()))
		}
		return
	}
	w.once.Do(func() {
		w.ready <- localResponse{response: &http.Response{
			StatusCode:    status,
			Header:        w.header.Clone(),
			Body:          &contextResponseBody{ReadCloser: w.reader, contextErr: w.request.Context().Err},
			Request:       w.request,
			ContentLength: -1,
		}}
	})
}

type contextResponseBody struct {
	io.ReadCloser
	contextErr func() error
}

func (b *contextResponseBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	if err != nil && b.contextErr() != nil {
		return n, b.contextErr()
	}
	return n, err
}

func (w *handlerResponseWriter) Write(b []byte) (int, error) {
	w.WriteHeader(http.StatusOK)
	n, err := w.writer.Write(b)
	if err != nil {
		w.mu.Lock()
		deadlineErr := w.writeDeadlineErr
		w.mu.Unlock()
		if deadlineErr != nil {
			return n, deadlineErr
		}
	}
	return n, err
}

func (w *handlerResponseWriter) Flush() { w.WriteHeader(http.StatusOK) }

func (w *handlerResponseWriter) SetReadDeadline(deadline time.Time) error {
	w.body.setDeadline(deadline)
	return nil
}

func (w *handlerResponseWriter) SetWriteDeadline(deadline time.Time) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.writeTimer != nil {
		w.writeTimer.Stop()
	}
	w.writeDeadlineErr = nil
	if !deadline.IsZero() {
		w.writeTimer = time.AfterFunc(time.Until(deadline), func() {
			w.mu.Lock()
			w.writeDeadlineErr = os.ErrDeadlineExceeded
			w.mu.Unlock()
			_ = w.reader.CloseWithError(os.ErrDeadlineExceeded)
		})
	}
	return nil
}

type deadlineRequestBody struct {
	io.ReadCloser
	contextDone <-chan struct{}
	contextErr  func() error
	mu          sync.Mutex
	deadline    time.Time
}

func (b *deadlineRequestBody) setDeadline(deadline time.Time) {
	b.mu.Lock()
	b.deadline = deadline
	b.mu.Unlock()
}

func (b *deadlineRequestBody) Read(p []byte) (int, error) {
	b.mu.Lock()
	deadline := b.deadline
	b.mu.Unlock()
	if len(p) == 0 {
		return 0, nil
	}
	type readResult struct {
		n   int
		err error
	}
	result := make(chan readResult, 1)
	scratch := make([]byte, len(p))
	go func() { n, err := b.ReadCloser.Read(scratch); result <- readResult{n, err} }()
	var timeout <-chan time.Time
	if !deadline.IsZero() {
		timer := time.NewTimer(time.Until(deadline))
		defer timer.Stop()
		timeout = timer.C
	}
	select {
	case read := <-result:
		copy(p, scratch[:read.n])
		return read.n, read.err
	case <-timeout:
		_ = b.ReadCloser.Close()
		return 0, os.ErrDeadlineExceeded
	case <-b.contextDone:
		_ = b.ReadCloser.Close()
		return 0, b.contextErr()
	}
}

var _ http.RoundTripper = (*handlerTransport)(nil)
var _ http.ResponseWriter = (*handlerResponseWriter)(nil)
var _ http.Flusher = (*handlerResponseWriter)(nil)
var _ interface{ SetReadDeadline(time.Time) error } = (*handlerResponseWriter)(nil)
var _ interface{ SetWriteDeadline(time.Time) error } = (*handlerResponseWriter)(nil)
