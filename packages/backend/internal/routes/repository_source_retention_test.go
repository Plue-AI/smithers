package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type retentionRouteStub struct {
	calls          int
	repoID, userID int64
}

func (s *retentionRouteStub) Retain(_ context.Context, repoID, userID int64, input services.RepositorySourceRetentionInput) (services.RepositorySourceRetentionResult, error) {
	s.calls++
	s.repoID, s.userID = repoID, userID
	return services.RepositorySourceRetentionResult{Status: "retained", WorkspaceID: input.WorkspaceID, Source: "github", FullName: "original/source"}, nil
}

func TestSourceRetentionRouteStrictInputAndAuthenticatedScope(t *testing.T) {
	service := &retentionRouteStub{}
	h := &RepositoryJobHandler{RepositoryJobs: repositoryJobRoutesStub{}, SourceRetention: service}
	request := func(body string) *http.Request {
		r := httptest.NewRequest(http.MethodPost, "/api/repos/owner/repo/repository-source/retain", strings.NewReader(body))
		ctx := middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{User: &db.User{ID: 9}})
		ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{Repository: &db.Repository{ID: 7}}, middleware.PermissionWrite)
		return r.WithContext(ctx)
	}
	for _, body := range []string{`{"token":"forged"}`, `{"repo_id":99}`, `{"user_id":99}`, `{"clone_url":"https://other.test"}`, `{} {}`, strings.Repeat("x", 4097)} {
		r := httptest.NewRecorder()
		h.RetainRepositorySource(r, request(body))
		require.Equal(t, 400, r.Code)
	}
	require.Zero(t, service.calls)
	r := httptest.NewRecorder()
	h.RetainRepositorySource(r, httptest.NewRequest(http.MethodPost, "/retain", nil))
	require.Equal(t, 401, r.Code)
	r = httptest.NewRecorder()
	h.RetainRepositorySource(r, request(`{"workspace_id":"chosen","kind":"pull_request","number":17}`))
	require.Equal(t, 200, r.Code)
	require.Equal(t, "no-store", r.Header().Get("Cache-Control"))
	require.Equal(t, int64(7), service.repoID)
	require.Equal(t, int64(9), service.userID)
	require.Equal(t, 1, service.calls)
}
