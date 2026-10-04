package compose

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestInstallScorecardUnqualifiedProductionRouter(t *testing.T) {
	router := defaultRouter(nil)
	for _, token := range []string{"", "Bearer member", "Bearer delegated", "Bearer machine", "Bearer run"} {
		req := httptest.NewRequest(http.MethodGet, "/api/install/scorecard?from=2026-10-04T06:30:00Z&to=2026-10-18T06:30:00Z", nil)
		if token != "" {
			req.Header.Set("Authorization", token)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		status := 401 // Invalid presented credentials are refused by the shared loader.
		if token == "" {
			status = 404
		}
		require.Equal(t, status, w.Code, token)
	}
}
