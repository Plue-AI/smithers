package routes

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

func TestGitHubProxyMachineMutationBeforeToken(t *testing.T) {
	for _, method := range []string{"POST", "PUT", "PATCH", "DELETE", " patch "} {
		t.Run(method, func(t *testing.T) {
			calls := 0
			upstream := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { calls++ }))
			defer upstream.Close()
			t.Setenv("SMITHERS_GITHUB_APP_API_BASE_URL", upstream.URL)
			tokens := &mockGitHubProxyTokenIssuer{}
			h := GitHubProxyHandler{Service: services.NewGitHubProxyService(tokens)}
			req := httptest.NewRequest("POST", "/api/repos/acme/demo/github-proxy", bytes.NewBufferString(`{"method":"`+method+`","path":"/repos/acme/demo/pulls/1","body":{"state":"closed"}}`))
			req.Header.Set("Content-Type", "application/json")
			req = withRouteParams(req, map[string]string{"owner": "acme", "repo": "demo"})
			ctx := middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{User: &db.User{ID: 77, Username: "alice"}, IsTokenAuth: true, TokenSystemIssued: true})
			req = req.WithContext(ctx)
			rec := httptest.NewRecorder()
			h.PostRepoGitHubProxy(rec, req)
			require.Equal(t, http.StatusForbidden, rec.Code)
			require.Contains(t, rec.Body.String(), services.GitHubProxyForbiddenActionCode)
			require.Empty(t, tokens.calls)
			require.Zero(t, calls)
		})
	}
}
