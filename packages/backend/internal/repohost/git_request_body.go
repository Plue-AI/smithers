package repohost

import (
	"compress/gzip"
	stdErrors "errors"
	"io"
	"net/http"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// GitRequestBody decodes a smart-HTTP Git request before proxying it to a
// transport that consumes raw protocol bytes. Git compresses larger fetch
// negotiations; forwarding them without Content-Encoding corrupts the stream.
// Both wire and decompressed bodies are bounded. The limiter lets handlers
// distinguish an oversized request from an ordinary proxy failure.
func GitRequestBody(r *http.Request, wireLimit int64) (io.Reader, *GitRequestBodyLimiter, error) {
	limiter := &GitRequestBodyLimiter{r: r.Body, remaining: wireLimit + 1}
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
// bodies (see GitRequestBody).
const maxDecompressedGitRequestSize int64 = 512 * 1024 * 1024

// MaxGitRequestBodySize bounds the raw wire bytes of a smart-HTTP git RPC
// request body (see GitRequestBody). Callers may supply a smaller wire limit.
const MaxGitRequestBodySize int64 = 512 * 1024 * 1024

var errGitRequestBodyTooLarge = stdErrors.New("git request body exceeds maximum allowed size")

// GitRequestBodyLimiter caps the bytes read from a git RPC request body and
// records when the cap was exceeded so handlers can answer 413.
type GitRequestBodyLimiter struct {
	r         io.Reader
	remaining int64
	exceeded  bool
}

func (l *GitRequestBodyLimiter) Read(p []byte) (int, error) {
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

// Exceeded reports that the wire request exceeded its configured bound.
func (l *GitRequestBodyLimiter) Exceeded() bool { return l.exceeded }
