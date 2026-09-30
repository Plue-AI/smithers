package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// withRouteUser attaches an authenticated user, the way the auth middleware
// would, so a handler under test reaches its service instead of 401-ing.
func withRouteUser(req *http.Request) *http.Request {
	return req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, &db.User{ID: 42, Username: "octo"}))
}

type stubSyncedReposService struct {
	repos              []services.GitHubSyncedRepoSummary
	refsOnly           bool
	err                error
	mirrorOwner        string
	mirrorRepo         string
	mirrorStatusReport services.GitHubMirrorStatusReport
	mirrorStatusErr    error
}

func (s *stubSyncedReposService) RecordMirrorStatus(_ context.Context, owner, repo string, report services.GitHubMirrorStatusReport) error {
	s.mirrorOwner = owner
	s.mirrorRepo = repo
	s.mirrorStatusReport = report
	return s.mirrorStatusErr
}

func (s *stubSyncedReposService) ListSyncedRepos(_ context.Context, refsOnly bool) ([]services.GitHubSyncedRepoSummary, error) {
	s.refsOnly = refsOnly
	return s.repos, s.err
}

func TestGitHubSyncedRepos_ListServesRegistryFeed(t *testing.T) {
	service := &stubSyncedReposService{repos: []services.GitHubSyncedRepoSummary{{
		GitHubOwner: "octo", GitHubRepo: "widget",
		SmithersOwner: "alice", SmithersRepo: "widget",
		SyncRefs: true, SyncMetadata: true, SyncState: "ready", EnrolledVia: "import",
	}}}
	handler := &GitHubSyncedReposHandler{Service: service}

	req := withRouteUser(httptest.NewRequest(http.MethodGet, "/api/github/synced-repos?refs=true", nil))
	rec := httptest.NewRecorder()
	handler.ListSyncedRepos(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.True(t, service.refsOnly, "?refs=true must narrow the feed to mirrored repos")

	var payload struct {
		Repositories []services.GitHubSyncedRepoSummary `json:"repositories"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
	require.Len(t, payload.Repositories, 1)
	assert.Equal(t, "octo", payload.Repositories[0].GitHubOwner)
	assert.Equal(t, "alice", payload.Repositories[0].SmithersOwner)
}

func TestGitHubSyncedRepos_ListRequiresAuthentication(t *testing.T) {
	handler := &GitHubSyncedReposHandler{Service: &stubSyncedReposService{}}
	rec := httptest.NewRecorder()
	handler.ListSyncedRepos(rec, httptest.NewRequest(http.MethodGet, "/api/github/synced-repos", nil))
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestGitHubSyncedRepos_RecordMirrorStatus(t *testing.T) {
	service := &stubSyncedReposService{}
	handler := &GitHubSyncedReposHandler{Service: service}
	req := withRouteUser(httptest.NewRequest(http.MethodPost,
		"/api/github/synced-repos/alice/widget/mirror-status",
		strings.NewReader(`{"mirror_status":"failed","github_head":"deadbeef","error":"two refs rejected","behind_refs":3,"failed_refs":2}`)))
	req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "widget"})
	rec := httptest.NewRecorder()

	handler.RecordMirrorStatus(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Equal(t, "alice", service.mirrorOwner)
	assert.Equal(t, "widget", service.mirrorRepo)
	assert.Equal(t, services.GitHubMirrorStatusReport{Status: "failed", GitHubHead: "deadbeef", Error: "two refs rejected", BehindRefs: 3, FailedRefs: 2}, service.mirrorStatusReport)
}

func TestGitHubSyncedRepos_RecordMirrorStatusErrors(t *testing.T) {
	t.Run("authentication", func(t *testing.T) {
		handler := &GitHubSyncedReposHandler{Service: &stubSyncedReposService{}}
		rec := httptest.NewRecorder()
		handler.RecordMirrorStatus(rec, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{}`)))
		assert.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("service", func(t *testing.T) {
		handler := &GitHubSyncedReposHandler{Service: &stubSyncedReposService{mirrorStatusErr: pkgerrors.NotFound("missing")}}
		req := withRouteUser(httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"mirror_status":"behind"}`)))
		req = withRouteParams(req, map[string]string{"owner": "alice", "repo": "widget"})
		rec := httptest.NewRecorder()
		handler.RecordMirrorStatus(rec, req)
		assert.Equal(t, http.StatusNotFound, rec.Code)
	})
}

type stubMetadataStalenessService struct {
	result services.GitHubRepoMetadataResult
}

func (s *stubMetadataStalenessService) ListAuthenticatedUserGitHubRepos(context.Context, int64, url.Values) (services.GitHubRepoListResult, error) {
	return services.GitHubRepoListResult{}, pkgerrors.Internal("unused")
}

func (s *stubMetadataStalenessService) DiagnoseGitHubAccess(context.Context, int64, string, string, string) (services.GitHubAccessDiagnosis, error) {
	return services.GitHubAccessDiagnosis{}, pkgerrors.Internal("unused")
}

func (s *stubMetadataStalenessService) GetAuthenticatedUserGitHubRepo(context.Context, int64, string, string) (services.GitHubRepoMetadataResult, error) {
	return s.result, nil
}

func (s *stubMetadataStalenessService) ListAuthenticatedUserGitHubRepoMetadata(context.Context, int64, string, string, string, url.Values) (services.GitHubRepoMetadataResult, error) {
	return s.result, nil
}

func (s *stubMetadataStalenessService) ListAuthenticatedUserGitHubIssueComments(context.Context, int64, string, string, int64, url.Values) (services.GitHubRepoMetadataResult, error) {
	return s.result, nil
}

func (s *stubMetadataStalenessService) GetAuthenticatedUserGitHubPullDiff(context.Context, int64, string, string, int64) (services.GitHubPullDiffResult, error) {
	return services.GitHubPullDiffResult{}, pkgerrors.Internal("unused")
}

func (s *stubMetadataStalenessService) GetAuthenticatedUserGitHubPull(context.Context, int64, string, string, int64) (services.GitHubRepoMetadataResult, error) {
	return s.result, nil
}

func TestGitHubRepoMetadata_ExposesStorenessHeaders(t *testing.T) {
	syncedAt := time.Date(2026, 8, 2, 10, 30, 0, 0, time.UTC)
	handler := &GitHubUserReposHandler{Service: &stubMetadataStalenessService{
		result: services.GitHubRepoMetadataResult{
			Body:      json.RawMessage(`[{"number":1}]`),
			Source:    services.GitHubRepoMetadataSourceStore,
			SyncedAt:  &syncedAt,
			Stale:     true,
			SyncError: "github repository metadata rate limit exceeded",
		},
	}}

	rec := httptest.NewRecorder()
	handler.ListGitHubRepoIssues(rec, withRouteUser(
		httptest.NewRequest(http.MethodGet, "/api/user/github-repos/octo/widget/issues", nil)))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "store", rec.Header().Get("X-Metadata-Source"))
	assert.Equal(t, "2026-08-02T10:30:00Z", rec.Header().Get("X-Metadata-Synced-At"))
	assert.Equal(t, "true", rec.Header().Get("X-Metadata-Stale"))
	assert.Equal(t, "github repository metadata rate limit exceeded", rec.Header().Get("X-Metadata-Sync-Error"))
	assert.JSONEq(t, `[{"number":1}]`, rec.Body.String())
}

func TestGitHubRepoMetadata_LivePassthroughSaysSo(t *testing.T) {
	handler := &GitHubUserReposHandler{Service: &stubMetadataStalenessService{
		result: services.GitHubRepoMetadataResult{
			Body:   json.RawMessage(`[]`),
			Source: services.GitHubRepoMetadataSourceLive,
		},
	}}

	rec := httptest.NewRecorder()
	handler.ListGitHubRepoPulls(rec, withRouteUser(
		httptest.NewRequest(http.MethodGet, "/api/user/github-repos/octo/widget/pulls", nil)))

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "live", rec.Header().Get("X-Metadata-Source"))
	assert.Empty(t, rec.Header().Get("X-Metadata-Synced-At"))
	assert.Empty(t, rec.Header().Get("X-Metadata-Stale"))
}
