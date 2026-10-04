package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

type branchRouteFixture struct {
	mockWorkspaceRouteService
	branch string
}

func (*branchRouteFixture) ListBranches(context.Context, int64, int64, int, int) ([]services.BranchMachineResponse, int64, error) {
	return nil, 0, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "providers unavailable")
}
func (f *branchRouteFixture) GetBranch(_ context.Context, branch string, _ int64, _ int64) (services.BranchMachineResponse, error) {
	f.branch = branch
	return services.BranchMachineResponse{}, pkgerrors.Forbidden("removed member")
}

func TestBranchReadRoutesRemainDark(t *testing.T) {
	router := chi.NewRouter()
	RegisterBranchReadRoutes(router, &WorkspaceHandler{}, nil)
	for _, path := range []string{"/api/branches", "/api/branches/main"} {
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		require.Equal(t, 404, w.Code)
	}
}
func TestBranchReadRoutesRefuseUnavailableAuthority(t *testing.T) {
	router := chi.NewRouter()
	RegisterBranchReadRoutes(router, &WorkspaceHandler{Service: &branchRouteFixture{}, BranchRepositoryID: 101}, nil)
	for _, tc := range []struct {
		path   string
		user   bool
		status int
		body   string
	}{
		{"/api/branches", false, 401, `{"code":"unauthenticated","class":"permission","message":"Sign in"}`},
		{"/api/branches", true, 503, `{"code":"branch_machine_unavailable","class":"infra","message":"Branch unavailable"}`},
		{"/api/branches/main", true, 403, `{"code":"permission","class":"permission","message":"Access denied"}`},
	} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, tc.path, nil)
		if tc.user {
			r = r.WithContext(middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{User: &db.User{ID: 1}}))
		}
		router.ServeHTTP(w, r)
		require.Equal(t, tc.status, w.Code)
		require.JSONEq(t, tc.body, w.Body.String())
	}
}

func TestBranchReadDecodesBranchNameOnce(t *testing.T) {
	fixture := &branchRouteFixture{}
	router := chi.NewRouter()
	RegisterBranchReadRoutes(router, &WorkspaceHandler{Service: fixture, BranchRepositoryID: 101}, nil)
	request := httptest.NewRequest("GET", "/api/branches/scratch%2Falice%2Fshared", nil)
	request = request.WithContext(middleware.ContextWithAuthInfo(request.Context(), &middleware.AuthInfo{User: &db.User{ID: 1}}))
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	require.Equal(t, 403, response.Code)
	require.Equal(t, "scratch/alice/shared", fixture.branch)
}
