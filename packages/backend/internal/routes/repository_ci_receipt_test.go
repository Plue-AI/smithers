package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type repositoryCheckReceiptStub struct {
	RepositoryJobRouteService
	receipt func(context.Context, string, string, string, services.RepositoryCheckReceiptInput) (services.RepositoryCheckReceiptResponse, bool, error)
}

func (s repositoryCheckReceiptStub) CreateCheckReceipt(ctx context.Context, id, bearer, requestID string, input services.RepositoryCheckReceiptInput) (services.RepositoryCheckReceiptResponse, bool, error) {
	return s.receipt(ctx, id, bearer, requestID, input)
}

func TestRepositoryCheckReceiptRoute(t *testing.T) {
	t.Parallel()
	const body = `{"repo":"owner/repo","workspace_id":"w","registration_id":"r","revision":1,"digest":"d","execution_digest":"e","run_id":"run-1","execution_id":"exec-1","commit_id":"c","change_id":"ch","base_commit_id":"b","checks":[{"id":"unit","outcome":"passed"}],"gate":"passed"}`
	created := true
	calls := 0
	h := &RepositoryJobHandler{RepositoryJobs: repositoryCheckReceiptStub{receipt: func(_ context.Context, id, bearer, requestID string, input services.RepositoryCheckReceiptInput) (services.RepositoryCheckReceiptResponse, bool, error) {
		calls++
		require.Equal(t, "gateway", id)
		require.Equal(t, "host-token", bearer)
		require.Equal(t, "receipt-request", requestID)
		require.Equal(t, "owner/repo", input.Repo)
		require.Equal(t, []services.RepositoryCheckOutcome{{ID: "unit", Outcome: "passed"}}, input.Checks)
		return services.RepositoryCheckReceiptResponse{RequestID: requestID, Context: "repository-ci/r@1.d", CommitID: "c", Status: "success", StatusID: 4}, created, nil
	}}}
	r := chi.NewRouter()
	r.Put("/gateways/{hostID}/repository-jobs/ci/check-receipts/{requestID}", h.PutRepositoryCheckReceipt)
	put := func(payload string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPut, "/gateways/gateway/repository-jobs/ci/check-receipts/receipt-request", strings.NewReader(payload))
		request.Header.Set("Authorization", "Bearer host-token")
		response := httptest.NewRecorder()
		r.ServeHTTP(response, request)
		return response
	}

	response := put(body)
	require.Equal(t, http.StatusCreated, response.Code)
	require.Contains(t, response.Body.String(), `"status_id":4`)
	require.Equal(t, "no-store", response.Header().Get("Cache-Control"))

	created = false
	require.Equal(t, http.StatusOK, put(body).Code)
	require.Equal(t, 2, calls)

	for _, malformed := range []string{`{"check_ids":["unit"]}`, `{} {}`, `{`, strings.Repeat("a", (1<<20)+1)} {
		require.Equal(t, http.StatusBadRequest, put(malformed).Code, malformed)
	}
	require.Equal(t, 2, calls)

	empty := &RepositoryJobHandler{}
	response = httptest.NewRecorder()
	empty.PutRepositoryCheckReceipt(response, httptest.NewRequest(http.MethodPut, "/receipt", strings.NewReader(body)))
	require.Equal(t, http.StatusServiceUnavailable, response.Code)

	h.RepositoryJobs = repositoryCheckReceiptStub{receipt: func(context.Context, string, string, string, services.RepositoryCheckReceiptInput) (services.RepositoryCheckReceiptResponse, bool, error) {
		return services.RepositoryCheckReceiptResponse{}, false, pkgerrors.New(pkgerrors.CodeRepositoryCIRunUnverified, "no retained run")
	}}
	response = put(body)
	require.Equal(t, http.StatusForbidden, response.Code)
	require.Contains(t, response.Body.String(), `"code":"repository_ci_run_unverified"`)
}
