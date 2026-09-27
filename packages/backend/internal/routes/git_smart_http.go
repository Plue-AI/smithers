package routes

import (
	"bytes"
	"compress/gzip"
	"context"
	stdErrors "errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type GitSmartRouteService interface {
	ProxyInfoRefs(ctx context.Context, owner, repo, service, token string, stdout io.Writer) (string, error)
	ProxyUploadPack(ctx context.Context, owner, repo, token string, stdin io.Reader, stdout io.Writer) error
	ProxyReceivePack(ctx context.Context, owner, repo, token string, stdin io.Reader, stdout io.Writer) error
}

type GitSmartHandler struct {
	Service GitSmartRouteService
	Metrics *SmithersMetrics
}

// bodyTrackingWriter wraps an http.ResponseWriter and records whether any body
// bytes have been written (i.e. whether WriteHeader has been called explicitly
// or implicitly via Write). Once body bytes are in flight the HTTP status code
// is committed and we must not attempt to write an error response.
type bodyTrackingWriter struct {
	http.ResponseWriter
	written atomic.Bool
}

func (b *bodyTrackingWriter) WriteHeader(status int) {
	b.written.Store(true)
	b.ResponseWriter.WriteHeader(status)
}

func (b *bodyTrackingWriter) Write(p []byte) (int, error) {
	b.written.Store(true)
	return b.ResponseWriter.Write(p)
}

// headersCommitted reports whether any response body bytes have been sent.
func (b *bodyTrackingWriter) headersCommitted() bool {
	return b.written.Load()
}

func (h *GitSmartHandler) InfoRefs(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	result := "success"
	defer func() {
		h.Metrics.ObserveHTTPGitOperation("info-refs", result, time.Since(start).Seconds())
	}()

	owner := strings.TrimSpace(chi.URLParam(r, "owner"))
	if owner == "" {
		result = "error"
		writeGitHTTPError(w, r, errors.BadRequest("owner is required"))
		return
	}

	repo, err := parseGitRepoParam(chi.URLParam(r, "repo"))
	if err != nil {
		result = "error"
		writeGitHTTPError(w, r, err)
		return
	}

	service := strings.TrimSpace(r.URL.Query().Get("service"))
	if service != "git-upload-pack" && service != "git-receive-pack" {
		result = "error"
		writeGitHTTPError(w, r, errors.BadRequest("unsupported git service"))
		return
	}

	token := extractGitToken(r)
	if h.Service == nil {
		result = "error"
		writeGitHTTPError(w, r, errors.Internal("git smart HTTP service is not configured"))
		return
	}

	// InfoRefs output is normally small (just the ref advertisement), so we
	// buffer it before writing response headers, preserving the ability to send
	// an HTTP error if the upstream call fails. The buffer is capped:
	// a repository with a pathological number of refs must not be able to
	// exhaust API memory through clone/fetch discovery (repo-host enforces the
	// same ceiling; this is defense in depth).
	out := &cappedBuffer{max: maxRefAdvertisementSize}
	contentType, err := h.Service.ProxyInfoRefs(r.Context(), owner, repo, service, token, out)
	if err != nil {
		result = "error"
		writeGitHTTPError(w, r, err)
		return
	}

	if strings.TrimSpace(contentType) == "" {
		contentType = fmt.Sprintf("application/x-%s-advertisement", service)
	}
	w.Header().Set("Content-Type", contentType)
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, &out.buf)
}

// maxRefAdvertisementSize caps the git info/refs advertisement buffered from
// repo-host: repo-host's own 64 MiB ceiling plus slack for the pkt-line
// service header. Variable so tests can lower it.
var maxRefAdvertisementSize int64 = 64*1024*1024 + 512

// cappedBuffer is a bytes.Buffer that fails writes past a byte ceiling
// instead of growing without bound.
type cappedBuffer struct {
	buf bytes.Buffer
	max int64
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	if int64(c.buf.Len())+int64(len(p)) > c.max {
		return 0, stdErrors.New("git ref advertisement exceeds maximum size")
	}
	return c.buf.Write(p)
}

// gitSmartRequestBody returns the git RPC request body, transparently
// gunzipping when the client sent Content-Encoding: gzip. git's remote-curl
// compresses smart-HTTP request bodies past a size threshold, so a LARGE
// negotiation (cloning a many-ref mirror wants hundreds of refs) arrives
// gzipped while a small one arrives as identity. This hop terminates the
// header — the repo-host proxy request does not forward Content-Encoding —
// so without decompressing here `git upload-pack` received gzip bytes,
// exited silently, and every large clone died with "remote end hung up".
//
// Every body — identity or gzip — is capped at maxGitRequestBodySize wire
// bytes via the returned limiter: these routes are mounted on the root router
// so they bypass the /api MaxBodySize middleware, and without a cap a
// write-authorized client could stream an unbounded push through the API into
// repo-host (SSH pushes already enforce a 500 MiB ceiling). Handlers check
// the limiter after a proxy failure to answer 413.
func gitSmartRequestBody(r *http.Request) (io.Reader, *gitRequestBodyLimiter, error) {
	limiter := &gitRequestBodyLimiter{r: r.Body, remaining: maxGitRequestBodySize + 1}
	if !strings.EqualFold(strings.TrimSpace(r.Header.Get("Content-Encoding")), "gzip") {
		return limiter, limiter, nil
	}
	zr, err := gzip.NewReader(limiter)
	if err != nil {
		return nil, nil, errors.BadRequest("malformed gzip request body")
	}
	// Cap the DECOMPRESSED size too, to bound a gzip-amplification DoS: a tiny
	// gzip body can inflate to gigabytes of CPU/bandwidth. 512 MiB comfortably
	// exceeds a legitimate large push (the receive-pack ceiling defaults to
	// 500 MiB) while capping the work an attacker can force from a small body;
	// an over-cap stream truncates and git fails the operation rather than us
	// doing unbounded work.
	return io.LimitReader(zr, maxDecompressedGitRequestSize), limiter, nil
}

// maxDecompressedGitRequestSize bounds gzip-decompressed smart-HTTP request
// bodies (see gitSmartRequestBody).
const maxDecompressedGitRequestSize int64 = 512 * 1024 * 1024

// maxGitRequestBodySize bounds the raw wire bytes of a smart-HTTP git RPC
// request body (see gitSmartRequestBody). Variable so tests can lower it.
var maxGitRequestBodySize int64 = 512 * 1024 * 1024

var errGitRequestBodyTooLarge = stdErrors.New("git request body exceeds maximum allowed size")

// gitRequestBodyLimiter caps the bytes read from a git RPC request body and
// records when the cap was exceeded so handlers can answer 413.
type gitRequestBodyLimiter struct {
	r         io.Reader
	remaining int64
	exceeded  bool
}

func (l *gitRequestBodyLimiter) Read(p []byte) (int, error) {
	if l.remaining <= 0 {
		l.exceeded = true
		return 0, errGitRequestBodyTooLarge
	}
	if int64(len(p)) > l.remaining {
		p = p[:l.remaining]
	}
	n, err := l.r.Read(p)
	l.remaining -= int64(n)
	return n, err
}

func (h *GitSmartHandler) UploadPack(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	result := "success"
	defer func() {
		h.Metrics.ObserveHTTPGitOperation("upload-pack", result, time.Since(start).Seconds())
	}()

	owner := strings.TrimSpace(chi.URLParam(r, "owner"))
	if owner == "" {
		result = "error"
		writeGitHTTPError(w, r, errors.BadRequest("owner is required"))
		return
	}

	repo, err := parseGitRepoParam(chi.URLParam(r, "repo"))
	if err != nil {
		result = "error"
		writeGitHTTPError(w, r, err)
		return
	}

	token := extractGitToken(r)
	if h.Service == nil {
		result = "error"
		writeGitHTTPError(w, r, errors.Internal("git smart HTTP service is not configured"))
		return
	}

	requestBody, limiter, err := gitSmartRequestBody(r)
	if err != nil {
		result = "error"
		writeGitHTTPError(w, r, err)
		return
	}

	// Wrap the writer so we can detect whether body bytes have been sent.
	tracked := &bodyTrackingWriter{ResponseWriter: w}
	w.Header().Set("Content-Type", "application/x-git-upload-pack-result")
	if err := h.Service.ProxyUploadPack(r.Context(), owner, repo, token, requestBody, tracked); err != nil {
		result = "error"
		if tracked.headersCommitted() {
			// Headers are already committed; writing an error response would
			// corrupt the git protocol stream. Log server-side instead.
			middleware.LoggerFromContext(r.Context()).Error(
				"upload-pack failed after response headers committed",
				"owner", owner, "repo", repo, "error", err,
			)
			return
		}
		if limiter.exceeded {
			writeGitHTTPError(w, r, errors.RequestEntityTooLarge("git request body exceeds maximum allowed size"))
			return
		}
		writeGitHTTPError(w, r, err)
	}
}

func (h *GitSmartHandler) ReceivePack(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	result := "success"
	defer func() {
		h.Metrics.ObserveHTTPGitOperation("receive-pack", result, time.Since(start).Seconds())
	}()

	owner := strings.TrimSpace(chi.URLParam(r, "owner"))
	if owner == "" {
		result = "error"
		writeGitHTTPError(w, r, errors.BadRequest("owner is required"))
		return
	}

	repo, err := parseGitRepoParam(chi.URLParam(r, "repo"))
	if err != nil {
		result = "error"
		writeGitHTTPError(w, r, err)
		return
	}

	token := extractGitToken(r)
	if h.Service == nil {
		result = "error"
		writeGitHTTPError(w, r, errors.Internal("git smart HTTP service is not configured"))
		return
	}

	requestBody, limiter, err := gitSmartRequestBody(r)
	if err != nil {
		result = "error"
		writeGitHTTPError(w, r, err)
		return
	}

	// Wrap the writer so we can detect whether body bytes have been sent.
	tracked := &bodyTrackingWriter{ResponseWriter: w}
	w.Header().Set("Content-Type", "application/x-git-receive-pack-result")
	if err := h.Service.ProxyReceivePack(r.Context(), owner, repo, token, requestBody, tracked); err != nil {
		result = "error"
		if tracked.headersCommitted() {
			// Headers are already committed; writing an error response would
			// corrupt the git protocol stream. Log server-side instead.
			middleware.LoggerFromContext(r.Context()).Error(
				"receive-pack failed after response headers committed",
				"owner", owner, "repo", repo, "error", err,
			)
			return
		}
		if limiter.exceeded {
			writeGitHTTPError(w, r, errors.RequestEntityTooLarge("git request body exceeds maximum allowed size"))
			return
		}
		writeGitHTTPError(w, r, err)
	}
}

func parseGitRepoParam(repoParam string) (string, error) {
	repoParam = strings.TrimSpace(repoParam)
	if repoParam == "" {
		return "", errors.BadRequest("repository name is required")
	}
	if !strings.HasSuffix(repoParam, ".git") {
		return "", errors.BadRequest("repository path must end with .git")
	}

	repo := strings.TrimSuffix(repoParam, ".git")
	if repo == "" || strings.Contains(repo, "/") || strings.Contains(repo, "..") {
		return "", errors.BadRequest("invalid repository path")
	}
	return repo, nil
}

// writeGitHTTPError answers a smart-HTTP request with a plain-text error git
// can show the user. A 5xx is logged with the request path (owner, repo and
// operation) and the original error, because git only prints the sanitized
// message.
func writeGitHTTPError(w http.ResponseWriter, r *http.Request, err error) {
	status := http.StatusInternalServerError
	message := "internal server error"

	var apiErr *errors.APIError
	if stdErrors.As(err, &apiErr) {
		status = apiErr.Status
		message = apiErr.Message
	}
	if status >= http.StatusInternalServerError {
		middleware.LoggerFromContext(r.Context()).Error("git smart HTTP request failed",
			"method", r.Method, "path", r.URL.Path, "status", status, "error", err)
	}

	if status == http.StatusUnauthorized {
		w.Header().Set("WWW-Authenticate", `Basic realm="Smithers Git"`)
	}
	if apiErr != nil && apiErr.RetryAfter > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(apiErr.RetryAfter))
	}

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, message+"\n")
}

func extractGitToken(r *http.Request) string {
	if _, password, ok := r.BasicAuth(); ok {
		return strings.TrimSpace(password)
	}

	auth := strings.TrimSpace(r.Header.Get("Authorization"))
	if auth != "" {
		parts := strings.Fields(auth)
		if len(parts) == 2 {
			switch strings.ToLower(parts[0]) {
			case "token", "bearer":
				return strings.TrimSpace(parts[1])
			}
		}
	}

	// Tokens are deliberately NOT accepted via URL query parameters: query
	// strings are recorded by proxy/CDN access logs and browser/shell history.
	// Git clients must authenticate with Basic auth or an Authorization header.
	return ""
}
