package routes

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
	"net/http/httptest"
	"testing"
	"time"
)

type syncRouteFixture struct {
	reads, retries int
	err            error
}

func (f *syncRouteFixture) SyncHealth(context.Context) (services.GitHubSyncHealth, error) {
	f.reads++
	at := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	return services.GitHubSyncHealth{State: "fresh", LastSuccessAt: &at}, f.err
}
func (f *syncRouteFixture) RetrySync(context.Context) error { f.retries++; return f.err }

func TestGitHubSyncDarkRoutesRefuseBeforeEffects(t *testing.T) {
	h := &GitHubSyncHandler{}
	for _, method := range []string{"GET", "POST"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(method, "/api/github/sync", nil)
		if method == "GET" {
			h.Status(rec, req)
		} else {
			h.Retry(rec, req)
		}
		require.Equal(t, 503, rec.Code)
		require.JSONEq(t, `{"code":"github_sync_unavailable","class":"infra","message":"GitHub sync is unavailable"}`, rec.Body.String())
	}
}
func TestGitHubSyncStatusReadsOnlyRetryAdmitsOnce(t *testing.T) {
	f := &syncRouteFixture{}
	h := &GitHubSyncHandler{Service: f}
	rec := httptest.NewRecorder()
	h.Status(rec, httptest.NewRequest("GET", "/api/github/sync", nil))
	require.Equal(t, 200, rec.Code)
	require.Equal(t, 1, f.reads)
	require.Zero(t, f.retries)
	var health map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &health))
	require.Len(t, health, 2)
	require.Equal(t, "fresh", health["state"])
	rec = httptest.NewRecorder()
	h.Retry(rec, httptest.NewRequest("POST", "/api/github/sync", nil))
	require.Equal(t, 202, rec.Code)
	require.JSONEq(t, `{"state":"accepted"}`, rec.Body.String())
	require.Equal(t, 1, f.retries)
	require.Equal(t, 1, f.reads)
}
func TestGitHubSyncRouteErrors(t *testing.T) {
	for _, err := range []error{&services.GitHubSyncUnavailable{Code: "github_sync_unavailable", Class: "infra", Message: "GitHub sync is unavailable"}, errors.New("unavailable")} {
		h := &GitHubSyncHandler{Service: &syncRouteFixture{err: err}}
		for _, method := range []string{"GET", "POST"} {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(method, "/api/github/sync", nil)
			if method == "GET" {
				h.Status(rec, req)
			} else {
				h.Retry(rec, req)
			}
			require.GreaterOrEqual(t, rec.Code, 500)
		}
	}
}
