package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// The source stub enumerates health states without a deployment dependency.
type publicStatusSource struct {
	runs  []services.CanaryRun
	err   error
	seen  context.Context
	wait  bool
	read  func(context.Context) ([]services.CanaryRun, error)
	calls int
}

func (s *publicStatusSource) LatestCanaryRuns(ctx context.Context) ([]services.CanaryRun, error) {
	s.calls++
	s.seen = ctx
	if s.read != nil {
		return s.read(ctx)
	}
	if s.wait {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	return s.runs, s.err
}

type publicStatusBody struct {
	Status     string    `json:"status"`
	CheckedAt  time.Time `json:"checked_at"`
	Components struct {
		Canary services.StatusComponent `json:"canary"`
	} `json:"components"`
}

func readPublicStatusBody(t *testing.T, rec *httptest.ResponseRecorder) publicStatusBody {
	t.Helper()
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var body publicStatusBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	return body
}

func TestPublicStatusHandlerSnapshot(t *testing.T) {
	now := time.Date(2026, time.September, 29, 12, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name       string
		source     *publicStatusSource
		wantStatus string
		wantCanary services.StatusComponent
	}{
		{"healthy", &publicStatusSource{runs: []services.CanaryRun{{Status: "success", CompletedAt: now.Add(-time.Minute), FreshnessWindow: time.Hour}}}, "ok", services.StatusComponent{Status: "ok", Detail: "latest canary runs passed"}},
		{"failure", &publicStatusSource{runs: []services.CanaryRun{{Status: "failure", CompletedAt: now.Add(-time.Minute), FreshnessWindow: time.Hour}}}, "degraded", services.StatusComponent{Status: "error", Detail: "latest canary run failed"}},
		{"failure with healthy suite", &publicStatusSource{runs: []services.CanaryRun{{Status: "failure", CompletedAt: now.Add(-time.Minute), FreshnessWindow: time.Hour}, {Status: "success", CompletedAt: now.Add(-time.Minute), FreshnessWindow: time.Hour}}}, "degraded", services.StatusComponent{Status: "error", Detail: "latest canary run failed"}},
		{"stale", &publicStatusSource{runs: []services.CanaryRun{{Status: "success", CompletedAt: now.Add(-time.Hour - time.Nanosecond), FreshnessWindow: time.Hour}}}, "degraded", services.StatusComponent{Status: "unknown", Detail: "latest canary run is stale"}},
		{"missing", &publicStatusSource{}, "degraded", services.StatusComponent{Status: "unknown", Detail: "no recorded canary runs"}},
		{"missing suite", &publicStatusSource{runs: []services.CanaryRun{{}}}, "degraded", services.StatusComponent{Status: "unknown", Detail: "canary run missing"}},
		{"source error", &publicStatusSource{err: errors.New("secret connection string")}, "degraded", services.StatusComponent{Status: "unknown", Detail: "canary runs unavailable"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			(&StatusHandler{CanaryRuns: tc.source, Clock: func() time.Time { return now }}).Status(rec, httptest.NewRequest(http.MethodGet, "/api/status", nil))
			assert.Contains(t, rec.Header().Get("Content-Type"), "application/json")
			body := readPublicStatusBody(t, rec)
			assert.Equal(t, tc.wantStatus, body.Status)
			assert.Equal(t, now, body.CheckedAt)
			assert.Equal(t, tc.wantCanary, body.Components.Canary)
			assert.Equal(t, 1, tc.source.calls)
			assert.NotContains(t, rec.Body.String(), "secret connection string")
		})
	}
}

func TestPublicStatusHandlerCanceledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	source := &publicStatusSource{wait: true}
	req := httptest.NewRequest(http.MethodGet, "/api/status", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	(&StatusHandler{CanaryRuns: source}).Status(rec, req)
	body := readPublicStatusBody(t, rec)
	assert.ErrorIs(t, source.seen.Err(), context.Canceled)
	assert.Equal(t, "degraded", body.Status)
	assert.Equal(t, services.StatusComponent{Status: "unknown", Detail: "canary runs unavailable"}, body.Components.Canary)
	assert.NotContains(t, rec.Body.String(), "context canceled")
}

func TestPublicStatusHandlerWithoutSource(t *testing.T) {
	rec := httptest.NewRecorder()
	(&StatusHandler{}).Status(rec, httptest.NewRequest(http.MethodGet, "/api/status", nil))
	body := readPublicStatusBody(t, rec)
	assert.Equal(t, "degraded", body.Status)
	assert.Equal(t, services.StatusComponent{Status: "unknown", Detail: "no recorded canary runs"}, body.Components.Canary)
	assert.False(t, body.CheckedAt.IsZero())
}

func TestPublicStatusHandlerSamplesClockAfterFetch(t *testing.T) {
	start := time.Date(2026, time.September, 29, 12, 0, 0, 0, time.UTC)
	completed := start.Add(time.Second)
	checkedAt := completed.Add(time.Second)
	clock := start
	source := &publicStatusSource{read: func(context.Context) ([]services.CanaryRun, error) {
		clock = checkedAt
		return []services.CanaryRun{{Status: "success", CompletedAt: completed, FreshnessWindow: time.Minute}}, nil
	}}
	rec := httptest.NewRecorder()
	(&StatusHandler{CanaryRuns: source, Clock: func() time.Time { return clock }}).Status(rec, httptest.NewRequest(http.MethodGet, "/api/status", nil))
	body := readPublicStatusBody(t, rec)
	assert.Equal(t, 1, source.calls)
	assert.Equal(t, checkedAt, body.CheckedAt)
	assert.Equal(t, "ok", body.Status)
	assert.Equal(t, services.StatusComponent{Status: "ok", Detail: "latest canary runs passed"}, body.Components.Canary)
}

func TestPublicStatusHandlerSourceDeadline(t *testing.T) {
	started := time.Now()
	var deadline time.Time
	source := &publicStatusSource{read: func(ctx context.Context) ([]services.CanaryRun, error) {
		var ok bool
		deadline, ok = ctx.Deadline()
		require.True(t, ok)
		<-ctx.Done()
		return nil, ctx.Err()
	}}
	rec := httptest.NewRecorder()
	(&StatusHandler{CanaryRuns: source}).Status(rec, httptest.NewRequest(http.MethodGet, "/api/status", nil))
	body := readPublicStatusBody(t, rec)
	assert.WithinDuration(t, started.Add(5*time.Second), deadline, time.Second)
	assert.Equal(t, 1, source.calls)
	assert.Equal(t, "degraded", body.Status)
	assert.Equal(t, services.StatusComponent{Status: "unknown", Detail: "canary runs unavailable"}, body.Components.Canary)
}
