package middleware

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestPerWorkspaceDesktopControl_BucketsByWorkspace pins the two properties
// the desktop control routes depend on: 1800 requests an hour is the budget,
// and the budget is scoped to a caller and box, not the repository — two boxes
// in one repository must not starve each other.
func TestPerWorkspaceDesktopControl_BucketsByWorkspace(t *testing.T) {
	t.Parallel()

	clock := NewFakeClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	store := NewTokenBucketStoreWithClock(clock)
	handler := quotaTestRouter(
		PerWorkspaceDesktopControl(store),
		http.MethodPost,
		"/api/repos/{owner}/{repo}/workspaces/{id}/desktop/observe",
	)
	const busy = "/api/repos/alice/demo/workspaces/ws-1/desktop/observe"

	drainQuota(t, handler, http.MethodPost, busy, 1800)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, busy, nil)
	req.RemoteAddr = "10.0.0.1:1"
	handler.ServeHTTP(rec, req)
	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	var body map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "rate_limit_exceeded", body["code"])
	assert.NotEmpty(t, rec.Header().Get("Retry-After"))

	// A second box in the same repository still has its full budget.
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost,
		"/api/repos/alice/demo/workspaces/ws-2/desktop/observe", nil))
	assert.Equal(t, http.StatusNoContent, rec.Code)

	// The bucket refills over its window.
	clock.Advance(time.Hour)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, busy, nil))
	assert.Equal(t, http.StatusNoContent, rec.Code)
}

func TestPerWorkspaceDesktopControl_WithoutAStoreIsAPassThrough(t *testing.T) {
	t.Parallel()

	handler := quotaTestRouter(
		PerWorkspaceDesktopControl(nil),
		http.MethodPost,
		"/api/repos/{owner}/{repo}/workspaces/{id}/desktop/input",
	)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost,
		"/api/repos/alice/demo/workspaces/ws-1/desktop/input", nil))
	assert.Equal(t, http.StatusNoContent, rec.Code)
}
