package services

import (
	"bytes"
	"context"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// notifyOnceHandler wraps a slog.Handler and closes done the first time a
// record is handled, so a test can deterministically wait for a specific
// async log line instead of racing a WaitGroup against the log write.
type notifyOnceHandler struct {
	next slog.Handler
	once sync.Once
	done chan struct{}
}

func newNotifyOnceHandler(next slog.Handler) *notifyOnceHandler {
	return &notifyOnceHandler{next: next, done: make(chan struct{})}
}

func (h *notifyOnceHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.next.Enabled(ctx, level)
}

func (h *notifyOnceHandler) Handle(ctx context.Context, rec slog.Record) error {
	err := h.next.Handle(ctx, rec)
	h.once.Do(func() { close(h.done) })
	return err
}

func (h *notifyOnceHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &notifyOnceHandler{next: h.next.WithAttrs(attrs), done: h.done}
}

func (h *notifyOnceHandler) WithGroup(name string) slog.Handler {
	return &notifyOnceHandler{next: h.next.WithGroup(name), done: h.done}
}

// withCapturedDefaultLog swaps the slog default logger for the duration of fn,
// returning a buffer of everything logged and a channel closed once the first
// record is handled. Guarded by auditTestLoggerMu (defined in audit_test.go)
// since slog.SetDefault mutates process-wide state shared by every test in
// this package.
func withCapturedDefaultLog(t *testing.T, fn func()) (*bytes.Buffer, <-chan struct{}) {
	t.Helper()

	auditTestLoggerMu.Lock()
	prev := slog.Default()

	var buf bytes.Buffer
	handler := newNotifyOnceHandler(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelWarn}))
	slog.SetDefault(slog.New(handler))
	t.Cleanup(func() {
		slog.SetDefault(prev)
		auditTestLoggerMu.Unlock()
	})

	fn()
	return &buf, handler.done
}

func waitForLog(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for the background goroutine's panic log")
	}
}

func TestSafeGo_RecoversPanicAndLogsIt(t *testing.T) {
	buf, done := withCapturedDefaultLog(t, func() {
		SafeGo("test-goroutine", func() {
			panic("boom")
		})
	})
	waitForLog(t, done)

	logs := buf.String()
	assert.Contains(t, logs, "background goroutine panic")
	assert.Contains(t, logs, "test-goroutine")
	assert.Contains(t, logs, "boom")
}

func TestSafeGo_RunsFnToCompletionWhenNoPanic(t *testing.T) {
	ran := make(chan struct{})

	SafeGo("no-panic-goroutine", func() {
		close(ran)
	})

	select {
	case <-ran:
	case <-time.After(2 * time.Second):
		t.Fatal("SafeGo did not run fn")
	}
}

// TestSafeGo_InnerDeferRunsBeforeRecovery pins the guarantee that a defer set
// up inside fn (e.g. a `defer inFlight.Delete(key)` marker)
// still executes on a panic, before SafeGo's own recover fires — so an
// in-flight marker is always cleared even when fn panics.
func TestSafeGo_InnerDeferRunsBeforeRecovery(t *testing.T) {
	var innerDeferRan bool

	buf, done := withCapturedDefaultLog(t, func() {
		SafeGo("inner-defer-goroutine", func() {
			defer func() { innerDeferRan = true }()
			panic("inner panic")
		})
	})
	waitForLog(t, done)

	require.True(t, innerDeferRan, "fn's own defer must run even when fn panics")
	logs := buf.String()
	assert.Contains(t, logs, "background goroutine panic")
	assert.Contains(t, logs, "inner-defer-goroutine")
}
