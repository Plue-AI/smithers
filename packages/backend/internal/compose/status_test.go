package compose

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type routerCanarySource struct{ runs []services.CanaryRun }

func (s routerCanarySource) LatestCanaryRuns(context.Context) ([]services.CanaryRun, error) {
	return s.runs, nil
}

func TestPublicStatusRouteIsAnonymous(t *testing.T) {
	// A recent completed run distinguishes the mounted status handler from a
	// generic fallback while exercising the public router without auth state.
	source := routerCanarySource{runs: []services.CanaryRun{{
		Status: "success", CompletedAt: time.Now().Add(-time.Minute), FreshnessWindow: time.Hour,
	}}}
	router := routerWithExtras(routerExtras{CanaryRuns: source})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/status", nil))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var body struct {
		Status     string    `json:"status"`
		CheckedAt  time.Time `json:"checked_at"`
		Components struct {
			Canary struct {
				Status string `json:"status"`
				Detail string `json:"detail"`
			} `json:"canary"`
		} `json:"components"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, "ok", body.Status)
	assert.Equal(t, "ok", body.Components.Canary.Status)
	assert.NotEmpty(t, body.Components.Canary.Detail)
	assert.False(t, body.CheckedAt.IsZero())
}
