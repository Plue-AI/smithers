package compose

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
)

func repoTransfersTestRouter(service *mockRouterRepoService) http.Handler {
	return buildRouterCompat(
		testConfigAllFlagsOn(), nil, nil,
		&routes.RepoHandler{Service: service, SSHHost: "smithers.test"},
		&routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{},
		&routes.OrgHandler{}, &routes.LandingHandler{},
		&routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{},
		nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
	)
}

func TestServerRouter_RepoTransferRequestsAreAccountScoped(t *testing.T) {
	var listed, accepted, declined, cancelled int
	service := &mockRouterRepoService{
		listTransfersFn: func(_ context.Context, actor *db.User) ([]db.RepositoryTransferRequest, error) {
			listed++
			require.Equal(t, int64(1), actor.ID)
			return []db.RepositoryTransferRequest{{ID: 17, RepositoryID: 90, RecipientID: 1, SourceOwner: "alice", SourceName: "private", Status: "pending"}}, nil
		},
		acceptTransferFn: func(_ context.Context, actor *db.User, id int64) (db.Repository, error) {
			accepted++
			require.Equal(t, int64(1), actor.ID)
			require.Equal(t, int64(17), id)
			return db.Repository{ID: 90, Name: "private", LowerName: "private"}, nil
		},
		declineTransferFn: func(_ context.Context, _ *db.User, id int64) error {
			declined++
			require.Equal(t, int64(17), id)
			return nil
		},
		cancelTransferFn: func(_ context.Context, _ *db.User, id int64) error {
			cancelled++
			require.Equal(t, int64(17), id)
			return nil
		},
	}
	router := repoTransfersTestRouter(service)
	for _, tc := range []struct {
		method, path string
		scope        middleware.TokenScope
		status       int
	}{
		{http.MethodGet, "/api/user/repository-transfers", middleware.ScopeReadRepository, http.StatusOK},
		{http.MethodPost, "/api/user/repository-transfers/17/accept", middleware.ScopeWriteRepository, http.StatusOK},
		{http.MethodPost, "/api/user/repository-transfers/17/decline", middleware.ScopeWriteRepository, http.StatusNoContent},
		{http.MethodPost, "/api/user/repository-transfers/17/cancel", middleware.ScopeWriteRepository, http.StatusNoContent},
	} {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			unauth := httptest.NewRecorder()
			router.ServeHTTP(unauth, httptest.NewRequest(tc.method, tc.path, nil))
			require.Equal(t, http.StatusUnauthorized, unauth.Code)
			wrongScope := middleware.ScopeReadUser
			if tc.method == http.MethodPost {
				wrongScope = middleware.ScopeReadRepository
			}
			denied := httptest.NewRecorder()
			router.ServeHTTP(denied, withRouterTokenAuth(httptest.NewRequest(tc.method, tc.path, nil), wrongScope))
			require.Equal(t, http.StatusForbidden, denied.Code)
			bound := withRouterTokenAuth(httptest.NewRequest(tc.method, tc.path, nil), tc.scope)
			middleware.AuthInfoFromContext(bound.Context()).RawScopes = string(tc.scope) + "," + middleware.RepositoryRestrictionScope(90)
			blocked := httptest.NewRecorder()
			router.ServeHTTP(blocked, bound)
			require.Equal(t, http.StatusForbidden, blocked.Code)
			allowed := httptest.NewRecorder()
			router.ServeHTTP(allowed, withRouterTokenAuth(httptest.NewRequest(tc.method, tc.path, nil), tc.scope))
			require.Equal(t, tc.status, allowed.Code, allowed.Body.String())
		})
	}
	require.Equal(t, 1, listed)
	require.Equal(t, 1, accepted)
	require.Equal(t, 1, declined)
	require.Equal(t, 1, cancelled)
}
