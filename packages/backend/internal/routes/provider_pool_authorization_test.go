package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/stretchr/testify/require"
)

type countingPoolScopes struct{ calls int }

func (s *countingPoolScopes) Scope(ctx context.Context, bearer string) (int64, int64, bool) {
	s.calls++
	return fakeScopes{ok: true}.Scope(ctx, bearer)
}

func TestProviderPoolDecisionCannotBeSubstituted(t *testing.T) {
	for _, change := range []string{"unchanged", "bearer", "credential", "method", "path", "handler"} {
		t.Run(change, func(t *testing.T) {
			scopes := &countingPoolScopes{}
			h := &ProviderPoolHandler{Pool: &fakePool{}, Scopes: scopes}
			request := httptest.NewRequest(http.MethodGet, "/provider-pool/routes", nil).WithContext(workspaceContext())
			request.Header.Set("Authorization", "Bearer smithers_pooltoken")
			response := httptest.NewRecorder()
			h.Authorize(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				target := h
				switch change {
				case "bearer":
					r.Header.Set("Authorization", "Bearer another")
				case "credential":
					r = r.WithContext(middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{User: &db.User{ID: 8}, IsTokenAuth: true}))
				case "method":
					r.Method = http.MethodPost
				case "path":
					r.URL.Path = "/provider-pool/another"
				case "handler":
					target = &ProviderPoolHandler{Pool: h.Pool, Scopes: scopes}
				}
				target.serveRoutes(w, r)
			})).ServeHTTP(response, request)
			require.Equal(t, 1, scopes.calls, "one scoped decision, including refused substitutions")
			if change == "unchanged" {
				require.Equal(t, http.StatusOK, response.Code)
				require.JSONEq(t, `{"routes":[]}`, response.Body.String())
			} else {
				require.Equal(t, http.StatusForbidden, response.Code)
				require.Contains(t, response.Body.String(), `"permission"`)
			}
		})
	}
}
