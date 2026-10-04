package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

type scorecardBoundaryService struct{ calls int }

func (s *scorecardBoundaryService) Summary(_ context.Context, from, to time.Time) (services.Scorecard, error) {
	s.calls++
	return services.Scorecard{Window: services.ScorecardWindow{From: from.UTC(), To: to.UTC()}, PersonMinutes: services.ScorecardPersonMinutes{Source: "sampled_alpha_sessions", Verdict: "manual"}}, nil
}

func TestInstallScorecardBoundary(t *testing.T) {
	service := &scorecardBoundaryService{}
	h := &InstallScorecardHandler{Service: service}
	request := func(path string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		h.Summary(w, httptest.NewRequest(http.MethodGet, path, nil))
		return w
	}
	require.Equal(t, 404, request("/api/install/scorecard").Code)
	require.Zero(t, service.calls)
	h.Authorize = func(*http.Request) error { return pkgerrors.Forbidden("owner person session required") }
	require.Equal(t, 403, request("/api/install/scorecard?from=invalid").Code)
	require.Zero(t, service.calls)
	h.Authorize = func(*http.Request) error { return nil }
	for _, path := range []string{
		"/api/install/scorecard",
		"/api/install/scorecard?from=x&to=y",
		"/api/install/scorecard?from=2026-10-04T06:30:00Z&to=2026-10-04T06:30:00Z",
		"/api/install/scorecard?from=2026-10-04T06:30:00Z&from=2026-10-04T06:30:00Z&to=2026-10-05T06:30:00Z",
	} {
		require.Equal(t, 400, request(path).Code, path)
	}
	require.Zero(t, service.calls)
	w := request("/api/install/scorecard?from=2026-10-03T23:30:00-07:00&to=2026-10-17T23:30:00-07:00")
	require.Equal(t, 200, w.Code)
	require.Equal(t, "no-store", w.Header().Get("Cache-Control"))
	require.JSONEq(t, `{"window":{"from":"2026-10-04T06:30:00Z","to":"2026-10-18T06:30:00Z"},"measures":null,"person_minutes":{"source":"sampled_alpha_sessions","verdict":"manual"}}`, w.Body.String())
	require.Equal(t, 1, service.calls)
}
