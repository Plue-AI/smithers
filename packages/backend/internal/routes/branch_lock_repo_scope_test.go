package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestBranchLockDecide_ForwardsRoutedRepository(t *testing.T) {
	var got services.DecideBranchLockJoinInput
	handler := &BranchLockHandler{Service: mockBranchLockRouteService{
		decideFn: func(ctx context.Context, input services.DecideBranchLockJoinInput) (services.BranchLockJoinRequestResponse, error) {
			got = input
			return services.BranchLockJoinRequestResponse{ID: input.JoinRequestID, Status: "approved"}, nil
		},
	}}
	req := branchLockAuthedRequest(http.MethodPost, "/api/repos/alice/app/branch-locks/join-requests/42/decide", `{"decision":"approve"}`)
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("id", "42")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))
	rec := httptest.NewRecorder()
	handler.DecideBranchLockJoin(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, int64(42), got.JoinRequestID)
	require.Equal(t, int64(1), got.RepositoryID, "decision input must carry the routed repository")
}
