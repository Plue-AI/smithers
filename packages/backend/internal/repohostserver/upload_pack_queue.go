package repohostserver

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// Fetch negotiation contains object IDs, never a pack. Bound its buffered
// representation independently of the much larger receive-pack limit.
const maxUploadPackNegotiationBytes int64 = 10 << 20

type uploadPackAdmission struct {
	requests chan struct{}
	waiting  prometheus.Gauge
	wait     prometheus.Histogram
	rejected *prometheus.CounterVec
}

func newUploadPackAdmission(cfg Config, metrics *Metrics) *uploadPackAdmission {
	a := &uploadPackAdmission{
		requests: make(chan struct{}, cfg.maxConcurrentUploadPacks()+cfg.maxQueuedUploadPacks()),
		waiting:  prometheus.NewGauge(prometheus.GaugeOpts{Name: "smithers_repo_host_upload_pack_waiting", Help: "Fetches reading negotiation, synchronizing refs, or waiting for process and repository read slots."}),
		wait:     prometheus.NewHistogram(prometheus.HistogramOpts{Name: "smithers_repo_host_upload_pack_wait_seconds", Help: "Fetch admission time including negotiation and repository waits.", Buckets: []float64{0.01, 0.1, 0.5, 1, 5, 10, 20, 30, 60}}),
		rejected: prometheus.NewCounterVec(prometheus.CounterOpts{Name: "smithers_repo_host_upload_pack_rejected_total", Help: "Fetch admission failures by reason."}, []string{"reason"}),
	}
	for _, reason := range []string{"body", "full", "ended"} {
		a.rejected.WithLabelValues(reason)
	}
	metrics.registry.MustRegister(a.waiting, a.wait, a.rejected)
	return a
}

// acquireUploadPack bounds negotiation reads, reference-export lock waits, and
// process and repository read-lock waits with one admission deadline. Reading the
// negotiation to EOF enables HTTP/1.1 disconnect detection during every wait.
// Ref synchronization waits for repository writers before taking a process
// slot, so reference-export lock waits do not consume git process capacity.
func (s *Server) acquireUploadPack(w http.ResponseWriter, r *http.Request, repoPath, gitDir string) (io.Reader, func(), error) {
	a := s.uploadPackQueue
	rc := http.NewResponseController(w)
	closeRejectedConnection := func() {
		w.Header().Set("Connection", "close")
		// net/http closes the request body after writing the response. A
		// rejected peer must not stall that cleanup with missing body bytes.
		_ = rc.SetReadDeadline(time.Now())
	}
	select {
	case a.requests <- struct{}{}:
	default:
		a.rejected.WithLabelValues("full").Inc()
		w.Header().Set("Retry-After", "1")
		closeRejectedConnection()
		return nil, nil, &appError{StatusCode: http.StatusServiceUnavailable, Code: repohost.UploadPackQueueFullCode, Message: "fetch queue full; retry later"}
	}
	admitted := false
	defer func() {
		if !admitted {
			<-a.requests
		}
	}()
	a.waiting.Inc()
	started := time.Now()
	defer func() { a.waiting.Dec(); a.wait.Observe(time.Since(started).Seconds()) }()
	ctx, cancel := context.WithTimeout(r.Context(), s.config.uploadPackQueueTimeout())
	defer cancel()
	deadline, _ := ctx.Deadline()
	_ = rc.SetReadDeadline(deadline)
	ended := func(err error) error {
		a.rejected.WithLabelValues("ended").Inc()
		return &appError{StatusCode: http.StatusGatewayTimeout, Code: repohost.UploadPackQueueTimeoutCode, Message: "request ended while waiting to build a pack", Cause: err}
	}
	rejectNegotiation := func(err error) error {
		// An invalid prefix may leave an unfinished request body. Do not
		// drain it before replying or permit reuse of that connection.
		// Classify first: closing a completed body's background socket read
		// can itself cancel r.Context, without changing the original error.
		wasEnded := ctx.Err() != nil || !time.Now().Before(deadline)
		closeRejectedConnection()
		if wasEnded {
			return ended(err)
		}
		a.rejected.WithLabelValues("body").Inc()
		return err
	}
	limit := maxUploadPackNegotiationBytes
	if configured := s.config.maxGitRequestBytes(); configured < limit {
		limit = configured
	}
	body, err := gitRequestBody(r, limit)
	if err != nil {
		return nil, nil, rejectNegotiation(err)
	}
	// The HTTP server owns its raw body. Closing it here would drain an
	// unfinished plain negotiation; only the gzip decoder needs closing.
	if decoded, ok := body.(limitedReadCloser); ok {
		defer decoded.Close()
	}
	data, err := io.ReadAll(io.LimitReader(body, limit+1))
	if errors.Is(err, errPushTooLarge) || int64(len(data)) > limit {
		return nil, nil, rejectNegotiation(&appError{StatusCode: http.StatusRequestEntityTooLarge, Code: repohost.UploadPackNegotiationTooLargeCode, Message: "fetch negotiation too large"})
	}
	if err != nil {
		return nil, nil, rejectNegotiation(badRequest("unable to read fetch negotiation"))
	}
	// The body is complete, so there is nothing to drain on an admission
	// timeout. Its background socket read must stay open for disconnect
	// detection and connection reuse; the context bounds all remaining waits.
	_ = rc.SetReadDeadline(time.Time{})
	if err := s.syncGitRefs(ctx, repoPath, gitDir); err != nil {
		if ctx.Err() != nil {
			return nil, nil, ended(err)
		}
		return nil, nil, err
	}
	if err := s.uploadPacks.Acquire(ctx, 1); err != nil {
		return nil, nil, ended(err)
	}
	// Keep the process-before-read-lock ordering so queued readers do not
	// block repository writers. The remaining lock wait uses the same bound.
	unlockRead, err := s.locks.RLock(ctx, repoPath)
	if err != nil {
		s.uploadPacks.Release(1)
		return nil, nil, ended(err)
	}
	admitted = true
	return bytes.NewReader(data), func() { unlockRead(); s.uploadPacks.Release(1); <-a.requests }, nil
}

func (c Config) maxQueuedUploadPacks() int {
	if c.MaxQueuedUploadPacks > 0 {
		return c.MaxQueuedUploadPacks
	}
	return 16
}
func (c Config) uploadPackQueueTimeout() time.Duration {
	if c.UploadPackQueueTimeout > 0 {
		return c.UploadPackQueueTimeout
	}
	return 30 * time.Second
}

func uploadPackBoundsFromEnv(cfg *Config) error {
	for _, item := range []struct {
		name  string
		value *int
	}{
		{"SMITHERS_REPO_HOST_MAX_CONCURRENT_UPLOAD_PACKS", &cfg.MaxConcurrentUploadPacks},
		{"SMITHERS_REPO_HOST_MAX_QUEUED_UPLOAD_PACKS", &cfg.MaxQueuedUploadPacks},
	} {
		if raw := strings.TrimSpace(os.Getenv(item.name)); raw != "" {
			n, err := strconv.Atoi(raw)
			if err != nil || n <= 0 || n > 1024 {
				return fmt.Errorf("%s must be between 1 and 1024", item.name)
			}
			*item.value = n
		}
	}
	if raw := strings.TrimSpace(os.Getenv("SMITHERS_REPO_HOST_UPLOAD_PACK_QUEUE_TIMEOUT")); raw != "" {
		d, err := time.ParseDuration(raw)
		if err != nil || d <= 0 {
			return fmt.Errorf("SMITHERS_REPO_HOST_UPLOAD_PACK_QUEUE_TIMEOUT must be a positive duration")
		}
		cfg.UploadPackQueueTimeout = d
	}
	return nil
}
