package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func githubAppInstallationsRequest(installationID string, signedIn bool) *http.Request {
	path := "/api/user/github-app/installations"
	routeContext := chi.NewRouteContext()
	if installationID != "" {
		path += "/" + installationID
		routeContext.URLParams.Add("installationId", installationID)
	}
	req := httptest.NewRequest(http.MethodGet, path, nil)
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, routeContext)
	if signedIn {
		ctx = context.WithValue(ctx, middleware.UserContextKey, &db.User{ID: 42, Username: "ada"})
	}
	return req.WithContext(ctx)
}

func installedRepoService(verdict string) mockGitHubUserReposRouteService {
	return mockGitHubUserReposRouteService{
		result: services.GitHubRepoListResult{Repos: []services.GitHubRepoListItem{{FullName: "ada/hello", PushedAt: "2026-09-12T00:00:00Z"}}},
		diagnosisResult: services.GitHubAccessDiagnosis{
			Verdict:        verdict,
			InstallationID: 42,
			Detail:         "Your GitHub credential cannot access this repository.",
		},
	}
}

func TestGitHubAppInstallations_ReturnsVerifiedReposInCamelCase(t *testing.T) {
	t.Parallel()
	handler := &GitHubUserReposHandler{Service: installedRepoService(services.GitHubAccessVerdictOK)}

	rec := httptest.NewRecorder()
	handler.ListGitHubAppInstallations(rec, githubAppInstallationsRequest("42", true))
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "private, no-store", rec.Header().Get("Cache-Control"))
	assert.JSONEq(t, `{"repos":[{"fullName":"ada/hello","pushedAt":"2026-09-12T00:00:00Z","installationId":42}]}`, rec.Body.String())

	rec = httptest.NewRecorder()
	handler.ListGitHubAppInstallations(rec, githubAppInstallationsRequest("999", true))
	require.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{"repos":[]}`, rec.Body.String())

	rec = httptest.NewRecorder()
	handler.ListGitHubAppInstallations(rec, githubAppInstallationsRequest("", true))
	require.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{"repos":[{"fullName":"ada/hello","pushedAt":"2026-09-12T00:00:00Z","installationId":42}]}`, rec.Body.String())
}

func TestGitHubAppInstallations_BlockerIsAConflict(t *testing.T) {
	t.Parallel()
	handler := &GitHubUserReposHandler{Service: installedRepoService(services.GitHubAccessVerdictNoOrgGrant)}

	rec := httptest.NewRecorder()
	handler.ListGitHubAppInstallations(rec, githubAppInstallationsRequest("42", true))
	require.Equal(t, http.StatusConflict, rec.Code)
	assert.JSONEq(t, `{"code":"conflict","fault":"user","message":"Your GitHub credential cannot access this repository."}`, rec.Body.String())
}

func TestGitHubAppInstallations_BudgetRefusalKeepsItsMessage(t *testing.T) {
	t.Parallel()
	full := make([]services.GitHubRepoListItem, 100)
	for i := range full {
		full[i] = services.GitHubRepoListItem{FullName: "ada/repo-" + string(rune('a'+i%26)) + string(rune('a'+i/26))}
	}
	calls := 0
	handler := &GitHubUserReposHandler{Service: mockGitHubUserReposRouteService{
		result: services.GitHubRepoListResult{Repos: full},
		diagnosisFn: func(context.Context, int64, string, string, string) (services.GitHubAccessDiagnosis, error) {
			calls++
			return services.GitHubAccessDiagnosis{}, nil
		},
	}}

	rec := httptest.NewRecorder()
	handler.ListGitHubAppInstallations(rec, githubAppInstallationsRequest("", true))
	require.Equal(t, http.StatusServiceUnavailable, rec.Code)
	assert.Contains(t, rec.Body.String(), "Smithers Cloud could not verify this repository inventory within its request budget.")
	assert.Equal(t, 0, calls)
}

func TestGitHubAppInstallations_RefusesSignedOutAndInvalidIDs(t *testing.T) {
	t.Parallel()
	listed := false
	handler := &GitHubUserReposHandler{Service: mockGitHubUserReposRouteService{
		diagnosisFn: func(context.Context, int64, string, string, string) (services.GitHubAccessDiagnosis, error) {
			listed = true
			return services.GitHubAccessDiagnosis{}, nil
		},
	}}

	rec := httptest.NewRecorder()
	handler.ListGitHubAppInstallations(rec, githubAppInstallationsRequest("42", false))
	assert.Equal(t, http.StatusUnauthorized, rec.Code)

	for _, id := range []string{"0", "007", "abc", "-1"} {
		rec = httptest.NewRecorder()
		handler.ListGitHubAppInstallations(rec, githubAppInstallationsRequest(id, true))
		assert.Equal(t, http.StatusBadRequest, rec.Code, id)
		assert.Contains(t, rec.Body.String(), "Invalid installation id.", id)
	}
	assert.False(t, listed)
}

func TestGitHubAppInstallations_UpstreamFailureKeepsStatusAndRestatesProse(t *testing.T) {
	t.Parallel()
	handler := &GitHubUserReposHandler{Service: mockGitHubUserReposRouteService{
		err: pkgerrors.New(pkgerrors.CodeGitHubUnavailable, "raw github prose"),
	}}

	rec := httptest.NewRecorder()
	handler.ListGitHubAppInstallations(rec, githubAppInstallationsRequest("", true))
	require.Equal(t, http.StatusBadGateway, rec.Code)
	assert.Contains(t, rec.Body.String(), "Smithers Cloud could not verify the GitHub App installation. Try again.")
	assert.NotContains(t, rec.Body.String(), "raw github prose")
}
