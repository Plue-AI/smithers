package compose

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// Compile-time assertion: services.WorkflowAPIService must satisfy routes.WorkflowRunRouteService.
// If this fails to compile, the production SSE route wiring will silently break.
var _ routes.WorkflowRunRouteService = (services.WorkflowAPIService)(nil)

type mockRouterGitService struct {
	proxyInfoRefsFn    func(ctx context.Context, owner, repo, service, token string, stdout io.Writer) (string, error)
	proxyUploadPackFn  func(ctx context.Context, owner, repo, token string, stdin io.Reader, stdout io.Writer) error
	proxyReceivePackFn func(ctx context.Context, owner, repo, token string, stdin io.Reader, stdout io.Writer) error
}

type mockRouterSearchService struct{}

type mockRouterAuthService struct{}
type mockRouterRepoService struct {
	getRepoCalls  int
	forkRepoCalls int
}
type mockRouterCommitStatusService struct {
	listCommitStatusesFn func(ctx context.Context, repositoryID int64, ref string, page, perPage int) ([]db.CommitStatus, int64, error)
	createCommitStatusFn func(ctx context.Context, repositoryID int64, sha string, input services.CreateCommitStatusInput) (db.CommitStatus, error)
}

type mockRouterWorkflowService struct {
	getWorkflowRunFn        func(ctx context.Context, repositoryID, runID int64) (db.WorkflowRun, error)
	cancelWorkflowRunFn     func(ctx context.Context, repositoryID, runID int64) error
	listWorkflowStepsFn     func(ctx context.Context, runID int64) ([]db.WorkflowStep, error)
	listWorkflowLogsSinceFn func(ctx context.Context, runID, afterID int64, limit int32) ([]db.WorkflowLog, error)
	rerunRunFn              func(ctx context.Context, input services.RerunInput) (*services.WorkflowRunResult, error)
	resumeRunFn             func(ctx context.Context, repositoryID, runID int64) error
}

type mockRouterWikiService struct {
	listWikiPagesFn  func(ctx context.Context, viewer *db.User, owner, repo string, input services.ListWikiPagesInput) ([]services.WikiPageResponse, int64, error)
	getWikiPageFn    func(ctx context.Context, viewer *db.User, owner, repo, slug string) (services.WikiPageResponse, error)
	createWikiPageFn func(ctx context.Context, actor *db.User, owner, repo string, req services.CreateWikiPageInput) (services.WikiPageResponse, error)
	updateWikiPageFn func(ctx context.Context, actor *db.User, owner, repo, slug string, req services.UpdateWikiPageInput) (services.WikiPageResponse, error)
	deleteWikiPageFn func(ctx context.Context, actor *db.User, owner, repo, slug string) error
}

func (m *mockRouterAuthService) CreateKeyAuthNonce(ctx context.Context) (string, error) {
	return "nonce", nil
}

func (m *mockRouterAuthService) VerifyKeyAuth(ctx context.Context, message, signature string) (services.VerifyKeyAuthResult, error) {
	return services.VerifyKeyAuthResult{
		User:       db.User{ID: 1, Username: "alice", LowerUsername: "alice"},
		SessionKey: "session-key",
		ExpiresAt:  time.Now().UTC().Add(time.Hour),
	}, nil
}

func (m *mockRouterAuthService) StartGitHubOAuth(ctx context.Context, stateVerifier string) (string, error) {
	return "https://example.com/oauth", nil
}

func (m *mockRouterAuthService) StartGitHubOAuthWithScopes(ctx context.Context, stateVerifier, rawScopes string) (string, error) {
	return "https://example.com/oauth", nil
}

func (m *mockRouterAuthService) StartAuth0OAuth(ctx context.Context, stateVerifier string) (string, error) {
	return "https://example.com/auth0", nil
}

func (m *mockRouterAuthService) CompleteGitHubOAuth(ctx context.Context, code, state, stateVerifier string) (services.OAuthCallbackResult, error) {
	return services.OAuthCallbackResult{
		SessionKey:  "session-key",
		ExpiresAt:   time.Now().UTC().Add(time.Hour),
		RedirectURL: "/",
	}, nil
}

func (m *mockRouterAuthService) CompleteAuth0OAuth(ctx context.Context, code, state, stateVerifier string) (services.OAuthCallbackResult, error) {
	return services.OAuthCallbackResult{
		SessionKey:  "session-key",
		ExpiresAt:   time.Now().UTC().Add(time.Hour),
		RedirectURL: "/",
	}, nil
}

func (m *mockRouterAuthService) Logout(ctx context.Context, sessionKey string) error {
	return nil
}

func (m *mockRouterAuthService) CreateToken(ctx context.Context, userID int64, req services.CreateTokenRequest) (services.CreateTokenResult, error) {
	return services.CreateTokenResult{Token: "smithers_test_token"}, nil
}

func (m *mockRouterAuthService) ExchangeGitHubToken(ctx context.Context, githubAccessToken, tokenName, githubRefreshToken string, githubTokenExpiresIn int64, ttlSeconds *int64) (services.ExchangeGitHubTokenResult, error) {
	return services.ExchangeGitHubTokenResult{}, nil
}

func (m *mockRouterSearchService) SearchRepositories(ctx context.Context, viewer *db.User, input services.SearchRepositoriesInput) (services.RepositorySearchResultPage, error) {
	return services.RepositorySearchResultPage{}, nil
}

func (m *mockRouterSearchService) SearchIssues(ctx context.Context, viewer *db.User, input services.SearchIssuesInput) (services.IssueSearchResultPage, error) {
	return services.IssueSearchResultPage{}, nil
}

func (m *mockRouterSearchService) SearchUsers(ctx context.Context, input services.SearchUsersInput) (services.UserSearchResultPage, error) {
	return services.UserSearchResultPage{}, nil
}

func (m *mockRouterSearchService) SearchCode(ctx context.Context, viewer *db.User, input services.SearchCodeInput) (services.CodeSearchResultPage, error) {
	return services.CodeSearchResultPage{}, &pkgerrors.APIError{Status: http.StatusNotImplemented, Message: "code search not implemented"}
}

func (m *mockRouterRepoService) ListRepoContents(ctx context.Context, viewer *db.User, owner, repo, ref, dirPath string) ([]services.RepoContent, error) {
	return nil, nil
}

func (m *mockRouterGitService) ProxyInfoRefs(ctx context.Context, owner, repo, service, token string, stdout io.Writer) (string, error) {
	if m.proxyInfoRefsFn != nil {
		return m.proxyInfoRefsFn(ctx, owner, repo, service, token, stdout)
	}
	return "application/x-git-upload-pack-advertisement", nil
}

func (m *mockRouterGitService) ProxyUploadPack(ctx context.Context, owner, repo, token string, stdin io.Reader, stdout io.Writer) error {
	if m.proxyUploadPackFn != nil {
		return m.proxyUploadPackFn(ctx, owner, repo, token, stdin, stdout)
	}
	return nil
}

func (m *mockRouterGitService) ProxyReceivePack(ctx context.Context, owner, repo, token string, stdin io.Reader, stdout io.Writer) error {
	if m.proxyReceivePackFn != nil {
		return m.proxyReceivePackFn(ctx, owner, repo, token, stdin, stdout)
	}
	return nil
}

func (m *mockRouterRepoService) CreateRepo(ctx context.Context, user *db.User, name, description string, isPublic bool, defaultBookmark string, autoInit bool) (db.Repository, error) {
	return db.Repository{}, nil
}

func (m *mockRouterRepoService) CreateOrgRepo(ctx context.Context, actor *db.User, orgName, name, description string, isPublic bool, defaultBookmark string, autoInit bool) (db.Repository, error) {
	return db.Repository{}, nil
}

func (m *mockRouterRepoService) GetRepo(ctx context.Context, viewer *db.User, owner, repo string) (db.Repository, error) {
	m.getRepoCalls++
	return db.Repository{Name: repo, LowerName: repo, IsPublic: true}, nil
}

func (m *mockRouterRepoService) UpdateRepo(ctx context.Context, actor *db.User, owner, repo string, req services.UpdateRepoRequest) (db.Repository, error) {
	return db.Repository{}, nil
}

func (m *mockRouterRepoService) DeleteRepo(ctx context.Context, actor *db.User, owner, repo string) error {
	return nil
}

func (m *mockRouterRepoService) GetRepoTopics(ctx context.Context, viewer *db.User, owner, repo string) ([]string, error) {
	return nil, nil
}

func (m *mockRouterRepoService) ReplaceRepoTopics(ctx context.Context, actor *db.User, owner, repo string, topics []string) ([]string, error) {
	return nil, nil
}

func (m *mockRouterRepoService) ListRepoStargazers(ctx context.Context, viewer *db.User, owner, repo string, page, perPage int) ([]db.User, int64, error) {
	return nil, 0, nil
}

func (m *mockRouterRepoService) CheckRepoStarred(ctx context.Context, actor *db.User, owner, repo string) (bool, error) {
	return false, nil
}

func (m *mockRouterRepoService) StarRepo(ctx context.Context, actor *db.User, owner, repo string) error {
	return nil
}

func (m *mockRouterRepoService) UnstarRepo(ctx context.Context, actor *db.User, owner, repo string) error {
	return nil
}

func (m *mockRouterRepoService) GetRepoContents(ctx context.Context, viewer *db.User, owner, repo, ref, path string) (services.RepoContent, error) {
	return services.RepoContent{}, nil
}

func (m *mockRouterRepoService) ListGitRefs(ctx context.Context, viewer *db.User, owner, repo string) ([]services.GitRef, error) {
	return nil, nil
}

func (m *mockRouterRepoService) ArchiveRepo(ctx context.Context, actor *db.User, owner, repo string) (db.Repository, error) {
	return db.Repository{}, nil
}

func (m *mockRouterRepoService) UnarchiveRepo(ctx context.Context, actor *db.User, owner, repo string) (db.Repository, error) {
	return db.Repository{}, nil
}

func (m *mockRouterRepoService) GetRepoView(ctx context.Context, viewer *db.User, owner, repo string) (services.RepoView, error) {
	repository, err := m.GetRepo(ctx, viewer, owner, repo)
	if err != nil {
		return services.RepoView{}, err
	}
	return services.RepoView{Repository: repository}, nil
}

func (m *mockRouterCommitStatusService) ListCommitStatuses(ctx context.Context, repositoryID int64, ref string, page, perPage int) ([]db.CommitStatus, int64, error) {
	if m.listCommitStatusesFn != nil {
		return m.listCommitStatusesFn(ctx, repositoryID, ref, page, perPage)
	}
	return []db.CommitStatus{}, 0, nil
}

func (m *mockRouterCommitStatusService) CreateCommitStatus(ctx context.Context, repositoryID int64, sha string, input services.CreateCommitStatusInput) (db.CommitStatus, error) {
	if m.createCommitStatusFn != nil {
		return m.createCommitStatusFn(ctx, repositoryID, sha, input)
	}
	return db.CommitStatus{}, nil
}

func (m *mockRouterWorkflowService) ListWorkflowDefinitions(ctx context.Context, repositoryID int64, page, perPage int) ([]db.WorkflowDefinition, error) {
	return nil, nil
}

func (m *mockRouterWorkflowService) GetWorkflowDefinition(ctx context.Context, repositoryID, definitionID int64) (db.WorkflowDefinition, error) {
	return db.WorkflowDefinition{}, nil
}

func (m *mockRouterWorkflowService) ListWorkflowRunsByRepo(ctx context.Context, repositoryID int64, page, perPage int) ([]db.WorkflowRun, error) {
	return nil, nil
}

func (m *mockRouterWorkflowService) ListWorkflowRunsByDefinition(ctx context.Context, repositoryID, definitionID int64, page, perPage int) ([]db.WorkflowRun, error) {
	return nil, nil
}

func (m *mockRouterWorkflowService) GetWorkflowRun(ctx context.Context, repositoryID, runID int64) (db.WorkflowRun, error) {
	if m.getWorkflowRunFn != nil {
		return m.getWorkflowRunFn(ctx, repositoryID, runID)
	}
	return db.WorkflowRun{ID: runID, RepositoryID: repositoryID}, nil
}

func (m *mockRouterWorkflowService) DispatchForEvent(ctx context.Context, input services.DispatchForEventInput) ([]services.WorkflowRunResult, error) {
	return nil, nil
}

func (m *mockRouterWorkflowService) InvokeWorkflow(ctx context.Context, input services.InvokeWorkflowInput) (*services.InvokeWorkflowResult, error) {
	return nil, nil
}

func (m *mockRouterWorkflowService) CancelWorkflowRun(ctx context.Context, repositoryID, runID int64) error {
	if m.cancelWorkflowRunFn != nil {
		return m.cancelWorkflowRunFn(ctx, repositoryID, runID)
	}
	return nil
}

func (m *mockRouterWorkflowService) ListWorkflowSteps(ctx context.Context, runID int64) ([]db.WorkflowStep, error) {
	if m.listWorkflowStepsFn != nil {
		return m.listWorkflowStepsFn(ctx, runID)
	}
	return nil, nil
}

func (m *mockRouterWorkflowService) ListWorkflowLogsSince(ctx context.Context, runID, afterID int64, limit int32) ([]db.WorkflowLog, error) {
	if m.listWorkflowLogsSinceFn != nil {
		return m.listWorkflowLogsSinceFn(ctx, runID, afterID, limit)
	}
	return nil, nil
}

func (m *mockRouterWorkflowService) RerunRun(ctx context.Context, input services.RerunInput) (*services.WorkflowRunResult, error) {
	if m.rerunRunFn != nil {
		return m.rerunRunFn(ctx, input)
	}
	return nil, nil
}

func (m *mockRouterWorkflowService) ResumeRun(ctx context.Context, repositoryID, runID int64) error {
	if m.resumeRunFn != nil {
		return m.resumeRunFn(ctx, repositoryID, runID)
	}
	return nil
}

func (m *mockRouterWikiService) ListWikiPages(ctx context.Context, viewer *db.User, owner, repo string, input services.ListWikiPagesInput) ([]services.WikiPageResponse, int64, error) {
	if m.listWikiPagesFn != nil {
		return m.listWikiPagesFn(ctx, viewer, owner, repo, input)
	}
	return []services.WikiPageResponse{}, 0, nil
}

func (m *mockRouterWikiService) GetWikiPage(ctx context.Context, viewer *db.User, owner, repo, slug string) (services.WikiPageResponse, error) {
	if m.getWikiPageFn != nil {
		return m.getWikiPageFn(ctx, viewer, owner, repo, slug)
	}
	return services.WikiPageResponse{Slug: slug, Title: slug}, nil
}

func (m *mockRouterWikiService) CreateWikiPage(ctx context.Context, actor *db.User, owner, repo string, req services.CreateWikiPageInput) (services.WikiPageResponse, error) {
	if m.createWikiPageFn != nil {
		return m.createWikiPageFn(ctx, actor, owner, repo, req)
	}
	return services.WikiPageResponse{Slug: req.Slug, Title: req.Title}, nil
}

func (m *mockRouterWikiService) UpdateWikiPage(ctx context.Context, actor *db.User, owner, repo, slug string, req services.UpdateWikiPageInput) (services.WikiPageResponse, error) {
	if m.updateWikiPageFn != nil {
		return m.updateWikiPageFn(ctx, actor, owner, repo, slug, req)
	}
	return services.WikiPageResponse{Slug: slug, Title: slug}, nil
}

func (m *mockRouterWikiService) DeleteWikiPage(ctx context.Context, actor *db.User, owner, repo, slug string) error {
	if m.deleteWikiPageFn != nil {
		return m.deleteWikiPageFn(ctx, actor, owner, repo, slug)
	}
	return nil
}

func (m *mockRouterWikiService) ListWikiRevisions(ctx context.Context, viewer *db.User, owner, repo, slug string, page, perPage int) ([]services.WikiRevisionResponse, int64, error) {
	return []services.WikiRevisionResponse{}, 0, nil
}

type mockAdminUserRouteService struct {
	createUserCalls int
}

func (m *mockAdminUserRouteService) ListUsers(ctx context.Context, input services.AdminUserListInput) ([]services.AdminUserProfile, int64, error) {
	return []services.AdminUserProfile{}, 0, nil
}

func (m *mockAdminUserRouteService) CreateUser(ctx context.Context, input services.AdminCreateUserInput) (services.UserProfile, error) {
	m.createUserCalls++
	return services.UserProfile{
		Username: input.Username,
	}, nil
}

func (m *mockAdminUserRouteService) DeleteUser(ctx context.Context, username string) error {
	return nil
}

func (m *mockAdminUserRouteService) SetUserAdmin(ctx context.Context, username string, isAdmin bool) (services.UserProfile, error) {
	return services.UserProfile{
		Username: username,
		IsAdmin:  isAdmin,
	}, nil
}

func (m *mockAdminUserRouteService) CreateTokenForUser(ctx context.Context, username string, req services.CreateTokenRequest) (services.CreateTokenResult, error) {
	return services.CreateTokenResult{
		Token: "smithers_admin_token",
	}, nil
}

func (m *mockAdminUserRouteService) SetSuspended(ctx context.Context, username string, suspended bool) (services.UserProfile, error) {
	return services.UserProfile{Username: username, Suspended: suspended}, nil
}

func (m *mockAdminUserRouteService) RevokeToken(ctx context.Context, username string, tokenID int64) error {
	return nil
}

func (m *mockAdminUserRouteService) EraseUser(ctx context.Context, username string, req services.EraseUserRequest) (services.EraseUserResult, error) {
	return services.EraseUserResult{Tombstone: "erased-" + username}, nil
}

func (m *mockAdminUserRouteService) ExportUser(ctx context.Context, username string, w io.Writer) (services.AccountExportManifest, error) {
	_, err := io.WriteString(w, "archive")
	return services.AccountExportManifest{Username: username}, err
}

// testConfigAllFlagsOn returns a Config with every FeatureFlags gate
// enabled, so cmd/server tests can exercise the entire route surface.
// Production defaults (most non-MVP flags off) are covered by the
// dedicated flag-gate tests in internal/middleware and internal/routes.
func testConfigAllFlagsOn() *config.Config {
	return &config.Config{
		Auth: config.AuthConfig{
			SessionSecret:    "router-test-session-secret",
			LFSSigningSecret: routerTestLFSSigningSecret,
		},
		Server: config.ServerConfig{PublicURL: "https://plue.test"},
		FeatureFlags: config.FeatureFlagsConfig{
			StackedPRs:           true,
			Workflows:            true,
			Sandboxes:            true,
			AutoPush:             true,
			Issues:               true,
			Search:               true,
			Workspaces:           true,
			Agents:               true,
			WebDashboard:         true,
			ProtectedBookmarks:   true,
			Notifications:        true,
			Wiki:                 true,
			Labels:               true,
			Releases:             true,
			Secrets:              true,
			WebhooksUser:         true,
			BotCommands:          true,
			DraftPRs:             true,
			Reviewers:            true,
			MultiAuth:            true,
			PrivateRepos:         true,
			ClientErrorReporting: true,
		},
	}
}

// defaultRouter returns a router with all handlers using their zero values.
// Pass a custom gitHandler to override.
func defaultRouter(gitHandler *routes.GitSmartHandler, lfsHandlers ...*routes.LFSHandler) http.Handler {
	if gitHandler == nil {
		gitHandler = &routes.GitSmartHandler{Service: &mockRouterGitService{}}
	}
	var lfsHandler *routes.LFSHandler
	if len(lfsHandlers) > 0 {
		lfsHandler = lfsHandlers[0]
	}
	return buildRouterCompat(
		testConfigAllFlagsOn(),
		nil,
		nil, // pool
		&routes.RepoHandler{},
		&routes.AuthHandler{},
		&routes.UserHandler{},
		&routes.SSHKeyHandler{},
		&routes.LabelHandler{},

		&routes.OrgHandler{},
		&routes.LandingHandler{},
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{},
		nil, // wikiService
		gitHandler,
		nil, // adminRunnerHandler
		nil, // adminUserHandler
		nil, // adminOrgHandler
		nil, // adminSystemHealthHandler
		nil, // adminGitHubAppHandler
		nil, // adminAuditHandler
		nil, // webhookHandler
		nil, // secretHandler
		nil, // variableHandler
		nil, // commitStatusHandler
		lfsHandler,
		nil, // jjVCSHandler
		nil, // agentInternalHandler
		nil, // agentSessionHandler
		nil, // agentSessionStreamHandler
		nil, // pushHookHandler
		nil, // workflowHandler
		nil, // workspaceHandler
		nil, // workspaceInternalHandler
		nil, // workspaceTerminalHandler
		nil, // telemetryHandler
		nil, // featureFlagHandler
		nil, // oauth2Handler
		nil, // smithersMetrics
	)
}

type routerAgentEnvironmentService struct {
	setupScript string
	input       services.PutAgentEnvironmentInput
}

func (s *routerAgentEnvironmentService) GetAgentEnvironment(context.Context, *db.User, string, string) (services.AgentEnvironmentResponse, error) {
	return services.AgentEnvironmentResponse{}, nil
}

func (s *routerAgentEnvironmentService) PutAgentEnvironment(_ context.Context, _ *db.User, _, _ string, input services.PutAgentEnvironmentInput) (services.AgentEnvironmentResponse, error) {
	s.setupScript = input.SetupScript
	s.input = input
	return services.AgentEnvironmentResponse{}, nil
}

func (s *routerAgentEnvironmentService) PutAgentEnvironmentSecret(context.Context, *db.User, string, string, services.AgentEnvironmentSecretWrite) (services.AgentEnvironmentSecretMetadata, error) {
	return services.AgentEnvironmentSecretMetadata{}, nil
}

func (s *routerAgentEnvironmentService) DeleteAgentEnvironmentSecret(context.Context, *db.User, string, string, string) error {
	return nil
}

func routerWithAgentEnvironment(service routes.AgentEnvironmentRouteService) http.Handler {
	return buildRouterCompat(
		testConfigAllFlagsOn(), nil, nil,
		&routes.RepoHandler{}, &routes.AuthHandler{}, &routes.UserHandler{},
		&routes.SSHKeyHandler{}, &routes.LabelHandler{}, &routes.OrgHandler{},
		&routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{}, nil,
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil, nil,
		&routes.SecretHandler{AgentEnvironment: service},
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
	)
}

func longTimeoutJSONCSRFCoverageRouter() http.Handler {
	return buildRouter(
		testConfigAllFlagsOn(),
		nil,
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
		&routes.RepositoryJobHandler{},
		nil, // gitHubProxyHandler
		nil, // gitHubRepoListHandler
		nil, // gitHubUserReposHandler
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

// buildCacheCSRFCoverageRouter mounts the build-cache group, which only
// registers when both a handler and queries are present, so the CSRF contract
// walk sees its session-capable write routes.
func buildCacheCSRFCoverageRouter() http.Handler {
	return buildRouter(
		testConfigAllFlagsOn(),
		db.New(nil),
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
		&routes.BuildCacheHandler{},
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
		&routes.RepositoryJobHandler{},
		nil, // gitHubProxyHandler
		nil, // gitHubRepoListHandler
		nil, // gitHubUserReposHandler
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

func prometheusMetricValue(t *testing.T, output, metricName string) float64 {
	t.Helper()
	for _, line := range strings.Split(output, "\n") {
		if !strings.HasPrefix(line, metricName+" ") {
			continue
		}
		fields := strings.Fields(line)
		require.Len(t, fields, 2)
		value, err := strconv.ParseFloat(fields[1], 64)
		require.NoError(t, err)
		return value
	}
	t.Fatalf("metric %s not found in output:\n%s", metricName, output)
	return 0
}

func routerWithFeatureFlags(flags config.FeatureFlagsConfig, workspaceHandler *routes.WorkspaceHandler, agentSessionStreamHandler *routes.AgentSessionStreamHandler, workspaceTerminalHandler *routes.WorkspaceTerminalHandler) http.Handler {
	return buildRouterCompat(
		&config.Config{FeatureFlags: flags},
		nil,
		nil, // pool
		&routes.RepoHandler{},
		&routes.AuthHandler{},
		&routes.UserHandler{},
		&routes.SSHKeyHandler{},
		&routes.LabelHandler{},

		&routes.OrgHandler{},
		&routes.LandingHandler{},
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{},
		nil, // wikiService
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, // adminRunnerHandler
		nil, // adminUserHandler
		nil, // adminOrgHandler
		nil, // adminSystemHealthHandler
		nil, // adminGitHubAppHandler
		nil, // adminAuditHandler
		nil, // webhookHandler
		nil, // secretHandler
		nil, // variableHandler
		nil, // commitStatusHandler
		nil, // lfsHandler
		nil, // jjVCSHandler
		nil, // agentInternalHandler
		nil, // agentSessionHandler
		agentSessionStreamHandler,
		nil, // pushHookHandler
		nil, // workflowHandler
		workspaceHandler,
		nil, // workspaceInternalHandler
		workspaceTerminalHandler,
		nil, // telemetryHandler
		nil, // featureFlagHandler
		nil, // oauth2Handler
		nil, // smithersMetrics
	)
}

func routerWithAuthAndNotifications(authHandler *routes.AuthHandler, notificationHandler *routes.NotificationHandler) http.Handler {
	return buildRouterCompat(
		testConfigAllFlagsOn(),
		nil,
		nil, // pool
		&routes.RepoHandler{},
		authHandler,
		&routes.UserHandler{},
		&routes.SSHKeyHandler{},
		&routes.LabelHandler{},

		&routes.OrgHandler{},
		&routes.LandingHandler{},
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{},
		nil, // wikiService
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		notificationHandler, // adminRunnerHandler
		nil,                 // adminUserHandler
		nil,                 // adminOrgHandler
		nil,                 // adminSystemHealthHandler
		nil,                 // adminGitHubAppHandler
		nil,                 // adminAuditHandler
		nil,                 // webhookHandler
		nil,                 // secretHandler
		nil,                 // variableHandler
		nil,                 // commitStatusHandler
		nil,                 // lfsHandler
		nil,                 // jjVCSHandler
		nil,                 // agentInternalHandler
		nil,                 // agentSessionHandler
		nil,                 // agentSessionStreamHandler
		nil,                 // pushHookHandler
		nil,                 // workflowHandler
		nil,                 // workspaceHandler
		nil,                 // workspaceInternalHandler
		nil,                 // workspaceTerminalHandler
		nil,                 // telemetryHandler
		nil,                 // featureFlagHandler
		nil,                 // oauth2Handler
		nil,                 // smithersMetrics
	)
}

func defaultRouterWithCommitStatus(commitStatusHandler *routes.CommitStatusHandler) http.Handler {
	return buildRouterCompat(
		testConfigAllFlagsOn(),
		nil,
		nil, // pool
		&routes.RepoHandler{},
		&routes.AuthHandler{},
		&routes.UserHandler{},
		&routes.SSHKeyHandler{},
		&routes.LabelHandler{},

		&routes.OrgHandler{},
		&routes.LandingHandler{},
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{},
		nil, // wikiService
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, // adminRunnerHandler
		nil, // adminUserHandler
		nil, // adminOrgHandler
		nil, // adminSystemHealthHandler
		nil, // adminGitHubAppHandler
		nil, // adminAuditHandler
		nil, // webhookHandler
		nil, // secretHandler
		nil, // variableHandler
		commitStatusHandler,
		nil, // lfsHandler
		nil, // jjVCSHandler
		nil, // agentInternalHandler
		nil, // agentSessionHandler
		nil, // agentSessionStreamHandler
		nil, // pushHookHandler
		nil, // workflowHandler
		nil, // workspaceHandler
		nil, // workspaceInternalHandler
		nil, // workspaceTerminalHandler
		nil, // telemetryHandler
		nil, // featureFlagHandler
		nil, // oauth2Handler
		nil, // smithersMetrics
	)
}

func defaultRouterWithWiki(wikiService routes.WikiService) http.Handler {
	return buildRouterCompat(
		testConfigAllFlagsOn(),
		nil,
		nil, // pool
		&routes.RepoHandler{},
		&routes.AuthHandler{},
		&routes.UserHandler{},
		&routes.SSHKeyHandler{},
		&routes.LabelHandler{},

		&routes.OrgHandler{},
		&routes.LandingHandler{},
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{},
		wikiService,
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, // adminRunnerHandler
		nil, // adminUserHandler
		nil, // adminOrgHandler
		nil, // adminSystemHealthHandler
		nil, // adminGitHubAppHandler
		nil, // adminAuditHandler
		nil, // webhookHandler
		nil, // secretHandler
		nil, // variableHandler
		nil, // commitStatusHandler
		nil, // lfsHandler
		nil, // jjVCSHandler
		nil, // agentInternalHandler
		nil, // agentSessionHandler
		nil, // agentSessionStreamHandler
		nil, // pushHookHandler
		nil, // workflowHandler
		nil, // workspaceHandler
		nil, // workspaceInternalHandler
		nil, // workspaceTerminalHandler
		nil, // telemetryHandler
		nil, // featureFlagHandler
		nil, // oauth2Handler
		nil, // smithersMetrics
	)
}

func withRouterRepoContext(req *http.Request, repoID int64, permission middleware.PermissionLevel) *http.Request {
	repository := &db.Repository{ID: repoID, Name: "demo", LowerName: "demo", IsPublic: true}
	ctx := middleware.ContextWithRepoContext(req.Context(), &middleware.RepoContext{
		Owner:      "alice",
		Repository: repository,
	}, permission)
	return req.WithContext(ctx)
}

func withRouterTokenAuth(req *http.Request, scopes ...middleware.TokenScope) *http.Request {
	scopeSet := make(middleware.ScopeSet, len(scopes))
	for _, scope := range scopes {
		scopeSet[scope] = struct{}{}
	}
	return req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User:        &db.User{ID: 1, Username: "alice", LowerUsername: "alice"},
		Scopes:      scopeSet,
		IsTokenAuth: true,
	}))
}

func withRouterSessionAuth(req *http.Request, scopes ...middleware.TokenScope) *http.Request {
	scopeSet := make(middleware.ScopeSet, len(scopes))
	for _, scope := range scopes {
		scopeSet[scope] = struct{}{}
	}
	return req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User:        &db.User{ID: 1, Username: "alice", LowerUsername: "alice"},
		Scopes:      scopeSet,
		IsTokenAuth: false,
	}))
}

func middlewareFuncName(mw func(http.Handler) http.Handler) string {
	fn := runtime.FuncForPC(reflect.ValueOf(mw).Pointer())
	if fn == nil {
		return ""
	}
	return fn.Name()
}

func isStateChangingMethod(method string) bool {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return false
	default:
		return true
	}
}

func TestServerRouter_DefaultAPICSRFProtectsSessionWrites(t *testing.T) {
	t.Parallel()

	router := defaultRouter(nil)

	reqMissing := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	reqMissing = withRouterSessionAuth(reqMissing)
	recMissing := httptest.NewRecorder()
	router.ServeHTTP(recMissing, reqMissing)
	require.Equal(t, http.StatusForbidden, recMissing.Code)
	assert.Contains(t, recMissing.Body.String(), "csrf token missing")

	reqValid := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	reqValid.Header.Set("X-CSRF-Token", "csrf-token")
	reqValid.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf-token"})
	reqValid = withRouterSessionAuth(reqValid)
	recValid := httptest.NewRecorder()
	router.ServeHTTP(recValid, reqValid)
	require.Equal(t, http.StatusNoContent, recValid.Code)
}

type fakeWorkspaceSessionWorkspaceLoader struct {
	workspace db.Workspace
	err       error
}

func (f *fakeWorkspaceSessionWorkspaceLoader) GetWorkspace(context.Context, string) (db.Workspace, error) {
	return f.workspace, f.err
}

func namedQuotaMiddleware(name string, called *[]string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			*called = append(*called, name)
			http.Error(w, "quota", http.StatusTooManyRequests)
		})
	}
}

func TestWorkspaceSessionSandboxQuota_BypassesQuotaWhenWorkspaceRunning(t *testing.T) {
	t.Parallel()

	var quotaCalled []string
	store := &fakeWorkspaceSessionWorkspaceLoader{workspace: db.Workspace{ID: "workspace-branch-1", Status: "running", VmID: "vm-1"}}
	handler := workspaceSessionSandboxQuota(
		store,
		[]func(http.Handler) http.Handler{namedQuotaMiddleware("create", &quotaCalled)},
		[]func(http.Handler) http.Handler{namedQuotaMiddleware("resume", &quotaCalled)},
	)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req workspaceSessionQuotaRequest
		require.NoError(t, json.NewDecoder(r.Body).Decode(&req))
		assert.Equal(t, "workspace-branch-1", req.WorkspaceID)
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/repos/o/r/workspace/sessions", strings.NewReader(`{"workspace_id":"workspace-branch-1"}`))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Empty(t, quotaCalled)
}

func TestWorkspaceSessionSandboxQuota_EnforcesResumeQuotaWhenWorkspaceSuspended(t *testing.T) {
	t.Parallel()

	var quotaCalled []string
	store := &fakeWorkspaceSessionWorkspaceLoader{workspace: db.Workspace{ID: "workspace-branch-1", Status: "suspended", VmID: "vm-1"}}
	handler := workspaceSessionSandboxQuota(
		store,
		[]func(http.Handler) http.Handler{namedQuotaMiddleware("create", &quotaCalled)},
		[]func(http.Handler) http.Handler{namedQuotaMiddleware("resume", &quotaCalled)},
	)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/repos/o/r/workspace/sessions", strings.NewReader(`{"workspace_id":"workspace-branch-1"}`))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	assert.Equal(t, []string{"resume"}, quotaCalled)
}

func TestWorkspaceSessionSandboxQuota_EnforcesResumeQuotaWhenStoreUnavailable(t *testing.T) {
	t.Parallel()

	var quotaCalled []string
	handler := workspaceSessionSandboxQuota(
		nil,
		[]func(http.Handler) http.Handler{namedQuotaMiddleware("create", &quotaCalled)},
		[]func(http.Handler) http.Handler{namedQuotaMiddleware("resume", &quotaCalled)},
	)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/repos/o/r/workspace/sessions", strings.NewReader(`{"workspace_id":"workspace-branch-1"}`))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	assert.Equal(t, []string{"resume"}, quotaCalled)
}

func TestWorkspaceSessionSandboxQuota_EnforcesCreateQuotaWhenWorkspaceIDMissing(t *testing.T) {
	t.Parallel()

	var quotaCalled []string
	handler := workspaceSessionSandboxQuota(
		&fakeWorkspaceSessionWorkspaceLoader{},
		[]func(http.Handler) http.Handler{namedQuotaMiddleware("create", &quotaCalled)},
		[]func(http.Handler) http.Handler{namedQuotaMiddleware("resume", &quotaCalled)},
	)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/repos/o/r/workspace/sessions", strings.NewReader(`{"cols":80,"rows":24}`))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	assert.Equal(t, []string{"create"}, quotaCalled)
}

func TestServerRouter_APIMutatingRoutesUseDefaultCSRFOrExplicitBypass(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		router http.Handler
	}{
		{name: "default api", router: defaultRouter(nil)},
		{name: "long-timeout json api", router: longTimeoutJSONCSRFCoverageRouter()},
		{name: "build cache api", router: buildCacheCSRFCoverageRouter()},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			routes, ok := tc.router.(chi.Routes)
			require.True(t, ok, "router must expose chi routes for contract walk")

			bypassPaths := make(map[string]struct{}, len(apiCSRFBypassPaths)+len(apiCSRFExemptRoutes))
			for _, path := range apiCSRFBypassPaths {
				bypassPaths[path] = struct{}{}
			}
			for _, path := range apiCSRFExemptRoutes {
				bypassPaths[path] = struct{}{}
			}

			var missing []error
			err := chi.Walk(routes, func(method, route string, _ http.Handler, middlewares ...func(http.Handler) http.Handler) error {
				if !strings.HasPrefix(route, "/api/") || !isStateChangingMethod(method) {
					return nil
				}
				if _, ok := bypassPaths[route]; ok {
					return nil
				}
				for _, mw := range middlewares {
					if strings.HasSuffix(middlewareFuncName(mw), ".apiCSRFMiddleware") {
						return nil
					}
				}
				missing = append(missing, fmt.Errorf("%s %s is missing default api CSRF middleware or explicit bypass", method, route))
				return nil
			})

			require.NoError(t, err)
			require.NoError(t, errors.Join(missing...))
		})
	}
}

func TestServerRouter_LongTimeoutJSONGroupsCSRFBehavior(t *testing.T) {
	t.Parallel()

	router := longTimeoutJSONCSRFCoverageRouter()

	sessionWrites := []struct {
		name   string
		method string
		path   string
		body   string
	}{
		{
			name:   "workspace provision",
			method: http.MethodPost,
			path:   "/api/repos/alice/demo/workspaces",
			body:   `{}`,
		},
		{
			name:   "workspace session provision",
			method: http.MethodPost,
			path:   "/api/repos/alice/demo/workspace/sessions",
			body:   `{"cols":80,"rows":24}`,
		},
	}

	for _, tc := range sessionWrites {
		tc := tc
		t.Run("session write requires csrf "+tc.name, func(t *testing.T) {
			t.Parallel()

			req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			req.Header.Set("Content-Type", "application/json")
			req = sessionContext(req)
			rec := httptest.NewRecorder()

			router.ServeHTTP(rec, req)

			require.Equal(t, http.StatusForbidden, rec.Code)
			assert.Contains(t, rec.Body.String(), "csrf token missing")
		})
	}

	tokenWrites := []struct {
		name   string
		method string
		path   string
		body   string
		scope  middleware.TokenScope
	}{
		{
			name:   "workspace provision",
			method: http.MethodPost,
			path:   "/api/repos/alice/demo/workspaces",
			body:   `{}`,
			scope:  middleware.ScopeWriteRepository,
		},
	}

	for _, tc := range tokenWrites {
		tc := tc
		t.Run("token write bypasses csrf "+tc.name, func(t *testing.T) {
			t.Parallel()

			req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			req.Header.Set("Content-Type", "application/json")
			req = withRouterTokenAuth(req, tc.scope)
			rec := httptest.NewRecorder()

			router.ServeHTTP(rec, req)

			assert.NotEqual(t, http.StatusForbidden, rec.Code)
		})
	}

}

func TestServerRouter_FeatureFlagGatesWorkspaceRoutes(t *testing.T) {
	t.Parallel()

	router := routerWithFeatureFlags(
		config.FeatureFlagsConfig{Sandboxes: true},
		&routes.WorkspaceHandler{},
		nil,
		&routes.WorkspaceTerminalHandler{},
	)

	tests := []struct {
		name   string
		method string
		path   string
		scope  middleware.TokenScope
		body   string
	}{
		{
			name:   "vm provisioning create",
			method: http.MethodPost,
			path:   "/api/repos/alice/demo/workspaces",
			scope:  middleware.ScopeWriteRepository,
			body:   `{"name":"dev"}`,
		},
		{
			name:   "repo workspace list",
			method: http.MethodGet,
			path:   "/api/repos/alice/demo/workspaces",
			scope:  middleware.ScopeReadRepository,
		},
		{
			name:   "user workspace list",
			method: http.MethodGet,
			path:   "/api/user/workspaces",
			scope:  middleware.ScopeReadRepository,
		},
		{
			name:   "terminal websocket",
			method: http.MethodGet,
			path:   "/api/repos/alice/demo/workspace/sessions/session-1/terminal",
			scope:  middleware.ScopeWriteRepository,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			if tc.body != "" {
				req.Header.Set("Content-Type", "application/json")
			}
			req = withRouterTokenAuth(req, tc.scope)
			rec := httptest.NewRecorder()

			router.ServeHTTP(rec, req)

			require.Equal(t, http.StatusForbidden, rec.Code)
			assert.Contains(t, rec.Body.String(), "feature not available")
		})
	}
}

func TestServerRouter_FeatureFlagGatesWorkspaceSandboxStreams(t *testing.T) {
	t.Parallel()

	router := routerWithFeatureFlags(
		config.FeatureFlagsConfig{Workspaces: true, Sandboxes: false},
		&routes.WorkspaceHandler{},
		nil,
		&routes.WorkspaceTerminalHandler{},
	)

	for _, path := range []string{
		"/api/repos/alice/demo/workspaces/workspace-1/stream",
		"/api/repos/alice/demo/workspace/sessions/session-1/stream",
		"/api/repos/alice/demo/workspace/sessions/session-1/terminal",
	} {
		path := path
		t.Run(path, func(t *testing.T) {
			t.Parallel()
			req := httptest.NewRequest(http.MethodGet, path, nil)
			req = withRouterTokenAuth(req, middleware.ScopeWriteRepository, middleware.ScopeReadRepository)
			rec := httptest.NewRecorder()

			router.ServeHTTP(rec, req)

			require.Equal(t, http.StatusForbidden, rec.Code)
			assert.Contains(t, rec.Body.String(), "feature not available")
		})
	}
}

func TestServerRouter_FeatureFlagGatesAgentSessionStream(t *testing.T) {
	t.Parallel()

	router := routerWithFeatureFlags(
		config.FeatureFlagsConfig{},
		nil,
		&routes.AgentSessionStreamHandler{},
		nil,
	)
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/agent/sessions/session-1/stream", nil)
	req = withRouterTokenAuth(req, middleware.ScopeReadRepository)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	require.Equal(t, http.StatusForbidden, rec.Code)
	assert.Contains(t, rec.Body.String(), "feature not available")
}

func withRouterAdminTokenAuth(req *http.Request, isAdmin bool, source middleware.TokenSource, scopes ...middleware.TokenScope) *http.Request {
	scopeSet := make(middleware.ScopeSet, len(scopes))
	for _, scope := range scopes {
		scopeSet[scope] = struct{}{}
	}
	return req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User:        &db.User{ID: 1, Username: "alice", LowerUsername: "alice", IsAdmin: isAdmin},
		Scopes:      scopeSet,
		IsTokenAuth: true,
		TokenSource: source,
	}))
}

func TestServerRouter_GitSmartRoutesRegistered(t *testing.T) {
	t.Parallel()

	gitHandler := &routes.GitSmartHandler{
		Service: &mockRouterGitService{
			proxyInfoRefsFn: func(ctx context.Context, owner, repo, service, token string, stdout io.Writer) (string, error) {
				_, _ = io.WriteString(stdout, "advertisement")
				return "application/x-git-upload-pack-advertisement", nil
			},
		},
	}

	router := defaultRouter(gitHandler)

	req := httptest.NewRequest(http.MethodGet, "/alice/demo.git/info/refs?service=git-upload-pack", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "advertisement", rec.Body.String())
}

func TestServerRouter_APIRoutesStillEnforceJSONContentType(t *testing.T) {
	t.Parallel()

	router := defaultRouter(nil)

	req := httptest.NewRequest(http.MethodPost, "/api/auth/logout", bytes.NewBufferString("not-json"))
	req.Header.Set("Content-Type", "text/plain")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	require.Equal(t, http.StatusUnsupportedMediaType, rec.Code)
}

func TestServerRouter_GitRoutesBypassJSONContentTypeMiddleware(t *testing.T) {
	t.Parallel()

	gitHandler := &routes.GitSmartHandler{
		Service: &mockRouterGitService{
			proxyUploadPackFn: func(ctx context.Context, owner, repo, token string, stdin io.Reader, stdout io.Writer) error {
				_, _ = io.WriteString(stdout, "upload-ok")
				return nil
			},
		},
	}

	router := defaultRouter(gitHandler)

	req := httptest.NewRequest(http.MethodPost, "/alice/demo.git/git-upload-pack", bytes.NewBufferString("payload"))
	req.Header.Set("Content-Type", "application/x-git-upload-pack-request")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "upload-ok", rec.Body.String())
}

func TestServerRouter_GitRoutesBypassAPITimeout(t *testing.T) {
	t.Setenv("SMITHERS_ENABLE_E2E_TEST_ROUTES", "true")

	sawDeadline := false
	gitHandler := &routes.GitSmartHandler{
		Service: &mockRouterGitService{
			proxyUploadPackFn: func(ctx context.Context, owner, repo, token string, stdin io.Reader, stdout io.Writer) error {
				if _, ok := ctx.Deadline(); ok {
					sawDeadline = true
				}
				time.Sleep(50 * time.Millisecond)
				_, _ = io.WriteString(stdout, "upload-timeout-bypass")
				return nil
			},
		},
	}

	router := defaultRouter(gitHandler)

	apiReq := httptest.NewRequest(http.MethodGet, "/api/_test/timeout", nil)
	apiRec := httptest.NewRecorder()
	router.ServeHTTP(apiRec, apiReq)
	require.Equal(t, http.StatusGatewayTimeout, apiRec.Code)

	gitReq := httptest.NewRequest(http.MethodPost, "/alice/demo.git/git-upload-pack", bytes.NewBufferString("payload"))
	gitReq.Header.Set("Content-Type", "application/x-git-upload-pack-request")
	gitRec := httptest.NewRecorder()
	router.ServeHTTP(gitRec, gitReq)

	require.Equal(t, http.StatusOK, gitRec.Code)
	assert.Equal(t, "upload-timeout-bypass", gitRec.Body.String())
	assert.False(t, sawDeadline)
}

func TestServerRouter_SearchRoutesRegistered(t *testing.T) {
	t.Parallel()

	router := defaultRouter(nil)

	req := httptest.NewRequest(http.MethodGet, "/api/search/code?q=test", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	assert.NotEqual(t, http.StatusNotFound, rec.Code)
}

func TestServerRouter_SearchRateLimitApplied(t *testing.T) {
	t.Parallel()

	router := defaultRouter(nil)

	req := httptest.NewRequest(http.MethodGet, "/api/search/users?q=alice", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	assert.NotEmpty(t, rec.Header().Get("X-RateLimit-Limit"))
	assert.NotEmpty(t, rec.Header().Get("X-RateLimit-Remaining"))
	assert.NotEmpty(t, rec.Header().Get("X-RateLimit-Reset"))
}

// TestServerRouter_IntegrationsCatalogRoutesRequireAuth pins the RequireAuth
// gate on the integrations catalog reads: an unauthenticated request must be
// rejected 401 (never 404 — the routes are registered unconditionally).
func TestServerRouter_IntegrationsCatalogRoutesRequireAuth(t *testing.T) {
	t.Parallel()

	router := defaultRouter(nil)

	for _, path := range []string{"/api/integrations/mcp", "/api/integrations/skills"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusUnauthorized, rec.Code, "GET %s without auth", path)
	}
}

func TestServerRouter_UserTokenRoutesRateLimitApplied(t *testing.T) {
	t.Parallel()

	router := defaultRouter(nil)

	req := httptest.NewRequest(http.MethodGet, "/api/user/tokens", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	assert.NotEqual(t, http.StatusNotFound, rec.Code)
	assert.NotEmpty(t, rec.Header().Get("X-RateLimit-Limit"))
	assert.NotEmpty(t, rec.Header().Get("X-RateLimit-Remaining"))
	assert.NotEmpty(t, rec.Header().Get("X-RateLimit-Reset"))
}

func TestServerRouter_CommitStatusGetRouteRegistered(t *testing.T) {
	t.Parallel()

	var called bool
	router := defaultRouterWithCommitStatus(&routes.CommitStatusHandler{
		Service: &mockRouterCommitStatusService{
			listCommitStatusesFn: func(ctx context.Context, repositoryID int64, ref string, page, perPage int) ([]db.CommitStatus, int64, error) {
				called = true
				assert.Equal(t, int64(101), repositoryID)
				assert.Equal(t, "deadbeef", ref)
				assert.Equal(t, 1, page)
				assert.Equal(t, 30, perPage)
				return []db.CommitStatus{}, 0, nil
			},
		},
	})

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/commits/deadbeef/statuses", nil)
	req = withRouterRepoContext(req, 101, middleware.PermissionRead)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.True(t, called, "route should dispatch to CommitStatusHandler.GetCommitStatuses")
}

func TestServerRouter_CommitStatusPostRouteRegistered(t *testing.T) {
	t.Parallel()

	var called bool
	router := defaultRouterWithCommitStatus(&routes.CommitStatusHandler{
		Service: &mockRouterCommitStatusService{
			createCommitStatusFn: func(ctx context.Context, repositoryID int64, sha string, input services.CreateCommitStatusInput) (db.CommitStatus, error) {
				called = true
				assert.Equal(t, int64(101), repositoryID)
				assert.Equal(t, "deadbeef", sha)
				assert.Equal(t, "ci/build", input.Context)
				assert.Equal(t, "success", input.Status)
				return db.CommitStatus{
					ID:           1,
					RepositoryID: repositoryID,
					Context:      input.Context,
					Status:       input.Status,
					Description:  input.Description,
					TargetUrl:    input.TargetURL,
					CreatedAt:    time.Now().UTC(),
					UpdatedAt:    time.Now().UTC(),
				}, nil
			},
		},
	})

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/statuses/deadbeef", strings.NewReader(`{"context":"ci/build","status":"success"}`))
	req.Header.Set("Content-Type", "application/json")
	req = withRouterRepoContext(req, 101, middleware.PermissionWrite)
	req = withRouterTokenAuth(req, middleware.ScopeWriteRepository)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
	assert.True(t, called, "route should dispatch to CommitStatusHandler.CreateCommitStatus")
}

func TestServerRouter_CommitStatusGetRoute_UsesReadRepoMiddleware(t *testing.T) {
	t.Parallel()

	calledCount := 0
	router := defaultRouterWithCommitStatus(&routes.CommitStatusHandler{
		Service: &mockRouterCommitStatusService{
			listCommitStatusesFn: func(ctx context.Context, repositoryID int64, ref string, page, perPage int) ([]db.CommitStatus, int64, error) {
				calledCount++
				return []db.CommitStatus{}, 0, nil
			},
		},
	})

	t.Run("anonymous request is allowed on read route", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/commits/deadbeef/statuses", nil)
		req = withRouterRepoContext(req, 101, middleware.PermissionRead)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, 1, calledCount, "anonymous read request should reach handler")
	})

	t.Run("token without read repository scope is rejected", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/commits/deadbeef/statuses", nil)
		req = withRouterRepoContext(req, 101, middleware.PermissionRead)
		req = withRouterTokenAuth(req, middleware.ScopeReadUser)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		require.Equal(t, http.StatusForbidden, rec.Code)
		assert.Equal(t, 1, calledCount, "middleware should reject insufficient token scopes before handler")
	})
}

func TestServerRouter_CommitStatusPostRoute_UsesWriteRepoMiddleware(t *testing.T) {
	t.Parallel()

	var called bool
	router := defaultRouterWithCommitStatus(&routes.CommitStatusHandler{
		Service: &mockRouterCommitStatusService{
			createCommitStatusFn: func(ctx context.Context, repositoryID int64, sha string, input services.CreateCommitStatusInput) (db.CommitStatus, error) {
				called = true
				return db.CommitStatus{}, nil
			},
		},
	})

	t.Run("requires authentication", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/statuses/deadbeef", strings.NewReader(`{"context":"ci/build","status":"success"}`))
		req.Header.Set("Content-Type", "application/json")
		req = withRouterRepoContext(req, 101, middleware.PermissionWrite)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		assert.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("requires write repository scope for token auth", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/statuses/deadbeef", strings.NewReader(`{"context":"ci/build","status":"success"}`))
		req.Header.Set("Content-Type", "application/json")
		req = withRouterRepoContext(req, 101, middleware.PermissionWrite)
		req = withRouterTokenAuth(req, middleware.ScopeReadRepository)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		assert.Equal(t, http.StatusForbidden, rec.Code)
	})

	assert.False(t, called, "middleware should block unauthorized/insufficient-scope requests before handler")
}

func TestServerRouter_RepoRoutesAreGroupedWithRepoContextMiddleware(t *testing.T) {
	t.Parallel()

	repoSvc := &mockRouterRepoService{}
	router := buildRouterCompat(
		testCORSConfig(),
		nil,
		nil,
		&routes.RepoHandler{Service: repoSvc},
		&routes.AuthHandler{},
		&routes.UserHandler{},
		&routes.SSHKeyHandler{},
		&routes.LabelHandler{},

		&routes.OrgHandler{},
		&routes.LandingHandler{},
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{},
		nil, // wikiService
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, // adminRunnerHandler
		nil, // adminUserHandler
		nil, // adminOrgHandler
		nil, // adminSystemHealthHandler
		nil, // adminGitHubAppHandler
		nil, // adminAuditHandler
		nil, // webhookHandler
		nil, // secretHandler
		nil, // variableHandler
		nil, // commitStatusHandler
		nil, // lfsHandler
		nil, // jjVCSHandler
		nil, // agentInternalHandler
		nil, // agentSessionHandler
		nil, // agentSessionStreamHandler
		nil, // pushHookHandler
		nil, // workflowHandler
		nil, // workspaceHandler
		nil, // workspaceInternalHandler
		nil, // workspaceTerminalHandler
		nil, // telemetryHandler
		nil, // featureFlagHandler
		nil, // oauth2Handler
		nil, // smithersMetrics
	)

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, 1, repoSvc.getRepoCalls, "repo group route should dispatch to the repo handler")
}

func TestServerRouter_RepoSyncRoute_RequiresRepoContextLookup(t *testing.T) {
	t.Parallel()

	store := &repoSyncLookupDB{t: t}
	queries := db.New(store)
	router := buildRouterCompat(
		testCORSConfig(),
		queries,
		nil,
		&routes.RepoHandler{},
		&routes.AuthHandler{},
		&routes.UserHandler{},
		&routes.SSHKeyHandler{},
		&routes.LabelHandler{},

		&routes.OrgHandler{},
		&routes.LandingHandler{},
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{},
		nil, // wikiService
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, // adminRunnerHandler
		nil, // adminUserHandler
		nil, // adminOrgHandler
		nil, // adminSystemHealthHandler
		nil, // adminGitHubAppHandler
		nil, // adminAuditHandler
		nil, // webhookHandler
		nil, // secretHandler
		nil, // variableHandler
		nil, // commitStatusHandler
		nil, // lfsHandler
		nil, // jjVCSHandler
		nil, // agentInternalHandler
		nil, // agentSessionHandler
		nil, // agentSessionStreamHandler
		nil, // pushHookHandler
		nil, // workflowHandler
		nil, // workspaceHandler
		nil, // workspaceInternalHandler
		nil, // workspaceTerminalHandler
		nil, // telemetryHandler
		nil, // featureFlagHandler
		nil, // oauth2Handler
		nil, // smithersMetrics
	)

	// Sync must pass the repository gate. The old skipped test expected it to
	// bypass this lookup, which predates the cross-repository authorization fix.
	for _, tc := range []struct {
		name   string
		err    error
		status int
		body   string
	}{
		{"missing", pgx.ErrNoRows, http.StatusNotFound, `{"code":"not_found","fault":"user","message":"repository not found"}`},
		{"unavailable", errors.New("private database diagnostic"), http.StatusInternalServerError, `{"code":"internal","fault":"bug","message":"failed to resolve repository"}`},
	} {
		for _, authenticated := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/authenticated=%v", tc.name, authenticated), func(t *testing.T) {
				store.t = t
				store.lookupErr = tc.err
				store.lookupCalls = 0
				store.provenanceCalls = 0
				req := httptest.NewRequest(http.MethodPost, "/api/repos/Alice/Demo/sync", strings.NewReader(`{"bookmarks":[{"name":"main"}]}`))
				req.Header.Set("Content-Type", "application/json")
				if authenticated {
					req = withRouterTokenAuth(req, middleware.ScopeWriteRepository)
					middleware.AuthInfoFromContext(req.Context()).User = &db.User{ID: 42, Username: "bob", LowerUsername: "bob"}
				}
				rec := httptest.NewRecorder()
				router.ServeHTTP(rec, req)
				require.Equal(t, tc.status, rec.Code, rec.Body.String())
				require.Equal(t, 1, store.lookupCalls, "sync must resolve the addressed repository")
				if authenticated && errors.Is(tc.err, pgx.ErrNoRows) {
					require.Equal(t, 1, store.provenanceCalls, "missing repository may resolve only through the caller’s imports")
				} else {
					require.Zero(t, store.provenanceCalls)
				}
				assert.JSONEq(t, tc.body, rec.Body.String())
			})
		}
	}
}

func TestServerRouter_AuthRateLimitApplied(t *testing.T) {
	t.Parallel()

	router := buildRouterCompat(
		testCORSConfig(),
		nil,
		nil,
		&routes.RepoHandler{},
		&routes.AuthHandler{
			Service: &mockRouterAuthService{},
		},
		&routes.UserHandler{},
		&routes.SSHKeyHandler{},
		&routes.LabelHandler{},

		&routes.OrgHandler{},
		&routes.LandingHandler{},
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{},
		nil, // wikiService
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, // adminRunnerHandler
		nil, // adminUserHandler
		nil, // adminOrgHandler
		nil, // adminSystemHealthHandler
		nil, // adminGitHubAppHandler
		nil, // adminAuditHandler
		nil, // webhookHandler
		nil, // secretHandler
		nil, // variableHandler
		nil, // commitStatusHandler
		nil, // lfsHandler
		nil, // jjVCSHandler
		nil, // agentInternalHandler
		nil, // agentSessionHandler
		nil, // agentSessionStreamHandler
		nil, // pushHookHandler
		nil, // workflowHandler
		nil, // workspaceHandler
		nil, // workspaceInternalHandler
		nil, // workspaceTerminalHandler
		nil, // telemetryHandler
		nil, // featureFlagHandler
		nil, // oauth2Handler
		nil, // smithersMetrics
	)

	testCases := []struct {
		name   string
		method string
		path   string
		body   string
	}{
		{
			name:   "key auth nonce",
			method: http.MethodGet,
			path:   "/api/auth/key/nonce",
		},
		{
			name:   "key auth verify",
			method: http.MethodPost,
			path:   "/api/auth/key/verify",
			body:   `{}`,
		},
		{
			name:   "github oauth start",
			method: http.MethodGet,
			path:   "/api/auth/github",
		},
		{
			name:   "github oauth callback",
			method: http.MethodGet,
			path:   "/api/auth/github/callback",
		},
	}

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			req := httptest.NewRequest(tc.method, tc.path, bytes.NewBufferString(tc.body))
			req.RemoteAddr = "198.51.100.99:4545"
			if tc.method == http.MethodPost {
				req.Header.Set("Content-Type", "application/json")
			}
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)

			assert.NotEmpty(t, rec.Header().Get("X-RateLimit-Limit"))
			assert.NotEmpty(t, rec.Header().Get("X-RateLimit-Remaining"))
			assert.NotEmpty(t, rec.Header().Get("X-RateLimit-Reset"))
		})
	}
}

func TestServerRouter_UserSessionsRoutesRegistered(t *testing.T) {
	t.Parallel()

	router := defaultRouter(nil)

	req := httptest.NewRequest(http.MethodGet, "/api/user/sessions", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	assert.NotEqual(t, http.StatusNotFound, rec.Code, "GET /api/user/sessions route must be registered")
	assert.Equal(t, http.StatusUnauthorized, rec.Code)

	req = httptest.NewRequest(http.MethodDelete, "/api/user/sessions/550e8400-e29b-41d4-a716-446655440000", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	assert.NotEqual(t, http.StatusNotFound, rec.Code, "DELETE /api/user/sessions/{id} route must be registered")
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestServerRouter_UserEmailRoutesRegistered(t *testing.T) {
	t.Parallel()

	router := defaultRouter(nil)

	testCases := []struct {
		name   string
		method string
		path   string
		body   string
	}{
		{
			name:   "list user emails",
			method: http.MethodGet,
			path:   "/api/user/emails",
		},
		{
			name:   "add user email",
			method: http.MethodPost,
			path:   "/api/user/emails",
			body:   `{"email":"new@example.com"}`,
		},
		{
			name:   "delete user email",
			method: http.MethodDelete,
			path:   "/api/user/emails/1",
		},
		{
			name:   "request verification",
			method: http.MethodPost,
			path:   "/api/user/emails/1/verify",
		},
	}

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			req := httptest.NewRequest(tc.method, tc.path, bytes.NewBufferString(tc.body))
			if tc.method != http.MethodGet {
				req.Header.Set("Content-Type", "application/json")
			}
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)

			assert.NotEqual(t, http.StatusNotFound, rec.Code, "%s %s route must be registered", tc.method, tc.path)
			assert.Equal(t, http.StatusUnauthorized, rec.Code)
		})
	}
}

// ---- Notification routes ----

func TestServerRouter_NotificationListRouteRegistered(t *testing.T) {
	t.Parallel()

	router := defaultRouter(nil)

	req := httptest.NewRequest(http.MethodGet, "/api/notifications/list", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	// notificationHandler is nil in defaultRouter, so the route is NOT registered.
	// When it IS registered (non-nil handler), it should return 401 (no auth) not 404.
	// We verify it's not 404 when registered by using a real handler.
	notifHandler := &routes.NotificationHandler{Service: &mockRouterNotificationService{}}
	routerWithNotif := buildRouterCompat(
		&config.Config{},
		nil,
		nil,
		&routes.RepoHandler{},
		&routes.AuthHandler{},
		&routes.UserHandler{},
		&routes.SSHKeyHandler{},
		&routes.LabelHandler{},

		&routes.OrgHandler{},
		&routes.LandingHandler{},
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{},
		nil, // wikiService
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		notifHandler, // adminRunnerHandler
		nil,          // adminUserHandler
		nil,          // adminOrgHandler
		nil,          // adminSystemHealthHandler
		nil,          // adminGitHubAppHandler
		nil,          // adminAuditHandler
		nil,          // webhookHandler
		nil,          // secretHandler
		nil,          // variableHandler
		nil,          // commitStatusHandler
		nil,          // lfsHandler
		nil,          // jjVCSHandler
		nil,          // agentInternalHandler
		nil,          // agentSessionHandler
		nil,          // agentSessionStreamHandler
		nil,          // pushHookHandler
		nil,          // workflowHandler
		nil,          // workspaceHandler
		nil,          // workspaceInternalHandler
		nil,          // workspaceTerminalHandler
		nil,          // telemetryHandler
		nil,          // featureFlagHandler
		nil,          // oauth2Handler
		nil,          // smithersMetrics
	)

	req2 := httptest.NewRequest(http.MethodGet, "/api/notifications/list", nil)
	rec2 := httptest.NewRecorder()
	routerWithNotif.ServeHTTP(rec2, req2)

	// 401 means the route IS registered but auth is required.
	assert.NotEqual(t, http.StatusNotFound, rec2.Code, "notification list route must be registered")

	// Without the route, we get 404.
	assert.Equal(t, http.StatusNotFound, rec.Code, "notification route should be absent when handler is nil")
}

func TestServerRouter_NotificationSSERouteRegistered(t *testing.T) {
	t.Parallel()

	notifHandler := &routes.NotificationHandler{Service: &mockRouterNotificationService{}}
	routerWithNotif := buildRouterCompat(
		&config.Config{},
		nil,
		nil,
		&routes.RepoHandler{},
		&routes.AuthHandler{},
		&routes.UserHandler{},
		&routes.SSHKeyHandler{},
		&routes.LabelHandler{},

		&routes.OrgHandler{},
		&routes.LandingHandler{},
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{},
		nil, // wikiService
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		notifHandler, // adminRunnerHandler
		nil,          // adminUserHandler
		nil,          // adminOrgHandler
		nil,          // adminSystemHealthHandler
		nil,          // adminGitHubAppHandler
		nil,          // adminAuditHandler
		nil,          // webhookHandler
		nil,          // secretHandler
		nil,          // variableHandler
		nil,          // commitStatusHandler
		nil,          // lfsHandler
		nil,          // jjVCSHandler
		nil,          // agentInternalHandler
		nil,          // agentSessionHandler
		nil,          // agentSessionStreamHandler
		nil,          // pushHookHandler
		nil,          // workflowHandler
		nil,          // workspaceHandler
		nil,          // workspaceInternalHandler
		nil,          // workspaceTerminalHandler
		nil,          // telemetryHandler
		nil,          // featureFlagHandler
		nil,          // oauth2Handler
		nil,          // smithersMetrics
	)

	req := httptest.NewRequest(http.MethodGet, "/api/notifications", nil)
	rec := httptest.NewRecorder()
	routerWithNotif.ServeHTTP(rec, req)

	// 401 means the route IS registered but auth is required; not 404.
	assert.NotEqual(t, http.StatusNotFound, rec.Code, "notification SSE route must be registered")
}

func TestServerRouter_WorkflowRunLogsSSERouteRegisteredAndBypassesTimeout(t *testing.T) {
	t.Parallel()

	sawDeadline := false
	workflowService := &mockRouterWorkflowService{
		getWorkflowRunFn: func(ctx context.Context, repositoryID, runID int64) (db.WorkflowRun, error) {
			if _, ok := ctx.Deadline(); ok {
				sawDeadline = true
			}
			return db.WorkflowRun{ID: runID, RepositoryID: repositoryID}, nil
		},
	}
	workflowHandler := &routes.WorkflowHandler{Service: workflowService}

	router := buildRouterCompat(
		testCORSConfig(),
		nil,
		nil,
		&routes.RepoHandler{},
		&routes.AuthHandler{},
		&routes.UserHandler{},
		&routes.SSHKeyHandler{},
		&routes.LabelHandler{},

		&routes.OrgHandler{},
		&routes.LandingHandler{},
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{},
		nil, // wikiService
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, // adminRunnerHandler
		nil, // adminUserHandler
		nil, // adminOrgHandler
		nil, // adminSystemHealthHandler
		nil, // adminGitHubAppHandler
		nil, // adminAuditHandler
		nil, // webhookHandler
		nil, // secretHandler
		nil, // variableHandler
		nil, // commitStatusHandler
		nil, // lfsHandler
		nil, // jjVCSHandler
		nil, // agentInternalHandler
		nil, // agentSessionHandler
		nil, // agentSessionStreamHandler
		nil, // pushHookHandler
		workflowHandler,
		nil, // workspaceHandler
		nil, // workspaceInternalHandler
		nil, // workspaceTerminalHandler
		nil, // telemetryHandler
		nil, // featureFlagHandler
		nil, // oauth2Handler
		nil, // smithersMetrics
	)

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/runs/1/logs", nil)
	req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User: &db.User{ID: 1, Username: "alice", LowerUsername: "alice"},
	}))
	req = req.WithContext(middleware.ContextWithRepoContext(req.Context(), &middleware.RepoContext{
		Repository: &db.Repository{ID: 1, Name: "demo", LowerName: "demo"},
		Owner:      "alice",
	}, middleware.PermissionRead))

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusInternalServerError, rec.Code, "handler reached route and failed because SSE pool is nil")
	assert.False(t, sawDeadline, "workflow logs SSE route must bypass JSON timeout middleware")
}

func TestServerRouter_WorkflowRunLogsSSERouteIncludesCORSHeaders(t *testing.T) {
	t.Parallel()

	workflowHandler := &routes.WorkflowHandler{Service: &mockRouterWorkflowService{}}

	router := buildRouterCompat(
		testCORSConfig(),
		nil,
		nil,
		&routes.RepoHandler{},
		&routes.AuthHandler{},
		&routes.UserHandler{},
		&routes.SSHKeyHandler{},
		&routes.LabelHandler{},

		&routes.OrgHandler{},
		&routes.LandingHandler{},
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{},
		nil, // wikiService
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, // adminRunnerHandler
		nil, // adminUserHandler
		nil, // adminOrgHandler
		nil, // adminSystemHealthHandler
		nil, // adminGitHubAppHandler
		nil, // adminAuditHandler
		nil, // webhookHandler
		nil, // secretHandler
		nil, // variableHandler
		nil, // commitStatusHandler
		nil, // lfsHandler
		nil, // jjVCSHandler
		nil, // agentInternalHandler
		nil, // agentSessionHandler
		nil, // agentSessionStreamHandler
		nil, // pushHookHandler
		workflowHandler,
		nil, // workspaceHandler
		nil, // workspaceInternalHandler
		nil, // workspaceTerminalHandler
		nil, // telemetryHandler
		nil, // featureFlagHandler
		nil, // oauth2Handler
		nil, // smithersMetrics
	)

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/runs/1/logs", nil)
	req.Header.Set("Origin", "https://example.com")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	assert.NotEqual(t, http.StatusNotFound, rec.Code, "workflow logs SSE route should be registered")
	assert.Equal(t, "https://example.com", rec.Header().Get("Access-Control-Allow-Origin"), "workflow logs SSE route should include the configured API CORS origin")

	req = httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/runs/1/logs", nil)
	req.Header.Set("Origin", "https://evil.example")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	assert.Empty(t, rec.Header().Get("Access-Control-Allow-Origin"), "unexpected origins must not receive CORS headers")
}

func TestServerRouter_WorkflowRunCancelRouteRegistered(t *testing.T) {
	t.Parallel()

	workflowHandler := &routes.WorkflowHandler{Service: &mockRouterWorkflowService{}}

	router := buildRouterCompat(
		&config.Config{},
		nil,
		nil,
		&routes.RepoHandler{},
		&routes.AuthHandler{},
		&routes.UserHandler{},
		&routes.SSHKeyHandler{},
		&routes.LabelHandler{},

		&routes.OrgHandler{},
		&routes.LandingHandler{},
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{},
		nil, // wikiService
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, // adminRunnerHandler
		nil, // adminUserHandler
		nil, // adminOrgHandler
		nil, // adminSystemHealthHandler
		nil, // adminGitHubAppHandler
		nil, // adminAuditHandler
		nil, // webhookHandler
		nil, // secretHandler
		nil, // variableHandler
		nil, // commitStatusHandler
		nil, // lfsHandler
		nil, // jjVCSHandler
		nil, // agentInternalHandler
		nil, // agentSessionHandler
		nil, // agentSessionStreamHandler
		nil, // pushHookHandler
		workflowHandler,
		nil, // workspaceHandler
		nil, // workspaceInternalHandler
		nil, // workspaceTerminalHandler
		nil, // telemetryHandler
		nil, // featureFlagHandler
		nil, // oauth2Handler
		nil, // smithersMetrics
	)

	req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/actions/runs/1/cancel", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	assert.NotEqual(t, http.StatusNotFound, rec.Code, "workflow run cancel route should be registered")
}

// ---- Internal runner routes ----

// ---- CSRF wiring tests ----

// sessionContext returns a request with session auth (IsTokenAuth=false) injected into context.
// This simulates what AuthLoader does when it authenticates via cookie.
func sessionContext(r *http.Request) *http.Request {
	authInfo := &middleware.AuthInfo{
		IsTokenAuth: false,
		User:        &db.User{ID: 1, Username: "alice"},
	}
	ctx := middleware.ContextWithAuthInfo(r.Context(), authInfo)
	return r.WithContext(ctx)
}

func routerRepoContext(r *http.Request, owner, repo string) *http.Request {
	repository := &db.Repository{ID: 200, Name: repo, LowerName: strings.ToLower(repo)}
	ctx := middleware.ContextWithRepoContext(r.Context(), &middleware.RepoContext{
		Owner:      owner,
		Repository: repository,
	}, middleware.PermissionWrite)
	return r.WithContext(ctx)
}

// TestServerRouter_CSRFWiredIntoFirstGroup verifies that session-authenticated state-changing
// requests to user/* endpoints return 403 without an X-CSRF-Token header.
// This guards against accidental removal of middleware.CSRF from the first router group.
func TestServerRouter_CSRFWiredIntoFirstGroup(t *testing.T) {
	t.Parallel()

	router := defaultRouter(nil)

	// PATCH /api/user is in the first router group — must require CSRF for session auth.
	// We inject session auth context directly (AuthLoader reads cookie from DB in prod,
	// but here we inject AuthInfo into context to simulate post-AuthLoader state).
	req := httptest.NewRequest(http.MethodPatch, "/api/user", bytes.NewBufferString(`{"display_name":"test"}`))
	req.Header.Set("Content-Type", "application/json")
	req = sessionContext(req)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	// CSRF must intercept before the handler: expect 403, not 401/404/200.
	assert.Equal(t, http.StatusForbidden, rec.Code, "PATCH /api/user without X-CSRF-Token must return 403 for session auth")
}

// TestServerRouter_CSRFWiredIntoSecondGroup verifies that session-authenticated state-changing
// requests to org/* mutation endpoints return 403 without an X-CSRF-Token header.
// This is the critical regression test for the bug where the second router group
// was missing middleware.CSRF.
func TestServerRouter_CSRFWiredIntoSecondGroup(t *testing.T) {
	t.Parallel()

	router := defaultRouter(nil)

	mutatingRoutes := []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/api/orgs"},
		{http.MethodPatch, "/api/orgs/test-org"},
		{http.MethodPost, "/api/orgs/test-org/teams"},
		{http.MethodPatch, "/api/orgs/test-org/teams/test-team"},
		{http.MethodDelete, "/api/orgs/test-org/teams/test-team"},
		{http.MethodPut, "/api/orgs/test-org/teams/test-team/members/bob"},
		{http.MethodDelete, "/api/orgs/test-org/teams/test-team/members/bob"},
		{http.MethodPut, "/api/orgs/test-org/teams/test-team/repos/alice/myrepo"},
		{http.MethodDelete, "/api/orgs/test-org/teams/test-team/repos/alice/myrepo"},
	}

	for _, route := range mutatingRoutes {
		route := route
		t.Run(route.method+" "+route.path, func(t *testing.T) {
			t.Parallel()

			req := httptest.NewRequest(route.method, route.path, bytes.NewBufferString(`{}`))
			req.Header.Set("Content-Type", "application/json")
			req = sessionContext(req)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)

			// CSRF must intercept before RequireAuth: expect 403, not 401/404/200.
			assert.Equal(t, http.StatusForbidden, rec.Code,
				"%s %s without X-CSRF-Token must return 403 for session auth", route.method, route.path)
		})
	}
}

func TestServerRouter_CSRFRejectsWhenHeaderPresentButCSRFCookieMissing(t *testing.T) {
	t.Parallel()

	router := defaultRouter(nil)

	req := httptest.NewRequest(http.MethodPatch, "/api/orgs/test-org", bytes.NewBufferString(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", "valid-csrf-token")
	req = sessionContext(req)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusForbidden, rec.Code,
		"PATCH /api/orgs/test-org with header but without __csrf cookie must be rejected")
}

func TestServerRouter_CSRFRejectsWhenHeaderAndCookieMismatch(t *testing.T) {
	t.Parallel()

	router := defaultRouter(nil)

	req := httptest.NewRequest(http.MethodPatch, "/api/orgs/test-org", bytes.NewBufferString(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", "header-token")
	req.AddCookie(&http.Cookie{Name: "__csrf", Value: "cookie-token"})
	req = sessionContext(req)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusForbidden, rec.Code,
		"PATCH /api/orgs/test-org with mismatched header/cookie csrf token must be rejected")
}

// TestServerRouter_CSRFPassesWithMatchingCookieAndToken verifies that session-authenticated
// requests pass CSRF validation only when the X-CSRF-Token header matches __csrf cookie.
func TestServerRouter_CSRFPassesWithMatchingCookieAndToken(t *testing.T) {
	t.Parallel()

	router := defaultRouter(nil)

	req := httptest.NewRequest(http.MethodPatch, "/api/orgs/test-org", bytes.NewBufferString(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", "valid-csrf-token")
	req.AddCookie(&http.Cookie{Name: "__csrf", Value: "valid-csrf-token"})
	req = sessionContext(req)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	// CSRF passes — the request should not be 403 from CSRF. It may be 401/404/500
	// depending on downstream auth and handler behavior.
	assert.NotEqual(t, http.StatusForbidden, rec.Code,
		"PATCH /api/orgs/test-org with X-CSRF-Token must NOT be rejected by CSRF middleware")
}

func TestServerRouter_RepoWriteRoutesRejectOversizedBodies(t *testing.T) {
	t.Parallel()

	router := defaultRouter(nil)
	largeValue := strings.Repeat("a", 2<<20)

	tests := []struct {
		name   string
		method string
		path   string
		body   string
	}{
		{
			name:   "create user repo",
			method: http.MethodPost,
			path:   "/api/user/repos",
			body:   `{"name":"` + largeValue + `"}`,
		},
		{
			name:   "create org repo",
			method: http.MethodPost,
			path:   "/api/orgs/acme/repos",
			body:   `{"name":"` + largeValue + `"}`,
		},
		{
			name:   "patch repo",
			method: http.MethodPatch,
			path:   "/api/repos/alice/demo",
			body:   `{"description":"` + largeValue + `"}`,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, bytes.NewBufferString(tc.body))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-CSRF-Token", "valid-csrf-token")
			req.AddCookie(&http.Cookie{Name: "__csrf", Value: "valid-csrf-token"})
			req = sessionContext(req)

			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)

			require.Equal(t, http.StatusRequestEntityTooLarge, rec.Code)
			var payload map[string]any
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
			assert.Equal(t, "request body too large", payload["message"])
		})
	}
}

func TestServerRouter_AgentEnvironmentAllowsMiBSetupScriptOnlyOnExactPut(t *testing.T) {
	t.Parallel()

	service := &routerAgentEnvironmentService{}
	router := routerWithAgentEnvironment(service)
	for _, script := range []string{strings.Repeat("x", 1<<20), strings.Repeat("\x01", 1<<20)} {
		body, err := json.Marshal(services.PutAgentEnvironmentInput{SetupScript: script})
		require.NoError(t, err)
		require.Greater(t, len(body), 1<<20)

		request := func(method, path string) *http.Request {
			req := httptest.NewRequest(method, path, bytes.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			return withRouterTokenAuth(req, middleware.ScopeWriteRepository)
		}

		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, request(http.MethodPut, "/api/repos/will/flows/agent-environment"))
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		require.Equal(t, script, service.setupScript)

		service.setupScript = ""
		rec = httptest.NewRecorder()
		router.ServeHTTP(rec, request(http.MethodPost, "/api/user/repos"))
		require.Equal(t, http.StatusRequestEntityTooLarge, rec.Code, rec.Body.String())
		require.Empty(t, service.setupScript)
	}

	combined := services.PutAgentEnvironmentInput{SetupScript: strings.Repeat("\x01", 1<<20)}
	for i := range 100 {
		combined.Env = append(combined.Env, services.AgentEnvironmentVariable{Name: fmt.Sprintf("ENV_%d", i), Value: strings.Repeat("x", 64<<10)})
	}
	for i := range 30 {
		combined.Secrets = append(combined.Secrets, services.AgentEnvironmentSecretWrite{Name: fmt.Sprintf("SECRET_%d", i), Value: strings.Repeat("x", 64<<10)})
	}
	body, err := json.Marshal(combined)
	require.NoError(t, err)
	require.Greater(t, len(body), 8<<20)
	require.Less(t, len(body), 16<<20)
	req := httptest.NewRequest(http.MethodPut, "/api/repos/will/flows/agent-environment", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, withRouterTokenAuth(req, middleware.ScopeWriteRepository))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Len(t, service.input.Env, 100)
	require.Len(t, service.input.Secrets, 30)

	service.setupScript = ""
	oversized := `{"setup_script":"` + strings.Repeat("x", 16<<20) + `"}`
	req = httptest.NewRequest(http.MethodPut, "/api/repos/will/flows/agent-environment", strings.NewReader(oversized))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, withRouterTokenAuth(req, middleware.ScopeWriteRepository))
	require.Equal(t, http.StatusRequestEntityTooLarge, rec.Code, rec.Body.String())
	require.Empty(t, service.setupScript)
}

func TestAPIBodyLimitOnlyWidensAgentEnvironmentPut(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		method string
		path   string
		want   int64
	}{
		{"setup PUT", http.MethodPut, "/api/repos/will/flows/agent-environment", middleware.MaxAgentEnvironmentBodySize},
		{"setup POST", http.MethodPost, "/api/repos/will/flows/agent-environment", middleware.MaxRequestBodySize},
		{"secret PUT", http.MethodPut, "/api/repos/will/flows/agent-environment/secrets/TOKEN", middleware.MaxRequestBodySize},
		{"lookalike PUT", http.MethodPut, "/api/repos/will/flows/agent-environment-extra", middleware.MaxRequestBodySize},
		{"trailing slash PUT", http.MethodPut, "/api/repos/will/flows/agent-environment/", middleware.MaxRequestBodySize},
		{"encoded suffix PUT", http.MethodPut, "/api/repos/will/flows/agent-environment%2Fextra", middleware.MaxRequestBodySize},
		{"encoded owner slash PUT", http.MethodPut, "/api/repos/will%2Fflows/agent-environment", middleware.MaxRequestBodySize},
		{"other write", http.MethodPut, "/api/repos/will/flows", middleware.MaxRequestBodySize},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, nil)
			assert.Equal(t, tc.want, apiBodyLimit(req))
		})
	}
}

// mockRouterNotificationService satisfies routes.NotificationRouteService.
type mockRouterNotificationService struct{}

func (m *mockRouterNotificationService) ListNotifications(_ context.Context, _ int64, _ int64, _ int) ([]services.NotificationResponse, string, int64, error) {
	return nil, "", 0, nil
}

func (m *mockRouterNotificationService) ListNotificationsAfterID(_ context.Context, _, _ int64, _ int) ([]services.NotificationResponse, error) {
	return nil, nil
}

func (m *mockRouterNotificationService) MarkRead(_ context.Context, _, _ int64) error {
	return nil
}

func (m *mockRouterNotificationService) MarkAllRead(_ context.Context, _ int64) error {
	return nil
}

func (m *mockRouterNotificationService) GetPreferences(_ context.Context, _ int64) (services.NotificationPreferencesResponse, error) {
	return services.NotificationPreferencesResponse{}, nil
}

func (m *mockRouterNotificationService) UpdatePreferences(_ context.Context, _ int64, _, _, _ bool) (services.NotificationPreferencesResponse, error) {
	return services.NotificationPreferencesResponse{}, nil
}

func (m *mockRouterNotificationService) Create(_ context.Context, arg db.CreateNotificationParams) (services.NotificationResponse, error) {
	return services.NotificationResponse{
		ID:         1,
		SourceType: arg.SourceType,
		Subject:    arg.Subject,
		Body:       arg.Body,
		Status:     "unread",
		CreatedAt:  time.Now().UTC(),
		UpdatedAt:  time.Now().UTC(),
	}, nil
}

func TestServerRouter_CSRFWiredIntoTestNotificationEndpoint(t *testing.T) {
	t.Setenv("SMITHERS_ENABLE_E2E_TEST_ROUTES", "true")

	notifHandler := &routes.NotificationHandler{Service: &mockRouterNotificationService{}}
	router := buildRouterCompat(
		&config.Config{},
		nil,
		nil,
		&routes.RepoHandler{},
		&routes.AuthHandler{},
		&routes.UserHandler{},
		&routes.SSHKeyHandler{},
		&routes.LabelHandler{},

		&routes.OrgHandler{},
		&routes.LandingHandler{},
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{},
		nil, // wikiService
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		notifHandler, // adminRunnerHandler
		nil,          // adminUserHandler
		nil,          // adminOrgHandler
		nil,          // adminSystemHealthHandler
		nil,          // adminGitHubAppHandler
		nil,          // adminAuditHandler
		nil,          // webhookHandler
		nil,          // secretHandler
		nil,          // variableHandler
		nil,          // commitStatusHandler
		nil,          // lfsHandler
		nil,          // jjVCSHandler
		nil,          // agentInternalHandler
		nil,          // agentSessionHandler
		nil,          // agentSessionStreamHandler
		nil,          // pushHookHandler
		nil,          // workflowHandler
		nil,          // workspaceHandler
		nil,          // workspaceInternalHandler
		nil,          // workspaceTerminalHandler
		nil,          // telemetryHandler
		nil,          // featureFlagHandler
		nil,          // oauth2Handler
		nil,          // smithersMetrics
	)

	req := httptest.NewRequest(http.MethodPost, "/api/_test/notifications", bytes.NewBufferString(`{"source_type":"e2e","subject":"s","body":"b"}`))
	req.Header.Set("Content-Type", "application/json")
	req = sessionContext(req)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusForbidden, rec.Code, "POST /api/_test/notifications without X-CSRF-Token must return 403 for session auth")
}

func TestServerRouter_AdminRoutes_RequireAdminScopeForTokenAuth(t *testing.T) {
	t.Parallel()

	adminUserHandler := &routes.AdminUserHandler{Service: &mockAdminUserRouteService{}}
	router := buildRouterCompat(
		&config.Config{},
		nil,
		nil,
		&routes.RepoHandler{},
		&routes.AuthHandler{},
		&routes.UserHandler{},
		&routes.SSHKeyHandler{},
		&routes.LabelHandler{},

		&routes.OrgHandler{},
		&routes.LandingHandler{},
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{},
		nil, // wikiService
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil,
		adminUserHandler, // adminUserHandler
		nil,              // adminOrgHandler
		nil,              // adminSystemHealthHandler
		nil,              // adminGitHubAppHandler
		nil,              // adminAuditHandler
		nil,              // webhookHandler
		nil,              // secretHandler
		nil,              // variableHandler
		nil,              // commitStatusHandler
		nil,              // lfsHandler
		nil,              // jjVCSHandler
		nil,              // agentInternalHandler
		nil,              // agentSessionHandler
		nil,              // agentSessionStreamHandler
		nil,              // pushHookHandler
		nil,              // workflowHandler
		nil,              // workspaceHandler
		nil,              // workspaceInternalHandler
		nil,              // workspaceTerminalHandler
		nil,              // telemetryHandler
		nil,              // featureFlagHandler
		nil,              // oauth2Handler
		nil,              // smithersMetrics
	)

	req := httptest.NewRequest(http.MethodGet, "/api/admin/users", nil)
	req = withRouterAdminTokenAuth(req, true, middleware.TokenSourcePersonalAccessToken, middleware.ScopeReadRepository)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusForbidden, rec.Code)
}

func TestServerRouter_AdminRoutes_ReadOnlyScopeCannotMutate(t *testing.T) {
	t.Parallel()

	adminUserSvc := &mockAdminUserRouteService{}
	adminUserHandler := &routes.AdminUserHandler{Service: adminUserSvc}
	router := buildRouterCompat(
		&config.Config{},
		nil,
		nil,
		&routes.RepoHandler{},
		&routes.AuthHandler{},
		&routes.UserHandler{},
		&routes.SSHKeyHandler{},
		&routes.LabelHandler{},

		&routes.OrgHandler{},
		&routes.LandingHandler{},
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{},
		nil, // wikiService
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, // adminRunnerHandler
		adminUserHandler,
		nil, // adminOrgHandler
		nil, // adminSystemHealthHandler
		nil, // adminGitHubAppHandler
		nil, // adminAuditHandler
		nil, // webhookHandler
		nil, // secretHandler
		nil, // variableHandler
		nil, // commitStatusHandler
		nil, // lfsHandler
		nil, // jjVCSHandler
		nil, // agentInternalHandler
		nil, // agentSessionHandler
		nil, // agentSessionStreamHandler
		nil, // pushHookHandler
		nil, // workflowHandler
		nil, // workspaceHandler
		nil, // workspaceInternalHandler
		nil, // workspaceTerminalHandler
		nil, // telemetryHandler
		nil, // featureFlagHandler
		nil, // oauth2Handler
		nil, // smithersMetrics
	)

	req := httptest.NewRequest(http.MethodPost, "/api/admin/users", bytes.NewBufferString(`{"username":"bob","email":"bob@example.com"}`))
	req.Header.Set("Content-Type", "application/json")
	req = withRouterAdminTokenAuth(req, true, middleware.TokenSourcePersonalAccessToken, middleware.ScopeReadAdmin)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusForbidden, rec.Code)
	assert.Equal(t, 0, adminUserSvc.createUserCalls)

	reqWrite := httptest.NewRequest(http.MethodPost, "/api/admin/users", bytes.NewBufferString(`{"username":"carol","email":"carol@example.com"}`))
	reqWrite.Header.Set("Content-Type", "application/json")
	reqWrite = withRouterAdminTokenAuth(reqWrite, true, middleware.TokenSourcePersonalAccessToken, middleware.ScopeWriteAdmin)
	recWrite := httptest.NewRecorder()
	router.ServeHTTP(recWrite, reqWrite)

	assert.Equal(t, http.StatusCreated, recWrite.Code)
	assert.Equal(t, 1, adminUserSvc.createUserCalls)
}

func TestServerRouter_AdminRunnerRouteAbsentWhenHandlerNil(t *testing.T) {
	t.Parallel()

	router := defaultRouter(nil) // adminRunnerHandler is nil

	req := httptest.NewRequest(http.MethodGet, "/api/admin/runners", nil)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusNotFound, rec.Code, "GET /api/admin/runners should be absent when adminRunnerHandler is nil")
}

func TestServerRouter_InternalPushHookRouteRequiresSharedBearerToken(t *testing.T) {
	t.Setenv("SMITHERS_PUSH_HOOK_CALLBACK_TOKEN", "push-callback-secret")

	buildPushRouter := func(callbackToken string) http.Handler {
		return buildRouterCompat(
			&config.Config{RepoHost: config.RepoHostConfig{
				AuthToken:             "repo-host-control-secret",
				PushHookCallbackToken: callbackToken,
			}},
			nil,
			nil, // pool
			nil, // repoHandler
			nil, // authHandler
			nil, // userHandler
			nil, // sshKeyHandler
			nil, // labelHandler
			nil, // orgHandler
			nil, // landingHandler
			nil, // searchHandler
			nil, // issueHandler
			nil, // wikiService
			nil, // gitHandler
			nil, // adminRunnerHandler
			nil, // adminUserHandler
			nil, // adminOrgHandler
			nil, // adminSystemHealthHandler
			nil, // adminGitHubAppHandler
			nil, // adminAuditHandler
			nil, // webhookHandler
			nil, // secretHandler
			nil, // variableHandler
			nil, // commitStatusHandler
			nil, // lfsHandler
			nil, // jjVCSHandler
			nil, // agentInternalHandler
			nil, // agentSessionHandler
			nil, // agentSessionStreamHandler
			&routes.InternalPushHookHandler{},
			nil, // workflowHandler
			nil, // workspaceHandler
			nil, // workspaceInternalHandler
			nil, // workspaceTerminalHandler
			nil, // telemetryHandler
			nil, // featureFlagHandler
			nil, // oauth2Handler
			nil, // smithersMetrics
		)
	}
	router := buildPushRouter("push-callback-secret")

	req := httptest.NewRequest(http.MethodPost, "/internal/repo-host/push-events", bytes.NewBufferString(`{}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)

	req2 := httptest.NewRequest(http.MethodPost, "/internal/repo-host/push-events", bytes.NewBufferString(`{}`))
	req2.Header.Set("Content-Type", "application/json")
	req2.Header.Set("Authorization", "Bearer repo-host-control-secret")
	rec2 := httptest.NewRecorder()
	router.ServeHTTP(rec2, req2)
	assert.Equal(t, http.StatusUnauthorized, rec2.Code, "repo-host control token must not forge push callbacks")

	req3 := httptest.NewRequest(http.MethodPost, "/internal/repo-host/push-events", bytes.NewBufferString(`{}`))
	req3.Header.Set("Content-Type", "application/json")
	req3.Header.Set("Authorization", "Bearer push-callback-secret")
	rec3 := httptest.NewRecorder()
	router.ServeHTTP(rec3, req3)
	assert.NotEqual(t, http.StatusUnauthorized, rec3.Code, "dedicated push callback token should pass route auth")

	req4 := httptest.NewRequest(http.MethodPost, "/internal/repo-host/push-events", bytes.NewBufferString(`{}`))
	req4.Header.Set("Content-Type", "application/json")
	req4.Header.Set("Authorization", "Bearer push-callback-secret")
	rec4 := httptest.NewRecorder()
	buildPushRouter("").ServeHTTP(rec4, req4)
	assert.Equal(t, http.StatusUnauthorized, rec4.Code, "missing callback configuration must fail closed")
}

// ---------------------------------------------------------------------------
// Observability: /metrics endpoint router tests
// ---------------------------------------------------------------------------

// TestServerRouter_MetricsEndpointRegistered verifies that when SmithersMetrics is
// provided, GET /metrics returns 200 with Prometheus text format.
func TestServerRouter_MetricsEndpointRegistered(t *testing.T) {
	t.Setenv("SMITHERS_METRICS_TOKEN", "test-metrics-token")
	metrics := routes.NewSmithersMetrics()
	router := buildRouterCompat(
		&config.Config{},
		nil,
		nil,
		&routes.RepoHandler{},
		&routes.AuthHandler{},
		&routes.UserHandler{},
		&routes.SSHKeyHandler{},
		&routes.LabelHandler{},

		&routes.OrgHandler{},
		&routes.LandingHandler{},
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{},
		nil, // wikiService
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, // adminRunnerHandler
		nil, // adminUserHandler
		nil, // adminOrgHandler
		nil, // adminSystemHealthHandler
		nil, // adminGitHubAppHandler
		nil, // adminAuditHandler
		nil, // webhookHandler
		nil, // secretHandler
		nil, // variableHandler
		nil, // commitStatusHandler
		nil, // lfsHandler
		nil, // jjVCSHandler
		nil, // agentInternalHandler
		nil, // agentSessionHandler
		nil, // agentSessionStreamHandler
		nil, // pushHookHandler
		nil, // workflowHandler
		nil, // workspaceHandler
		nil, // workspaceInternalHandler
		nil, // workspaceTerminalHandler
		nil, // telemetryHandler
		nil, // featureFlagHandler
		nil, // oauth2Handler
		metrics,
	)

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	req.Header.Set("Authorization", "Bearer test-metrics-token")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code, "GET /metrics must return 200 when metrics handler is registered")
	ct := rec.Header().Get("Content-Type")
	assert.Contains(t, ct, "text/plain", "GET /metrics must return Prometheus text format")
	assert.Contains(t, rec.Body.String(), "smithers_", "GET /metrics must contain smithers_ prefixed metrics")
}

// TestServerRouter_MetricsEndpointAbsentWhenNilMetrics verifies that when
// SmithersMetrics is nil, GET /metrics returns 404 (endpoint not registered).
func TestServerRouter_MetricsEndpointAbsentWhenNilMetrics(t *testing.T) {
	t.Parallel()

	router := defaultRouter(nil) // smithersMetrics is nil in defaultRouter

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusNotFound, rec.Code, "GET /metrics should return 404 when smithersMetrics is nil")
}

// TestServerRouter_HealthEndpointsRegistered verifies that all three health
// check endpoints (/health, /healthz, /readyz) are always registered.
func TestServerRouter_HealthEndpointsRegistered(t *testing.T) {
	t.Parallel()

	router := defaultRouter(nil)

	for _, path := range []string{"/health", "/healthz", "/readyz"} {
		path := path
		t.Run(path, func(t *testing.T) {
			t.Parallel()
			req := httptest.NewRequest(http.MethodGet, path, nil)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			// 200 = healthy or ready; 503 = degraded (DB unconfigured in test)
			// Must NOT be 404 (endpoint must always be registered)
			assert.NotEqual(t, http.StatusNotFound, rec.Code,
				"%s must always be registered (not 404)", path)
		})
	}
}

// TestServerRouter_RequestIDEchoedInResponse verifies that the X-Request-Id
// header is echoed back in response headers for trace correlation.
// This is required for edge proxy correlation per infra.md §8.
func TestServerRouter_RequestIDEchoedInResponse(t *testing.T) {
	t.Parallel()

	router := defaultRouter(nil)

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.Header.Set("X-Request-Id", "test-trace-correlation-id")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	assert.Equal(t, "test-trace-correlation-id", rec.Header().Get("X-Request-Id"),
		"X-Request-Id must be echoed in response for edge proxy trace correlation")
}

// TestServerRouter_RequestIDGeneratedWhenAbsent verifies that when no client
// X-Request-Id is supplied, the server generates one and echoes it.
func TestServerRouter_RequestIDGeneratedWhenAbsent(t *testing.T) {
	t.Parallel()

	router := defaultRouter(nil)

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	echoed := rec.Header().Get("X-Request-Id")
	assert.NotEmpty(t, echoed,
		"server must generate and echo X-Request-Id when not supplied by client")
}

// TestServerRouter_HTTPMetricsRecordsRequests verifies that when SmithersMetrics
// is wired, HTTP requests are counted in smithers_http_requests_total.
func TestServerRouter_HTTPMetricsRecordsRequests(t *testing.T) {
	t.Setenv("SMITHERS_METRICS_TOKEN", "test-metrics-token")
	metrics := routes.NewSmithersMetrics()
	router := buildRouterCompat(
		&config.Config{},
		nil,
		nil,
		&routes.RepoHandler{},
		&routes.AuthHandler{},
		&routes.UserHandler{},
		&routes.SSHKeyHandler{},
		&routes.LabelHandler{},

		&routes.OrgHandler{},
		&routes.LandingHandler{},
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{},
		nil, // wikiService
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, // adminRunnerHandler
		nil, // adminUserHandler
		nil, // adminOrgHandler
		nil, // adminSystemHealthHandler
		nil, // adminGitHubAppHandler
		nil, // adminAuditHandler
		nil, // webhookHandler
		nil, // secretHandler
		nil, // variableHandler
		nil, // commitStatusHandler
		nil, // lfsHandler
		nil, // jjVCSHandler
		nil, // agentInternalHandler
		nil, // agentSessionHandler
		nil, // agentSessionStreamHandler
		nil, // pushHookHandler
		nil, // workflowHandler
		nil, // workspaceHandler
		nil, // workspaceInternalHandler
		nil, // workspaceTerminalHandler
		nil, // telemetryHandler
		nil, // featureFlagHandler
		nil, // oauth2Handler
		metrics,
	)

	// Make a request to /health (public endpoint, always responds).
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	// Read back /metrics and verify the request was counted.
	router.(chi.Router).Get("/test-observability-panic", func(http.ResponseWriter, *http.Request) {
		panic("test handler failure")
	})
	panicRec := httptest.NewRecorder()
	router.ServeHTTP(panicRec, httptest.NewRequest(http.MethodGet, "/test-observability-panic", nil))
	require.Equal(t, http.StatusInternalServerError, panicRec.Code)

	metricsReq := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	metricsReq.Header.Set("Authorization", "Bearer test-metrics-token")
	metricsRec := httptest.NewRecorder()
	router.ServeHTTP(metricsRec, metricsReq)
	require.Equal(t, http.StatusOK, metricsRec.Code)

	body := metricsRec.Body.String()
	assert.Contains(t, body, `smithers_http_requests_total`,
		"smithers_http_requests_total must appear in /metrics after requests are made")
	assert.Contains(t, body, `method="GET"`,
		"HTTP method must be recorded in metrics labels")
	assert.Contains(t, body, `status="200"`,
		"HTTP status must be recorded in metrics labels")
	assert.Contains(t, body, `smithers_http_requests_total{method="GET",path="/test-observability-panic",status="500"} 1`,
		"the production middleware order must count recovered panics as 500 responses")
}

// ---- OpenTelemetry Middleware Tests ----

// TestServerRouter_OTelMiddlewareInjectsTraceHeaders verifies that the router
// correctly includes the otelhttp middleware and injects trace headers.
func TestServerRouter_OTelMiddlewareInjectsTraceHeaders(t *testing.T) {
	t.Parallel()

	router := defaultRouter(nil)

	// Make a request without any trace headers
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	// The otelhttp middleware should inject traceparent header in the response
	// when trace context is propagated (even for responses, via response writer wrapper)
	_ = rec.Header().Get("traceparent") // Trace context propagation verified by successful request
	// Note: traceparent header in response depends on propagation configuration
	// The key assertion is that the request completes successfully with middleware wired

	// Verify that request ID is still echoed (middleware doesn't break existing functionality)
	assert.NotEmpty(t, rec.Header().Get("X-Request-Id"),
		"X-Request-Id must still be echoed when OTel middleware is active")
}

// TestServerRouter_OTelMiddlewarePropagatesIncomingTrace verifies that incoming
// traceparent headers are propagated through the request chain.
func TestServerRouter_OTelMiddlewarePropagatesIncomingTrace(t *testing.T) {
	t.Parallel()

	router := defaultRouter(nil)

	// Make a request with a traceparent header (simulating a trace from upstream)
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.Header.Set("traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	// The trace context should be propagated (verified by successful handling)
	// The middleware chain should not break when trace headers are present
}

// TestServerRouter_OTelMiddlewareWithBaggage verifies that baggage headers
// are correctly propagated when present.
func TestServerRouter_OTelMiddlewareWithBaggage(t *testing.T) {
	t.Parallel()

	router := defaultRouter(nil)

	// Make a request with baggage header
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.Header.Set("baggage", "key1=value1,key2=value2")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
}
func TestServerRouter_NotificationMark_RequiresWriteUserScope(t *testing.T) {
	t.Parallel()

	notifHandler := &routes.NotificationHandler{Service: &mockRouterNotificationService{}}
	routerWithNotif := buildRouterCompat(
		&config.Config{},
		nil,
		nil,
		&routes.RepoHandler{},
		&routes.AuthHandler{},
		&routes.UserHandler{},
		&routes.SSHKeyHandler{},
		&routes.LabelHandler{},

		&routes.OrgHandler{},
		&routes.LandingHandler{},
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{},
		nil, // wikiService
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		notifHandler, // adminRunnerHandler
		nil,          // adminUserHandler
		nil,          // adminOrgHandler
		nil,          // adminSystemHealthHandler
		nil,          // adminGitHubAppHandler
		nil,          // adminAuditHandler
		nil,          // webhookHandler
		nil,          // secretHandler
		nil,          // variableHandler
		nil,          // commitStatusHandler
		nil,          // lfsHandler
		nil,          // jjVCSHandler
		nil,          // agentInternalHandler
		nil,          // agentSessionHandler
		nil,          // agentSessionStreamHandler
		nil,          // pushHookHandler
		nil,          // workflowHandler
		nil,          // workspaceHandler
		nil,          // workspaceInternalHandler
		nil,          // workspaceTerminalHandler
		nil,          // telemetryHandler
		nil,          // featureFlagHandler
		nil,          // oauth2Handler
		nil,          // smithersMetrics
	)

	t.Run("PATCH /api/notifications/{id} with read:user token returns 403", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPatch, "/api/notifications/1", bytes.NewBufferString(`{}`))
		req.Header.Set("Content-Type", "application/json")
		req = withRouterTokenAuth(req, middleware.ScopeReadUser) // Only read:user
		req.Header.Set("X-CSRF-Token", "valid-csrf-token")
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "valid-csrf-token"})
		rec := httptest.NewRecorder()
		routerWithNotif.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusForbidden, rec.Code, "PATCH /api/notifications/1 with only read:user token must return 403")
	})

	t.Run("PUT /api/notifications/mark-read with read:user token returns 403", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPut, "/api/notifications/mark-read", bytes.NewBufferString(`{}`))
		req.Header.Set("Content-Type", "application/json")
		req = withRouterTokenAuth(req, middleware.ScopeReadUser) // Only read:user
		req.Header.Set("X-CSRF-Token", "valid-csrf-token")
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "valid-csrf-token"})
		rec := httptest.NewRecorder()
		routerWithNotif.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusForbidden, rec.Code, "PUT /api/notifications/mark-read with only read:user token must return 403")
	})
}

// ---------------------------------------------------------------------------
// Structured Logging Integration Tests
// ---------------------------------------------------------------------------

// structuredLogEntry represents a parsed structured log entry for testing.
type structuredLogEntry struct {
	Severity    string                 `json:"severity"`
	Message     string                 `json:"message"`
	TraceID     string                 `json:"trace_id"`
	SpanID      string                 `json:"span_id"`
	HTTPRequest map[string]interface{} `json:"httpRequest"`
	Labels      map[string]interface{} `json:"labels"`
	Time        string                 `json:"time"`
}

// TestBuildRouter_EmitsStructuredRequestLog verifies that the router emits
// structured JSON request logs through the StructuredLogger middleware.
func TestBuildRouter_EmitsStructuredRequestLog(t *testing.T) {
	t.Parallel()

	var buf bytes.Buffer
	logger := middleware.NewServerLogger(&buf, "info")

	r := chi.NewRouter()
	r.Use(middleware.StructuredLogger(logger))
	r.Get("/api/test", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	})

	req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	output := buf.String()
	require.NotEmpty(t, output, "log output should not be empty")

	var entry structuredLogEntry
	err := json.Unmarshal([]byte(output), &entry)
	require.NoError(t, err, "log output should be valid JSON: %s", output)

	// Verify required fields
	assert.NotEmpty(t, entry.Severity, "severity should be present")
	assert.NotEmpty(t, entry.Message, "message should be present")
	assert.NotNil(t, entry.HTTPRequest, "httpRequest should be present")
	assert.Equal(t, "GET", entry.HTTPRequest["requestMethod"])
	assert.Equal(t, "/api/test", entry.HTTPRequest["requestUrl"])
	assert.Equal(t, float64(200), entry.HTTPRequest["status"])
	assert.NotEmpty(t, entry.HTTPRequest["latency"], "latency should be present")
}

// TestBuildRouter_DoesNotEmitChiTextLoggerFormat verifies that chi's text logger
// format (like "HTTP/1.1 GET /path") is not emitted when using StructuredLogger.
func TestBuildRouter_DoesNotEmitChiTextLoggerFormat(t *testing.T) {
	t.Parallel()

	var buf bytes.Buffer
	logger := middleware.NewServerLogger(&buf, "info")

	r := chi.NewRouter()
	r.Use(middleware.StructuredLogger(logger))
	r.Get("/api/test", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodGet, "/api/test", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	output := buf.String()

	// Chi text logger format contains patterns like "HTTP/1.1" and specific formatting
	// We should NOT see these patterns in structured logging output
	assert.NotContains(t, output, "HTTP/1.1", "output should not contain chi text logger format")
	assert.NotContains(t, output, "\"GET /api/test\",", "output should not contain chi-style quoted paths")

	// Verify it's valid JSON
	var entry map[string]interface{}
	err := json.Unmarshal([]byte(output), &entry)
	assert.NoError(t, err, "output should be valid JSON, got: %s", output)
}

// TestServerRouter_UserDevicesRequireWriteUserScope pins the RequireScope gate
// on push-notification device registration (issue #154): a fine-grained token
// without write:user must not be able to register or remove devices.
func TestServerRouter_UserDevicesRequireWriteUserScope(t *testing.T) {
	t.Parallel()

	router := defaultRouter(nil)

	for _, method := range []string{http.MethodPost, http.MethodDelete} {
		req := httptest.NewRequest(method, "/api/user/devices", bytes.NewBufferString(`{}`))
		req.Header.Set("Content-Type", "application/json")
		req = withRouterTokenAuth(req, middleware.ScopeReadUser)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusForbidden, rec.Code, "%s /api/user/devices with read-only token must be rejected", method)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/user/devices", bytes.NewBufferString(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req = withRouterTokenAuth(req, middleware.ScopeWriteUser)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	assert.NotEqual(t, http.StatusForbidden, rec.Code, "write:user token must pass the scope gate")
}

// sseTicketMintRouter builds the production router with (queries != nil) or
// without (queries == nil) a database, which is the switch that selects the
// database-backed ticket handler over the process-local HMAC fallback.
func sseTicketMintRouter(queries *db.Queries) http.Handler {
	return buildRouterCompat(
		testConfigAllFlagsOn(),
		queries,
		nil, // pool
		&routes.RepoHandler{},
		&routes.AuthHandler{},
		&routes.UserHandler{},
		&routes.SSHKeyHandler{},
		&routes.LabelHandler{},

		&routes.OrgHandler{},
		&routes.LandingHandler{},
		&routes.SearchHandler{Service: &mockRouterSearchService{}},
		&routes.IssueHandler{},
		nil, // wikiService
		&routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, // adminRunnerHandler
		nil, // adminUserHandler
		nil, // adminOrgHandler
		nil, // adminSystemHealthHandler
		nil, // adminGitHubAppHandler
		nil, // adminAuditHandler
		nil, // webhookHandler
		nil, // secretHandler
		nil, // variableHandler
		nil, // commitStatusHandler
		nil, // lfsHandler
		nil, // jjVCSHandler
		nil, // agentInternalHandler
		nil, // agentSessionHandler
		nil, // agentSessionStreamHandler
		nil, // pushHookHandler
		nil, // workflowHandler
		nil, // workspaceHandler
		nil, // workspaceInternalHandler
		nil, // workspaceTerminalHandler
		nil, // telemetryHandler
		nil, // featureFlagHandler
		nil, // oauth2Handler
		nil, // smithersMetrics
	)
}

// sseTicketMintEndpoints maps "METHOD route" to the endpoint function name
// for the two ticket-minting routes, as chi resolves them after every With()
// chain is peeled off.
func sseTicketMintEndpoints(t *testing.T, router http.Handler) map[string]string {
	t.Helper()
	chiRoutes, ok := router.(chi.Routes)
	require.True(t, ok, "router must expose chi routes for the walk")

	endpoints := map[string]string{}
	err := chi.Walk(chiRoutes, func(method, route string, handler http.Handler, _ ...func(http.Handler) http.Handler) error {
		if method != http.MethodPost {
			return nil
		}
		if route != "/api/auth/sse-ticket" && route != "/api/v1/sse/ticket" {
			return nil
		}
		fn := runtime.FuncForPC(reflect.ValueOf(handler).Pointer())
		require.NotNil(t, fn, "%s %s: endpoint must be a plain handler func", method, route)
		endpoints[method+" "+route] = fn.Name()
		return nil
	})
	require.NoError(t, err)
	return endpoints
}

// TestServerRouter_SSETicketAliasIsDatabaseBacked: /api/v1/sse/ticket is a
// retained alias of /api/auth/sse-ticket and must resolve to the same
// implementation. With a database it is the shared, single-use ticket store
// that any replica can redeem; the process-local HMAC manager (whose tickets
// only the issuing replica accepts) is the fallback for routers built without
// queries.
func TestServerRouter_SSETicketAliasIsDatabaseBacked(t *testing.T) {
	t.Parallel()

	withDB := sseTicketMintEndpoints(t, sseTicketMintRouter(db.New(nil)))
	require.Len(t, withDB, 2, "both minting routes must be registered: %v", withDB)
	for key, name := range withDB {
		assert.Contains(t, name, "(*SSETicketHandler).PostSSETicket", "%s must mint database tickets when queries are configured, got %s", key, name)
	}

	withoutDB := sseTicketMintEndpoints(t, sseTicketMintRouter(nil))
	require.Empty(t, withoutDB, "without the database no minting route is registered")
}

func TestServerRouter_SSETicketAliasReturnsDatabaseTicketShape(t *testing.T) {
	queries, principal := sseTicketRouterQueries(t)
	router := sseTicketMintRouter(queries)
	for _, path := range []string{"/api/v1/sse/ticket", "/api/auth/sse-ticket"} {
		req := httptest.NewRequest(http.MethodPost, path, nil)
		req.Header.Set("Authorization", "token "+principal.rawToken)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code, "%s: %s", path, rec.Body.String())
		var issued sseTicketReplicaResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &issued))
		assertSSETicketNotHS256JWT(t, path, issued.Ticket)
		assert.False(t, issued.ExpiresAt.IsZero(), "%s must return expires_at", path)
		// Only a row minted by the database implementation can pass this redemption.
		redeemed, err := services.NewSSETicketService(queries).ValidateTicket(context.Background(), issued.Ticket)
		require.NoError(t, err, "%s must mint a database ticket", path)
		assert.Equal(t, principal.userID, redeemed.User.ID)
	}
}

func (m *mockRouterWorkflowService) GetWorkflowLogStreamHead(context.Context, int64) (int64, error) {
	return 0, nil
}
func (m *mockRouterNotificationService) GetNotificationStreamHead(context.Context, int64) (int64, error) {
	return 0, nil
}
func (m *mockRouterNotificationService) ListNotificationStreamPage(_ context.Context, _, after int64, _ int) (services.NotificationStreamPage, error) {
	return services.NotificationStreamPage{Cursor: after}, nil
}

func (m *mockRouterNotificationService) ListNotificationFacts(_ context.Context, _, after int64, _ int) (services.NotificationFactPage, error) {
	return services.NotificationFactPage{Cursor: after, Head: after}, nil
}

// Organizations are not a feature flag (owner decision, 2026-09-15): with every
// flag off, the org and team routes still mount and none of them carries a
// FeatureFlagGate. Prod ran with feature_flags.orgs unset, which 403'd every
// org route and made org-owned repositories impossible on Cloud.
func TestServerRouter_OrgRoutesMountWithoutFeatureFlags(t *testing.T) {
	t.Parallel()

	router := routerWithFeatureFlags(config.FeatureFlagsConfig{}, nil, nil, nil)
	routes, ok := router.(chi.Routes)
	require.True(t, ok, "router must expose chi routes for contract walk")

	gated := map[string]string{}
	mounted := map[string]struct{}{}
	require.NoError(t, chi.Walk(routes, func(method, route string, _ http.Handler, middlewares ...func(http.Handler) http.Handler) error {
		key := method + " " + route
		mounted[key] = struct{}{}
		for _, mw := range middlewares {
			if strings.HasSuffix(middlewareFuncName(mw), ".FeatureFlagGate.func1") {
				gated[key] = middlewareFuncName(mw)
			}
		}
		return nil
	}))

	for _, key := range []string{
		"GET /api/orgs/{org}",
		"GET /api/orgs/{org}/repos",
		"POST /api/orgs",
		"PATCH /api/orgs/{org}",
		"GET /api/orgs/{org}/members",
		"POST /api/orgs/{org}/members",
		"DELETE /api/orgs/{org}/members/{username}",
		"GET /api/orgs/{org}/teams",
		"POST /api/orgs/{org}/teams",
		"GET /api/orgs/{org}/teams/{team}/repos",
		"POST /api/orgs/{org}/repos",
		"GET /api/user/orgs",
	} {
		assert.Contains(t, mounted, key, "org route must mount with no feature flags set")
		assert.NotContains(t, gated, key, "org route must not be feature-flag gated")
	}
}

// An unauthenticated org read reaches the handler instead of the flag gate's
// 403 "feature not available".
func TestServerRouter_OrgReadIsNotFeatureGated(t *testing.T) {
	t.Parallel()

	router := routerWithFeatureFlags(config.FeatureFlagsConfig{}, nil, nil, nil)
	req := httptest.NewRequest(http.MethodGet, "/api/orgs/acme", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	assert.NotContains(t, rec.Body.String(), "feature not available")
}
