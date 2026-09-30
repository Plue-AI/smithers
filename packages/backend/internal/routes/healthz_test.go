package routes_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
)

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type healthyDB struct{}

func (d *healthyDB) Ping(_ context.Context) error { return nil }

type unhealthyDB struct{ err error }

func (d *unhealthyDB) Ping(_ context.Context) error { return d.err }

// ---------------------------------------------------------------------------
// HealthzHandler tests
// ---------------------------------------------------------------------------

func TestHealthz_ReturnsOKWhenAllDependenciesHealthy(t *testing.T) {
	t.Parallel()

	h := routes.NewHealthzHandler(&healthyDB{}, "")
	// Override httpCheck to skip real network call.
	h.SetHTTPCheck(func(url string) error { return nil })

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	h.Healthz(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Header().Get("Content-Type"), "application/json")

	var body struct {
		Status string            `json:"status"`
		Checks map[string]string `json:"checks"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "ok", body.Status)
	assert.Equal(t, "ok", body.Checks["database"])
}

func TestHealthz_Returns503WhenDatabaseUnhealthy(t *testing.T) {
	t.Parallel()

	h := routes.NewHealthzHandler(&unhealthyDB{err: errors.New("connection refused")}, "")
	h.SetHTTPCheck(func(url string) error { return nil })

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	h.Healthz(rec, req)

	assert.Equal(t, http.StatusServiceUnavailable, rec.Code)

	var body struct {
		Status string            `json:"status"`
		Checks map[string]string `json:"checks"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "unhealthy", body.Status)
	assert.Equal(t, "error", body.Checks["database"])
}

func TestHealthz_Returns503WhenRepoHostUnhealthy(t *testing.T) {
	t.Parallel()

	h := routes.NewHealthzHandler(&healthyDB{}, "http://repo-host:8080")
	h.SetHTTPCheck(func(url string) error { return errors.New("connection refused") })

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	h.Healthz(rec, req)

	assert.Equal(t, http.StatusServiceUnavailable, rec.Code)

	var body struct {
		Status string            `json:"status"`
		Checks map[string]string `json:"checks"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "unhealthy", body.Status)
	assert.Equal(t, "error", body.Checks["repo_host"])
}

func TestHealthz_Returns503WhenRepoHostReturns5xx(t *testing.T) {
	t.Parallel()

	repoHost := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(repoHost.Close)

	h := routes.NewHealthzHandler(&healthyDB{}, repoHost.URL)

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	h.Healthz(rec, req)

	assert.Equal(t, http.StatusServiceUnavailable, rec.Code)

	var body struct {
		Status string            `json:"status"`
		Checks map[string]string `json:"checks"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "unhealthy", body.Status)
	assert.Equal(t, "error", body.Checks["repo_host"])
}

func TestHealthz_DoesNotRequireAuthentication(t *testing.T) {
	t.Parallel()

	// Healthz must be accessible without auth headers (used by K8s liveness probes).
	h := routes.NewHealthzHandler(&healthyDB{}, "")
	h.SetHTTPCheck(func(url string) error { return nil })

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	// No Authorization header.
	rec := httptest.NewRecorder()
	h.Healthz(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
}

func TestHealthz_ResponseBodyHasExpectedShape(t *testing.T) {
	t.Parallel()

	h := routes.NewHealthzHandler(&healthyDB{}, "http://repo-host:8080")
	h.SetHTTPCheck(func(url string) error { return nil })

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	h.Healthz(rec, req)

	var body map[string]interface{}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Contains(t, body, "status", "response must contain 'status' field")
	assert.Contains(t, body, "checks", "response must contain 'checks' field")
}

// ---------------------------------------------------------------------------
// ReadyzHandler tests
// ---------------------------------------------------------------------------

func TestReadyz_ReturnsReadyWhenAllDependenciesHealthy(t *testing.T) {
	t.Parallel()

	h := routes.NewReadyzHandler(&healthyDB{}, "")
	h.SetHTTPCheck(func(url string) error { return nil })

	req := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	rec := httptest.NewRecorder()
	h.Readyz(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Header().Get("Content-Type"), "application/json")

	var body struct {
		Status string            `json:"status"`
		Checks map[string]string `json:"checks"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "ready", body.Status)
	assert.Equal(t, "ok", body.Checks["database"])
}

func TestReadyz_Returns503WhenDatabaseUnhealthy(t *testing.T) {
	t.Parallel()

	h := routes.NewReadyzHandler(&unhealthyDB{err: errors.New("timeout")}, "")
	h.SetHTTPCheck(func(url string) error { return nil })

	req := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	rec := httptest.NewRecorder()
	h.Readyz(rec, req)

	assert.Equal(t, http.StatusServiceUnavailable, rec.Code)

	var body struct {
		Status string            `json:"status"`
		Checks map[string]string `json:"checks"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "not_ready", body.Status)
	assert.Equal(t, "error", body.Checks["database"])
}

func TestReadyz_Returns503WhenRepoHostReturns5xx(t *testing.T) {
	t.Parallel()

	repoHost := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(repoHost.Close)

	h := routes.NewReadyzHandler(&healthyDB{}, repoHost.URL)

	req := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	rec := httptest.NewRecorder()
	h.Readyz(rec, req)

	assert.Equal(t, http.StatusServiceUnavailable, rec.Code)

	var body struct {
		Status string            `json:"status"`
		Checks map[string]string `json:"checks"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "not_ready", body.Status)
	assert.Equal(t, "error", body.Checks["repo_host"])
}

func TestReadyz_StorageCheckNamesTheCause(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name       string
		err        error
		wantCode   int
		wantStatus string
		wantCheck  string
	}{
		{"ok", nil, http.StatusOK, "ready", "ok"},
		{"full", fmt.Errorf("reserve: %w", blob.ErrStorageFull), http.StatusServiceUnavailable, "not_ready", "full"},
		{"statfs failure", errors.New("statfs: permission denied"), http.StatusServiceUnavailable, "not_ready", "error"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			h := routes.NewReadyzHandler(&healthyDB{}, "")
			h.SetHTTPCheck(func(string) error { return nil })
			h.SetStorageCheck(func() error { return tc.err })

			rec := httptest.NewRecorder()
			h.Readyz(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))

			assert.Equal(t, tc.wantCode, rec.Code)
			var body struct {
				Status string            `json:"status"`
				Checks map[string]string `json:"checks"`
			}
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
			assert.Equal(t, tc.wantStatus, body.Status)
			assert.Equal(t, tc.wantCheck, body.Checks["storage"])
			assert.Equal(t, "ok", body.Checks["database"])
		})
	}

	// Without a storage check the response has no storage entry.
	h := routes.NewReadyzHandler(&healthyDB{}, "")
	h.SetHTTPCheck(func(string) error { return nil })
	rec := httptest.NewRecorder()
	h.Readyz(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	var body struct {
		Checks map[string]string `json:"checks"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.NotContains(t, body.Checks, "storage")
}

func TestReadyz_DoesNotRequireAuthentication(t *testing.T) {
	t.Parallel()

	h := routes.NewReadyzHandler(&healthyDB{}, "")
	h.SetHTTPCheck(func(url string) error { return nil })

	req := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	rec := httptest.NewRecorder()
	h.Readyz(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
}

func TestReadyz_StatusIsReadyNotOk(t *testing.T) {
	t.Parallel()

	// Readyz uses "ready"/"not_ready" (not "ok"/"unhealthy" which healthz uses).
	h := routes.NewReadyzHandler(&healthyDB{}, "")
	h.SetHTTPCheck(func(url string) error { return nil })

	req := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	rec := httptest.NewRecorder()
	h.Readyz(rec, req)

	var body struct {
		Status string `json:"status"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	// Readyz uses "ready" (not "ok") to distinguish from /healthz semantics.
	assert.Equal(t, "ready", body.Status)
}
