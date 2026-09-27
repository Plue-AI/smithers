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
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type repositoryJobRoutesStub struct {
	RepositoryJobRouteService
	register func(context.Context, string, string, string, services.RegisterRepositoryJobInput) (db.RegisterRepositoryJobRow, error)
	trial    func(context.Context, string, string, string, string, services.RepositoryJobTrialInput) (services.RepositoryJobTrialResult, error)
	comment  func(context.Context, string, string, string, string, services.RepositoryJobCommentInput) (services.RepositoryJobCommentResult, error)
	manual   func(context.Context, string, string, string, string, services.RepositoryJobManualInput) (services.RepositoryJobManualResult, error)
}

func (s repositoryJobRoutesStub) Register(ctx context.Context, id, bearer, job string, input services.RegisterRepositoryJobInput) (db.RegisterRepositoryJobRow, error) {
	return s.register(ctx, id, bearer, job, input)
}
func (s repositoryJobRoutesStub) CreateTrial(ctx context.Context, id, bearer, job, requestID string, input services.RepositoryJobTrialInput) (services.RepositoryJobTrialResult, error) {
	return s.trial(ctx, id, bearer, job, requestID, input)
}

func (s repositoryJobRoutesStub) CreateComment(ctx context.Context, id, bearer, job, step string, input services.RepositoryJobCommentInput) (services.RepositoryJobCommentResult, error) {
	return s.comment(ctx, id, bearer, job, step, input)
}

func (s repositoryJobRoutesStub) RunManual(ctx context.Context, id, bearer, job, requestID string, input services.RepositoryJobManualInput) (services.RepositoryJobManualResult, error) {
	return s.manual(ctx, id, bearer, job, requestID, input)
}

func TestRepositoryJobRoutes(t *testing.T) {
	t.Parallel()
	called := 0
	h := &RepositoryJobHandler{RepositoryJobs: repositoryJobRoutesStub{register: func(_ context.Context, id, bearer, job string, input services.RegisterRepositoryJobInput) (db.RegisterRepositoryJobRow, error) {
		called++
		require.Equal(t, "gateway", id)
		require.Equal(t, "host-token", bearer)
		require.Equal(t, "issues", job)
		require.Equal(t, "owner/repo", input.Repo)
		return db.RegisterRepositoryJobRow{ID: "registration", Revision: 2, Mode: "trial", Enabled: true}, nil
	}, trial: func(_ context.Context, id, bearer, job, requestID string, input services.RepositoryJobTrialInput) (services.RepositoryJobTrialResult, error) {
		called++
		require.Equal(t, "setup-request", requestID)
		require.Equal(t, "host-token", bearer)
		require.Equal(t, "trial", input.Title)
		return services.RepositoryJobTrialResult{RequestID: requestID, Number: 7, Source: "smithers-cloud"}, nil
	}, comment: func(_ context.Context, id, bearer, job, step string, input services.RepositoryJobCommentInput) (services.RepositoryJobCommentResult, error) {
		called++
		require.Equal(t, "host-token", bearer)
		require.Equal(t, "research:question", step)
		require.Equal(t, "native:event", input.DeliveryKey)
		return services.RepositoryJobCommentResult{CommentID: 9, Source: "smithers-cloud", Step: step}, nil
	}, manual: func(_ context.Context, id, bearer, job, requestID string, input services.RepositoryJobManualInput) (services.RepositoryJobManualResult, error) {
		called++
		require.Equal(t, "host-token", bearer)
		require.Equal(t, "manual-request", requestID)
		require.Equal(t, "poc", input.StepID)
		return services.RepositoryJobManualResult{DispatchID: "dispatch", Status: "queued"}, nil
	}}}
	r := chi.NewRouter()
	r.Put("/gateways/{hostID}/repository-jobs/{job}", h.PutRepositoryJob)
	r.Put("/gateways/{hostID}/repository-jobs/{job}/trials/{requestID}", h.PutRepositoryJobTrial)
	r.Put("/gateways/{hostID}/repository-jobs/{job}/comments/{step}", h.PutRepositoryJobComment)
	r.Put("/gateways/{hostID}/repository-jobs/{job}/manual/{requestID}", h.PutRepositoryJobManual)
	for _, body := range []string{`{"repo":"owner/repo","client_passed":true}`, `{} {}`, `{`, strings.Repeat("a", (1<<20)+1)} {
		response := httptest.NewRecorder()
		r.ServeHTTP(response, httptest.NewRequest(http.MethodPut, "/gateways/gateway/repository-jobs/issues", strings.NewReader(body)))
		require.Equal(t, http.StatusBadRequest, response.Code)
	}
	require.Zero(t, called)
	request := httptest.NewRequest(http.MethodPut, "/gateways/gateway/repository-jobs/issues", strings.NewReader(`{"repo":"owner/repo"}`))
	request.Header.Set("Authorization", "Bearer host-token")
	response := httptest.NewRecorder()
	r.ServeHTTP(response, request)
	require.Equal(t, http.StatusOK, response.Code)
	require.Contains(t, response.Body.String(), `"registration_id":"registration"`)
	require.Equal(t, "no-store", response.Header().Get("Cache-Control"))
	request = httptest.NewRequest(http.MethodPut, "/gateways/gateway/repository-jobs/issues/trials/setup-request", strings.NewReader(`{"title":"trial"}`))
	request.Header.Set("Authorization", "Bearer host-token")
	response = httptest.NewRecorder()
	r.ServeHTTP(response, request)
	require.Equal(t, http.StatusOK, response.Code)
	require.Equal(t, 2, called)
	request = httptest.NewRequest(http.MethodPut, "/gateways/gateway/repository-jobs/issues/comments/research:question", strings.NewReader(`{"delivery_key":"native:event"}`))
	request.Header.Set("Authorization", "Bearer host-token")
	response = httptest.NewRecorder()
	r.ServeHTTP(response, request)
	require.Equal(t, http.StatusOK, response.Code)
	require.Contains(t, response.Body.String(), `"comment_id":9`)
	require.Equal(t, 3, called)
	request = httptest.NewRequest(http.MethodPut, "/gateways/gateway/repository-jobs/issues/comments/research:question", strings.NewReader(`{"approved":true}`))
	response = httptest.NewRecorder()
	r.ServeHTTP(response, request)
	require.Equal(t, http.StatusBadRequest, response.Code)
	require.Equal(t, 3, called)
	request = httptest.NewRequest(http.MethodPut, "/gateways/gateway/repository-jobs/issues/manual/manual-request", strings.NewReader(`{"step_id":"poc","prompt":"try it"}`))
	request.Header.Set("Authorization", "Bearer host-token")
	response = httptest.NewRecorder()
	r.ServeHTTP(response, request)
	require.Equal(t, http.StatusOK, response.Code)
	require.Contains(t, response.Body.String(), `"status":"queued"`)
	require.NotContains(t, response.Body.String(), `"run_id"`)
	require.Equal(t, 4, called)
	request = httptest.NewRequest(http.MethodPut, "/gateways/gateway/repository-jobs/issues/manual/manual-request", strings.NewReader(`{"event":{"manualStep":"fix"}}`))
	response = httptest.NewRecorder()
	r.ServeHTTP(response, request)
	require.Equal(t, http.StatusBadRequest, response.Code)
	require.Equal(t, 4, called)
	for _, handler := range []http.HandlerFunc{h.GetRepositoryJobs, h.GetRepositoryJobDispatches, h.PauseRepositoryJob, h.GetRepositorySource} {
		response := httptest.NewRecorder()
		handler(response, httptest.NewRequest(http.MethodGet, "/repo", nil))
		require.Equal(t, http.StatusUnauthorized, response.Code)
	}
}
