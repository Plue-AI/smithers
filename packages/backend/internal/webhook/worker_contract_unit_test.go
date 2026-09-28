package webhook

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

type workerUnitCodec func(string) (string, error)

func (c workerUnitCodec) EncryptString(s string) (string, error) { return s, nil }
func (c workerUnitCodec) DecryptString(s string) (string, error) { return c(s) }

type workerUnitMetrics struct {
	mu                  sync.Mutex
	attempts, terminals []string
}

func (m *workerUnitMetrics) ObserveWebhookDeliveryAttempt(s string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.attempts = append(m.attempts, s)
}
func (m *workerUnitMetrics) ObserveWebhookDeliveryTerminal(s string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.terminals = append(m.terminals, s)
}

type workerUnitLogs struct {
	mu      sync.Mutex
	records []slog.Record
}

func (l *workerUnitLogs) Enabled(context.Context, slog.Level) bool { return true }
func (l *workerUnitLogs) Handle(_ context.Context, r slog.Record) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.records = append(l.records, r.Clone())
	return nil
}
func (l *workerUnitLogs) WithAttrs([]slog.Attr) slog.Handler { return l }
func (l *workerUnitLogs) WithGroup(string) slog.Handler      { return l }
func workerUnitWait[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(3 * time.Second):
		t.Fatal("worker did not reach owned boundary")
		var zero T
		return zero
	}
}
func workerUnitBatch(deliveries []db.WebhookDelivery, hooks []db.Webhook) *workerMockStore {
	return &workerMockStore{
		claimFn:        func(context.Context, int32) ([]db.WebhookDelivery, error) { return deliveries, nil },
		listWebhooksFn: func(context.Context, []int64) ([]db.Webhook, error) { return hooks, nil },
	}
}

func TestWorkerContractUnitMixedBatchAndOwnedWait(t *testing.T) {
	t.Parallel()
	release := make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	entered := make(chan struct{})
	slowExited := make(chan struct{})
	fastRecorded := make(chan struct{})
	store := workerUnitBatch([]db.WebhookDelivery{
		{ID: 1, WebhookID: 11, Attempts: 1}, {ID: 2, WebhookID: 12, Attempts: 1}, {ID: 3, WebhookID: 13, Attempts: 1}, {ID: 4, WebhookID: 14, Attempts: 1},
	}, []db.Webhook{
		{ID: 11, IsActive: true, Url: "https://receiver.example/slow", Secret: "good"},
		{ID: 12, IsActive: false, Secret: "must-not-decrypt"},
		{ID: 13, IsActive: true, Secret: "bad"},
		{ID: 14, IsActive: true, Url: "https://receiver.example/fast", Secret: "good"},
	})
	store.updateResultFn = func(_ context.Context, arg db.UpdateWebhookDeliveryResultParams) error {
		if arg.ID == 4 {
			close(fastRecorded)
		}
		return nil
	}
	var mu sync.Mutex
	var decoded, requests []string
	codec := workerUnitCodec(func(s string) (string, error) {
		mu.Lock()
		decoded = append(decoded, s)
		mu.Unlock()
		if s == "bad" {
			return "", errors.New("corrupt ciphertext")
		}
		return "", nil
	})
	client := &http.Client{Transport: httpUnitTransport(func(r *http.Request) (*http.Response, error) {
		mu.Lock()
		requests = append(requests, r.Header.Get("X-Smithers-Delivery"))
		mu.Unlock()
		if r.URL.Path == "/slow" {
			close(entered)
			defer close(slowExited)
			<-release
		}
		return &http.Response{StatusCode: 202, Body: io.NopCloser(strings.NewReader(r.URL.Path))}, nil
	})}
	metrics := &workerUnitMetrics{}
	w := NewWorker(store, client, codec, WithMetricsObserver(metrics))
	done := make(chan error, 1)
	exited := make(chan struct{})
	t.Cleanup(func() {
		unblock()
		workerUnitWait(t, exited)
		select {
		case <-entered:
			workerUnitWait(t, slowExited)
		default:
		}
	})
	go func() { defer close(exited); done <- w.PollOnce(context.Background()) }()
	workerUnitWait(t, entered)
	workerUnitWait(t, fastRecorded)
	select {
	case <-done:
		t.Fatal("PollOnce returned while its slow request was still owned")
	default:
	}
	unblock()
	require.NoError(t, workerUnitWait(t, done))
	require.ElementsMatch(t, []string{"good", "bad", "good"}, decoded)
	require.ElementsMatch(t, []string{"1", "4"}, requests)
	require.Empty(t, store.retryCalls)
	require.Empty(t, store.setActiveCalls)
	require.Len(t, store.resultCalls, 4)
	byID := map[int64]db.UpdateWebhookDeliveryResultParams{}
	for _, r := range store.resultCalls {
		_, duplicate := byID[r.ID]
		require.False(t, duplicate)
		byID[r.ID] = r
	}
	require.Equal(t, "success", byID[1].Status)
	require.Equal(t, "/slow", byID[1].ResponseBody)
	require.Equal(t, int32(202), byID[1].ResponseStatus.Int32)
	require.Equal(t, "failed", byID[2].Status)
	require.Equal(t, "webhook disabled", byID[2].ResponseBody)
	require.False(t, byID[2].ResponseStatus.Valid)
	require.Equal(t, "failed", byID[3].Status)
	require.Equal(t, "failed to decrypt webhook secret: corrupt ciphertext", byID[3].ResponseBody)
	require.False(t, byID[3].ResponseStatus.Valid)
	require.Equal(t, "success", byID[4].Status)
	require.Equal(t, "/fast", byID[4].ResponseBody)
	require.ElementsMatch(t, []string{"success", "success", "disabled", "failed"}, metrics.attempts)
	require.ElementsMatch(t, metrics.attempts, metrics.terminals)
}

func TestWorkerContractUnitCancellationDuringOwnedRequest(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(context.Background())
	release := make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	entered := make(chan struct{})
	store := workerUnitBatch([]db.WebhookDelivery{{ID: 51, WebhookID: 61, Attempts: 1}}, []db.Webhook{{ID: 61, IsActive: true, Url: "https://receiver.example/"}})
	var persistedContextErr error
	store.updateRetryFn = func(c context.Context, arg db.UpdateWebhookDeliveryRetryParams) error {
		persistedContextErr = c.Err()
		return nil
	}
	client := &http.Client{Transport: httpUnitTransport(func(r *http.Request) (*http.Response, error) {
		close(entered)
		select {
		case <-r.Context().Done():
			return nil, r.Context().Err()
		case <-release:
			return nil, context.Canceled
		}
	})}
	metrics := &workerUnitMetrics{}
	w := NewWorker(store, client, nil, WithMetricsObserver(metrics))
	done := make(chan error, 1)
	before := time.Now()
	exited := make(chan struct{})
	t.Cleanup(func() { cancel(); unblock(); workerUnitWait(t, exited) })
	go func() { defer close(exited); done <- w.PollOnce(ctx) }()
	workerUnitWait(t, entered)
	cancel()
	require.NoError(t, workerUnitWait(t, done))
	after := time.Now()
	require.ErrorIs(t, persistedContextErr, context.Canceled)
	require.Empty(t, store.resultCalls)
	require.Len(t, store.retryCalls, 1)
	retry := store.retryCalls[0]
	require.Equal(t, int64(51), retry.ID)
	require.Equal(t, "pending", retry.Status)
	require.False(t, retry.ResponseStatus.Valid)
	require.Empty(t, retry.ResponseBody)
	require.True(t, retry.NextRetryAt.Valid)
	require.False(t, retry.NextRetryAt.Time.Before(before.Add(time.Second)))
	require.False(t, retry.NextRetryAt.Time.After(after.Add(time.Second)))
	require.Equal(t, []string{"retry"}, metrics.attempts)
	require.Empty(t, metrics.terminals)
}

func TestWorkerContractUnitPanicIsolatedAndCorrelated(t *testing.T) {
	t.Parallel()
	store := workerUnitBatch([]db.WebhookDelivery{{ID: 71, WebhookID: 81, Attempts: 1}, {ID: 72, WebhookID: 82, Attempts: 1}}, []db.Webhook{{ID: 81, IsActive: true, Secret: "panic"}, {ID: 82, IsActive: true, Url: "https://receiver.example/"}})
	codec := workerUnitCodec(func(s string) (string, error) {
		if s == "panic" {
			panic("codec exploded")
		}
		return "", nil
	})
	client := &http.Client{Transport: httpUnitTransport(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 204, Body: io.NopCloser(strings.NewReader(""))}, nil
	})}
	metrics := &workerUnitMetrics{}
	logs := &workerUnitLogs{}
	w := NewWorker(store, client, codec, WithMetricsObserver(metrics))
	w.logger = slog.New(logs)
	require.NoError(t, w.PollOnce(context.Background()))
	require.Len(t, store.resultCalls, 1)
	require.Equal(t, int64(72), store.resultCalls[0].ID)
	require.Equal(t, "success", store.resultCalls[0].Status)
	require.Empty(t, store.retryCalls)
	require.Equal(t, []string{"success"}, metrics.attempts)
	require.Equal(t, []string{"success"}, metrics.terminals)
	require.Len(t, logs.records, 1)
	record := logs.records[0]
	require.Equal(t, slog.LevelError, record.Level)
	require.Equal(t, "webhook delivery panicked", record.Message)
	attrs := map[string]any{}
	record.Attrs(func(a slog.Attr) bool { attrs[a.Key] = a.Value.Any(); return true })
	require.Equal(t, int64(71), attrs["delivery_id"])
	require.Equal(t, int64(81), attrs["webhook_id"])
	require.Equal(t, "codec exploded", attrs["panic"])
}

func TestWorkerContractUnitFailedPersistenceOwnsErrorReceipt(t *testing.T) {
	t.Parallel()
	for _, tt := range []struct{ name, secret, message string }{
		{"delivered", "", "failed to update webhook delivery status"},
		{"decrypt failed", "corrupt", "failed to mark webhook delivery failed after decrypt error"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			writeErr := errors.New("status write refused")
			store := workerUnitBatch([]db.WebhookDelivery{{ID: 91, WebhookID: 92, Attempts: 1}}, []db.Webhook{{ID: 92, IsActive: true, Secret: tt.secret, Url: "https://receiver.example/"}})
			store.updateResultFn = func(context.Context, db.UpdateWebhookDeliveryResultParams) error { return writeErr }
			codec := workerUnitCodec(func(s string) (string, error) {
				if s == "corrupt" {
					return "", errors.New("decrypt refused")
				}
				return "", nil
			})
			client := &http.Client{Transport: httpUnitTransport(func(r *http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("ok"))}, nil
			})}
			logs := &workerUnitLogs{}
			metrics := &workerUnitMetrics{}
			w := NewWorker(store, client, codec, WithMetricsObserver(metrics))
			w.logger = slog.New(logs)
			require.NoError(t, w.PollOnce(context.Background()))
			require.Len(t, store.resultCalls, 1)
			require.Empty(t, store.retryCalls)
			require.Empty(t, metrics.attempts)
			require.Empty(t, metrics.terminals)
			require.Len(t, logs.records, 1)
			record := logs.records[0]
			require.Equal(t, tt.message, record.Message)
			require.Equal(t, slog.LevelError, record.Level)
			attrs := map[string]any{}
			record.Attrs(func(a slog.Attr) bool { attrs[a.Key] = a.Value.Any(); return true })
			require.Equal(t, int64(91), attrs["delivery_id"])
			require.Equal(t, int64(92), attrs["webhook_id"])
			require.ErrorIs(t, attrs["error"].(error), writeErr)
		})
	}
}
