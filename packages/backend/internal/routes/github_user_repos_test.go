package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type mockGitHubUserReposRouteService struct {
	result         services.GitHubRepoListResult
	err            error
	repoResult     services.GitHubRepoMetadataResult
	repoErr        error
	repoFn         func(context.Context, int64, string, string) (services.GitHubRepoMetadataResult, error)
	metadataResult services.GitHubRepoMetadataResult
	metadataErr    error
	metadataFn     func(context.Context, int64, string, string, string, url.Values) (services.GitHubRepoMetadataResult, error)

	diagnosisResult services.GitHubAccessDiagnosis
	diagnosisErr    error
	diagnosisFn     func(context.Context, int64, string, string, string) (services.GitHubAccessDiagnosis, error)

	commentsResult services.GitHubRepoMetadataResult
	commentsErr    error
	commentsFn     func(context.Context, int64, string, string, int64, url.Values) (services.GitHubRepoMetadataResult, error)

	diffResult services.GitHubPullDiffResult
	diffErr    error
	diffFn     func(context.Context, int64, string, string, int64) (services.GitHubPullDiffResult, error)
	pullFn     func(context.Context, int64, string, string, int64) (services.GitHubRepoMetadataResult, error)
	pullErr    error
}

func (m mockGitHubUserReposRouteService) ListAuthenticatedUserGitHubRepos(ctx context.Context, userID int64, query url.Values) (services.GitHubRepoListResult, error) {
	return m.result, m.err
}

func (m mockGitHubUserReposRouteService) DiagnoseGitHubAccess(ctx context.Context, userID int64, owner, repo, surface string) (services.GitHubAccessDiagnosis, error) {
	if m.diagnosisFn != nil {
		return m.diagnosisFn(ctx, userID, owner, repo, surface)
	}
	return m.diagnosisResult, m.diagnosisErr
}

func (m mockGitHubUserReposRouteService) GetAuthenticatedUserGitHubRepo(ctx context.Context, userID int64, owner, repo string) (services.GitHubRepoMetadataResult, error) {
	if m.repoFn != nil {
		return m.repoFn(ctx, userID, owner, repo)
	}
	return m.repoResult, m.repoErr
}

func (m mockGitHubUserReposRouteService) ListAuthenticatedUserGitHubRepoMetadata(ctx context.Context, userID int64, owner, repo, resource string, query url.Values) (services.GitHubRepoMetadataResult, error) {
	if m.metadataFn != nil {
		return m.metadataFn(ctx, userID, owner, repo, resource, query)
	}
	return m.metadataResult, m.metadataErr
}

func (m mockGitHubUserReposRouteService) ListAuthenticatedUserGitHubIssueComments(ctx context.Context, userID int64, owner, repo string, number int64, query url.Values) (services.GitHubRepoMetadataResult, error) {
	if m.commentsFn != nil {
		return m.commentsFn(ctx, userID, owner, repo, number, query)
	}
	return m.commentsResult, m.commentsErr
}

func (m mockGitHubUserReposRouteService) GetAuthenticatedUserGitHubPullDiff(ctx context.Context, userID int64, owner, repo string, number int64) (services.GitHubPullDiffResult, error) {
	if m.diffFn != nil {
		return m.diffFn(ctx, userID, owner, repo, number)
	}
	return m.diffResult, m.diffErr
}

func (m mockGitHubUserReposRouteService) GetAuthenticatedUserGitHubPull(ctx context.Context, userID int64, owner, repo string, number int64) (services.GitHubRepoMetadataResult, error) {
	if m.pullFn != nil {
		return m.pullFn(ctx, userID, owner, repo, number)
	}
	if m.pullErr != nil {
		return services.GitHubRepoMetadataResult{}, m.pullErr
	}
	return services.GitHubRepoMetadataResult{Body: []byte(`{"number":7}`)}, nil
}

func TestGitHubUserReposHandler_GetsTypedPullForAuthenticatedUser(t *testing.T) {
	t.Parallel()
	var called bool
	handler := &GitHubUserReposHandler{Service: mockGitHubUserReposRouteService{pullFn: func(_ context.Context, userID int64, owner, repo string, number int64) (services.GitHubRepoMetadataResult, error) {
		called = true
		assert.Equal(t, int64(42), userID)
		assert.Equal(t, "upstream", owner)
		assert.Equal(t, "project", repo)
		assert.Equal(t, int64(17), number)
		return services.GitHubRepoMetadataResult{Body: []byte(`{"number":17}`)}, nil
	}}}
	req := githubRepoMetadataRequest(t, "/api/user/github-repos/upstream/project/pulls/17", "upstream", "project")
	chi.RouteContext(req.Context()).URLParams.Add("number", "17")
	rec := httptest.NewRecorder()
	handler.GetGitHubPull(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{"number":17}`, rec.Body.String())
	assert.Equal(t, "private, no-store", rec.Header().Get("Cache-Control"))
	assert.True(t, called)
}

func TestGitHubUserReposHandler_TypedPullRefusals(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name    string
		number  string
		service GitHubUserReposRouteService
		want    int
	}{
		{name: "not numeric", number: "abc", service: mockGitHubUserReposRouteService{}, want: http.StatusBadRequest},
		{name: "zero", number: "0", service: mockGitHubUserReposRouteService{}, want: http.StatusBadRequest},
		{name: "no service", number: "17", want: http.StatusInternalServerError},
		{name: "GitHub refused", number: "17", service: mockGitHubUserReposRouteService{pullErr: pkgerrors.NotFound("pull request not found")}, want: http.StatusNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := githubRepoMetadataRequest(t, "/api/user/github-repos/upstream/project/pulls/"+tc.number, "upstream", "project")
			chi.RouteContext(req.Context()).URLParams.Add("number", tc.number)
			rec := httptest.NewRecorder()
			(&GitHubUserReposHandler{Service: tc.service}).GetGitHubPull(rec, req)
			require.Equal(t, tc.want, rec.Code)
			assert.Equal(t, "private, no-store", rec.Header().Get("Cache-Control"))
		})
	}
}

func githubUserReposRequest(t *testing.T) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/user/github-repos", nil)
	return req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, &db.User{ID: 42, Username: "octo"}))
}

func githubRepoMetadataRequest(t *testing.T, path, owner, repo string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	routeContext := chi.NewRouteContext()
	routeContext.URLParams.Add("owner", owner)
	routeContext.URLParams.Add("repo", repo)
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, routeContext)
	ctx = context.WithValue(ctx, middleware.UserContextKey, &db.User{ID: 42, Username: "octo"})
	return req.WithContext(ctx)
}

func TestGitHubUserReposHandler_SetsStalenessHeaders(t *testing.T) {
	t.Parallel()

	syncedAt := time.Date(2026, 7, 4, 11, 55, 0, 0, time.UTC)
	handler := &GitHubUserReposHandler{Service: mockGitHubUserReposRouteService{
		result: services.GitHubRepoListResult{
			Repos:          []services.GitHubRepoListItem{{FullName: "octo/repo-1"}},
			Link:           `</api/user/github-repos?cursor=2&per_page=100>; rel="next"`,
			CacheSyncedAt:  &syncedAt,
			CacheSyncError: "github user repositories request failed",
		},
	}}

	rec := httptest.NewRecorder()
	handler.ListGitHubUserRepos(rec, githubUserReposRequest(t))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "2026-07-04T11:55:00Z", rec.Header().Get("X-Repos-Synced-At"))
	assert.Equal(t, "github user repositories request failed", rec.Header().Get("X-Repos-Sync-Error"))
	assert.Equal(t, `</api/user/github-repos?cursor=2&per_page=100>; rel="next"`, rec.Header().Get("Link"))

	// The body stays a plain JSON array — multi's parser contract.
	var body []services.GitHubRepoListItem
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Len(t, body, 1)
	assert.Equal(t, "octo/repo-1", body[0].FullName)
}

func TestGitHubUserReposHandler_NoCacheMetadataMeansNoHeaders(t *testing.T) {
	t.Parallel()

	handler := &GitHubUserReposHandler{Service: mockGitHubUserReposRouteService{
		result: services.GitHubRepoListResult{
			Repos: []services.GitHubRepoListItem{},
		},
	}}

	rec := httptest.NewRecorder()
	handler.ListGitHubUserRepos(rec, githubUserReposRequest(t))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Empty(t, rec.Header().Get("X-Repos-Synced-At"))
	assert.Empty(t, rec.Header().Get("X-Repos-Sync-Error"))
	assert.Empty(t, rec.Header().Get("Link"))
	assert.JSONEq(t, "[]", rec.Body.String())
}

func TestGitHubUserReposHandler_ListsRepoMetadataAndPropagatesLink(t *testing.T) {
	t.Parallel()

	var gotOwner, gotRepo, gotResource string
	var gotQuery url.Values
	handler := &GitHubUserReposHandler{Service: mockGitHubUserReposRouteService{
		metadataFn: func(_ context.Context, userID int64, owner, repo, resource string, query url.Values) (services.GitHubRepoMetadataResult, error) {
			assert.Equal(t, int64(42), userID)
			gotOwner, gotRepo, gotResource, gotQuery = owner, repo, resource, query
			return services.GitHubRepoMetadataResult{
				Body: json.RawMessage(`[{"number":17,"title":"Fix it"}]`),
				Link: `<https://api.github.test/repositories/1/issues?page=2>; rel="next"`,
			}, nil
		},
	}}

	issuesRec := httptest.NewRecorder()
	handler.ListGitHubRepoIssues(issuesRec, githubRepoMetadataRequest(t, "/api/user/github-repos/acme/widget/issues?state=open&per_page=50", "acme", "widget"))

	require.Equal(t, http.StatusOK, issuesRec.Code)
	assert.Equal(t, "acme", gotOwner)
	assert.Equal(t, "widget", gotRepo)
	assert.Equal(t, services.GitHubRepoMetadataIssues, gotResource)
	assert.Equal(t, "open", gotQuery.Get("state"))
	assert.Equal(t, "50", gotQuery.Get("per_page"))
	assert.Equal(t, `<https://api.github.test/repositories/1/issues?page=2>; rel="next"`, issuesRec.Header().Get("Link"))
	assert.Equal(t, "private, no-store", issuesRec.Header().Get("Cache-Control"))
	assert.JSONEq(t, `[{"number":17,"title":"Fix it"}]`, issuesRec.Body.String())

	pullsRec := httptest.NewRecorder()
	handler.ListGitHubRepoPulls(pullsRec, githubRepoMetadataRequest(t, "/api/user/github-repos/acme/widget/pulls", "acme", "widget"))
	require.Equal(t, http.StatusOK, pullsRec.Code)
	assert.Equal(t, services.GitHubRepoMetadataPulls, gotResource)
}

func TestGitHubUserReposHandler_GetsRepoObjectAsPrivateRawJSON(t *testing.T) {
	t.Parallel()

	var gotOwner, gotRepo string
	handler := &GitHubUserReposHandler{Service: mockGitHubUserReposRouteService{
		repoFn: func(_ context.Context, userID int64, owner, repo string) (services.GitHubRepoMetadataResult, error) {
			assert.Equal(t, int64(42), userID)
			gotOwner, gotRepo = owner, repo
			return services.GitHubRepoMetadataResult{Body: json.RawMessage(`{"owner":{"login":"smithersai"},"name":"smithers","full_name":"smithersai/smithers","default_branch":"main"}`)}, nil
		},
	}}

	rec := httptest.NewRecorder()
	handler.GetGitHubRepo(rec, githubRepoMetadataRequest(t, "/api/user/github-repos/smithersai/smithers", "smithersai", "smithers"))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "smithersai", gotOwner)
	assert.Equal(t, "smithers", gotRepo)
	assert.Equal(t, "private, no-store", rec.Header().Get("Cache-Control"))
	assert.JSONEq(t, `{"owner":{"login":"smithersai"},"name":"smithers","full_name":"smithersai/smithers","default_branch":"main"}`, rec.Body.String())
}

func TestGitHubUserReposHandler_MetadataErrorsArePrivateNoStore(t *testing.T) {
	t.Parallel()

	handler := &GitHubUserReposHandler{Service: mockGitHubUserReposRouteService{
		metadataErr: pkgerrors.Forbidden("github denied"),
	}}
	rec := httptest.NewRecorder()
	handler.ListGitHubRepoIssues(rec, githubRepoMetadataRequest(t, "/api/user/github-repos/acme/widget/issues", "acme", "widget"))

	require.Equal(t, http.StatusForbidden, rec.Code)
	assert.Equal(t, "private, no-store", rec.Header().Get("Cache-Control"))
}

func TestGitHubUserReposHandler_WritesMaximumRawBodyWithoutHTMLEscapeExpansion(t *testing.T) {
	payload := append([]byte("[\""), bytes.Repeat([]byte("<"), (8<<20)-4)...)
	payload = append(payload, '"', ']')
	handler := &GitHubUserReposHandler{Service: mockGitHubUserReposRouteService{
		metadataResult: services.GitHubRepoMetadataResult{Body: json.RawMessage(payload)},
	}}

	rec := httptest.NewRecorder()
	handler.ListGitHubRepoIssues(rec, githubRepoMetadataRequest(t, "/api/user/github-repos/acme/widget/issues", "acme", "widget"))

	require.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, payload, rec.Body.Bytes())
	require.Len(t, rec.Body.Bytes(), 8<<20)
	assert.Equal(t, "private, no-store", rec.Header().Get("Cache-Control"))
}

func TestGitHubUserReposHandler_AccessDiagnosis(t *testing.T) {
	t.Parallel()

	handler := &GitHubUserReposHandler{Service: mockGitHubUserReposRouteService{
		diagnosisFn: func(_ context.Context, userID int64, owner, repo, surface string) (services.GitHubAccessDiagnosis, error) {
			assert.Equal(t, int64(42), userID)
			assert.Equal(t, "acme", owner)
			assert.Equal(t, "widgets", repo)
			assert.Equal(t, "pulls", surface)
			return services.GitHubAccessDiagnosis{
				Verdict:           services.GitHubAccessVerdictPermissionMissing,
				Surface:           surface,
				MissingPermission: "pull_requests:read",
			}, nil
		},
	}}

	rec := httptest.NewRecorder()
	handler.GetGitHubAccessDiagnosis(
		rec,
		githubRepoMetadataRequest(t, "/api/user/github-access/acme/widgets?surface=pulls", "acme", "widgets"),
	)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "private, no-store", rec.Header().Get("Cache-Control"))
	var payload services.GitHubAccessDiagnosis
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	assert.Equal(t, services.GitHubAccessVerdictPermissionMissing, payload.Verdict)
	assert.Equal(t, "pull_requests:read", payload.MissingPermission)
}

func TestGitHubUserReposHandler_AccessDiagnosisDefaultsToIssues(t *testing.T) {
	t.Parallel()

	handler := &GitHubUserReposHandler{Service: mockGitHubUserReposRouteService{
		diagnosisFn: func(_ context.Context, _ int64, _, _, surface string) (services.GitHubAccessDiagnosis, error) {
			assert.Equal(t, "issues", surface)
			return services.GitHubAccessDiagnosis{Verdict: services.GitHubAccessVerdictOK, Surface: surface}, nil
		},
	}}

	rec := httptest.NewRecorder()
	handler.GetGitHubAccessDiagnosis(
		rec,
		githubRepoMetadataRequest(t, "/api/user/github-access/acme/widgets", "acme", "widgets"),
	)
	require.Equal(t, http.StatusOK, rec.Code)
}

func githubNumberedRequest(t *testing.T, path, owner, repo, number string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	routeContext := chi.NewRouteContext()
	routeContext.URLParams.Add("owner", owner)
	routeContext.URLParams.Add("repo", repo)
	routeContext.URLParams.Add("number", number)
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, routeContext)
	ctx = context.WithValue(ctx, middleware.UserContextKey, &db.User{ID: 42, Username: "octo"})
	return req.WithContext(ctx)
}

func TestGitHubUserReposHandler_IssueCommentsServeStoreProvenance(t *testing.T) {
	t.Parallel()

	syncedAt := time.Date(2026, 8, 2, 12, 0, 0, 0, time.UTC)
	handler := &GitHubUserReposHandler{Service: mockGitHubUserReposRouteService{
		commentsFn: func(_ context.Context, userID int64, owner, repo string, number int64, query url.Values) (services.GitHubRepoMetadataResult, error) {
			assert.Equal(t, int64(42), userID)
			assert.Equal(t, "acme", owner)
			assert.Equal(t, "widget", repo)
			assert.Equal(t, int64(7), number)
			assert.Equal(t, "100", query.Get("per_page"))
			return services.GitHubRepoMetadataResult{
				Body:     json.RawMessage(`[{"id":9001,"body":"from the store"}]`),
				Source:   services.GitHubRepoMetadataSourceStore,
				SyncedAt: &syncedAt,
			}, nil
		},
	}}

	rec := httptest.NewRecorder()
	handler.ListGitHubRepoIssueComments(rec, githubNumberedRequest(
		t, "/api/user/github-repos/acme/widget/issues/7/comments?per_page=100", "acme", "widget", "7"))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "private, no-store", rec.Header().Get("Cache-Control"))
	assert.Equal(t, "store", rec.Header().Get("X-Metadata-Source"))
	assert.Equal(t, "2026-08-02T12:00:00Z", rec.Header().Get("X-Metadata-Synced-At"))
	assert.JSONEq(t, `[{"id":9001,"body":"from the store"}]`, rec.Body.String())
}

func TestGitHubUserReposHandler_IssueCommentsRejectInvalidNumber(t *testing.T) {
	t.Parallel()

	handler := &GitHubUserReposHandler{Service: mockGitHubUserReposRouteService{
		commentsFn: func(context.Context, int64, string, string, int64, url.Values) (services.GitHubRepoMetadataResult, error) {
			t.Fatal("an invalid number must never reach the service")
			return services.GitHubRepoMetadataResult{}, nil
		},
	}}

	rec := httptest.NewRecorder()
	handler.ListGitHubRepoIssueComments(rec, githubNumberedRequest(
		t, "/api/user/github-repos/acme/widget/issues/nope/comments", "acme", "widget", "nope"))

	require.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Equal(t, "private, no-store", rec.Header().Get("Cache-Control"))
}

func TestGitHubUserReposHandler_PullDiffWritesPlainTextBody(t *testing.T) {
	t.Parallel()

	diff := "diff --git a/main.go b/main.go\n--- a/main.go\n+++ b/main.go\n"
	handler := &GitHubUserReposHandler{Service: mockGitHubUserReposRouteService{
		diffFn: func(_ context.Context, userID int64, owner, repo string, number int64) (services.GitHubPullDiffResult, error) {
			assert.Equal(t, int64(42), userID)
			assert.Equal(t, "acme", owner)
			assert.Equal(t, "widget", repo)
			assert.Equal(t, int64(7), number)
			return services.GitHubPullDiffResult{Body: []byte(diff)}, nil
		},
	}}

	rec := httptest.NewRecorder()
	handler.GetGitHubPullDiff(rec, githubNumberedRequest(
		t, "/api/user/github-repos/acme/widget/pulls/7/diff", "acme", "widget", "7"))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "private, no-store", rec.Header().Get("Cache-Control"))
	assert.Equal(t, "text/plain; charset=utf-8", rec.Header().Get("Content-Type"))
	assert.Equal(t, diff, rec.Body.String())
}

func TestGitHubUserReposHandler_PullDiffTooLargeKeepsTypedVerdict(t *testing.T) {
	t.Parallel()

	handler := &GitHubUserReposHandler{Service: mockGitHubUserReposRouteService{
		diffErr: &pkgerrors.APIError{
			Status:  http.StatusBadGateway,
			Code:    services.CodeGitHubPullDiffTooLarge,
			Message: "github pull diff exceeded the size limit",
		},
	}}

	rec := httptest.NewRecorder()
	handler.GetGitHubPullDiff(rec, githubNumberedRequest(
		t, "/api/user/github-repos/acme/widget/pulls/7/diff", "acme", "widget", "7"))

	require.Equal(t, http.StatusBadGateway, rec.Code)
	assert.Equal(t, "private, no-store", rec.Header().Get("Cache-Control"))
	// The 5xx message is sanitized, but the machine-readable verdict survives.
	assert.Contains(t, rec.Body.String(), services.CodeGitHubPullDiffTooLarge)
	assert.NotContains(t, rec.Body.String(), "exceeded the size limit")
}

func TestGitHubUserReposHandler_PullDiffRejectsInvalidNumber(t *testing.T) {
	t.Parallel()

	handler := &GitHubUserReposHandler{Service: mockGitHubUserReposRouteService{
		diffFn: func(context.Context, int64, string, string, int64) (services.GitHubPullDiffResult, error) {
			t.Fatal("an invalid number must never reach the service")
			return services.GitHubPullDiffResult{}, nil
		},
	}}

	rec := httptest.NewRecorder()
	handler.GetGitHubPullDiff(rec, githubNumberedRequest(
		t, "/api/user/github-repos/acme/widget/pulls/-1/diff", "acme", "widget", "-1"))

	require.Equal(t, http.StatusBadRequest, rec.Code)
}
