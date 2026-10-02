package compose

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type githubUserReposRouterService struct {
	calls atomic.Int32
}

func (s *githubUserReposRouterService) ListAuthenticatedUserGitHubRepos(context.Context, int64, url.Values) (services.GitHubRepoListResult, error) {
	s.calls.Add(1)
	return services.GitHubRepoListResult{Repos: []services.GitHubRepoListItem{}}, nil
}

func (s *githubUserReposRouterService) GetAuthenticatedUserGitHubRepo(context.Context, int64, string, string) (services.GitHubRepoMetadataResult, error) {
	s.calls.Add(1)
	return services.GitHubRepoMetadataResult{Body: []byte(`{}`)}, nil
}

func (s *githubUserReposRouterService) ListAuthenticatedUserGitHubRepoMetadata(context.Context, int64, string, string, string, url.Values) (services.GitHubRepoMetadataResult, error) {
	s.calls.Add(1)
	return services.GitHubRepoMetadataResult{Body: []byte(`[]`)}, nil
}

func (s *githubUserReposRouterService) ListAuthenticatedUserGitHubIssueComments(context.Context, int64, string, string, int64, url.Values) (services.GitHubRepoMetadataResult, error) {
	s.calls.Add(1)
	return services.GitHubRepoMetadataResult{Body: []byte(`[]`)}, nil
}

func (s *githubUserReposRouterService) GetAuthenticatedUserGitHubPullDiff(context.Context, int64, string, string, int64) (services.GitHubPullDiffResult, error) {
	s.calls.Add(1)
	return services.GitHubPullDiffResult{Body: []byte("diff --git a/x b/x\n")}, nil
}

func (s *githubUserReposRouterService) GetAuthenticatedUserGitHubPull(context.Context, int64, string, string, int64) (services.GitHubRepoMetadataResult, error) {
	s.calls.Add(1)
	return services.GitHubRepoMetadataResult{Body: []byte(`{"number":7}`)}, nil
}

func (s *githubUserReposRouterService) DiagnoseGitHubAccess(context.Context, int64, string, string, string) (services.GitHubAccessDiagnosis, error) {
	s.calls.Add(1)
	return services.GitHubAccessDiagnosis{Verdict: services.GitHubAccessVerdictOK, Surface: "issues"}, nil
}

func githubUserReposSecurityRouter(service routes.GitHubUserReposRouteService) http.Handler {
	return buildRouter(
		testConfigAllFlagsOn(),
		nil, // queries
		nil, // pool
		&routes.RepoHandler{},
		nil, // mirrorSyncHandler
		&routes.AuthHandler{},
		&routes.UserHandler{},
		&routes.SSHKeyHandler{},
		nil, // deployKeyHandler
		&routes.LabelHandler{},

		&routes.OrgHandler{},
		&routes.LandingHandler{},
		nil, // buildCacheHandler
		nil, // stackHandler
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{},
		nil, // wikiService
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, // notificationHandler
		nil, // adminUserHandler
		nil, // adminOrgHandler
		nil, // adminSystemMetricsHandler
		nil, // adminGitHubAppHandler
		nil, // adminAuditHandler
		nil, // webhookHandler
		nil, // secretHandler
		nil, // providerConnectionHandler
		nil, // variableHandler
		nil, // billingHandler
		nil, // protectedBookmarkHandler
		nil, // commitStatusHandler
		nil, // lfsHandler
		nil, // jjVCSHandler
		nil, // agentInternalHandler
		nil, // agentSessionHandler
		nil, // agentSessionStreamHandler
		nil, // approvalsHandler
		nil, // branchLockHandler
		nil, // canaryReportHandler
		nil, // workflowHandler
		nil, // workflowCacheHandler
		nil, // workflowArtifactHandler
		nil, // issueEventHandler
		&routes.WorkspaceHandler{},
		nil, // workspaceInternalHandler
		nil, // repositoryJobHandler
		nil, // gitHubProxyHandler
		nil, // gitHubRepoListHandler
		&routes.GitHubUserReposHandler{Service: service},
		nil, // gitHubSyncedReposHandler
		nil, // gitHubImportHandler
		nil, // workspaceTerminalHandler
		nil, // telemetryHandler
		nil, // featureFlagHandler
		nil, // oauth2Handler
		nil, // gitHubWebhookHandler
		nil, // smithersMetrics
	)
}

func githubUserReposRestrictedRequest(path string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	rawScopes := string(middleware.ScopeReadRepository) + "," + middleware.RepositoryRestrictionScope(99)
	return req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User:        &db.User{ID: 7, Username: "octo", LowerUsername: "octo"},
		RawScopes:   rawScopes,
		Scopes:      middleware.ParseTokenScopes(rawScopes),
		IsTokenAuth: true,
		TokenSource: middleware.TokenSourcePersonalAccessToken,
	}))
}

func TestServerRouter_GitHubUserRepoRoutesRejectRestrictedPATBeforeService(t *testing.T) {
	service := &githubUserReposRouterService{}
	router := githubUserReposSecurityRouter(service)
	paths := []string{
		"/api/user/github-repos",
		"/api/user/github-repos/smithersai/smithers",
		"/api/user/github-repos/smithersai/smithers/issues?state=open&per_page=100&page=1",
		"/api/user/github-repos/smithersai/smithers/pulls?state=open&per_page=100&page=1",
		"/api/user/github-repos/smithersai/smithers/pulls/7",
		"/api/user/github-repos/smithersai/smithers/issues/7/comments?per_page=100",
		"/api/user/github-repos/smithersai/smithers/pulls/7/diff",
		"/api/user/github-app/installations",
		"/api/user/github-app/installations/42",
	}

	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, githubUserReposRestrictedRequest(path))
			require.Equal(t, http.StatusForbidden, rec.Code)
			assert.Equal(t, "private, no-store", rec.Header().Get("Cache-Control"))
		})
	}
	assert.Equal(t, int32(0), service.calls.Load(), "router must reject before any user-GitHub service method")
}

func TestServerRouter_GitHubRepoObjectRouteAllowsSessionAndCallsService(t *testing.T) {
	service := &githubUserReposRouterService{}
	router := githubUserReposSecurityRouter(service)
	req := httptest.NewRequest(http.MethodGet, "/api/user/github-repos/smithersai/smithers", nil)
	req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User:        &db.User{ID: 7, Username: "octo", LowerUsername: "octo"},
		IsTokenAuth: false,
	}))
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{}`, rec.Body.String())
	assert.Equal(t, "private, no-store", rec.Header().Get("Cache-Control"))
	assert.Equal(t, int32(1), service.calls.Load())
}

func TestServerRouter_GitHubAppInstallationsServesSessionUser(t *testing.T) {
	service := &githubUserReposRouterService{}
	router := githubUserReposSecurityRouter(service)
	for _, path := range []string{"/api/user/github-app/installations", "/api/user/github-app/installations/42"} {
		t.Run(path, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, path, nil)
			req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
				User:        &db.User{ID: 7, Username: "octo", LowerUsername: "octo"},
				IsTokenAuth: false,
			}))
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			require.Equal(t, http.StatusOK, rec.Code)
			assert.JSONEq(t, `{"repos":[]}`, rec.Body.String())
			assert.Equal(t, "private, no-store", rec.Header().Get("Cache-Control"))
		})
	}
	unauthenticated := httptest.NewRecorder()
	router.ServeHTTP(unauthenticated, httptest.NewRequest(http.MethodGet, "/api/user/github-app/installations", nil))
	assert.Equal(t, http.StatusUnauthorized, unauthenticated.Code)
}
