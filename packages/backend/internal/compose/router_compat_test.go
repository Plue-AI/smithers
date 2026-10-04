package compose

import (
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
)

func testCORSConfig() *config.Config {
	return &config.Config{
		FeatureFlags: config.FeatureFlagsConfig{Workflows: true},
		Server:       config.ServerConfig{PublicURL: "https://example.com"},
	}
}

func TestAPIAllowedOriginsUsesExplicitServerAllowlist(t *testing.T) {
	cfg := &config.Config{
		Server: config.ServerConfig{
			PublicURL: "https://email.example",
			AllowedOrigins: []string{
				" http://127.0.0.1:5173, http://localhost:5173 ",
				"https://app.example/path",
			},
		},
	}

	assert.Equal(t, []string{
		"http://127.0.0.1:5173",
		"http://localhost:5173",
	}, apiAllowedOrigins(cfg))
}

// buildRouterCompat preserves the older test helper signature and fills newly
// added handlers with nil so existing router tests continue to compile.
func buildRouterCompat(
	cfg *config.Config,
	queries *db.Queries,
	pool *pgxpool.Pool,
	repoHandler *routes.RepoHandler,
	authHandler *routes.AuthHandler,
	userHandler *routes.UserHandler,
	sshKeyHandler *routes.SSHKeyHandler,
	labelHandler *routes.LabelHandler,

	orgHandler *routes.OrgHandler,
	landingHandler *routes.LandingHandler,
	searchHandler *routes.SearchHandler,
	issueHandler *routes.IssueHandler,
	wikiService routes.WikiService,
	gitHandler *routes.GitSmartHandler,
	notificationHandler *routes.NotificationHandler,
	adminUserHandler *routes.AdminUserHandler,
	adminOrgHandler *routes.AdminOrgHandler,
	adminRepoHandler *routes.AdminRepoHandler,
	adminGitHubAppHandler *routes.AdminGitHubAppHandler,
	adminAuditHandler *routes.AdminAuditHandler,
	webhookHandler *routes.WebhookHandler,
	secretHandler *routes.SecretHandler,
	variableHandler *routes.VariableHandler,
	commitStatusHandler *routes.CommitStatusHandler,
	lfsHandler *routes.LFSHandler,
	jjVCSHandler *routes.JJVCSHandler,
	agentInternalHandler *routes.AgentInternalHandler,
	agentSessionHandler *routes.AgentSessionHandler,
	agentSessionStreamHandler *routes.AgentSessionStreamHandler,
	pushHookHandler *routes.InternalPushHookHandler,
	workflowHandler *routes.WorkflowHandler,
	workspaceHandler *routes.WorkspaceHandler,
	workspaceInternalHandler *routes.WorkspaceInternalHandler,
	workspaceTerminalHandler *routes.WorkspaceTerminalHandler,
	telemetryHandler *routes.TelemetryHandler,
	featureFlagHandler *routes.FeatureFlagHandler,
	oauth2Handler *routes.OAuth2Handler,
	smithersMetrics *routes.SmithersMetrics,
	optional ...any, // *routes.GitHubImportHandler, *routes.ProviderConnectionHandler, routerExtras
) http.Handler {
	var importHandler *routes.GitHubImportHandler
	var providerConnectionHandler *routes.ProviderConnectionHandler
	var gitHubWebhookHandler *routes.GitHubWebhookHandler
	var extras []any
	for _, handler := range optional {
		switch h := handler.(type) {
		case routerExtras:
			extras = append(extras, h)
		case *routes.GitHubImportHandler:
			importHandler = h
		case *routes.ProviderConnectionHandler:
			providerConnectionHandler = h
		case *routes.GitHubWebhookHandler:
			gitHubWebhookHandler = h
		}
	}
	return buildRouter(
		cfg,
		queries,
		pool,
		repoHandler,
		nil, // mirrorSyncHandler
		authHandler,
		userHandler,
		sshKeyHandler,
		nil, // deployKeyHandler
		labelHandler,

		orgHandler,
		landingHandler,
		nil, // buildCacheHandler
		nil, // stackHandler
		searchHandler,
		issueHandler,
		wikiService,
		gitHandler,
		notificationHandler,
		adminUserHandler,
		adminOrgHandler,
		adminRepoHandler, // adminSystemMetricsHandler
		adminGitHubAppHandler,
		adminAuditHandler,
		webhookHandler,
		secretHandler,
		providerConnectionHandler,
		variableHandler,
		nil, // billingHandler
		nil, // protectedBookmarkHandler
		commitStatusHandler,
		lfsHandler,
		jjVCSHandler,
		agentInternalHandler,
		agentSessionHandler,
		agentSessionStreamHandler,
		nil,             // approvalsHandler
		pushHookHandler, // canaryReportHandler
		workflowHandler,
		nil, // workflowCacheHandler
		nil, // workflowArtifactHandler
		nil, // issueEventHandler
		workspaceHandler,
		workspaceInternalHandler,
		nil, // repositoryJobHandler
		nil, // gitHubProxyHandler
		nil, // gitHubRepoListHandler
		nil, // gitHubUserReposHandler
		nil, // gitHubSyncedReposHandler
		importHandler,
		workspaceTerminalHandler,
		telemetryHandler,
		featureFlagHandler,
		oauth2Handler,
		gitHubWebhookHandler,
		smithersMetrics,
		extras...,
	)
}
