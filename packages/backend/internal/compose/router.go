package compose

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	chiMiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/lfsauth"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/smithersai/smithers/packages/backend/ports"
)

type routerExtras struct {
	Admission           services.BillingPolicy
	BillingCapabilities services.BillingCapabilities
	Recommender         *routes.RecommendationHandler
	ModelStream         *routes.ModelStreamHandler
	Catalog             *routes.PublicRepositoryCatalogHandler
	Mythical            *routes.MythicalHandler
	UserRefs            *routes.UserRefHandler
	AdminSystemStatus   *routes.AdminSystemStatusHandler
	AdminSystemHealth   *routes.AdminSystemHealthHandler
	AdminAnalytics      *routes.AdminAnalyticsHandler
	AdminAgentSessions  *routes.AdminAgentSessionHandler
	AdminWorkspaces     *routes.AdminWorkspaceHandler
	AdminTokens         *routes.AdminTokenHandler
	// DeploymentAdmin are operator endpoints for deployment-owned resources,
	// mounted behind the same admin chain as the product's.
	DeploymentAdmin []ports.AdminRoute
	// ModelProxy is the metered platform-model proxy; nil when the deployment
	// offers no platform models.
	ModelProxy http.Handler
}

func buildRouter(
	cfg *config.Config,
	queries *db.Queries,
	pool *pgxpool.Pool,
	repoHandler *routes.RepoHandler,
	mirrorSyncHandler *routes.GitMirrorSyncHandler,
	authHandler *routes.AuthHandler,
	userHandler *routes.UserHandler,
	sshKeyHandler *routes.SSHKeyHandler,
	deployKeyHandler *routes.DeployKeyHandler,
	labelHandler *routes.LabelHandler,

	orgHandler *routes.OrgHandler,
	landingHandler *routes.LandingHandler,
	changesetHandler *routes.ChangesetHandler,
	buildCacheHandler *routes.BuildCacheHandler,
	stackHandler *routes.StackHandler,
	searchHandler *routes.SearchHandler,
	issueHandler *routes.IssueHandler,

	wikiService routes.WikiService,
	gitHandler *routes.GitSmartHandler,
	notificationHandler *routes.NotificationHandler,
	pairSessionHandler *routes.PairSessionHandler,

	adminUserHandler *routes.AdminUserHandler,
	adminOrgHandler *routes.AdminOrgHandler,
	adminRepoHandler *routes.AdminRepoHandler,
	adminGitHubAppHandler *routes.AdminGitHubAppHandler,
	adminAuditHandler *routes.AdminAuditHandler,
	webhookHandler *routes.WebhookHandler,
	secretHandler *routes.SecretHandler,
	providerConnectionHandler *routes.ProviderConnectionHandler,
	variableHandler *routes.VariableHandler,
	billingHandler *routes.BillingHandler,
	protectedBookmarkHandler *routes.ProtectedBookmarkHandler,
	commitStatusHandler *routes.CommitStatusHandler,
	lfsHandler *routes.LFSHandler,
	jjVCSHandler *routes.JJVCSHandler,
	agentInternalHandler *routes.AgentInternalHandler,
	agentSessionHandler *routes.AgentSessionHandler,
	agentSessionStreamHandler *routes.AgentSessionStreamHandler,
	approvalsHandler *routes.ApprovalsHandler,
	branchLockHandler *routes.BranchLockHandler,
	pushHookHandler *routes.InternalPushHookHandler,
	workflowHandler *routes.WorkflowHandler,
	workflowCacheHandler *routes.WorkflowCacheHandler,
	workflowArtifactHandler *routes.WorkflowArtifactHandler,

	issueEventHandler *routes.IssueEventHandler,
	workspaceHandler *routes.WorkspaceHandler,
	workspaceInternalHandler *routes.WorkspaceInternalHandler,
	repositoryJobHandler *routes.RepositoryJobHandler,
	gitHubProxyHandler *routes.GitHubProxyHandler,
	gitHubRepoListHandler *routes.GitHubRepoListHandler,
	gitHubUserReposHandler *routes.GitHubUserReposHandler,
	gitHubSyncedReposHandler *routes.GitHubSyncedReposHandler,
	gitHubImportHandler *routes.GitHubImportHandler,
	workspaceTerminalHandler *routes.WorkspaceTerminalHandler,
	telemetryHandler *routes.TelemetryHandler,
	featureFlagHandler *routes.FeatureFlagHandler,
	oauth2Handler *routes.OAuth2Handler,
	linearHandler *routes.LinearIntegrationHandler,
	gitHubWebhookHandler *routes.GitHubWebhookHandler,
	smithersMetrics *routes.SmithersMetrics,
	routerOptions ...any,
) *chi.Mux {
	var extras routerExtras
	for _, option := range routerOptions {
		switch value := option.(type) {
		case routerExtras:
			extras = value
		}
	}
	if extras.Catalog == nil {
		extras.Catalog = routes.NewPublicRepositoryCatalog(queries)
	}
	r := chi.NewRouter()
	var ownerBoundary identity.OwnerAuthorizer
	if config.IsSingleOwner(cfg.Auth) {
		ownerBoundary = identity.NewSingleOwnerBoundary(queries)
	}
	allowedOrigins := apiAllowedOrigins(cfg)
	if authHandler != nil {
		// Credential endpoints and CORS consume the same exact allowlist.
		authHandler.AllowedOrigins = append([]string(nil), allowedOrigins...)
	}

	// Ticket 12: feature-flag gates for non-MVP route families. Each gate is a
	// closure over cfg.FeatureFlags so flipping the flag at config-load time
	// flips the gate. The gates short-circuit with 403 + Gitea-compatible
	// APIError JSON ({"message":"feature not available"}) when the flag is
	// off. Callers wrap a route or sub-router with the gate alongside (not
	// instead of) the existing auth/scope middleware.
	gateIssues := middleware.FeatureFlagGate(func() bool { return cfg.FeatureFlags.Issues })
	gateSearch := middleware.FeatureFlagGate(func() bool { return cfg.FeatureFlags.Search })
	gateWiki := middleware.FeatureFlagGate(func() bool { return cfg.FeatureFlags.Wiki })
	gateLabels := middleware.FeatureFlagGate(func() bool { return cfg.FeatureFlags.Labels })

	gateSecrets := middleware.FeatureFlagGate(func() bool { return cfg.FeatureFlags.Secrets })
	gateNotifications := middleware.FeatureFlagGate(func() bool { return cfg.FeatureFlags.Notifications })
	gateChangesets := middleware.FeatureFlagGate(func() bool { return cfg.FeatureFlags.Changesets })
	// Stored Claude/ChatGPT subscription logins: self-host only, off in the
	// hosted product. Covers every /provider-connections route and the pool.
	gateSubscriptionConnections := middleware.FeatureFlagGate(func() bool { return cfg.FeatureFlags.SubscriptionConnections })
	gateProtectedBookmarks := middleware.FeatureFlagGate(func() bool { return cfg.FeatureFlags.ProtectedBookmarks })
	gateWebhooksUser := middleware.FeatureFlagGate(func() bool { return cfg.FeatureFlags.WebhooksUser })
	gateWorkflows := middleware.FeatureFlagGate(func() bool { return cfg.FeatureFlags.Workflows })
	gateAgents := middleware.FeatureFlagGate(func() bool { return config.IsSingleOwner(cfg.Auth) || cfg.FeatureFlags.Agents })
	gateWorkspaces := middleware.FeatureFlagGate(func() bool { return config.IsSingleOwner(cfg.Auth) || cfg.FeatureFlags.Workspaces })
	gateSandboxes := middleware.FeatureFlagGate(func() bool { return cfg.FeatureFlags.Sandboxes })
	gateTelemetry := middleware.FeatureFlagGate(func() bool { return cfg.FeatureFlags.ClientErrorReporting })
	quotaStore := middleware.NewTokenBucketStore()
	repoAPIQuota := middleware.PerRepoAPIRequests(quotaStore)
	repoStackQuota := middleware.PerRepoStackSubmits(quotaStore)
	repoWorkflowQuota := middleware.PerRepoWorkflowRuns(quotaStore)
	var quotaCounters interface {
		middleware.ConnectedRepoCounter
		middleware.ConcurrentWorkflowRunCounter
		middleware.ConcurrentSandboxCounter
	}
	if queries != nil {
		quotaCounters = queries
	}
	userConnectedReposQuota := middleware.PerUserConnectedRepos(quotaCounters, 10)
	userWorkflowRunsQuota := middleware.PerUserConcurrentWorkflowRuns(quotaCounters, 5)
	var sandboxPlanCheck func(context.Context, int64) error
	if extras.Admission != nil {
		sandboxPlanCheck = extras.Admission.AuthorizeSandboxStart
	}

	userSandboxesQuota := middleware.PerUserConcurrentSandboxes(quotaCounters, perUserConcurrentSandboxCap, sandboxPlanCheck)
	workflowRunCountHandler := &routes.WorkflowRunCountHandler{Counter: quotaCounters}
	// Server startup validation requires this secret. Keep construction
	// defensive for unit routers: a nil manager still fails closed whenever a
	// caller presents the dedicated LFS scheme, while unrelated auth continues.
	// The API only verifies bridge credentials, so it must not depend on the
	// public URL that is needed solely by the SSH issuer.
	lfsAuthManager, _ := lfsauth.NewManager(cfg.Auth.LFSSigningSecret)
	var ticketsIssued prometheus.Counter
	var ticketsValidated *prometheus.CounterVec
	if smithersMetrics != nil {
		ticketsIssued = prometheus.NewCounter(prometheus.CounterOpts{
			Name: "smithers_sse_tickets_issued_total",
			Help: "Total SSE auth tickets issued.",
		})
		ticketsValidated = prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "smithers_sse_tickets_validated_total",
			Help: "SSE ticket validation outcomes.",
		}, []string{"result"})
		smithersMetrics.MustRegister(ticketsIssued, ticketsValidated)
	}
	var sseTicketHandler *routes.SSETicketHandler
	var sseTicketService *services.SSETicketService
	if queries != nil {
		sseTicketService = services.NewSSETicketService(queries)
		sseTicketHandler = &routes.SSETicketHandler{
			Service: sseTicketService,
		}
		if ticketsIssued != nil {
			sseTicketHandler.Metrics = &routes.SSETicketRouteMetrics{TicketsIssued: ticketsIssued}
		}
	}
	sseTicketAuth := func(next http.Handler) http.Handler { return next }
	if sseTicketHandler != nil {
		var sseTicketMetrics *middleware.SSETicketMetrics
		if ticketsValidated != nil {
			sseTicketMetrics = &middleware.SSETicketMetrics{TicketsValidated: ticketsValidated}
		}
		ticketAuth := middleware.SSETicketAuth(
			sseTicketService,
			sseTicketMetrics,
			ownerBoundary,
		)
		// Ticket auth installs its principal after authLoader's guard has
		// already run, so the guard must run again behind it or a ticket's
		// revoked token or disabled user is never checked.
		ticketGuard := middleware.RevocationGuard(revocationChecker)
		sseTicketAuth = func(next http.Handler) http.Handler {
			return ticketAuth(ticketGuard(next))
		}
	}

	// Middleware stack prefix (spec order)
	r.Use(chiMiddleware.RequestID)
	// Derive the client IP from X-Forwarded-For using a trusted-hop count
	// (SMITHERS_SERVER_TRUSTED_PROXY_HOPS: 1 behind GCLB in prod, 0 = keep
	// the socket address elsewhere). Replaces chi's RealIP, which trusted
	// the spoofable first XFF entry (rate-limit bypass, audit-log forgery).
	r.Use(middleware.RealIP(cfg.Server.TrustedProxyHops))
	r.Use(middleware.RequestIDEcho) // echo X-Request-Id in response for trace correlation
	// OpenTelemetry HTTP middleware - instruments all incoming requests with trace context
	r.Use(middleware.HTTPTracing("smithers-server"))
	r.Use(middleware.InjectLogger(slog.Default()))
	r.Use(middleware.StructuredLogger(slog.Default()))
	// Record HTTP request counts + durations. Pass nil explicitly when smithersMetrics is nil
	// to avoid a non-nil interface wrapping a nil pointer (Go interface nil semantics).
	if smithersMetrics != nil {
		r.Use(middleware.HTTPMetrics(smithersMetrics))
	}
	// A dependency's own verdict (repo-host holding a repository) answers any
	// generic server error its refusal caused, whichever route made the call,
	// a panic's included.
	r.Use(middleware.DependencyRefusals)
	// Recovery must complete inside the metrics recorder so a panic's 500 is
	// counted alongside ordinary responses.
	r.Use(middleware.JSONRecoverer)
	if strings.TrimSpace(cfg.Auth.GitHubClientID) != "" {
		r.Use(middleware.CanonicalBrowserAuthOrigin(cfg.Auth.GitHubRedirectURL))
	}

	healthzHandler := routes.NewHealthzHandler(pool, cfg.RepoHost.URL)
	readyzHandler := routes.NewReadyzHandler(pool, cfg.RepoHost.URL)
	var alphaAccessHandler *routes.AlphaAccessHandler
	if queries != nil {
		alphaAccessHandler = &routes.AlphaAccessHandler{
			Service:      services.NewAlphaAccessService(queries),
			AuditService: services.NewAuditService(queries),
		}
	}

	// Public health endpoint
	r.Get("/health", routes.Health)
	r.Get("/healthz", healthzHandler.Healthz)
	r.Get("/readyz", readyzHandler.Readyz)
	// Prometheus metrics endpoint (for Kubernetes monitoring / Cloud Monitoring scraping).
	// The ingress exposes "/" publicly, so network policy alone is not sufficient: the
	// metrics expose sensitive operational data. Require a shared bearer token. The token
	// is read from SMITHERS_METRICS_TOKEN (provisioned as a Secret Manager secret + env
	// binding; the Cloudflare status worker must send it as `Authorization: Bearer <token>`).
	// RequireSharedBearerToken fails safe (401) when the token is unset.
	if smithersMetrics != nil {
		r.Get("/metrics", protectedMetricsHandler(smithersMetrics).ServeHTTP)
	}

	r.Route("/internal", func(r chi.Router) {
		var querier middleware.AgentTokenQuerier
		if queries != nil {
			querier = queries
		}
		// Workspace status callbacks operate purely on IDs from the URL/body
		// with no per-run ownership scoping, so they must only be reachable with
		// the shared deployment credential (SMITHERS_AGENT_TOKEN) — never with
		// per-run agent tokens handed to untrusted sandboxes, which could
		// otherwise spoof any workspace's status.
		sharedAgentToken := strings.TrimSpace(os.Getenv("SMITHERS_AGENT_TOKEN"))
		r.Group(func(r chi.Router) {
			r.Use(middleware.RequireSharedBearerToken(sharedAgentToken))
			if workspaceInternalHandler != nil {
				r.Post("/workspace/{id}/status", workspaceInternalHandler.PostWorkspaceStatus)
				r.Post("/workspace/{id}/head", workspaceInternalHandler.PostWorkspaceHead)
			}
		})
		// Workflow cache and artifact routes also accept a CI job token: the
		// per-job credential the sandbox scheduler hands each NixOS CI guest.
		// Agent-session routes below stay per-run-agent-token only.
		var jobTokens middleware.CIJobTokenQuerier
		if queries != nil {
			jobTokens = queries
		}
		r.Group(func(r chi.Router) {
			r.Use(middleware.RequireWorkflowRunCredential(querier, jobTokens))
			if workflowCacheHandler != nil {
				r.With(gateWorkflows).Post("/caches/restore", workflowCacheHandler.Restore)
				r.With(gateWorkflows).Post("/caches/save", workflowCacheHandler.BeginSave)
				r.With(gateWorkflows).Post("/caches/{cache-id}/finalize", workflowCacheHandler.FinalizeSave)
				r.With(gateWorkflows).Post("/caches/{cache-id}/abort", workflowCacheHandler.AbortSave)
			}
			if workflowArtifactHandler != nil {
				r.With(gateWorkflows).Post("/runs/{id}/artifacts/upload-url", workflowArtifactHandler.PostInternalUploadURL)
				r.With(gateWorkflows).Post("/runs/{id}/artifacts/confirm", workflowArtifactHandler.PostInternalConfirm)
				r.With(gateWorkflows).Get("/runs/{id}/artifacts/{name}/download", workflowArtifactHandler.GetInternalDownloadURL)
			}
		})
		r.Group(func(r chi.Router) {
			r.Use(middleware.RequireAgentToken(querier))
			if agentInternalHandler != nil {
				r.Post("/agent/sessions/{session_id}/events", agentInternalHandler.PostSessionEvent)
			}
		})
		if pushHookHandler != nil {
			r.With(middleware.RequireSharedBearerToken(cfg.RepoHost.PushHookCallbackToken)).Post("/repo-host/push-events", pushHookHandler.PostPushEvent)
		}
	})

	// Git smart HTTP routes are outside /api and intentionally bypass JSON timeout/content-type middleware.
	if gitHandler != nil {
		r.Get("/{owner}/{repo}/info/refs", gitHandler.InfoRefs)
		r.Post("/{owner}/{repo}/git-upload-pack", gitHandler.UploadPack)
		r.Post("/{owner}/{repo}/git-receive-pack", gitHandler.ReceivePack)
	}

	// Git LFS derives this endpoint directly from an HTTP Git remote by
	// appending .git/info/lfs/objects/batch. Keep it outside /api alongside the
	// smart-HTTP transport, while applying the same bounded JSON and auth
	// loading used by the API alias. The literal .git suffix is excluded from
	// chi's {repo} parameter, so repository resolution sees the canonical name.
	if lfsHandler != nil {
		r.Group(func(r chi.Router) {
			r.Use(middleware.JSONAllowContentType("application/json", routes.LFSJSONMediaType))
			r.Use(middleware.MaxBodySize(middleware.MaxRequestBodySize))
			r.Use(lfsauth.HTTPMiddleware(lfsAuthManager))
			r.Use(authLoader(queries, cfg.Auth))
			r.Use(apiCSRFMiddleware)
			r.Use(middleware.GlobalAPIRateLimit(queries))
			r.With(middleware.JSONTimeout(apiJSONTimeout), repoAPIQuota).Post("/{owner}/{repo}.git/info/lfs/objects/batch", lfsHandler.PostBatch)
		})
	}

	apiCORS := apiCORSOptions(cfg)

	// Canonical LFS protocol endpoints intentionally resolve authorization in
	// LFSService rather than LoadRepoContext: a git-lfs-authenticate credential
	// represents an SSH deploy key as well as a user, and therefore has no
	// db.User to attach. The dedicated middleware validates its repository and
	// operation scope; ordinary PAT/session requests retain scope, CSRF, and
	// service-level repository permission checks.
	if lfsHandler != nil {
		r.Group(func(r chi.Router) {
			r.Use(cors.Handler(apiCORS))
			r.Use(middleware.JSONAllowContentType("application/json", routes.LFSJSONMediaType))
			r.Use(middleware.MaxBodySize(middleware.MaxRequestBodySize))
			r.Use(lfsauth.HTTPMiddleware(lfsAuthManager))
			r.Use(authLoader(queries, cfg.Auth))
			r.Use(apiCSRFMiddleware)
			r.Use(middleware.GlobalAPIRateLimit(queries))
			r.With(middleware.JSONTimeout(apiJSONTimeout), repoAPIQuota).Post("/api/repos/{owner}/{repo}/lfs/objects/batch", lfsHandler.PostBatch)
			r.With(middleware.JSONTimeout(lfsVerifyTimeout(cfg)), repoAPIQuota).Post("/api/repos/{owner}/{repo}/lfs/verify", lfsHandler.PostVerify)
		})
	}

	integrationsHandler := routes.NewIntegrationsHandler(routes.IntegrationCatalog(routes.IntegrationCapabilities{
		GitHubMirror: gitHubSyncedReposHandler != nil && strings.TrimSpace(cfg.Webhook.GitHubAppSecret) != "",
		Linear:       linearHandler != nil && strings.TrimSpace(cfg.Auth.LinearClientID) != "" && strings.TrimSpace(cfg.Auth.LinearClientSecret) != "",
	})...)

	// SSE workflow run log stream — registered at the top-level router (outside /api's JSONTimeout
	// middleware group) so the connection is not subject to the 30s request timeout.
	// The full path prefix /api/repos/... is used so CORS and routing are consistent with other API paths.
	// WorkflowRouteService satisfies WorkflowRunRouteService at compile time -- no runtime type assertion needed.
	if workflowHandler != nil {
		// Reuse the one shared SSE broker (created alongside the agent-session
		// handler) so workflow-run log streams do not consume a pool slot each.
		var wrrBroker *sse.Broker
		if agentSessionStreamHandler != nil {
			wrrBroker = agentSessionStreamHandler.Broker
		}
		wrrHandler := &routes.WorkflowRunHandler{Service: workflowHandler.Service, Broker: wrrBroker, Metrics: smithersMetrics}
		r.Group(func(r chi.Router) {
			r.Use(cors.Handler(apiCORS))
			r.Use(authLoader(queries, cfg.Auth))
			r.Use(sseTicketAuth)
			if queries != nil {
				r.Use(middleware.LoadRepoContext(queries))
			}
			readRepo := []func(http.Handler) http.Handler{
				middleware.RequireAuth,
				middleware.RequireScope(middleware.ScopeReadRepository),
			}
			if queries != nil {
				readRepo = append(readRepo, middleware.RequireRepoPermission(middleware.PermissionRead))
			}
			readRepo = append(readRepo, repoAPIQuota, gateWorkflows)
			r.With(readRepo...).Get("/api/repos/{owner}/{repo}/runs/{id}/logs", wrrHandler.WorkflowRunLogsStream)
			r.With(readRepo...).Get("/api/repos/{owner}/{repo}/workflows/runs/{id}/events", wrrHandler.WorkflowRunLogsStream)
			// Ticket 0111: canonical SSE route for run events. Aliases the
			// existing `/workflows/runs/{id}/events` path at the same handler —
			// no behavior change, just a single canonical naming for clients.
			r.With(readRepo...).Get("/api/repos/{owner}/{repo}/runs/{id}/events", wrrHandler.WorkflowRunLogsStream)
			// The run lifecycle stream (queued/running/terminal) — the follow
			// half of the invocation seam for clients that did not start the run.
			r.With(readRepo...).Get("/api/repos/{owner}/{repo}/runs/{id}/status/stream", wrrHandler.WorkflowRunStatusStream)
		})
	}

	// Wiki collaboration uses the existing shared broker and auth/revocation
	// infrastructure. The stream must remain outside the JSON timeout group.
	if collaborative, ok := wikiService.(routes.WikiCollaborationService); ok {
		var broker *sse.Broker
		if agentSessionStreamHandler != nil {
			broker = agentSessionStreamHandler.Broker
		}
		handler := &routes.WikiCollaborationHandler{Service: collaborative, Broker: broker}
		r.Group(func(r chi.Router) {
			r.Use(cors.Handler(apiCORS))
			r.Use(authLoader(queries, cfg.Auth))
			r.Use(sseTicketAuth)
			if queries != nil {
				r.Use(middleware.LoadRepoContext(queries))
			}
			gates := []func(http.Handler) http.Handler{middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadRepository), repoAPIQuota, gateWiki}
			if queries != nil {
				gates = append(gates, middleware.RequireRepoPermission(middleware.PermissionRead))
			}
			r.With(gates...).Get("/api/repos/{owner}/{repo}/wiki/{slug}/stream", handler.Stream)
		})
	}

	// SSE agent session stream — registered at the top-level router (outside /api's JSONTimeout
	// middleware group) so the connection is not subject to the 30s request timeout.
	if agentSessionStreamHandler != nil {
		r.Group(func(r chi.Router) {
			r.Use(cors.Handler(apiCORS))
			r.Use(authLoader(queries, cfg.Auth))
			r.Use(sseTicketAuth)
			if queries != nil {
				r.Use(middleware.LoadRepoContext(queries))
			}
			readAgent := []func(http.Handler) http.Handler{
				middleware.RequireAuth,
				middleware.RequireScope(middleware.ScopeReadRepository),
			}
			if queries != nil {
				readAgent = append(readAgent, middleware.RequireRepoPermission(middleware.PermissionRead))
			}
			readAgent = append(readAgent, repoAPIQuota)
			readAgent = append(readAgent, gateAgents)
			r.With(readAgent...).Get("/api/repos/{owner}/{repo}/agent/sessions/{id}/stream", agentSessionStreamHandler.AgentSessionStream)
		})
	}

	// Workspace VM provisioning routes — registered at the top-level router (outside /api's
	// JSONTimeout middleware group) because Microsandbox VM creation can take minutes.
	// Uses its own 10-minute timeout instead of the default 30s; the Microsandbox
	// client times out first so the handler can record failed provisioning state.
	if workspaceHandler != nil {
		r.Group(func(r chi.Router) {
			r.Use(cors.Handler(apiCORS))
			r.Use(middleware.JSONTimeout(10 * time.Minute))
			r.Use(authLoader(queries, cfg.Auth))
			r.Use(apiCSRFMiddleware)
			r.Use(middleware.JSONAllowContentType("application/json"))
			r.Use(middleware.MaxBodySize(middleware.MaxRequestBodySize))
			if queries != nil {
				r.Use(middleware.LoadRepoContext(queries))
			}
			vmProvision := []func(http.Handler) http.Handler{
				middleware.RequireAuth,
				middleware.RequireScope(middleware.ScopeWriteRepository),
			}
			if queries != nil {
				vmProvision = append(vmProvision, middleware.RequireRepoPermission(middleware.PermissionWrite))
			}
			vmProvision = append(vmProvision, repoAPIQuota)
			vmProvision = append(vmProvision, gateWorkspaces)
			vmProvisionSandbox := append([]func(http.Handler) http.Handler{}, vmProvision...)
			vmProvisionSandbox = append(vmProvisionSandbox, gateSandboxes, userSandboxesQuota)
			// Session create deliberately does NOT take userSandboxesQuota on the
			// no-workspace_id path: the service REUSES the repo's existing primary
			// workspace (findOrCreatePrimaryWorkspace) and only creates one when
			// none exists — where enforceWorkspaceQuota already fires (ticket
			// 0105). Gating the route on the concurrent-sandbox count 429'd every
			// terminal attach for users whose OTHER VMs (durable gateways, resumed
			// workspaces) had filled the cap, even though attaching provisions
			// nothing (2026-07-08 prod outage: all terminals dead with
			// "concurrent sandboxes limit reached"). A workspace_id targeting a
			// NON-running workspace, however, resumes a VM, so it must clear the
			// same stack as /workspaces/{id}/resume (issue #20).
			var workspaceSessionStore workspaceSessionWorkspaceLoader
			if queries != nil {
				workspaceSessionStore = queries
			}
			workspaceSessionProvision := append([]func(http.Handler) http.Handler{}, vmProvision...)
			workspaceSessionProvision = append(
				workspaceSessionProvision,
				gateSandboxes,
				workspaceSessionSandboxQuota(
					workspaceSessionStore,
					nil,
					[]func(http.Handler) http.Handler{userSandboxesQuota},
				),
			)
			r.With(vmProvisionSandbox...).Post("/api/repos/{owner}/{repo}/workspaces", workspaceHandler.CreateWorkspace)
			r.With(vmProvisionSandbox...).Post("/api/repos/{owner}/{repo}/workspaces/{id}/resume", workspaceHandler.ResumeWorkspace)
			r.With(vmProvisionSandbox...).Post("/api/repos/{owner}/{repo}/workspaces/{id}/fork", workspaceHandler.ForkWorkspace)
			r.With(vmProvision...).Delete("/api/repos/{owner}/{repo}/workspaces/{id}", workspaceHandler.DeleteWorkspace)
			r.With(vmProvision...).Post("/api/repos/{owner}/{repo}/workspaces/{id}/suspend", workspaceHandler.SuspendWorkspace)
			// RFD-004: guest head reports; a workspace-bound token reaches only this route.
			r.With(vmProvision...).Post("/api/repos/{owner}/{repo}/workspaces/{id}/head", workspaceHandler.ReportWorkspaceHead)
			r.With(vmProvision...).Post("/api/repos/{owner}/{repo}/workspaces/{id}/snapshot", workspaceHandler.CreateWorkspaceSnapshot)
			r.With(vmProvision...).Post("/api/repos/{owner}/{repo}/workspaces/{id}/coding/operations", workspaceHandler.ApplyCodingOperation)
			if jjVCSHandler != nil {
				r.With(vmProvision...).Get("/api/repos/{owner}/{repo}/workspaces/{id}/operations/{op_id}/undo/preview", jjVCSHandler.PreviewOperationUndo)
				r.With(vmProvision...).Post("/api/repos/{owner}/{repo}/workspaces/{id}/operations/{op_id}/undo", jjVCSHandler.UndoOperation)
			}
			r.With(vmProvision...).Post("/api/repos/{owner}/{repo}/workspace-snapshots", workspaceHandler.CreateWorkspaceSnapshotTemplate)
			r.With(workspaceSessionProvision...).Post("/api/repos/{owner}/{repo}/workspace/sessions", workspaceHandler.CreateSession)
			// Destroying the last session suspends and checkpoints a persistent
			// Microsandbox VM. Disk snapshot export can legitimately exceed the
			// ordinary 30-second JSON API deadline, just like provisioning.
			r.With(vmProvision...).Post("/api/repos/{owner}/{repo}/workspace/sessions/{id}/destroy", workspaceHandler.DestroySession)
		})
	}
	if workspaceHandler != nil && workspaceHandler.Desktop != nil {
		// Desktop-session-token authenticated relay for kind=desktop workspaces.
		// Outside repository auth: the viewer runs in an iframe and a
		// WebSocket, neither of which can carry headers, so the path token is
		// the credential.
		r.Group(func(r chi.Router) {
			r.Use(cors.Handler(apiCORS))
			r.Handle("/api/workspaces/{workspaceID}/desktop/{token}", http.HandlerFunc(workspaceHandler.Desktop.Relay))
			r.Handle("/api/workspaces/{workspaceID}/desktop/{token}/*", http.HandlerFunc(workspaceHandler.Desktop.Relay))
		})
	}
	if repositoryJobHandler != nil {
		// A box's coding host calls repository jobs back with its flowhost
		// binding ID (SMITHERS_GATEWAY_ID) and control credential. Keep these
		// outside repository auth: the binding ID and credential are the auth.
		r.Group(func(r chi.Router) {
			r.Use(cors.Handler(apiCORS))
			r.With(gateWorkflows).Put("/api/gateways/{hostID}/repository-jobs/{job}", repositoryJobHandler.PutRepositoryJob)
			r.With(gateWorkflows).Put("/api/gateways/{hostID}/repository-jobs/{job}/trials/{requestID}", repositoryJobHandler.PutRepositoryJobTrial)
			r.With(gateWorkflows).Put("/api/gateways/{hostID}/repository-jobs/{job}/comments/{step}", repositoryJobHandler.PutRepositoryJobComment)
			r.With(gateWorkflows).Put("/api/gateways/{hostID}/repository-jobs/{job}/manual/{requestID}", repositoryJobHandler.PutRepositoryJobManual)
			r.With(gateWorkflows).Put("/api/gateways/{hostID}/repository-jobs/ci/check-receipts/{requestID}", repositoryJobHandler.PutRepositoryCheckReceipt)
		})
	}

	// Inbound Linear webhook — HMAC-verified inside the handler, no auth middleware.
	if linearHandler != nil {
		r.Post("/webhooks/linear", linearHandler.PostLinearWebhook)
	}
	// Inbound GitHub App webhook — signature-verified inside the handler, no auth middleware.
	if gitHubWebhookHandler != nil {
		r.Post("/webhooks/github", gitHubWebhookHandler.PostGitHubWebhook)
	}

	// API routes: apply timeout, CORS, then JSON content type enforcement.
	// Health check at /api/health so the Cloudflare Worker can proxy /api/health.
	// Registered outside the /api route group to avoid JSON content-type enforcement.
	r.Get("/api/health", routes.Health)
	// The failure-code registry, served so a deployment can be asked which
	// vocabulary it is actually running. Unauthenticated and read-only for the
	// same reason /api/health is: it is a published contract.
	r.Get("/api/meta/failure-codes", routes.FailureCodes)
	if extras.Catalog != nil {
		r.Get("/api/public/repos", extras.Catalog.ServeHTTP)
	}
	if billingHandler != nil && extras.BillingCapabilities.Webhook {
		r.With(
			middleware.JSONTimeout(30*time.Second),
			cors.Handler(apiCORS),
			middleware.JSONAllowContentType("application/json"),
			middleware.MaxBodySize(middleware.MaxRequestBodySize),
		).Post("/api/billing/webhook", billingHandler.PostStripeWebhook)
	}

	// /api/internal is the machine-to-machine namespace. Mounting it keeps an
	// unknown path under it a 404 instead of falling through to the
	// user-authenticated /api group below.
	r.Route("/api/internal", func(chi.Router) {})

	// The provider account pool (self-host only, behind
	// feature_flags.subscription_connections): workspaces' and managed Flow
	// hosts' Claude and Codex model calls, authenticated by the workspace's
	// pool credential or the host's model credential. Outside /api: calls
	// stream for minutes, and workspace-bound credentials are confined away
	// from the /api surface.
	if providerConnectionHandler != nil && providerConnectionHandler.Pool != nil {
		r.Group(func(r chi.Router) {
			r.Use(gateSubscriptionConnections)
			r.Use(routes.ProviderPoolAuth(func(next http.Handler) http.Handler {
				return authLoader(queries, cfg.Auth)(middleware.RequireAuth(next))
			}))
			r.Get(services.ProviderPoolPath+"/routes", providerConnectionHandler.Pool.ServeHTTP)
			r.Post(services.ProviderPoolPath+"/*", providerConnectionHandler.Pool.ServeHTTP)
		})
	}

	// The metered platform-model proxy: guests reach it at /model-proxy with a
	// model credential or their run's agent token, and the app's signed-in
	// calls at /api/model/{provider} with the user's token. Outside /api:
	// calls stream for minutes, and the handler bounds its own bodies.
	if extras.ModelProxy != nil {
		mountModelProxy(r, queries, cfg, extras.ModelProxy)
	}

	// Build the rate-limit reject observer once so both the /api route group and
	// the long-lived SSE/WebSocket groups (mounted outside /api to avoid the 30s
	// timeout) share the same Prometheus counter instance.
	rateLimitRejectObserver := buildRateLimitRejectObserver(smithersMetrics)

	// GitHub import status can be requested as SSE, so keep it outside /api's
	// JSONTimeout group. POST /api/github/import stays in /api because it is a
	// bounded JSON request.
	if gitHubImportHandler != nil {
		r.Group(func(r chi.Router) {
			r.Use(cors.Handler(apiCORS))
			r.Use(authLoader(queries, cfg.Auth))
			r.Use(middleware.GlobalAPIRateLimit(queries))
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadRepository)).
				Get("/api/github/import/{id}", gitHubImportHandler.GetImportJob)
		})
	}

	// SSE notification stream — mounted at the top-level router (outside /api's
	// JSONTimeout group) so the long-lived connection is not subject to the 30s
	// request timeout. CORS is applied explicitly here to match /api behavior.
	// Ticket 12: gated by feature_flags.notifications.
	if notificationHandler != nil {
		r.Group(func(r chi.Router) {
			r.Use(cors.Handler(apiCORS))
			r.Use(authLoader(queries, cfg.Auth))
			r.Use(sseTicketAuth)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadUser), gateNotifications).Get("/api/notifications", notificationHandler.NotificationStream)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadUser), gateNotifications).Get("/api/notifications/events/stream", notificationHandler.NotificationFactsStream)
		})
	}

	// Issue accepted-state replay uses the shared durable broker outside JSONTimeout.
	if issueEventHandler != nil {
		r.Group(func(r chi.Router) {
			r.Use(cors.Handler(apiCORS))
			r.Use(authLoader(queries, cfg.Auth))
			r.Use(sseTicketAuth)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadRepository), gateIssues).
				Get("/api/repos/{owner}/{repo}/issues/state-events/stream", issueEventHandler.IssueStateFactsStream)
		})
	}

	// Smithers Pair sessions — the server-authoritative pairing API. Every route
	// is session-authed (AuthLoader + RequireAuth): identity is the real
	// signed-in user, roles + the paid-plan gate are enforced inside the service.
	// Mounted outside /api's 30s JSONTimeout group for headroom, but these are
	// plain JSON routes (no SSE). This SUPERSEDES the legacy key-gated
	// /api/pair/* realtime surface below.
	if pairSessionHandler != nil {
		r.Group(func(r chi.Router) {
			r.Use(cors.Handler(apiCORS))
			r.Use(authLoader(queries, cfg.Auth))
			r.Use(apiCSRFMiddleware)
			r.Group(func(r chi.Router) {
				r.Use(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadUser))
				// Bound request bodies like every other JSON mount — otherwise an
				// authenticated editor can POST a multi-GB body to /draft, /queue,
				// or /presence (each stored verbatim), a cheap DoS.
				r.Use(middleware.MaxBodySize(middleware.MaxRequestBodySize))
				pairSessionHandler.Mount(r)
			})
		})
	}

	// LEGACY Smithers Pair realtime API (pair_state + pg_notify SSE, key-gated)
	// is fully RETIRED: no /api/pair/* legacy routes are mounted — pair sessions
	// above are the sole sync/authz path, and pair_state is frozen (never
	// extended, no new write path). The pairauth hash/TTL machinery lives on,
	// reused by pair_session_invites.

	// App-machine timelines — the REST write path for synchronized xstate
	// history. Same auth chain as pair sessions: session
	// or read:user token; mutations gated on write:user inside Mount. The
	// larger body cap covers whole-dump rewrites (service-capped at 4 MiB of
	// payload; JSON escaping can inflate past the global 1 MB default).
	if queries != nil {
		appTimelineService := services.NewAppTimelineService(queries)
		if pool != nil {
			services.WithAppTimelineTxBeginner(pool)(appTimelineService)
		}
		appTimelineHandler := routes.NewAppTimelineHandler(appTimelineService)
		appTimelineHandler.WriteRateLimit = middleware.AppTimelineWriteRateLimit(queries, cfg.RateLimit.AppTimelineWritePerMin)
		r.Group(func(r chi.Router) {
			r.Use(cors.Handler(apiCORS))
			r.Use(authLoader(queries, cfg.Auth))
			r.Use(apiCSRFMiddleware)
			r.Group(func(r chi.Router) {
				r.Use(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadUser))
				r.Use(middleware.MaxBodySize(appTimelineMaxRequestBodySize))
				appTimelineHandler.Mount(r)
			})
		})
	}

	// Public sharing (/api/share/*) — selective publishing of workflow and
	// connector DEFINITIONS to a public catalog, with usage stats. The catalog
	// reads are deliberately unauthenticated (that is the point of a public
	// catalog), so this group runs AuthLoader without RequireAuth and carries
	// the global API bucket explicitly: these routes sit outside the /api
	// group, so the anonymous 600/hr-per-IP ceiling would not otherwise apply.
	// RequireAuth + scope gating for publish / unpublish / events / my-listings
	// lives inside Mount, and the events route additionally draws on a durable
	// per-user bucket so a caller cannot inflate their own listing's stats.
	if queries != nil {
		shareListingService := services.NewShareListingService(queries)
		shareListingHandler := routes.NewShareListingHandler(shareListingService)
		shareListingEventLimiter := middleware.ShareListingEventRateLimit(queries, cfg.RateLimit.ShareListingEventPerMin)
		r.Group(func(r chi.Router) {
			r.Use(cors.Handler(apiCORS))
			r.Use(authLoader(queries, cfg.Auth))
			r.Use(apiCSRFMiddleware)
			r.Use(middleware.GlobalAPIRateLimit(queries))
			// A publish body is one flow file / connector manifest; the service
			// caps the snapshot at 256 KiB and this bounds the envelope.
			r.Use(middleware.MaxBodySize(shareListingMaxRequestBodySize))
			shareListingHandler.Mount(r, shareListingEventLimiter)
		})
	}

	// Change facet events are mounted outside /api's JSONTimeout group. The
	// stream announces newly available per-revision artifacts such as the
	// smithers review walkthrough.
	if jjVCSHandler != nil {
		r.Group(func(r chi.Router) {
			r.Use(cors.Handler(apiCORS))
			r.Use(authLoader(queries, cfg.Auth))
			r.Use(sseTicketAuth)
			if queries != nil {
				r.Use(middleware.LoadRepoContext(queries))
			}
			readRepo := []func(http.Handler) http.Handler{
				middleware.RequireAuth,
				middleware.RequireScope(middleware.ScopeReadRepository),
			}
			if queries != nil {
				readRepo = append(readRepo, middleware.RequireRepoPermission(middleware.PermissionRead))
			}
			readRepo = append(readRepo, repoAPIQuota)
			r.With(readRepo...).Get("/api/repos/{owner}/{repo}/changes/events", jjVCSHandler.ChangeStream)
			if extras.Mythical != nil {
				r.With(readRepo...).Get("/api/repos/{owner}/{repo}/mythical/events", extras.Mythical.Events)
			}
		})
	}

	// The smithers build cache: the /ac + /cas protocol the smithers-build CLI
	// speaks, hosted per repository. Mounted outside the /api JSONTimeout group
	// because a 16 MiB artifact upload or download must not be cut at 30 s.
	// BuildCacheAccess classifies the credential (public read token, or normal
	// auth with repository permission) before any body is read; the write gate
	// refuses PUT and DELETE on a read credential with the protocol's 403.
	if buildCacheHandler != nil && queries != nil {
		r.Group(func(r chi.Router) {
			r.Use(cors.Handler(apiCORS))
			r.Get("/api/build-cache/healthz", buildCacheHandler.Health)
			r.Head("/api/build-cache/healthz", buildCacheHandler.Health)
		})
		r.Route("/api/repos/{owner}/{repo}/build-cache", func(r chi.Router) {
			r.Use(cors.Handler(apiCORS))
			r.Use(authLoader(queries, cfg.Auth))
			r.Use(apiCSRFMiddleware)
			r.Group(func(r chi.Router) {
				r.Use(middleware.BuildCacheAccess(queries, buildCacheHandler.Service))
				r.Use(middleware.BuildCacheRateLimit(queries, cfg.RateLimit.BuildCachePerMinute, time.Minute))
				r.Use(middleware.RequireBuildCacheWrite)
				r.Get("/healthz", buildCacheHandler.Health)
				r.Head("/healthz", buildCacheHandler.Health)
				r.Get("/ac/{keyDigest}", buildCacheHandler.ActionCache)
				r.Put("/ac/{keyDigest}", buildCacheHandler.ActionCache)
				r.Delete("/ac/{keyDigest}", buildCacheHandler.ActionCache)
				r.Post("/cas/findMissing", buildCacheHandler.FindMissing)
				r.Get("/cas/{digest}", buildCacheHandler.Artifact)
				r.Head("/cas/{digest}", buildCacheHandler.Artifact)
				r.Put("/cas/{digest}", buildCacheHandler.Artifact)
			})
			// Public read tokens are minted and revoked by repository admins
			// with a first-class credential; the cache routes above never
			// accept a management call.
			r.Group(func(r chi.Router) {
				r.Use(middleware.LoadRepoContext(queries))
				r.Use(middleware.RefuseRunCredentials)
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadRepository), middleware.RequireRepoPermission(middleware.PermissionWrite), repoAPIQuota).Get("/tokens", buildCacheHandler.ListReadTokens)
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteRepository), middleware.RequireRepoPermission(middleware.PermissionWrite), repoAPIQuota).Post("/tokens", buildCacheHandler.CreateReadToken)
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteRepository), middleware.RequireRepoPermission(middleware.PermissionWrite), repoAPIQuota).Delete("/tokens/{id}", buildCacheHandler.RevokeReadToken)
			})
		})
	}

	// SSE workspace/session streams — mounted outside /api's JSONTimeout group
	// so long-lived connections are not cut at 30 s.
	if workspaceHandler != nil {
		r.Group(func(r chi.Router) {
			r.Use(cors.Handler(apiCORS))
			r.Use(authLoader(queries, cfg.Auth))
			r.Use(sseTicketAuth)
			if queries != nil {
				r.Use(middleware.LoadRepoContext(queries))
			}
			readWorkspaceSSE := []func(http.Handler) http.Handler{
				middleware.RequireAuth,
				middleware.RequireScope(middleware.ScopeReadRepository),
			}
			if queries != nil {
				readWorkspaceSSE = append(readWorkspaceSSE, middleware.RequireRepoPermission(middleware.PermissionRead))
			}
			readWorkspaceSSE = append(readWorkspaceSSE, gateWorkspaces, gateSandboxes)
			r.With(readWorkspaceSSE...).Get("/api/repos/{owner}/{repo}/workspaces/{id}/stream", workspaceHandler.StreamWorkspace)
			r.With(readWorkspaceSSE...).Get("/api/repos/{owner}/{repo}/workspace/sessions/{id}/stream", workspaceHandler.StreamSession)
		})
	}

	// WebSocket terminal — mounted outside /api's JSONTimeout group so the
	// upgrade and subsequent bidirectional stream are not killed after 30 s.
	if workspaceTerminalHandler != nil {
		r.Group(func(r chi.Router) {
			r.Use(cors.Handler(apiCORS))
			r.Use(authLoader(queries, cfg.Auth))
			r.Use(sseTicketAuth)
			if queries != nil {
				r.Use(middleware.LoadRepoContext(queries))
			}
			writeTerminal := []func(http.Handler) http.Handler{
				middleware.RequireAuth,
				middleware.RequireScope(middleware.ScopeWriteRepository),
			}
			if queries != nil {
				writeTerminal = append(writeTerminal, middleware.RequireRepoPermission(middleware.PermissionWrite))
			}
			writeTerminal = append(writeTerminal, gateWorkspaces, gateSandboxes)
			// Ticket 0132: open-rate limit applied at route registration time.
			// Active-connection cap is enforced inside the handler (before dialSSH).
			writeTerminal = append(
				writeTerminal,
				middleware.WorkspaceTerminalOpenRateLimitWithObserver(
					queries,
					cfg.RateLimit.TerminalOpenPerMin,
					rateLimitRejectObserver,
				),
			)
			r.With(writeTerminal...).Get("/api/repos/{owner}/{repo}/workspace/sessions/{id}/terminal", workspaceTerminalHandler.TerminalWebSocket)
			// LSP relay (#505): the same chain, open-rate limiter, and active cap
			// as the terminal; the handler checks the session kind.
			r.With(writeTerminal...).Get("/api/repos/{owner}/{repo}/workspace/sessions/{id}/lsp", workspaceTerminalHandler.LSPWebSocket)
		})
	}

	// observe-v2: api-cli
	// Consent authenticates with its single-use OAuth state and verifier-bound
	// CSRF token, independently of any existing browser session.
	r.With(middleware.InteractiveAuthRateLimit(queries)).Get("/api/auth/github/cli/consent", authHandler.GetAdminCLIConsent)
	r.With(apiCSRFMiddleware, middleware.InteractiveAuthRateLimit(queries)).Post("/api/auth/github/cli/consent", authHandler.PostAdminCLIConsent)

	// Binary wiki uploads retain the API auth/CSRF/quota gates, with their own
	// bounded body instead of the JSON group's media type and 1 MiB limit.
	if content, ok := wikiService.(routes.WikiContentService); ok {
		handler := &routes.WikiContentHandler{Service: content}
		r.Group(func(r chi.Router) {
			r.Use(middleware.JSONTimeout(apiJSONTimeout))
			r.Use(cors.Handler(apiCORS))
			r.Use(authLoader(queries, cfg.Auth))
			r.Use(apiCSRFMiddleware)
			r.Use(middleware.GlobalAPIRateLimit(queries))
			if queries != nil {
				r.Use(middleware.LoadRepoContext(queries))
			}
			gates := []func(http.Handler) http.Handler{middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteRepository), repoAPIQuota, gateWiki}
			if queries != nil {
				gates = append(gates, middleware.RequireRepoPermission(middleware.PermissionWrite))
			}
			r.With(gates...).Put("/api/repos/{owner}/{repo}/wiki/attachments/{slug}", handler.PutAttachment)
		})
	}

	r.Route("/api", func(r chi.Router) {
		r.Use(middleware.JSONTimeout(apiJSONTimeout))
		r.Use(cors.Handler(apiCORS))
		r.Use(middleware.JSONAllowContentType("application/json", routes.LFSJSONMediaType))
		r.Use(middleware.MaxBodySize(middleware.MaxRequestBodySize))
		// Global API rate limit: 5000/hr auth, 600/hr anon. AuthLoader runs first
		// so user context is available for limit selection. Search routes excluded
		// (they have their own SearchRateLimit). The worker token-exchange is
		// excluded too: it is always anonymous at this layer (the shared worker
		// bearer is not a session), so the 600/hr-capacity anon bucket (10/min
		// refill per shared CF-egress IP) would starve logins long before its own
		// SharedBearerAwareAuthRateLimit — which stays strictly 5/min for callers
		// WITHOUT the valid worker bearer, so no protection is lost by the skip.
		r.Use(lfsauth.HTTPMiddleware(lfsAuthManager))
		r.Use(authLoader(queries, cfg.Auth))
		if config.IsSingleOwner(cfg.Auth) {
			r.Use(middleware.RejectTenantProvisioning)
		}
		r.Use(apiCSRFMiddleware)
		r.Use(middleware.ExcludePaths(middleware.GlobalAPIRateLimit(queries), "/api/search/", "/api/_test/", "/api/telemetry/", "/api/auth/github/token-exchange"))
		if extras.Recommender != nil {
			r.Post("/recommend", extras.Recommender.Recommend)
			r.Post("/recommend/outcome", extras.Recommender.Outcome)
		}
		if extras.ModelStream != nil {
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser)).Post("/model/stream", extras.ModelStream.ServeHTTP)
		}

		if strings.EqualFold(os.Getenv("SMITHERS_ENABLE_E2E_TEST_ROUTES"), "true") {
			r.Get("/_test/panic", routes.MiddlewarePanic)
			r.With(middleware.JSONTimeout(25*time.Millisecond)).Get("/_test/timeout", routes.MiddlewareTimeout)
			r.With(middleware.JSONTimeout(25*time.Millisecond)).Get("/_test/timeout-ignore-context", routes.MiddlewareTimeoutIgnoreContext)
			r.Delete("/_test/search-rate-limits", routes.ResetSearchRateLimits(queries))
			r.Delete("/_test/auth-rate-limits", routes.ResetAuthRateLimits(queries))
			if notificationHandler != nil {
				if createService, ok := notificationHandler.Service.(routes.NotificationCreateService); ok {
					r.Group(func(r chi.Router) {
						r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser)).
							Post("/_test/notifications", routes.CreateTestNotification(createService))
					})
				}
			}
		}

		// Public telemetry: 10/min per IP; trusted Worker exports: separate 120/min.
		// Gated on feature_flags.client_error_reporting so operators can disable
		// ingestion entirely; the gate runs before the rate limiter so a
		// disabled flag short-circuits before any rate-limit store writes,
		// logging, or metrics.
		if telemetryHandler != nil {
			r.With(gateTelemetry, middleware.SharedBearerAwareTelemetryRateLimit(queries, cfg.Auth.WorkerExchangeToken)).Post("/telemetry/errors", telemetryHandler.PostClientError)
		}

		// Feature flags endpoint: no auth required, public.
		if featureFlagHandler != nil {
			r.Get("/feature-flags", featureFlagHandler.GetFeatureFlags)
		}

		// Wallet/key auth is an account-provisioning surface. A self-hosted
		// installation has one persisted owner and must not expose a second
		// signup path, even when a carried-over config enables key auth.
		if cfg.Auth.EnableKeyAuth && !config.IsSingleOwner(cfg.Auth) {
			r.With(middleware.AuthRateLimit(queries)).Get("/auth/key/nonce", authHandler.GetKeyAuthNonce)
			r.With(middleware.AuthRateLimit(queries)).Post("/auth/key/verify", authHandler.PostKeyAuthVerify)
			r.With(middleware.AuthRateLimit(queries)).Post("/auth/key/token", authHandler.PostKeyAuthToken)
		}
		if config.IsSingleOwner(cfg.Auth) && authHandler.LocalService != nil {
			r.With(middleware.InteractiveAuthRateLimit(queries)).Get("/auth/local/status", authHandler.GetLocalIdentityStatus)
			r.With(middleware.AuthRateLimit(queries)).Post("/auth/local/bootstrap", authHandler.PostLocalBootstrap)
			r.With(middleware.AuthRateLimit(queries)).Post("/auth/local/login", authHandler.PostLocalLogin)
			r.With(middleware.AuthRateLimit(queries)).Post("/auth/local/token", authHandler.PostLocalToken)
			r.With(middleware.AuthRateLimit(queries), middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser)).Post("/auth/local/password", authHandler.PostLocalPassword)
		}
		// Direct GitHub App OAuth (browser sign-in / connect + CLI login).
		// These interactive routes use the looser "auth_interactive" scope
		// (20/min per IP): one sign-in attempt burns two tokens (start +
		// callback), so the strict 5/min "auth" scope locked out users who
		// retried a few times within a minute.
		r.With(middleware.InteractiveAuthRateLimit(queries)).Get("/auth/github", authHandler.GetGitHubOAuthStart)
		r.With(middleware.InteractiveAuthRateLimit(queries)).Get("/auth/github/cli", authHandler.GetGitHubOAuthCLIStart)
		r.With(middleware.InteractiveAuthRateLimit(queries)).Get("/auth/github/callback", authHandler.GetGitHubOAuthCallback)
		r.With(middleware.InteractiveAuthRateLimit(queries)).Get("/auth/auth0/authorize", authHandler.GetAuth0Authorize)
		r.With(middleware.InteractiveAuthRateLimit(queries)).Get("/auth/auth0/callback", authHandler.GetAuth0Callback)
		// Worker-only GitHub-token → Plue-token exchange. Guarded by a shared
		// bearer secret (fails closed when SMITHERS_AUTH_WORKER_EXCHANGE_TOKEN
		// is unset). CSRF is not a concern: the request is anonymous (no
		// session cookie → no AuthInfo user), so the CSRF middleware exempts it.
		// Rate limit is shared-bearer-aware: requests carrying the correct
		// Worker token get a dedicated generous "auth_worker" bucket (120/min)
		// — all Worker logins funnel through a few shared CF egress IPs and
		// were starving in the anonymous 5/min "auth" bucket — while everyone
		// else stays in the strict "auth" bucket. RequireSharedBearerToken
		// after it remains the real auth gate.
		r.With(
			middleware.SharedBearerAwareAuthRateLimit(queries, cfg.Auth.WorkerExchangeToken, 120, time.Minute),
			middleware.RequireSharedBearerToken(cfg.Auth.WorkerExchangeToken),
		).Post("/auth/github/token-exchange", authHandler.PostGitHubTokenExchange)
		issueSSETicket := []func(http.Handler) http.Handler{
			middleware.RequireAuth,
			middleware.SSETicketRateLimit(queries),
		}
		if sseTicketHandler != nil {
			r.With(issueSSETicket...).Post("/auth/sse-ticket", sseTicketHandler.PostSSETicket)
			r.With(issueSSETicket...).Post("/v1/sse/ticket", sseTicketHandler.PostSSETicket)
		}
		if cfg.FeatureFlags.Integrations && linearHandler != nil {
			r.With(middleware.AuthRateLimit(queries), authLoader(queries, cfg.Auth), middleware.RequireAuth).Get("/auth/linear", linearHandler.GetLinearOAuthStart)
			r.With(middleware.AuthRateLimit(queries), authLoader(queries, cfg.Auth), middleware.RequireAuth).Get("/auth/linear/callback", linearHandler.GetLinearOAuthCallback)
		}
		if alphaAccessHandler != nil {
			r.With(middleware.AuthRateLimit(queries)).Post("/alpha/waitlist", alphaAccessHandler.PostWaitlistJoin)
		}
		r.Post("/auth/logout", authHandler.PostLogout)

		// OAuth2 provider endpoints.
		if oauth2Handler != nil {
			// Token exchange and revocation are public (client authenticates via client_id/secret).
			r.With(middleware.AuthRateLimit(queries)).Post("/oauth2/token", oauth2Handler.PostToken)
			r.With(middleware.AuthRateLimit(queries)).Post("/oauth2/revoke", oauth2Handler.PostRevoke)
			// Browser-native authorize endpoint (ticket 0106).
			//
			// Trust boundary: the endpoint is PUBLIC (no RequireAuth). A
			// mobile browser / ASWebAuthenticationSession cannot meet a
			// RequireAuth precondition on the FIRST request — it has no
			// Smithers session yet. The handler itself:
			//   1) validates client_id + redirect_uri against the
			//      registered OAuth2 client (rejecting invalid values
			//      BEFORE any redirect, per RFC 6749 §4.1.2.1),
			//   2) enforces PKCE S256 up front (RFC 7636 + RFC 8252 §6),
			//   3) enforces the state param (anti-CSRF, RFC 8252 §8.9),
			//   4) detours unauthenticated users through the upstream
			//      IdP (the GitHub App OAuth flow) to establish a session,
			//   5) enforces the closed-alpha whitelist before issuing a
			//      code, returning structured error code
			//      "access_not_granted" on denial.
			// Rate-limited via AuthRateLimit to deter authorize-endpoint
			// abuse (enumeration of client_ids, PKCE oracle attempts).
			//
			// GET renders the CSRF-bound consent page for browser sessions
			// (and issues codes directly for CSRF-immune token-auth / E2E
			// dev callers); POST is the consent decision that actually
			// mints the code for browser sessions.
			r.With(middleware.AuthRateLimit(queries)).Get("/oauth2/authorize", oauth2Handler.GetAuthorize)
			r.With(middleware.AuthRateLimit(queries)).Post("/oauth2/authorize", oauth2Handler.PostAuthorizeDecision)
		}

		r.Get("/users/{username}", userHandler.GetUserByUsername)
		r.Get("/users/{username}/activity", userHandler.GetUserActivityByUsername)
		r.Get("/users/{username}/repos", userHandler.GetUserReposByUsername)

		if billingHandler != nil {
			if extras.BillingCapabilities.Overview {
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadUser)).Get("/billing/balance", billingHandler.GetUserBalance)
			}
			if extras.BillingCapabilities.Overview {
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadUser)).Get("/billing", billingHandler.GetUserBilling)
			}
			if extras.BillingCapabilities.Plans {
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadUser)).Get("/billing/plans", billingHandler.GetUserPlans)
			}
			if extras.BillingCapabilities.Checkout {
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser)).Post("/billing/checkout", billingHandler.PostUserCheckout)
			}
			if extras.BillingCapabilities.Portal {
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser)).Post("/billing/portal", billingHandler.PostUserPortal)
			}
			if extras.BillingCapabilities.Overview {
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser)).Post("/billing/refresh", billingHandler.PostUserRefresh)
			}
			if extras.BillingCapabilities.Overview {
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadOrganization)).Get("/orgs/{org}/billing", billingHandler.GetOrgBilling)
			}
			if extras.BillingCapabilities.Checkout {
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteOrganization)).Post("/orgs/{org}/billing/checkout", billingHandler.PostOrgCheckout)
			}
			if extras.BillingCapabilities.Portal {
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteOrganization)).Post("/orgs/{org}/billing/portal", billingHandler.PostOrgPortal)
			}
			if extras.BillingCapabilities.Overview {
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteOrganization)).Post("/orgs/{org}/billing/refresh", billingHandler.PostOrgRefresh)
			}
		}

		if linearHandler != nil {
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadRepository)).Get("/linear/setup/{setupKey}", linearHandler.GetLinearOAuthSetup)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteRepository)).Post("/linear", linearHandler.ConfigureLinearIntegration)
		}

		r.Route("/integrations", func(r chi.Router) {
			r.With(middleware.RequireAuth).Get("/mcp", integrationsHandler.GetMCPIntegrations)
			r.With(middleware.RequireAuth).Get("/skills", integrationsHandler.GetSkills)
			if linearHandler != nil {
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadRepository)).Get("/linear", linearHandler.ListLinearIntegrations)
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadRepository)).Get("/linear/repositories", linearHandler.ListLinearRepositoryOptions)
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadRepository)).Get("/linear/setup/{setupKey}", linearHandler.GetLinearOAuthSetup)
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteRepository)).Post("/linear", linearHandler.ConfigureLinearIntegration)
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteRepository)).Delete("/linear/{id}", linearHandler.DeleteLinearIntegration)
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteRepository)).Post("/linear/{id}/sync", linearHandler.TriggerInitialSync)
			}
		})

		if linearHandler != nil {
			r.Route("/linear/{id}", func(r chi.Router) {
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadRepository)).Get("/ops", linearHandler.ListLinearSyncOps)
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteRepository)).Post("/ops/{opId}/retry", linearHandler.RetryLinearSyncOp)
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteRepository)).Post("/sync", linearHandler.StartLinearSyncRun)
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadRepository)).Get("/sync/{runId}", linearHandler.GetLinearSyncRun)
			})
		}

		// Dual-auth write group: accepts both token auth (Authorization: token) and session
		// auth (smithers_session cookie). The default /api CSRF middleware protects
		// session-authenticated state-changing requests. RequireAuth + RequireScope
		// enforce authentication and permission gating.
		r.Group(func(r chi.Router) {
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteRepository), userConnectedReposQuota).Post("/repo-connection", repoHandler.ConnectRepo)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteRepository)).Delete("/repo-connection", repoHandler.DisconnectRepo)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadRepository)).Get("/repo-connection", repoHandler.RepoConnectionStatus)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadRepository), middleware.LoadRepoContext(queries), middleware.RequireRepoPermission(middleware.PermissionRead)).Get("/repos/{owner}/{repo}/github-app-status", repoHandler.GitHubAppStatus)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadUser)).Get("/user", userHandler.GetAuthenticatedUser)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser)).Patch("/user", userHandler.PatchAuthenticatedUser)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadRepository)).Get("/user/workflow-runs/active-count", workflowRunCountHandler.GetActiveWorkflowRunCount)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteRepository)).Post("/user/repos", repoHandler.CreateRepo)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteOrganization)).Post("/orgs/{org}/repos", repoHandler.CreateOrgRepo)

			r.Route("/repos/{owner}/{repo}", func(r chi.Router) {
				if queries != nil {
					r.Use(middleware.LoadRepoContext(queries))
				}

				readRepo := []func(http.Handler) http.Handler{
					middleware.RequireAuth,
					middleware.RequireScope(middleware.ScopeReadRepository),
				}
				writeRepo := []func(http.Handler) http.Handler{
					middleware.RequireAuth,
					middleware.RequireScope(middleware.ScopeWriteRepository),
				}
				forkRepo := []func(http.Handler) http.Handler{
					middleware.RequireAuth,
					middleware.RequireScope(middleware.ScopeWriteRepository),
				}
				adminRepo := []func(http.Handler) http.Handler{
					middleware.RequireAuth,
					middleware.RequireScope(middleware.ScopeWriteRepository),
				}
				ownerRepo := []func(http.Handler) http.Handler{
					middleware.RequireAuth,
					middleware.RequireScope(middleware.ScopeWriteRepository),
				}
				if queries != nil {
					readRepo = append(readRepo, middleware.RequireRepoPermission(middleware.PermissionRead))
					writeRepo = append(writeRepo, middleware.RequireRepoPermission(middleware.PermissionWrite))
					forkRepo = append(forkRepo, middleware.RequireRepoPermission(middleware.PermissionRead))
					adminRepo = append(adminRepo, middleware.RequireRepoPermission(middleware.PermissionAdmin))
					ownerRepo = append(ownerRepo, middleware.RequireRepoPermission(middleware.PermissionOwner))
				}
				// A repository-bound workflow/agent token may mutate only the
				// repository it names. Fork and transfer are repo-addressed routes,
				// but their effects create or move a repository in another owner
				// namespace, so they must reject that restricted capability.
				forkRepo = append(forkRepo, middleware.RejectRepositoryRestrictedToken)
				ownerRepo = append(ownerRepo, middleware.RejectRepositoryRestrictedToken)
				readRepo = append(readRepo, repoAPIQuota)
				writeRepo = append(writeRepo, repoAPIQuota)
				forkRepo = append(forkRepo, repoAPIQuota)
				adminRepo = append(adminRepo, repoAPIQuota)
				ownerRepo = append(ownerRepo, repoAPIQuota)

				// Ticket 0154: mount repo-scoped devtools snapshot HTTP routes.
				// Keep the route tree static; the handler enforces feature-flag
				// gating (404 when disabled) via the resolved config flag, which
				// defaults to false when SMITHERS_DEVTOOLS_SNAPSHOT_ENABLED is unset.
				if queries != nil {
					devtoolsSnapshotWriteRepo := append([]func(http.Handler) http.Handler{}, writeRepo...)
					devtoolsSnapshotWriteRepo = append(
						devtoolsSnapshotWriteRepo,
						middleware.DevtoolsSnapshotPostRateLimit(queries, 0),
					)
					routes.RegisterDevtoolsSnapshotRoutes(r, queries, readRepo, devtoolsSnapshotWriteRepo, cfg.FeatureFlags.DevtoolsSnapshotEnabled)
				}

				r.With(writeRepo...).Patch("/", repoHandler.PatchRepo)
				r.With(writeRepo...).Put("/topics", repoHandler.ReplaceRepoTopics)
				r.With(adminRepo...).Delete("/", repoHandler.DeleteRepo)
				r.With(adminRepo...).Post("/archive", repoHandler.ArchiveRepo)
				r.With(adminRepo...).Post("/unarchive", repoHandler.UnarchiveRepo)
				r.With(ownerRepo...).Post("/transfer", repoHandler.TransferRepo)
				// Forking is an explicit, user-initiated action. /fork is the
				// documented spelling; /forks stays registered because existing
				// clients call it.
				r.With(forkRepo...).Post("/fork", repoHandler.ForkRepo)
				r.With(forkRepo...).Post("/forks", repoHandler.ForkRepo)

				// Repo sync routes: registered inside the repo-scoped group so
				// LoadRepoContext + RequireRepoPermission(write) gate access to the
				// specific {owner}/{repo}. (Previously these were registered outside
				// this group, allowing any authenticated user with write scope to
				// trigger a sync of ANY repo — an IDOR.)
				r.With(writeRepo...).Post("/sync", repoHandler.SyncRepo)
				r.With(writeRepo...).Post("/mirror-sync", mirrorSyncHandler.MirrorSync)
				r.With(readRepo...).Get("/mirror-sync/{run_id}", mirrorSyncHandler.GetMirrorSyncRun)
				r.With(writeRepo...).Post("/github/reconcile", mirrorSyncHandler.ReconcileGitHub)
				r.With(writeRepo...).Post("/github/mirror/refs/{ref}/retry", mirrorSyncHandler.RetryMirrorRef)
				if mirrorSyncHandler != nil && mirrorSyncHandler.MainPull != nil {
					r.With(writeRepo...).Post("/github/main-pull", mirrorSyncHandler.MainPull.RequestMainPull)
					r.With(readRepo...).Get("/github/main-pull", mirrorSyncHandler.MainPull.GetMainPull)
				}
				// The mythical stack: its snapshot, and the admin's bootstrap
				// request. The event stream is mounted outside the JSON timeout.
				if extras.Mythical != nil {
					r.With(readRepo...).Get("/mythical", extras.Mythical.GetStack)
					r.With(adminRepo...).Post("/mythical/bootstrap", extras.Mythical.Bootstrap)
					r.With(writeRepo...).Post("/mythical/backfill", extras.Mythical.Backfill)
					r.With(adminRepo...).Put("/mythical/config", extras.Mythical.Config)
					r.With(writeRepo...).Post("/mythical/items/{id}/retry", extras.Mythical.Retry)
					r.With(writeRepo...).Put("/mythical/lanes", extras.Mythical.Lanes)
					r.With(writeRepo...).Post("/mythical/wiki", extras.Mythical.Wiki)
				}

				// A user's own pushed refs (smithers repo push).
				if extras.UserRefs != nil {
					r.With(writeRepo...).Get("/user-refs", extras.UserRefs.List)
					r.With(writeRepo...).Post("/user-refs/renew", extras.UserRefs.Renew)
				}

				// Required checks trust a commit status. The platform's own CI
				// records its statuses on the server; a run credential cannot
				// report one, or an agent could pass its own required checks.
				r.With(append(append([]func(http.Handler) http.Handler{}, writeRepo...), middleware.RefuseRunCredentials)...).Post("/statuses/{sha}", commitStatusHandler.CreateCommitStatus)

				// jj VCS write routes: bookmarks and generated change artifacts.
				r.With(writeRepo...).Post("/bookmarks", jjVCSHandler.CreateBookmark)
				r.With(writeRepo...).Delete("/bookmarks/{name}", jjVCSHandler.DeleteBookmark)
				r.With(writeRepo...).Post("/changes/{change_id}/revert", jjVCSHandler.RevertChange)
				r.With(writeRepo...).Post("/changes/{change_id}/split", jjVCSHandler.SplitChange)
				r.With(writeRepo...).Put("/changes/{change_id}/walkthrough", jjVCSHandler.PutChangeWalkthrough)
				if stackHandler != nil {
					r.With(append(writeRepo, repoStackQuota)...).Post("/stacks/active", stackHandler.UpsertActiveStack)
					r.With(writeRepo...).Delete("/stacks/active", stackHandler.DeleteActiveStack)
				}
				if gitHubProxyHandler != nil {
					r.With(writeRepo...).Post("/github-proxy", gitHubProxyHandler.PostRepoGitHubProxy)
				}

				r.With(append(writeRepo, repoStackQuota)...).Post("/landings", landingHandler.CreateLandingRequest)
				r.With(append(writeRepo, repoStackQuota)...).Put("/landings/requests/{request_uuid}", landingHandler.PutLandingRequest)
				r.With(writeRepo...).Post("/landings/append/prepare", landingHandler.PrepareLandingAppend)
				r.With(writeRepo...).Patch("/landings/{number}", landingHandler.PatchLandingRequest)
				r.With(writeRepo...).Put("/landings/{number}/land", landingHandler.LandLandingRequest)
				r.With(writeRepo...).Put("/landings/{number}/land/append", landingHandler.AppendLandingRequest)
				r.With(writeRepo...).Put("/landings/{number}/github/pull", landingHandler.OpenLandingGitHubPull)
				r.With(writeRepo...).Post("/landings/{number}/auto-land", landingHandler.SetLandingRequestAutoLand)
				r.With(writeRepo...).Delete("/landings/{number}/auto-land", landingHandler.ClearLandingRequestAutoLand)
				r.With(writeRepo...).Post("/landings/{number}/review-requests", landingHandler.RequestLandingReview)
				r.With(writeRepo...).Delete("/landings/{number}/review-requests/{id}", landingHandler.DeleteLandingReviewRequest)
				r.With(writeRepo...).Post("/landings/{number}/reviews", landingHandler.PostLandingReview)
				r.With(writeRepo...).Patch("/landings/{number}/reviews/{review_id}", landingHandler.DismissLandingReview)
				r.With(writeRepo...).Post("/landings/{number}/comments", landingHandler.PostLandingComment)
				r.With(writeRepo...).Post("/landings/{number}/threads/{id}/done", landingHandler.MarkLandingThreadDone)
				r.With(writeRepo...).Post("/landings/{number}/threads/{id}/ack", landingHandler.AckLandingThread)
				r.With(writeRepo...).Post("/landings/{number}/threads/{id}/reopen", landingHandler.ReopenLandingThread)

				// Ticket 12: Issue routes — gated by feature_flags.issues.
				r.With(append(writeRepo, gateIssues)...).Post("/issues", issueHandler.CreateIssue)
				r.With(append(writeRepo, gateIssues)...).Put("/issues/{number}/comments/{comment}/reactions", issueHandler.IssueReaction)
				r.With(append(readRepo, gateIssues)...).Get("/issues/{number}/comments/{comment}/reactions", issueHandler.IssueReaction)
				r.With(append(writeRepo, gateIssues)...).Put("/issues/{number}/sync", issueHandler.IssueSync)
				r.With(append(readRepo, gateIssues)...).Get("/issues/{number}/sync", issueHandler.IssueSync)
				r.With(append(writeRepo, gateIssues)...).Put("/issues/sync/channels", issueHandler.IssueSyncChannel)
				r.With(append(readRepo, gateIssues)...).Get("/issues/sync/channels", issueHandler.IssueSyncChannels)
				r.With(append(writeRepo, gateIssues)...).Post("/issues/sync/events", issueHandler.IssueSyncEvent)
				r.With(append(writeRepo, gateIssues)...).Get("/issues/sync/deliveries", issueHandler.IssueSyncDeliveries)
				r.With(append(writeRepo, gateIssues)...).Post("/issues/sync/deliveries/{id}", issueHandler.IssueSyncReceipt)
				r.With(append(writeRepo, gateIssues)...).Put("/issues/sync/deliveries/{id}", issueHandler.IssueSyncReceipt)

				r.With(append(writeRepo, gateIssues)...).Patch("/issues/{number}", issueHandler.PatchIssue)
				r.With(append(writeRepo, gateIssues)...).Post("/issues/{number}/linear-link", issueHandler.PostLinearIssueLink)
				r.With(append(writeRepo, gateIssues)...).Delete("/issues/{number}/linear-link", issueHandler.DeleteLinearIssueLink)
				r.With(append(writeRepo, gateIssues)...).Post("/issues/{number}/comments", issueHandler.PostIssueComment)
				r.With(append(writeRepo, gateIssues)...).Patch("/issues/comments/{id}", issueHandler.PatchIssueComment)
				r.With(append(writeRepo, gateIssues)...).Delete("/issues/comments/{id}", issueHandler.DeleteIssueComment)

				// Ticket 12: Wiki routes — gated by feature_flags.wiki.
				if wikiService != nil {
					r.With(append(writeRepo, gateWiki)...).Post("/wiki", routes.CreateWikiPage(wikiService))
					if collaborative, ok := wikiService.(routes.WikiCollaborationService); ok {
						handler := &routes.WikiCollaborationHandler{Service: collaborative}
						r.With(append(readRepo, gateWiki)...).Get("/wiki/{slug}/document", handler.Document)
						r.With(append(readRepo, gateWiki)...).Get("/wiki/{slug}/updates", handler.Updates)
						r.With(append(writeRepo, gateWiki)...).Post("/wiki/{slug}/updates", handler.Apply)
					}
					r.With(append(writeRepo, gateWiki)...).Patch("/wiki/{slug}", routes.UpdateWikiPage(wikiService))
					r.With(append(writeRepo, gateWiki)...).Delete("/wiki/{slug}", routes.DeleteWikiPage(wikiService))
				}

				// Ticket 12: Label routes — gated by feature_flags.labels.
				// /issues/{number}/labels intentionally takes the labels gate
				// (not the issues gate) so labels can be disabled
				// independently of issues.
				r.With(append(writeRepo, gateLabels)...).Post("/labels", labelHandler.PostRepoLabel)
				r.With(append(writeRepo, gateLabels)...).Patch("/labels/{id}", labelHandler.PatchRepoLabel)
				r.With(append(writeRepo, gateLabels)...).Delete("/labels/{id}", labelHandler.DeleteRepoLabel)
				r.With(append(writeRepo, gateLabels)...).Post("/issues/{number}/labels", labelHandler.PostIssueLabels)
				r.With(append(writeRepo, gateLabels)...).Delete("/issues/{number}/labels/{name}", labelHandler.DeleteIssueLabel)

				if lfsHandler != nil {
					// LFS batch handles both upload and download. LFSService.Batch
					// enforces repository write access for operation:"upload" and read
					// access for "download" itself; LFSHandler enforces write scope for
					// token-authenticated upload requests after decoding the operation.
					// /objects/batch is the canonical Git LFS Batch API path. Keep
					// /batch as a compatibility alias for existing direct API users.
					// Batch itself selects read vs write authorization from the
					// operation. Keeping it out of readRepo permits anonymous downloads
					// from public repositories while the service still rejects private
					// reads and enforces write access for uploads.
					r.With(readRepo...).Post("/lfs/batch", lfsHandler.PostBatch)
					r.With(writeRepo...).Post("/lfs/confirm", lfsHandler.PostConfirm)
					r.With(writeRepo...).Delete("/lfs/objects/{oid}", lfsHandler.DeleteObject)
				}

				// Deploy keys: per-repository SSH deploy keys.
				r.With(readRepo...).Get("/keys", deployKeyHandler.ListDeployKeys)
				r.With(adminRepo...).Post("/keys", deployKeyHandler.CreateDeployKey)
				r.With(adminRepo...).Delete("/keys/{id}", deployKeyHandler.DeleteDeployKey)

				// Ticket 12: per-repo webhook management — gated by feature_flags.webhooks_user.
				if webhookHandler != nil {
					r.With(append(adminRepo, gateWebhooksUser)...).Get("/hooks", webhookHandler.ListWebhooks)
					r.With(append(adminRepo, gateWebhooksUser)...).Post("/hooks", webhookHandler.CreateWebhook)
					r.With(append(adminRepo, gateWebhooksUser)...).Get("/hooks/{id}", webhookHandler.GetWebhook)
					r.With(append(adminRepo, gateWebhooksUser)...).Patch("/hooks/{id}", webhookHandler.UpdateWebhook)
					r.With(append(adminRepo, gateWebhooksUser)...).Delete("/hooks/{id}", webhookHandler.DeleteWebhook)
					r.With(append(adminRepo, gateWebhooksUser)...).Post("/hooks/{id}/tests", webhookHandler.TestWebhook)
					r.With(append(adminRepo, gateWebhooksUser)...).Get("/hooks/{id}/deliveries", webhookHandler.ListWebhookDeliveries)
					r.With(append(adminRepo, gateWebhooksUser)...).Post("/hooks/{id}/deliveries/{delivery_id}/redeliver", webhookHandler.RedeliverWebhookDelivery)
				}

				// Ticket 12: per-repo secrets — gated by feature_flags.secrets.
				if secretHandler != nil {
					r.With(append(writeRepo, gateSecrets)...).Get("/secrets", secretHandler.ListSecrets)
					r.With(append(adminRepo, gateSecrets)...).Post("/secrets", secretHandler.SetSecret)
					r.With(append(adminRepo, gateSecrets)...).Delete("/secrets/{name}", secretHandler.DeleteSecret)
					// Agent workspace environment secrets are a distinct setup-only
					// resource and never enter the long-lived agent environment.
					r.With(writeRepo...).Get("/agent-environment", secretHandler.GetAgentEnvironment)
					r.With(adminRepo...).Put("/agent-environment", secretHandler.PutAgentEnvironment)
					r.With(adminRepo...).Put("/agent-environment/secrets/{name}", secretHandler.PutAgentEnvironmentSecret)
					r.With(adminRepo...).Delete("/agent-environment/secrets/{name}", secretHandler.DeleteAgentEnvironmentSecret)
				}

				if variableHandler != nil {
					r.With(writeRepo...).Get("/variables", variableHandler.ListVariables)
					r.With(writeRepo...).Get("/variables/{name}", variableHandler.GetVariable)
					r.With(writeRepo...).Post("/variables", variableHandler.SetVariable)
					r.With(writeRepo...).Delete("/variables/{name}", variableHandler.DeleteVariable)
				}

				if protectedBookmarkHandler != nil {
					r.With(append(adminRepo, gateProtectedBookmarks)...).Get("/protected-bookmarks", protectedBookmarkHandler.ListProtectedBookmarks)
					r.With(append(adminRepo, gateProtectedBookmarks)...).Post("/protected-bookmarks", protectedBookmarkHandler.UpsertProtectedBookmark)
					r.With(append(adminRepo, gateProtectedBookmarks)...).Delete("/protected-bookmarks/{pattern:.*}", protectedBookmarkHandler.DeleteProtectedBookmark)
				}

				// Workflow dispatch (manual trigger) — requires write access.
				if repositoryJobHandler != nil {
					r.With(append(append([]func(http.Handler) http.Handler{}, readRepo...), gateWorkflows)...).Get("/repository-jobs", repositoryJobHandler.GetRepositoryJobs)
					r.With(append(append([]func(http.Handler) http.Handler{}, readRepo...), gateWorkflows)...).Get("/repository-source", repositoryJobHandler.GetRepositorySource)
					r.With(append(append([]func(http.Handler) http.Handler{}, writeRepo...), gateWorkflows)...).Post("/repository-source/retain", repositoryJobHandler.RetainRepositorySource)
					r.With(append(append([]func(http.Handler) http.Handler{}, readRepo...), gateWorkflows)...).Get("/repository-jobs/{job}/dispatches", repositoryJobHandler.GetRepositoryJobDispatches)
					r.With(append(append([]func(http.Handler) http.Handler{}, writeRepo...), gateWorkflows)...).Post("/repository-jobs/{job}/pause", repositoryJobHandler.PauseRepositoryJob)
					r.With(append(append([]func(http.Handler) http.Handler{}, readRepo...), middleware.RequireMatchingRepositoryRestriction, gateWorkflows)...).Get("/repository-jobs/{job}/approvals", repositoryJobHandler.GetRepositoryJobApprovals)
					// No workspace, agent or other system-issued credential may
					// stamp the human approval whose authority it later consumes.
					r.With(append(append([]func(http.Handler) http.Handler{}, writeRepo...), middleware.RejectRepositoryRestrictedToken, middleware.RefuseRunCredentials, gateWorkflows)...).Post("/repository-jobs/{job}/approvals", repositoryJobHandler.PostRepositoryJobApproval)
				}
				workflowWriteRepo := append([]func(http.Handler) http.Handler{}, writeRepo...)
				workflowWriteRepo = append(workflowWriteRepo, gateWorkflows)
				if workflowHandler != nil {
					// Ticket 0153: dedicated per-user limiter on manual dispatch
					// endpoints (both canonical ID and legacy name routes).
					// A run credential starts, reruns or resumes no workflow run:
					// its run's agent would otherwise run the default bookmark's
					// workflows with inputs it chooses, as a person's request.
					workflowStartRepo := append(append([]func(http.Handler) http.Handler{}, workflowWriteRepo...), middleware.RefuseRunCredentials)
					workflowDispatchWriteRepo := append([]func(http.Handler) http.Handler{}, workflowStartRepo...)
					workflowDispatchWriteRepo = append(
						workflowDispatchWriteRepo,
						repoWorkflowQuota,
						userWorkflowRunsQuota,
						middleware.WorkflowDispatchRateLimit(queries, 0),
					)
					r.With(workflowDispatchWriteRepo...).Post("/workflows/{name}/dispatch", workflowHandler.DispatchWorkflowByIdentifier)
					r.With(workflowDispatchWriteRepo...).Post("/workflows/{id}/dispatches", workflowHandler.DispatchWorkflow)
					// Durable repo-file flow invocation (smithersai/ui#7): one
					// sandbox-plane run per call, started by a person's
					// write-scoped session or token.
					r.With(workflowDispatchWriteRepo...).Post("/invoke", workflowHandler.InvokeWorkflow)
					r.With(workflowWriteRepo...).Post("/workflows/runs/{id}/cancel", workflowHandler.CancelWorkflowRun)
					r.With(workflowStartRepo...).Post("/workflows/runs/{id}/rerun", workflowHandler.RerunWorkflowRun)
					r.With(workflowStartRepo...).Post("/workflows/runs/{id}/resume", workflowHandler.ResumeWorkflowRun)
					r.With(workflowWriteRepo...).Post("/actions/runs/{id}/cancel", workflowHandler.CancelWorkflowRun)
					r.With(workflowStartRepo...).Post("/actions/runs/{id}/rerun", workflowHandler.RerunWorkflowRun)
					// Ticket 0111: canonical `/runs/{id}/...` client surface.
					// Aliases the existing `/workflows/runs/...` and
					// `/actions/runs/...` paths at the same handlers — no new
					// semantics; just one naming clients can standardize on.
					r.With(workflowWriteRepo...).Post("/runs/{id}/cancel", workflowHandler.CancelWorkflowRun)
					r.With(workflowStartRepo...).Post("/runs/{id}/rerun", workflowHandler.RerunWorkflowRun)
					r.With(workflowStartRepo...).Post("/runs/{id}/resume", workflowHandler.ResumeWorkflowRun)
				}
				if workflowCacheHandler != nil {
					// Clearing every cache belongs to a person, not a run.
					r.With(append(append([]func(http.Handler) http.Handler{}, workflowWriteRepo...), middleware.RefuseRunCredentials)...).Delete("/caches", workflowCacheHandler.ClearCaches)
				}

				// Workflow artifact routes.
				if workflowArtifactHandler != nil {
					workflowReadRepo := append([]func(http.Handler) http.Handler{}, readRepo...)
					workflowReadRepo = append(workflowReadRepo, gateWorkflows)
					r.With(workflowWriteRepo...).Delete("/actions/runs/{id}/artifacts/{name}", workflowArtifactHandler.DeleteArtifact)
					r.With(workflowWriteRepo...).Delete("/workflow/runs/{id}/artifacts/{name}", workflowArtifactHandler.DeleteArtifact)
					r.With(workflowReadRepo...).Get("/actions/runs/{id}/artifacts", workflowArtifactHandler.ListArtifacts)
					r.With(workflowReadRepo...).Get("/actions/runs/{id}/artifacts/{name}/download", workflowArtifactHandler.GetDownloadURL)
					r.With(workflowReadRepo...).Get("/workflow/runs/{id}/artifacts", workflowArtifactHandler.ListArtifacts)
					r.With(workflowReadRepo...).Get("/workflow/runs/{id}/artifacts/{name}", workflowArtifactHandler.GetDownloadURL)
					// Canonical `/runs/{id}/...` aliases (ticket 0111).
					r.With(workflowReadRepo...).Get("/runs/{id}/artifacts", workflowArtifactHandler.ListArtifacts)
					r.With(workflowReadRepo...).Get("/runs/{id}/artifacts/{name}/download", workflowArtifactHandler.GetDownloadURL)
				}

				// Ticket 12: agent sessions / messages — gated by feature_flags.agents.
				if agentSessionHandler != nil {
					// Ticket 0153: dedicated per-user limiter on agent message
					// append route.
					agentMessageWriteRepo := append([]func(http.Handler) http.Handler{}, writeRepo...)
					agentMessageWriteRepo = append(
						agentMessageWriteRepo,
						middleware.AgentMessagePostRateLimit(queries, 0),
					)
					r.With(append(agentMessageWriteRepo, gateAgents)...).Post("/changes/{change_id}/conflicts/resolve", jjVCSHandler.ResolveChangeConflict)
					r.With(append(agentMessageWriteRepo, gateAgents)...).Post("/changes/{change_id}/findings/{finding_id}/dispatch", jjVCSHandler.DispatchFinding)
					r.With(append(writeRepo, gateAgents)...).Post("/agent/sessions", agentSessionHandler.CreateSession)
					r.With(append(readRepo, gateAgents)...).Get("/agent/sessions", agentSessionHandler.ListSessions)
					r.With(append(readRepo, gateAgents)...).Get("/agent/sessions/{id}", agentSessionHandler.GetSession)
					r.With(append(readRepo, gateAgents)...).Get("/agent-sessions/{id}/egress", agentSessionHandler.ListEgressAudit)
					r.With(append(writeRepo, gateAgents)...).Delete("/agent/sessions/{id}", agentSessionHandler.DeleteSession)
					r.With(append(readRepo, gateAgents)...).Get("/agent/sessions/{id}/messages", agentSessionHandler.ListMessages)
					r.With(append(agentMessageWriteRepo, gateAgents)...).Post("/agent/sessions/{id}/messages", agentSessionHandler.PostMessage)
				}
				r.With(writeRepo...).Post("/changes/{change_id}/findings/{finding_id}/feedback", jjVCSHandler.SubmitFindingFeedback)

				// Ticket 0110: approvals decide endpoint. The handler itself
				// enforces the feature flag (returns 404 when disabled), so
				// the route is always registered; this keeps the wiring
				// static and avoids route-tree drift between flag states.
				if approvalsHandler != nil {
					r.With(readRepo...).
						Get("/approvals", approvalsHandler.ListApprovals)
					r.With(readRepo...).
						Get("/approvals/{id}", approvalsHandler.GetApproval)

					// Ticket 0132: dedicated per-user rate limit on
					// decide. Idempotency already exists in the service
					// layer, but the limiter protects audit logs and
					// downstream notifications from a buggy client.
					// A decision is a person's: a run credential acts
					// as its user but is held by an agent.
					r.With(append(
						append([]func(http.Handler) http.Handler{}, writeRepo...),
						middleware.RefuseRunCredentials,
						middleware.ApprovalDecideRateLimitWithObserver(
							queries,
							cfg.RateLimit.ApprovalDecidePerMin,
							rateLimitRejectObserver,
						),
					)...).
						Post("/approvals/{id}/decide", approvalsHandler.Decide)
				}

				// Branch locks: one person checks out a branch at a time.
				// Acquire/heartbeat/release drive the client's open flow;
				// join requests + decide are the holder's multiplayer inbox.
				if branchLockHandler != nil {
					r.With(writeRepo...).
						Post("/branch-locks/acquire", branchLockHandler.AcquireBranchLock)
					r.With(writeRepo...).
						Post("/branch-locks/heartbeat", branchLockHandler.HeartbeatBranchLock)
					r.With(writeRepo...).
						Post("/branch-locks/release", branchLockHandler.ReleaseBranchLock)
					r.With(writeRepo...).
						Post("/branch-locks/join-requests", branchLockHandler.RequestBranchLockJoin)
					r.With(readRepo...).
						Get("/branch-locks/join-requests", branchLockHandler.ListBranchLockJoinRequests)
					r.With(writeRepo...).
						Post("/branch-locks/join-requests/{id}/decide", branchLockHandler.DecideBranchLockJoin)
				}

				// Workspace routes: scoped to the repository.
				// VM lifecycle routes (create, resume, fork, suspend, delete, snapshot,
				// session create/destroy, snapshot template)
				// are registered at the top-level router with a 10-minute timeout to avoid
				// the 30s JSONTimeout that applies to /api routes.
				if workspaceHandler != nil {
					readWorkspace := []func(http.Handler) http.Handler{
						middleware.RequireAuth,
						middleware.RequireScope(middleware.ScopeReadRepository),
					}
					writeWorkspace := []func(http.Handler) http.Handler{
						middleware.RequireAuth,
						middleware.RequireScope(middleware.ScopeWriteRepository),
					}
					if queries != nil {
						readWorkspace = append(readWorkspace, middleware.RequireRepoPermission(middleware.PermissionRead))
						writeWorkspace = append(writeWorkspace, middleware.RequireRepoPermission(middleware.PermissionWrite))
					}
					readWorkspace = append(readWorkspace, repoAPIQuota)
					writeWorkspace = append(writeWorkspace, repoAPIQuota)
					readWorkspace = append(readWorkspace, gateWorkspaces)
					writeWorkspace = append(writeWorkspace, gateWorkspaces)
					r.With(readWorkspace...).Get("/workspaces", workspaceHandler.ListWorkspaces)
					r.With(readWorkspace...).Get("/workspaces/{id}", workspaceHandler.GetWorkspace)
					r.With(readWorkspace...).Get("/workspaces/{id}/egress", workspaceHandler.ListEgressAudit)
					r.With(readWorkspace...).Get("/workspaces/{id}/files", workspaceHandler.ListWorkspaceFiles)
					r.With(readWorkspace...).Get("/workspaces/{id}/coding/revisions", workspaceHandler.ReadCodingRevisions)
					r.With(readWorkspace...).Get("/workspaces/{id}/files/content", workspaceHandler.ReadWorkspaceFile)
					r.With(writeWorkspace...).Put("/workspaces/{id}/files/content", workspaceHandler.WriteWorkspaceFile)
					r.With(readWorkspace...).Get("/workspaces/{id}/services", workspaceHandler.ListWorkspaceServices)
					r.With(writeWorkspace...).Post("/workspaces/{id}/services/{name}/{action}", workspaceHandler.ManageWorkspaceService)
					r.With(writeWorkspace...).Delete("/workspaces/{id}", workspaceHandler.DeleteWorkspace)
					r.With(writeWorkspace...).Post("/workspaces/{id}/suspend", workspaceHandler.SuspendWorkspace)
					if extras.UserRefs != nil {
						r.With(writeWorkspace...).Post("/workspaces/{id}/user-source", extras.UserRefs.StartFrom)
					}
					r.With(writeWorkspace...).Get("/workspaces/{id}/ssh", workspaceHandler.GetWorkspaceSSHConnectionInfo)
					routes.RegisterWorkspaceRuntimeRoutes(r, workspaceHandler, readWorkspace, writeWorkspace)
					if workspaceHandler.Desktop != nil {
						// kind=desktop stream session mint: rotates the VNC password in
						// the guest and returns the credentialed viewer URL once.
						r.With(writeWorkspace...).Post("/workspaces/{id}/desktop/session", workspaceHandler.Desktop.PostDesktopSession)
						// Desktop observe/input: the same write scope and repo
						// permission as the mint (and as SSH), but the per-repo
						// 1000/hr API bucket is REPLACED by a per-workspace
						// 1800/hr one. An agent driving a box spends a request
						// every couple of seconds; charging that to the repo's
						// generic budget would starve every other API call the
						// same user makes.
						desktopControl := []func(http.Handler) http.Handler{
							middleware.RequireAuth,
							middleware.RequireScope(middleware.ScopeWriteRepository),
						}
						if queries != nil {
							desktopControl = append(desktopControl, middleware.RequireRepoPermission(middleware.PermissionWrite))
						}
						desktopControl = append(desktopControl, middleware.PerWorkspaceDesktopControl(quotaStore), gateWorkspaces)
						r.With(desktopControl...).Post("/workspaces/{id}/desktop/observe", workspaceHandler.Desktop.PostDesktopObserve)
						r.With(desktopControl...).Post("/workspaces/{id}/desktop/input", workspaceHandler.Desktop.PostDesktopInput)
					}
					if workspaceHandler.EnvironmentImages != nil {
						// NixOS environment image registry (kind=vm/desktop images built
						// from .smithers/environment.nix by scripts/build-nix-environment.ts).
						r.With(readWorkspace...).Get("/environment-images", workspaceHandler.EnvironmentImages.ListRepoImages)
						adminWorkspaceImages := []func(http.Handler) http.Handler{
							middleware.RequireAuth,
							middleware.RequireScope(middleware.ScopeWriteRepository),
						}
						if queries != nil {
							adminWorkspaceImages = append(adminWorkspaceImages, middleware.RequireRepoPermission(middleware.PermissionAdmin))
						}
						adminWorkspaceImages = append(adminWorkspaceImages, repoAPIQuota, gateWorkspaces)
						r.With(adminWorkspaceImages...).Post("/environment-images", workspaceHandler.EnvironmentImages.RegisterRepoImage)
						r.With(adminWorkspaceImages...).Delete("/environment-images/{id}", workspaceHandler.EnvironmentImages.RetireRepoImage)
					}
					r.With(readWorkspace...).Get("/workspace-snapshots", workspaceHandler.ListWorkspaceSnapshots)
					r.With(readWorkspace...).Get("/workspace-snapshots/{id}", workspaceHandler.GetWorkspaceSnapshot)
					r.With(writeWorkspace...).Delete("/workspace-snapshots/{id}", workspaceHandler.DeleteWorkspaceSnapshot)
					r.With(readWorkspace...).Get("/workspace/sessions", workspaceHandler.ListSessions)
					r.With(readWorkspace...).Get("/workspace/sessions/{id}", workspaceHandler.GetSession)
					r.With(writeWorkspace...).Get("/workspace/sessions/{id}/ssh", workspaceHandler.GetSSHConnectionInfo)
				}

			})

			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadRepository)).Get("/user/repos", userHandler.GetAuthenticatedUserRepos)
			if gitHubRepoListHandler != nil {
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadRepository)).Get("/user/github/repos", gitHubRepoListHandler.ListGitHubRepos)
			}
			if gitHubUserReposHandler != nil {
				// Lists private repos via the full-repo OAuth token, so it must require
				// read:repository (matching /user/github/repos) — read:user must NOT reach
				// private-repo enumeration (final-pass security finding). A repo-bound
				// PAT cannot safely call these user-global routes: no Plue repository
				// context exists here against which to enforce its repo:<id> binding.
				githubUserRepoRead := []func(http.Handler) http.Handler{
					middleware.PrivateNoStore,
					middleware.RequireAuth,
					middleware.RejectRepositoryRestrictedToken,
					middleware.RequireScope(middleware.ScopeReadRepository),
				}
				r.With(githubUserRepoRead...).Get("/user/github-repos", gitHubUserReposHandler.ListGitHubUserRepos)
				r.With(githubUserRepoRead...).Get("/user/github-repos/{owner}/{repo}", gitHubUserReposHandler.GetGitHubRepo)
				r.With(githubUserRepoRead...).Get("/user/github-repos/{owner}/{repo}/issues", gitHubUserReposHandler.ListGitHubRepoIssues)
				r.With(githubUserRepoRead...).Get("/user/github-repos/{owner}/{repo}/pulls", gitHubUserReposHandler.ListGitHubRepoPulls)
				// Authenticated issue/PR comments (synced store + live fallback)
				// and the raw PR diff — same token resolution and cache policy
				// as the metadata surfaces above.
				r.With(githubUserRepoRead...).Get("/user/github-repos/{owner}/{repo}/issues/{number}/comments", gitHubUserReposHandler.ListGitHubRepoIssueComments)
				r.With(githubUserRepoRead...).Get("/user/github-repos/{owner}/{repo}/pulls/{number}/diff", gitHubUserReposHandler.GetGitHubPullDiff)
				// Typed access diagnosis for the surfaces above: WHY a read fails
				// (app-not-installed / permission-missing / no-org-grant / token-broken
				// / ok), from the App's own installation lookup.
				r.With(githubUserRepoRead...).Get("/user/github-access/{owner}/{repo}", gitHubUserReposHandler.GetGitHubAccessDiagnosis)
			}
			if gitHubSyncedReposHandler != nil {
				// Service-to-service feed: github-sync reads the sync registry here
				// instead of carrying a static repo mapping. It names private repos
				// across every installation, so it is admin-only — never a
				// user-facing listing.
				r.With(
					middleware.RequireAuth,
					middleware.RejectRepositoryRestrictedToken,
					middleware.RequireScope(middleware.ScopeReadRepository),
					middleware.RequireAdmin,
				).Get("/github/synced-repos", gitHubSyncedReposHandler.ListSyncedRepos)
				r.With(
					middleware.RequireAuth,
					middleware.RejectRepositoryRestrictedToken,
					middleware.RequireScope(middleware.ScopeWriteRepository),
					middleware.RequireAdmin,
				).Post("/github/synced-repos/{owner}/{repo}/mirror-status", gitHubSyncedReposHandler.RecordMirrorStatus)
			}
			if gitHubImportHandler != nil {
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteRepository)).Post("/github/import", gitHubImportHandler.StartImport)
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteRepository)).Post("/github/import/{id}/retry", gitHubImportHandler.RetryImportJob)
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteRepository)).Post("/repos/from-template", gitHubImportHandler.StartTemplateImport)
			}
			// Ticket 0135: cross-repo workspace listing + readable-repos discovery
			// for the recent-first switcher. Both behind ScopeReadRepository so
			// the same token that drives repo-scoped reads populates the switcher.
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadRepository), gateWorkspaces).Get("/user/workspaces", workspaceHandler.GetUserWorkspaces)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadRepository), gateWorkspaces).Get("/user/readable-repos", userHandler.GetAuthenticatedUserReadableRepos)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadUser)).Get("/user/orgs", userHandler.GetAuthenticatedUserOrgs)

			// Bring-your-own subscriptions (RFD-003), self-host only behind
			// feature_flags.subscription_connections. Token auth is allowed so
			// the CLI can connect with a PAT; connecting needs write:user.
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadUser), gateSubscriptionConnections).Get("/user/provider-connections", providerConnectionHandler.ListUserConnections)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser), gateSubscriptionConnections).Post("/user/provider-connections", providerConnectionHandler.ConnectUser)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser), gateSubscriptionConnections).Put("/user/provider-connections/order", providerConnectionHandler.ReorderConnections)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser), gateSubscriptionConnections).Post("/user/provider-connections/codex/device", providerConnectionHandler.StartCodexDeviceLogin)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser), gateSubscriptionConnections).Post("/user/provider-connections/codex/device/{id}", providerConnectionHandler.PollCodexDeviceLogin)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadUser), gateSubscriptionConnections).Get("/user/provider-connections/{id}", providerConnectionHandler.GetConnection)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser), gateSubscriptionConnections).Delete("/user/provider-connections/{id}", providerConnectionHandler.RevokeConnection)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser), gateSubscriptionConnections).Post("/user/provider-connections/{id}/refresh", providerConnectionHandler.RefreshConnection)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser), gateSubscriptionConnections).Post("/user/provider-connections/{id}/grants", providerConnectionHandler.AddGrant)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser), gateSubscriptionConnections).Delete("/user/provider-connections/{id}/grants/{grantID}", providerConnectionHandler.DeleteGrant)
			r.With(middleware.SearchRateLimit(queries), middleware.RequireAuth, middleware.RequireFirstPartyAuth, middleware.RequireScope(middleware.ScopeReadUser)).Get("/user/tokens", userHandler.GetUserTokens)
			r.With(middleware.SearchRateLimit(queries), middleware.RequireAuth, middleware.RequireFirstPartyAuth, middleware.RequireScope(middleware.ScopeWriteUser)).Post("/user/tokens", userHandler.PostUserToken)
			r.With(middleware.SearchRateLimit(queries), middleware.RequireAuth, middleware.RequireFirstPartyAuth, middleware.RequireScope(middleware.ScopeWriteUser)).Delete("/user/tokens/{id}", userHandler.DeleteUserToken)
			r.With(middleware.RequireAuth, middleware.RequireFirstPartyAuth, middleware.RequireScope(middleware.ScopeReadUser)).Get("/user/sessions", userHandler.GetUserSessions)
			r.With(middleware.RequireAuth, middleware.RequireFirstPartyAuth, middleware.RequireScope(middleware.ScopeWriteUser)).Delete("/user/sessions/{id}", userHandler.DeleteUserSession)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadUser)).Get("/user/emails", userHandler.GetUserEmails)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser)).Post("/user/emails", userHandler.PostUserEmail)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser)).Delete("/user/emails/{id}", userHandler.DeleteUserEmail)
			r.With(middleware.EmailVerificationRateLimit(queries), middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser)).Post("/user/emails/{id}/verify", userHandler.PostUserEmailVerify)
			r.Get("/user/emails/verify-token", userHandler.GetUserEmailVerifyToken)
			r.Post("/user/emails/verify-token", userHandler.PostUserEmailVerifyToken)

			// Avatar upload

			// Notification preferences
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadUser)).Get("/user/settings/notifications", userHandler.GetNotificationPreferences)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser)).Put("/user/settings/notifications", userHandler.PutNotificationPreferences)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser)).Post("/user/devices", userHandler.PostUserDevice)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser)).Delete("/user/devices", userHandler.DeleteUserDevice)

			// Connected accounts (GitHub OAuth link/unlink)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadUser)).Get("/user/connections", userHandler.GetConnectedAccounts)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser)).Delete("/user/connections/{id}", userHandler.DeleteConnectedAccount)

			r.With(middleware.RequireAuth, middleware.RequireFirstPartyAuth, middleware.RequireScope(middleware.ScopeReadUser)).Get("/user/keys", sshKeyHandler.ListSSHKeys)
			r.With(middleware.RequireAuth, middleware.RequireFirstPartyAuth, middleware.RequireScope(middleware.ScopeReadUser)).Get("/user/keys/{id}", sshKeyHandler.GetSSHKey)
			r.With(middleware.RequireAuth, middleware.RequireFirstPartyAuth, middleware.RequireScope(middleware.ScopeWriteUser)).Post("/user/keys", sshKeyHandler.CreateSSHKey)
			r.With(middleware.RequireAuth, middleware.RequireFirstPartyAuth, middleware.RequireScope(middleware.ScopeWriteUser)).Delete("/user/keys/{id}", sshKeyHandler.DeleteSSHKey)

			// OAuth2 application management (scoped to authenticated user).
			if oauth2Handler != nil {
				r.With(middleware.RequireAuth, middleware.RequireFirstPartyAuth, middleware.RequireScope(middleware.ScopeWriteUser)).Post("/oauth2/applications", oauth2Handler.PostApplication)
				r.With(middleware.RequireAuth, middleware.RequireFirstPartyAuth, middleware.RequireScope(middleware.ScopeReadUser)).Get("/oauth2/applications", oauth2Handler.GetApplications)
				r.With(middleware.RequireAuth, middleware.RequireFirstPartyAuth, middleware.RequireScope(middleware.ScopeReadUser)).Get("/oauth2/applications/{id}", oauth2Handler.GetApplication)
				r.With(middleware.RequireAuth, middleware.RequireFirstPartyAuth, middleware.RequireScope(middleware.ScopeWriteUser)).Delete("/oauth2/applications/{id}", oauth2Handler.DeleteApplication)
				// revoke-all is destructive (deletes every token issued by the
				// app for this user), so it demands a write-capable scope: a
				// read:user-only access token must not be able to kill other
				// live sessions/tokens for the OAuth app.
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser)).Post("/oauth2/revoke-all", oauth2Handler.PostRevokeAll)
				// /oauth2/authorize is intentionally registered ONLY in the
				// public block above (ticket 0106 browser-native flow).
			}

			// Notification REST endpoints (scoped to authenticated user).
			// Ticket 12: gated by feature_flags.notifications.
			if notificationHandler != nil {
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadUser), gateNotifications).Get("/notifications/list", notificationHandler.ListNotifications)
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadUser), gateNotifications).Get("/notifications/events", notificationHandler.ListNotificationFacts)
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser), gateNotifications).Patch("/notifications/{id}", notificationHandler.MarkNotificationRead)
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser), gateNotifications).Put("/notifications/mark-read", notificationHandler.MarkAllNotificationsRead)
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadUser), gateNotifications).Get("/notifications/preferences", notificationHandler.GetNotificationPreferences)
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser), gateNotifications).Put("/notifications/preferences", notificationHandler.PutNotificationPreferences)
			}

		})

		// Mixed-access group: public read routes (no auth required) and session/token
		// authenticated org/team mutation routes. The default /api CSRF middleware
		// protects state-changing requests for session-authenticated users.
		// RequireTokenScope gates public reads for token callers; RequireAuth +
		// RequireScope gate the mutation routes.
		r.Group(func(r chi.Router) {
			readRepo := []func(http.Handler) http.Handler{
				middleware.RequireTokenScope(middleware.ScopeReadRepository),
			}
			if queries != nil {
				readRepo = append(readRepo, middleware.LoadRepoContext(queries))
				readRepo = append(readRepo, middleware.RequireRepoPermission(middleware.PermissionRead))
			}
			readRepo = append(readRepo, repoAPIQuota)
			r.With(readRepo...).Get("/repos/{owner}/{repo}", repoHandler.GetRepo)
			r.With(readRepo...).Get("/repos/{owner}/{repo}/topics", repoHandler.GetRepoTopics)

			r.With(readRepo...).Get("/repos/{owner}/{repo}/contents", repoHandler.GetRepoContents)
			r.With(readRepo...).Get("/repos/{owner}/{repo}/contents/*", repoHandler.GetRepoContents)
			r.With(readRepo...).Get("/repos/{owner}/{repo}/home", repoHandler.GetRepositoryHome)
			r.With(readRepo...).Get("/repos/{owner}/{repo}/git/refs", repoHandler.ListGitRefs)
			r.With(readRepo...).Get("/repos/{owner}/{repo}/commits/{ref}/statuses", commitStatusHandler.GetCommitStatuses)
			// jj VCS read routes: bookmarks, changes, operations.
			r.With(readRepo...).Get("/repos/{owner}/{repo}/bookmarks", jjVCSHandler.ListBookmarks)
			r.With(readRepo...).Get("/repos/{owner}/{repo}/changes", jjVCSHandler.ListChanges)
			r.With(readRepo...).Get("/repos/{owner}/{repo}/changes/{change_id}/walkthrough", jjVCSHandler.GetChangeWalkthrough)
			r.With(readRepo...).Get("/repos/{owner}/{repo}/changes/{change_id}", jjVCSHandler.GetChange)
			r.With(readRepo...).Get("/repos/{owner}/{repo}/changes/{change_id}/findings", jjVCSHandler.GetChangeFindings)
			r.With(readRepo...).Get("/repos/{owner}/{repo}/changes/{change_id}/diff", jjVCSHandler.GetChangeDiff)
			r.With(readRepo...).Get("/repos/{owner}/{repo}/changes/{change_id}/files", jjVCSHandler.GetChangeFiles)
			r.With(readRepo...).Get("/repos/{owner}/{repo}/changes/{change_id}/conflicts", jjVCSHandler.GetChangeConflicts)
			r.With(readRepo...).Get("/repos/{owner}/{repo}/changes/{change_id}/operations", jjVCSHandler.ListChangeOperations)
			r.With(readRepo...).Get("/repos/{owner}/{repo}/file/{change_id}/*", jjVCSHandler.GetFileAtChange)
			r.With(readRepo...).Get("/repos/{owner}/{repo}/operations", jjVCSHandler.ListOperations)
			r.With(readRepo...).Get("/repos/{owner}/{repo}/status", jjVCSHandler.GetWorkingTreeStatus)
			if stackHandler != nil {
				r.With(readRepo...).Get("/repos/{owner}/{repo}/stacks/active", stackHandler.GetActiveStack)
			}
			// Ticket 12: Wiki read routes — gated by feature_flags.wiki.
			if wikiService != nil {
				// Legacy Gitea-style /wiki/pages and /wiki/page/{pageName} aliases are intentionally
				// not mounted so slugs like "pages" and "new" remain valid page names.
				if content, ok := wikiService.(routes.WikiContentService); ok {
					h := &routes.WikiContentHandler{Service: content}
					r.With(append(readRepo, gateWiki)...).Get("/repos/{owner}/{repo}/wiki/history/events", h.Events)
					r.With(append(readRepo, gateWiki)...).Get("/repos/{owner}/{repo}/wiki/history/{pageID}", h.History)
					r.With(append(readRepo, gateWiki)...).Get("/repos/{owner}/{repo}/wiki/history/{pageID}/{revision}/content", h.Content)
				}
				if indexed, ok := wikiService.(routes.WikiIndexService); ok {
					r.With(append(readRepo, gateWiki)...).Get("/repos/{owner}/{repo}/wiki/navigation/index", routes.WikiIndex(indexed))
				}
				r.With(append(readRepo, gateWiki)...).Get("/repos/{owner}/{repo}/wiki", routes.ListWikiPages(wikiService))
				r.With(append(readRepo, gateWiki)...).Get("/repos/{owner}/{repo}/wiki/search", routes.SearchWikiPages(wikiService))
				r.With(append(readRepo, gateWiki)...).Get("/repos/{owner}/{repo}/wiki/{slug}", routes.GetWikiPage(wikiService))
				r.With(append(readRepo, gateWiki)...).Get("/repos/{owner}/{repo}/wiki/{slug}/revisions", routes.ListWikiRevisions(wikiService))
			}
			r.With(readRepo...).Get("/repos/{owner}/{repo}/landings", landingHandler.ListLandingRequests)
			r.With(readRepo...).Get("/repos/{owner}/{repo}/landings/{number}", landingHandler.GetLandingRequest)
			r.With(readRepo...).Get("/repos/{owner}/{repo}/landings/{number}/land/append", landingHandler.ObserveLandingAppend)
			r.With(readRepo...).Get("/repos/{owner}/{repo}/landings/{number}/reviews", landingHandler.ListLandingReviews)
			r.With(readRepo...).Get("/repos/{owner}/{repo}/landings/{number}/comments", landingHandler.ListLandingComments)
			r.With(readRepo...).Get("/repos/{owner}/{repo}/landings/{number}/changes", landingHandler.ListLandingChanges)
			r.With(readRepo...).Get("/repos/{owner}/{repo}/landings/{number}/diff", landingHandler.GetLandingDiff)
			r.With(readRepo...).Get("/repos/{owner}/{repo}/landings/{number}/conflicts", landingHandler.GetLandingConflicts)
			// Ticket 12: Issue read routes — gated by feature_flags.issues.
			r.With(append(readRepo, gateIssues)...).Get("/repos/{owner}/{repo}/issues", issueHandler.ListIssues)
			r.With(append(readRepo, gateIssues)...).Get("/repos/{owner}/{repo}/issues/{number}", issueHandler.GetIssue)
			r.With(append(readRepo, gateIssues)...).Get("/repos/{owner}/{repo}/issues/{number}/comments", issueHandler.ListIssueComments)

			r.With(append(readRepo, gateIssues)...).Get("/repos/{owner}/{repo}/issues/{number}/events", issueEventHandler.ListIssueEvents)
			r.With(append(readRepo, middleware.RequireAuth, gateIssues)...).Get("/repos/{owner}/{repo}/issues/state-events", issueEventHandler.ListIssueStateFacts)

			// Ticket 12: Label read routes — gated by feature_flags.labels.
			r.With(append(readRepo, gateLabels)...).Get("/repos/{owner}/{repo}/labels", labelHandler.GetRepoLabels)
			r.With(append(readRepo, gateLabels)...).Get("/repos/{owner}/{repo}/labels/{id}", labelHandler.GetRepoLabel)
			r.With(append(readRepo, gateLabels)...).Get("/repos/{owner}/{repo}/issues/{number}/labels", labelHandler.GetIssueLabels)

			if lfsHandler != nil {
				r.With(readRepo...).Get("/repos/{owner}/{repo}/lfs/objects", lfsHandler.GetObjects)
			}

			// Workflow execution read routes.
			workflowReadRepo := append([]func(http.Handler) http.Handler{}, readRepo...)
			workflowReadRepo = append(workflowReadRepo, gateWorkflows)
			if workflowHandler != nil {
				r.With(workflowReadRepo...).Get("/repos/{owner}/{repo}/workflows/runs", workflowHandler.ListWorkflowRunsV2)
				r.With(workflowReadRepo...).Get("/repos/{owner}/{repo}/workflows/runs/{id}", workflowHandler.GetWorkflowRunV2)
				r.With(workflowReadRepo...).Get("/repos/{owner}/{repo}/workflows/runs/{id}/nodes/{nodeId}", workflowHandler.GetWorkflowRunNode)
				r.With(workflowReadRepo...).Get("/repos/{owner}/{repo}/workflows", workflowHandler.ListWorkflows)
				r.With(workflowReadRepo...).Get("/repos/{owner}/{repo}/workflows/{id}", workflowHandler.GetWorkflow)
				r.With(workflowReadRepo...).Get("/repos/{owner}/{repo}/workflows/{id}/runs", workflowHandler.ListWorkflowRuns)
				r.With(workflowReadRepo...).Get("/repos/{owner}/{repo}/actions/runs", workflowHandler.ListAllWorkflowRuns)
				r.With(workflowReadRepo...).Get("/repos/{owner}/{repo}/actions/runs/{id}", workflowHandler.GetWorkflowRun)
				r.With(workflowReadRepo...).Get("/repos/{owner}/{repo}/actions/runs/{id}/steps", workflowHandler.ListWorkflowRunSteps)
				// Ticket 0111: canonical run inspect routes. Same handlers as
				// `/actions/runs/...`, just advertised under the canonical
				// `/runs/{id}` prefix for the client contract.
				r.With(workflowReadRepo...).Get("/repos/{owner}/{repo}/runs", workflowHandler.ListAllWorkflowRuns)
				r.With(workflowReadRepo...).Get("/repos/{owner}/{repo}/runs/{id}", workflowHandler.GetWorkflowRun)
				r.With(workflowReadRepo...).Get("/repos/{owner}/{repo}/runs/{id}/steps", workflowHandler.ListWorkflowRunSteps)
				// The compact status read half of the invocation seam.
				r.With(workflowReadRepo...).Get("/repos/{owner}/{repo}/runs/{id}/status", workflowHandler.GetWorkflowRunStatus)
			}
			if workflowCacheHandler != nil {
				r.With(workflowReadRepo...).Get("/repos/{owner}/{repo}/caches", workflowCacheHandler.ListCaches)
				r.With(workflowReadRepo...).Get("/repos/{owner}/{repo}/caches/stats", workflowCacheHandler.GetStats)
			}

			// Orgs / teams routes. Organizations are not a feature flag: these
			// routes are always mounted so org-owned repositories exist on Cloud.
			orgPublicRead := middleware.PublicReadAsAnonymousWithoutTokenScope(middleware.ScopeReadOrganization)
			r.With(orgPublicRead).Get("/orgs/{org}", orgHandler.GetOrg)
			r.With(orgPublicRead).Get("/orgs/{org}/repos", orgHandler.GetOrgRepos)

			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteOrganization)).Post("/orgs", orgHandler.PostOrg)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteOrganization)).Patch("/orgs/{org}", orgHandler.PatchOrg)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadOrganization)).Get("/orgs/{org}/members", orgHandler.GetOrgMembers)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteOrganization)).Post("/orgs/{org}/members", orgHandler.PostOrgMember)
			// Organization subscriptions (RFD-003): members list legacy rows so
			// an owner can revoke them; the service refuses new ones because a
			// subscription serves only its account holder's own runs.
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadUser), gateSubscriptionConnections).Get("/orgs/{org}/provider-connections", providerConnectionHandler.ListOrgConnections)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteUser), gateSubscriptionConnections).Post("/orgs/{org}/provider-connections", providerConnectionHandler.ConnectOrg)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteOrganization)).Delete("/orgs/{org}/members/{username}", orgHandler.DeleteOrgMember)
			if changesetHandler != nil {
				// Cross-repository changesets land through the organization
				// superproject; gated by feature_flags.changesets alone.
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadRepository), gateChangesets).Get("/orgs/{org}/changesets", changesetHandler.ListChangesets)
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteRepository), gateChangesets).Post("/orgs/{org}/changesets", changesetHandler.CreateChangeset)
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadRepository), gateChangesets).Get("/orgs/{org}/changesets/{id}", changesetHandler.GetChangeset)
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteRepository), gateChangesets).Post("/orgs/{org}/changesets/{id}/land", changesetHandler.LandChangeset)
			}
			if secretHandler != nil {
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadOrganization), gateSecrets).Get("/orgs/{org}/secrets", secretHandler.ListOrgSecrets)
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteOrganization), gateSecrets).Post("/orgs/{org}/secrets", secretHandler.SetOrgSecret)
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteOrganization), gateSecrets).Delete("/orgs/{org}/secrets/{name}", secretHandler.DeleteOrgSecret)
			}
			if variableHandler != nil {
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadOrganization)).Get("/orgs/{org}/variables", variableHandler.ListOrgVariables)
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteOrganization)).Post("/orgs/{org}/variables", variableHandler.SetOrgVariable)
				r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteOrganization)).Delete("/orgs/{org}/variables/{name}", variableHandler.DeleteOrgVariable)
			}
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadOrganization)).Get("/orgs/{org}/teams", orgHandler.GetOrgTeams)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteOrganization)).Post("/orgs/{org}/teams", orgHandler.PostOrgTeam)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadOrganization)).Get("/orgs/{org}/teams/{team}", orgHandler.GetOrgTeam)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteOrganization)).Patch("/orgs/{org}/teams/{team}", orgHandler.PatchOrgTeam)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteOrganization)).Delete("/orgs/{org}/teams/{team}", orgHandler.DeleteOrgTeam)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadOrganization)).Get("/orgs/{org}/teams/{team}/members", orgHandler.GetOrgTeamMembers)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteOrganization)).Put("/orgs/{org}/teams/{team}/members/{username}", orgHandler.PutOrgTeamMember)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteOrganization)).Delete("/orgs/{org}/teams/{team}/members/{username}", orgHandler.DeleteOrgTeamMember)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeReadOrganization)).Get("/orgs/{org}/teams/{team}/repos", orgHandler.GetOrgTeamRepos)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteOrganization)).Put("/orgs/{org}/teams/{team}/repos/{owner}/{repo}", orgHandler.PutOrgTeamRepo)
			r.With(middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteOrganization)).Delete("/orgs/{org}/teams/{team}/repos/{owner}/{repo}", orgHandler.DeleteOrgTeamRepo)

			// Ticket 12: Search sub-router — gated by feature_flags.search.
			r.Route("/search", func(r chi.Router) {
				r.Use(gateSearch)
				r.Use(middleware.SearchRateLimit(queries))

				r.With(middleware.RequireTokenScope(middleware.ScopeReadRepository)).Get("/repositories", searchHandler.SearchRepositories)
				r.With(middleware.RequireTokenScope(middleware.ScopeReadRepository)).Get("/issues", searchHandler.SearchIssues)
				r.With(middleware.RequireTokenScope(middleware.ScopeReadUser)).Get("/users", searchHandler.SearchUsers)
				r.With(middleware.RequireTokenScope(middleware.ScopeReadRepository)).Get("/code", searchHandler.SearchCode)
			})

			// Admin endpoints: require authenticated admin user (is_admin flag).
			r.Route("/admin", func(r chi.Router) {
				r.Use(middleware.RequireAdmin)
				readAdmin := []func(http.Handler) http.Handler{
					middleware.RequireScope(middleware.ScopeReadAdmin),
				}
				writeAdmin := []func(http.Handler) http.Handler{
					middleware.RequireScope(middleware.ScopeWriteAdmin),
				}
				if workspaceHandler != nil && workspaceHandler.EnvironmentImages != nil {
					// Platform base NixOS images (repository_id NULL) for kind=vm/desktop.
					r.With(readAdmin...).Get("/sandbox/environment-images", workspaceHandler.EnvironmentImages.ListBaseImages)
					r.With(writeAdmin...).Post("/sandbox/environment-images", workspaceHandler.EnvironmentImages.RegisterBaseImage)
				}
				if adminUserHandler != nil && !config.IsSingleOwner(cfg.Auth) {
					r.With(readAdmin...).Get("/users", adminUserHandler.ListUsers)
					r.With(writeAdmin...).Post("/users", adminUserHandler.CreateUser)
					r.With(writeAdmin...).Delete("/users/{username}", adminUserHandler.DeleteUser)
					r.With(writeAdmin...).Patch("/users/{username}", adminUserHandler.PatchUser)
					r.With(writeAdmin...).Patch("/users/{username}/admin", adminUserHandler.PatchUserAdmin)
					r.With(writeAdmin...).Post("/users/{username}/tokens", adminUserHandler.PostUserToken)
					r.With(writeAdmin...).Delete("/users/{username}/tokens/{token_id}", adminUserHandler.DeleteUserToken)
				}
				if adminOrgHandler != nil {
					r.With(readAdmin...).Get("/orgs", adminOrgHandler.ListOrgs)
				}
				if adminRepoHandler != nil {
					r.With(readAdmin...).Get("/repos", adminRepoHandler.ListRepos)
				}
				if adminGitHubAppHandler != nil {
					r.With(writeAdmin...).Post("/github-app/reconcile", adminGitHubAppHandler.Reconcile)
				}
				if adminAuditHandler != nil {
					r.With(readAdmin...).Get("/audit-logs", adminAuditHandler.ListAuditLogs)
				}
				if extras.AdminSystemHealth != nil {
					r.With(readAdmin...).Get("/system/health", extras.AdminSystemHealth.SystemHealth)
				}
				if extras.AdminSystemStatus != nil {
					r.With(readAdmin...).Get("/system/status", extras.AdminSystemStatus.SystemStatus)
				}
				if extras.AdminAnalytics != nil {
					r.With(readAdmin...).Get("/analytics/summary", extras.AdminAnalytics.Summary)
				}
				if extras.AdminAgentSessions != nil {
					r.With(readAdmin...).Get("/agent-sessions", extras.AdminAgentSessions.List)
					r.With(writeAdmin...).Post("/agent-sessions/{id}/cancel", extras.AdminAgentSessions.Cancel)
				}
				if extras.AdminWorkspaces != nil {
					r.With(readAdmin...).Get("/workspaces", extras.AdminWorkspaces.List)
					r.With(writeAdmin...).Post("/workspaces/{id}/stop", extras.AdminWorkspaces.Stop)
					r.With(writeAdmin...).Post("/workspaces/{id}/suspend", extras.AdminWorkspaces.Suspend)
				}
				if extras.AdminTokens != nil {
					r.With(readAdmin...).Get("/tokens", extras.AdminTokens.List)
				}
				for _, route := range extras.DeploymentAdmin {
					scope := readAdmin
					if route.Write {
						scope = writeAdmin
					}
					r.With(scope...).Method(route.Method, route.Pattern, withAdminAuditActor(route.Handler))
				}
				if alphaAccessHandler != nil {
					r.With(readAdmin...).Get("/alpha/whitelist", alphaAccessHandler.GetAdminWhitelist)
					r.With(writeAdmin...).Post("/alpha/whitelist", alphaAccessHandler.PostAdminWhitelist)
					r.With(writeAdmin...).Delete("/alpha/whitelist/{identity_type}/{identity_value}", alphaAccessHandler.DeleteAdminWhitelist)
					r.With(readAdmin...).Get("/alpha/waitlist", alphaAccessHandler.GetAdminWaitlist)
					r.With(writeAdmin...).Post("/alpha/waitlist/approve", alphaAccessHandler.PostAdminWaitlistApprove)
				}
			})
		})
	})

	return r
}

// revocationChecker is the process-wide view of recent revocations installed
// by main before the router is built; nil (tests) disables the guard.
var revocationChecker middleware.RevocationChecker

// authLoader resolves the caller and then refuses a credential revoked since
// it was issued, so every route group gets both with one middleware.
func authLoader(queries *db.Queries, cfg config.AuthConfig) func(http.Handler) http.Handler {
	load := middleware.AuthLoader(queries, cfg)
	guard := middleware.RevocationGuard(revocationChecker)
	return func(next http.Handler) http.Handler {
		return load(guard(next))
	}
}

// mountModelProxy serves the metered model proxy at /model-proxy and, for the
// app's signed-in calls, at /api/model/{provider}.
func mountModelProxy(r chi.Router, queries *db.Queries, cfg *config.Config, handler http.Handler) {
	r.Group(func(r chi.Router) {
		r.Use(routes.ModelProxyAuth(middleware.RequireAgentToken(queries), func(next http.Handler) http.Handler {
			return authLoader(queries, cfg.Auth)(middleware.RequireAuth(next))
		}))
		r.Post(modelproxy.Path+"/*", handler.ServeHTTP)
		for _, seat := range modelproxy.Seats {
			r.Post(modelproxy.APIPath+"/"+seat.Provider+"/*", handler.ServeHTTP)
		}
	})
}

// withAdminAuditActor attributes a deployment operator request to the acting
// admin so its AdminOperations records name them.
func withAdminAuditActor(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next(w, r.WithContext(routes.AdminUserAuditContext(r)))
	})
}
