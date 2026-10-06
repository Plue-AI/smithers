package routes

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/stretchr/testify/require"
)

func TestBranchFileRefusesWithoutSourceAuthority(t *testing.T) {
	for _, tc := range []struct {
		name, path string
		signed     bool
		status     int
	}{
		{"anonymous", "JOURNEY.md", false, 401},
		{"no source", "JOURNEY.md", true, 503},
		{"escaped traversal", "%2e%2e/etc/passwd", true, 400},
		{"backslash traversal", "..%5Cetc%5Cpasswd", true, 400},
		{"digest", "JOURNEY.md?digest=sha256:abc", true, 503},
		{"empty digest", "JOURNEY.md?digest=", true, 503},
		{"comparison", "JOURNEY.md?compare=burst-before", true, 503},
		{"empty comparison", "JOURNEY.md?compare=", true, 503},
		{"revision does not override digest", "JOURNEY.md?at=main&digest=sha256:abc", true, 503},
		{"anonymous digest", "JOURNEY.md?digest=sha256:abc", false, 401},
	} {
		t.Run(tc.name, func(t *testing.T) {
			router := chi.NewRouter()
			router.Get("/api/branches/{b}/files/*", (&BranchFileHandler{}).Read)
			request := httptest.NewRequest(http.MethodGet, "/api/branches/main/files/"+tc.path, nil)
			if tc.signed {
				request = request.WithContext(middleware.ContextWithAuthInfo(request.Context(), &middleware.AuthInfo{User: &db.User{ID: 1}}))
			}
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			require.Equal(t, tc.status, response.Code)
			require.NotContains(t, response.Body.String(), "Add a greeting")
			if tc.signed && (tc.name == "digest" || tc.name == "comparison") {
				require.Contains(t, response.Body.String(), `"code":"service_unavailable"`)
			}
		})
	}
}
