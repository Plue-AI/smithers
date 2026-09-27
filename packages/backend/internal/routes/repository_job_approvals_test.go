package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type repositoryJobApprovalRouteStub struct {
	RepositoryJobRouteService
	record func(context.Context, int64, int64, string, services.RepositoryJobApprovalInput) (services.RepositoryJobApproval, error)
	list   func(context.Context, int64, int64, string) ([]services.RepositoryJobApproval, error)
}

func (s repositoryJobApprovalRouteStub) RecordApproval(ctx context.Context, repoID, userID int64, job string, input services.RepositoryJobApprovalInput) (services.RepositoryJobApproval, error) {
	return s.record(ctx, repoID, userID, job, input)
}

func (s repositoryJobApprovalRouteStub) Approvals(ctx context.Context, repoID, userID int64, job string) ([]services.RepositoryJobApproval, error) {
	return s.list(ctx, repoID, userID, job)
}

func TestRepositoryJobApprovalRoutesUseAuthenticatedRepositoryScope(t *testing.T) {
	t.Parallel()
	calls := 0
	h := &RepositoryJobHandler{RepositoryJobs: repositoryJobApprovalRouteStub{
		record: func(_ context.Context, repoID, userID int64, job string, input services.RepositoryJobApprovalInput) (services.RepositoryJobApproval, error) {
			calls++
			require.Equal(t, int64(42), repoID)
			require.Equal(t, int64(9), userID)
			require.Equal(t, "flow:nightly-lint", job)
			require.Equal(t, "plan-01", input.PlanID)
			return services.RepositoryJobApproval{Job: job, PlanID: input.PlanID, PlanDigest: input.PlanDigest, FlowID: input.FlowID, ApprovedBy: userID}, nil
		},
		list: func(_ context.Context, repoID, userID int64, job string) ([]services.RepositoryJobApproval, error) {
			calls++
			require.Equal(t, int64(42), repoID)
			require.Equal(t, int64(9), userID)
			require.Equal(t, "flow:nightly-lint", job)
			return []services.RepositoryJobApproval{{Job: job, PlanID: "plan-01", PlanDigest: strings.Repeat("d", 64), FlowID: "nightly-lint", ApprovedBy: userID}}, nil
		},
	}}
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := context.WithValue(r.Context(), middleware.UserContextKey, &db.User{ID: 9, Username: "owner"})
			ctx = middleware.ContextWithRepoContext(ctx, &middleware.RepoContext{Repository: &db.Repository{ID: 42, Name: "repo"}}, middleware.PermissionWrite)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	})
	router.Post("/repository-jobs/{job}/approvals", h.PostRepositoryJobApproval)
	router.Get("/repository-jobs/{job}/approvals", h.GetRepositoryJobApprovals)

	body := `{"plan_id":"plan-01","plan_digest":"` + strings.Repeat("d", 64) + `","flow_id":"nightly-lint","envelope":{"capabilities":["read"],"flows":["nightly-lint"],"budget":{"tokens":10,"milliseconds":20}}}`
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/repository-jobs/flow:nightly-lint/approvals", strings.NewReader(body)))
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.Contains(t, response.Body.String(), `"approved_by":9`)
	require.NotContains(t, response.Body.String(), "capabilities", "approval response must not disclose the execution envelope")

	response = httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/repository-jobs/flow:nightly-lint/approvals", nil))
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.Contains(t, response.Body.String(), `"plan_id":"plan-01"`)
	require.Equal(t, 2, calls)

	response = httptest.NewRecorder()
	malformed := strings.TrimSuffix(body, "}") + `,"approved_by":123}`
	router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/repository-jobs/flow:nightly-lint/approvals", strings.NewReader(malformed)))
	require.Equal(t, http.StatusBadRequest, response.Code)
	require.Equal(t, 2, calls, "wire provenance must be rejected before reaching the service")
}
