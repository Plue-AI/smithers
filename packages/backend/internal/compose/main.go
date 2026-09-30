package compose

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"go.opentelemetry.io/otel/sdk/trace"

	"github.com/smithersai/smithers/packages/backend/admission"
	"github.com/smithersai/smithers/packages/backend/chatconnector"
	"github.com/smithersai/smithers/packages/backend/commerce"
	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/flowmanifest"
	"github.com/smithersai/smithers/packages/backend/internal/auth"
	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/cleanup"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/configsync"
	"github.com/smithersai/smithers/packages/backend/internal/database"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/email"
	"github.com/smithersai/smithers/packages/backend/internal/lfsauth"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/observability"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/background"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/modelhost"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/smithersai/smithers/packages/backend/operations"
	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/smithersai/smithers/packages/backend/previewgateway"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	"github.com/smithersai/smithers/packages/backend/webapp"
	"github.com/smithersai/smithers/packages/backend/workspace"
)

// newRevocationBus is a test seam: run() tests capture the bus to prove its
// listener is stopped on every exit path before the pool closes.
var newRevocationBus = revocation.NewBus

func main() {
	if err := run(context.Background(), os.Args[1:], os.Stdout, os.Stderr); err != nil {
		exitFn(exitCodeFor(err))
	}
}

func Run(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	return run(ctx, args, stdout, stderr)
}

// RunWithExporter uses a deployment-provided trace exporter while retaining
// the shared redaction and sampling pipeline.
func RunWithExporter(ctx context.Context, args []string, stdout, stderr io.Writer, exporter trace.SpanExporter) error {
	return RunWithOptions(ctx, args, stdout, stderr, Options{TraceExporter: exporter})
}

func RunWithOptions(ctx context.Context, args []string, stdout, stderr io.Writer, adapters Options) error {
	return runWithOptions(ctx, args, stdout, stderr, runOptions{Options: adapters})
}

func run(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	return runWithOptions(ctx, args, stdout, stderr, runOptions{})
}

// Start assembles the same product routes and workers as Run, then hands the
// live handler to a host that owns its HTTP listener. The call remains active
// until ctx is cancelled and the shared workers have drained.
func Start(ctx context.Context, args []string, stdout, stderr io.Writer, ready func(http.Handler)) error {
	return StartWithExporter(ctx, args, stdout, stderr, nil, ready)
}

func StartWithExporter(ctx context.Context, args []string, stdout, stderr io.Writer, exporter trace.SpanExporter, ready func(http.Handler)) error {
	return StartWithOptions(ctx, args, stdout, stderr, Options{TraceExporter: exporter}, ready)
}

func StartWithOptions(ctx context.Context, args []string, stdout, stderr io.Writer, adapters Options, ready func(http.Handler)) error {
	if ready == nil {
		return errors.New("compose: ready callback is required")
	}
	return runWithOptions(ctx, args, stdout, stderr, runOptions{Options: adapters, externalHTTP: true, ready: ready})
}

// Options are the only deployment seams in the common product assembly.
type Options struct {
	CanaryRuns      ports.CanaryRunSource
	RuntimeStores   ports.RuntimeStores
	ReadyBindings   func(operations.Bindings)
	BeforeShutdown  func() error
	ComputeProvider sandbox.Provider
	Admission       admission.Policy
	Commerce        commerce.Service
	// Duties selects which halves of the product this process runs. The zero
	// value serves HTTP and runs the background workers in one process.
	Duties                 Duties
	TraceExporter          trace.SpanExporter
	Blobs                  blob.Store
	AgentLogs              services.AgentLogStore
	Repository             *repohost.Client
	RepositoryPlacement    services.RepoPlacementLookup
	RepositoryProvisioning services.RepositoryProvisioningStore
	Workspace              workspace.WorkspaceRuntime
	FlowHostRegistry       *flowmanifest.Registry
	FlowHostProductAPIURL  string
	ChatHost               ports.ChatHost
	ChatCallbackListener   net.Listener
	ChatProducerBaseURL    string
	Recommender            ports.Recommender
	RecommendationLog      ports.RecommendationLog
	ModelStreamHost        ports.ModelStreamHost
	// MetricsCollectors are deployment collectors exported with the product
	// registry on this process's /metrics endpoint.
	MetricsCollectors []prometheus.Collector
	// PlatformModelKeys supplies the provider keys Smithers pays for. Nil
	// offers no platform models: guests use repository keys and connected
	// accounts only.
	PlatformModelKeys modelproxy.Keys
	// ModelProxyUpstreams overrides provider origins for PlatformModelKeys.
	ModelProxyUpstreams map[string]string
	// AdminRoutes serves deployment operator endpoints under /api/admin.
	AdminRoutes ports.AdminRoutes
}

// Duties splits one product composition across processes. A deployment
// expresses its topology by the processes it starts, never by naming itself.
type Duties string

const (
	DutiesAll     Duties = ""
	DutiesHTTP    Duties = "http"
	DutiesWorkers Duties = "workers"
)

func (duties Duties) valid() bool {
	return duties == DutiesAll || duties == DutiesHTTP || duties == DutiesWorkers
}

// topology is derived from the configured identity mode and requested duties.
type topology struct {
	multitenant bool
	duties      Duties
}

func (t topology) hosted() bool     { return t.multitenant }
func (t topology) workers() bool    { return t.duties != DutiesHTTP }
func (t topology) servesHTTP() bool { return t.duties != DutiesWorkers }

type runOptions struct {
	Options
	topology     topology
	externalHTTP bool
	ready        func(http.Handler)
}

func runWithOptions(ctx context.Context, args []string, stdout, stderr io.Writer, options runOptions) (runErr error) {
	if !options.Duties.valid() {
		return fmt.Errorf("unsupported backend duties %q", options.Duties)
	}
	_ = stdout
	// `smithers-backend migrate [apply|status]` is a server-free schema
	// migration path: it applies the embedded product baseline and exits (non-zero on
	// failure) WITHOUT booting the HTTP server or loading/validating the full
	// server config. Dispatch before the server flag set so a stray positional
	// can never silently boot the API. See migrate.go.
	if len(args) > 0 && args[0] == "migrate" {
		return runMigrate(ctx, args[1:], stdout, stderr)
	}
	fs := flag.NewFlagSet("smithers-server", flag.ContinueOnError)
	fs.SetOutput(stderr)
	configPath := fs.String("config", "", "Path to config file")
	if err := fs.Parse(args); err != nil {
		return &flagParseError{err}
	}

	cfg, err := config.Load(*configPath)
	if err != nil {
		// slog not yet initialized; use a minimal stderr logger for bootstrap failures.
		slog.New(middleware.NewGCPJSONHandler(stderr, slog.LevelError)).Error("failed to load config", "error", err)
		return err
	}
	if err := validateProductionConfig(os.Getenv("SMITHERS_ENV"), strings.EqualFold(os.Getenv("SMITHERS_ENABLE_E2E_TEST_ROUTES"), "true")); err != nil {
		slog.New(middleware.NewGCPJSONHandler(stderr, slog.LevelError)).Error("invalid production config", "error", err)
		return err
	}
	modelDailyCap, err := modelproxy.ParseDailySpendCap(os.Getenv(modelproxy.DailySpendCapEnv))
	if err != nil {
		slog.New(middleware.NewGCPJSONHandler(stderr, slog.LevelError)).Error("invalid model spend cap", "error", err)
		return err
	}
	options.topology = topology{multitenant: config.IsMultitenant(cfg.Auth), duties: options.Duties}
	if options.Workspace != nil {
		switch isolation := options.Workspace.Isolation(); isolation {
		case workspace.IsolationTrustedProcess:
			if options.topology.hosted() {
				return fmt.Errorf("auth.mode=%q requires an isolated workspace runtime", cfg.Auth.Mode)
			}
		case workspace.IsolationSandboxed:
			// Hosted deployments require it; a single-owner installation may
			// choose it (SMITHERS_WORKSPACE_ISOLATION=microvm) and then never
			// executes workspace work on the host.
		default:
			return fmt.Errorf("unsupported workspace isolation %q", isolation)
		}
	}
	if !options.topology.hosted() && cfg.FeatureFlags.Workflows {
		return errors.New("legacy workflow triggers are unavailable in single-owner mode; use canonical Flow hosts")
	}
	if options.Commerce != nil && options.Admission == nil {
		return errors.New("commerce requires injected metered admission")
	}
	if options.Commerce != nil && !options.topology.servesHTTP() {
		return errors.New("worker duties do not accept commerce authority")
	}
	cfg.Observability.MetricsAddr = strings.TrimSpace(cfg.Observability.MetricsAddr)
	if cfg.Observability.MetricsAddr != "" && options.topology.servesHTTP() {
		return errors.New("observability.metrics_addr applies only to worker duties; HTTP processes serve /metrics on the product router")
	}
	if err := config.ValidateServerStartupWithDependencies(cfg, config.StartupDependencies{
		InProcessRepository: options.Repository != nil && options.Repository.InProcess(),
		WorkspaceRuntime:    options.Workspace != nil,
		ComputeProvider:     options.ComputeProvider != nil,
		MeteredAdmission:    options.Admission != nil,
	}); err != nil {
		slog.New(middleware.NewGCPJSONHandler(stderr, slog.LevelError)).Error("invalid startup config", "error", err)
		return err
	}
	if options.Blobs == nil {
		if err := validateProductionBlobStore(os.Getenv("SMITHERS_ENV"), cfg.Blob); err != nil {
			slog.New(middleware.NewGCPJSONHandler(stderr, slog.LevelError)).Error("invalid production blob config", "error", err)
			return err
		}
	}

	// Initialize structured JSON logger from config and set as global default.
	serverLogger := middleware.NewServerLogger(stderr, cfg.Observability.LogLevel)
	slog.SetDefault(serverLogger)
	shutdownTimeout, err := shutdownTimeoutFn(cfg.Server)
	if err != nil {
		slog.Error("invalid server shutdown timeout", "value", cfg.Server.ShutdownTimeout, "error", err)
		return err
	}

	// ctx is supplied by the caller (context.Background() in prod; a cancelable
	// context in tests to drive the graceful-shutdown path).

	// Log startup configuration summary so operators can quickly identify
	// misconfigurations from pod logs without digging through error chains.
	logStartupConfig(cfg)

	smithersMetrics := routes.NewSmithersMetrics()

	// Initialize OpenTelemetry
	var tp *trace.TracerProvider
	if options.TraceExporter != nil {
		tp, err = observability.InitWithExporter(ctx, cfg.Observability, options.TraceExporter)
	} else {
		tp, err = otelInit(ctx, cfg.Observability)
	}
	if err != nil {
		// Tracing defaults to "none", so an error means an exporter was
		// configured and cannot be built. Fail instead of running untraced.
		slog.Error("failed to initialize OpenTelemetry", "error", err)
		return err
	}
	if tp != nil {
		defer func() {
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := tp.Shutdown(shutdownCtx); err != nil {
				slog.Warn("error shutting down tracer provider", "error", err)
			}
		}()
	}

	pool, err := database.NewPool(ctx, cfg.Database, smithersMetrics)
	if err != nil {
		slog.Error("failed to connect to database", "error", err)
		return err
	}
	defer pool.Close()
	slog.Info("connected to database")

	provisioningEnforced := options.topology.hosted()

	// Start background DB pool stats collector (reports every 15s).
	poolStatsCtx, poolStatsCancel := context.WithCancel(ctx)
	defer poolStatsCancel()
	database.StartPoolStatsCollector(poolStatsCtx, pool, smithersMetrics, 15*time.Second)

	queries := db.New(pool)
	runtimeStores := resolveProductRuntimeStores(options.RuntimeStores, queries)
	if err := services.ValidateLocalIdentityStartup(ctx, queries, cfg.Auth); err != nil {
		return fmt.Errorf("validate local identity startup: %w", err)
	}
	// One shared broker multiplexes every SSE stream type (notifications,
	// workspaces, workflow-run logs, agent sessions, releases) over a SINGLE
	// pooled connection, so SSE clients no longer consume one pgxpool slot each.
	//
	// MaxStreamsPerUser is a per-pod ABUSE cap, not a product/UX limit. Because a
	// stream no longer pins a DB connection, each one costs only a small buffered
	// Go channel, so this can be generous. The cap now spans ALL of a user's SSE
	// stream types at once (before the migration, notifications/workspace/workflow/
	// release ran through the uncapped per-client path and only agent sessions were
	// capped, at 5). It is deliberately set well above the busiest realistic
	// first-party client: the multi dashboard opens on the order of a dozen
	// concurrent live streams (notifications + several workspaces + a run or two +
	// an agent session), and SSE reconnect churn can transiently double-count a
	// stream while the server has not yet observed the old TCP close and run the
	// deferred Unsubscribe. 100 leaves comfortable headroom for that overlap while
	// still stopping a single user from opening unbounded streams on one pod.
	// (Pair stays on the uncapped per-client path — see routes/pair.go — so keyless
	// viewers are unaffected by this cap.)
	sseBroker := sse.NewBroker(pool)
	smithersMetrics.MustRegister(sseBroker.MetricsCollectors()...)
	sseBroker.MaxStreamsPerUser = 100
	if err := startSSEBroker(sseBroker, ctx); err != nil {
		slog.Error("failed to start SSE broker", "error", err)
		return err
	}
	defer sseBroker.Stop()

	// Revocation fan-out: one durable event per revocation plus NOTIFY, a
	// per-request check in the auth chain, and termination of every live SSE
	// stream, terminal, relay, and sandbox proxy the revocation covers.
	revocationBus := newRevocationBus(pool, queries)
	smithersMetrics.MustRegister(revocationBus.MetricsCollectors()...)
	// Own the listener lifetime even when production supplies Background().
	// Register the stop immediately after Start so it runs before pool.Close
	// on startup errors as well as normal shutdown.
	revocationBusCtx, cancelRevocationBus := context.WithCancel(ctx)
	if err := revocationBus.Start(revocationBusCtx); err != nil {
		cancelRevocationBus()
		slog.Error("failed to start revocation bus", "error", err)
		return err
	}
	stopRevocationBus := func() {
		stopRevocationListener(cancelRevocationBus, revocationBus, revocationBusStopTimeout)
	}
	defer stopRevocationBus()
	revocationPublisher := revocation.NewDBPublisher(queries, revocationBus)
	routes.SetRevocationSource(revocationBus)
	revocationChecker = revocationBus

	activeStorageSetID := strings.TrimSpace(os.Getenv("ACTIVE_STORAGE_SET"))
	if activeStorageSetID == "" {
		activeStorageSetID = services.DefaultStorageSetID
	}
	storageSetResolverTemplate := services.BuildStorageSetResolverTemplate(cfg.RepoHost.URL, activeStorageSetID)

	storageSetResolver := services.NewDBStorageSetResolver(queries, storageSetResolverTemplate, options.RepositoryPlacement)
	repoHostClient := options.Repository
	if repoHostClient == nil {
		repoHostClient = repohost.NewClient(storageSetResolver, cfg.RepoHost.AuthToken, smithersMetrics)
	}

	webhookDispatcher := webhooks.NewDispatcher(queries)
	// Complete the dispatcher before any service captures it.
	linearClient := auth.NewLinearClient(cfg.Auth.LinearClientID, cfg.Auth.LinearClientSecret, cfg.Auth.LinearRedirectURL)
	linearIntegrationSvc := services.NewLinearIntegrationService(queries, linearClient, cfg.Auth.SessionSecret)
	linearEnabled := strings.TrimSpace(cfg.Auth.LinearClientID) != "" && strings.TrimSpace(cfg.Auth.LinearClientSecret) != ""
	var linearSyncSvc *services.LinearSyncService
	var linearDispatcher *webhooks.LinearDispatcher
	if linearEnabled {
		linearSyncSvc = services.NewLinearSyncServiceWithPool(queries, linearIntegrationSvc, pool)
		linearDispatcher = webhooks.NewLinearDispatcher(webhookDispatcher, linearSyncSvc)
		webhookDispatcher = linearDispatcher
	}
	sshAuthzService := services.NewSSHAuthorizationService(queries)
	var gitHTTPOptions []services.GitHTTPProxyServiceOption
	if config.IsSingleOwner(cfg.Auth) {
		gitHTTPOptions = append(gitHTTPOptions, services.WithGitHTTPSingleOwnerBoundary(queries))
	}
	gitHTTPProxyService := services.NewGitHTTPProxyService(queries, sshAuthzService, repoHostClient, gitHTTPOptions...)
	orgService := services.NewOrgServiceWithPool(queries, pool, services.WithOrgWebhookDispatcher(webhookDispatcher))
	keyAuthVerifier, githubClient, err := buildAuthProviders(cfg.Auth)
	if err != nil {
		slog.Error("invalid auth provider configuration", "error", err)
		return err
	}
	authService := services.NewAuthService(queries, cfg.Auth, keyAuthVerifier, githubClient,
		services.WithAuthMetrics(smithersMetrics),
		// GitHub App refresh tokens are single-use. Serialize refreshes for one
		// account across ALL replicas, not just across goroutines in this one.
		services.WithAuthGitHubRefreshLocker(services.NewPgGitHubRefreshLocker(pool)),
	)
	auth0Configured := strings.TrimSpace(cfg.Auth.Auth0Domain) != "" &&
		strings.TrimSpace(cfg.Auth.Auth0ClientID) != "" &&
		strings.TrimSpace(cfg.Auth.Auth0ClientSecret) != ""
	if auth0Configured {
		auth0Client := auth.NewAuth0Client(
			cfg.Auth.Auth0Domain,
			cfg.Auth.Auth0ClientID,
			cfg.Auth.Auth0ClientSecret,
			cfg.Auth.Auth0RedirectURL,
			cfg.Auth.Auth0Connection,
			cfg.Auth.GitHubAPIBaseURL,
		)
		authService.SetAuth0Client(auth0Client)
	}
	userService := services.NewUserService(queries)
	userDeviceService := services.NewUserDeviceService(queries)

	// Initialize email transport from config.
	emailTransport, err := newEmailTransport(cfg.Email)
	if err != nil {
		slog.Error("failed to initialize email transport", "error", err)
		return err
	}
	// Wrap transport with rate limiting.
	emailTransport = email.NewRateLimitedTransport(emailTransport, email.RateLimitConfig{
		MaxPerSecond:           cfg.Email.RateLimitPerSecond,
		MaxPerRecipientPerHour: cfg.Email.RateLimitPerRecipientPerHr,
		RecipientPool:          pool,
	})
	emailFrom := cfg.Email.From
	if emailFrom == "" {
		emailFrom = cfg.Email.SMTPFrom
	}
	// One public origin serves browser redirects, email, Git and blob transfers.
	publicBaseURL := config.PublicOrigin(cfg)
	workspaceGitBaseURL := publicBaseURL
	if !options.topology.hosted() && options.Workspace != nil {
		workspaceGitBaseURL, err = flowHostProductAPIURL(options, cfg.Server.Addr)
		if err != nil {
			return fmt.Errorf("workspace Git origin: %w", err)
		}
	}
	agentAPIBaseURL := publicBaseURL + "/api"
	emailService := services.NewEmailService(queries, emailTransport, services.EmailServiceConfig{
		BaseURL: publicBaseURL,
		From:    emailFrom,
	})

	billingPolicy := options.Admission
	if billingPolicy == nil {
		// Startup validation permits this only for the single trusted owner.
		billingPolicy = services.NewUnlimitedBillingPolicy()
	}
	billingCommerce := options.Commerce
	if !options.topology.servesHTTP() {
		billingCommerce = nil
	}
	billingCapabilities := commerce.Capabilities{}
	if billingCommerce != nil {
		billingCommerce.SetFallbackEmailSender(emailService)
		billingCapabilities = billingCommerce.Capabilities()
		orgService.SetSeatReconciler(billingCommerce.ReconcileOrgSeats)
	}
	repoOptions := []services.RepoServiceOption{
		services.WithRepoWebhookDispatcher(webhookDispatcher),
		services.WithRepoBillingPolicy(billingPolicy),
	}
	var repoService *services.RepoService
	if options.topology.hosted() {
		repoOptions = append(repoOptions, services.WithRepoPlacementResolver(options.RepositoryPlacement), services.WithRepoProvisioningStore(options.RepositoryProvisioning))
		repoService = services.NewRepoServiceWithPool(queries, repoHostClient, activeStorageSetID, pool, repoOptions...)
	} else {
		repoService = services.NewProductRepoServiceWithPool(queries, repoHostClient, pool, repoOptions...)
	}
	if provisioningEnforced {
		repoService.EnableDurableProvisioning()
	}
	repositoryStorageReconciler := services.NewRepositoryStorageOperationReconciler(pool, repoHostClient)
	repositoryProvisioningReconciler := services.NewRepositoryProvisioningReconciler(options.RepositoryProvisioning, repoHostClient)
	repoOwnershipFence := services.NewRepoOwnershipFence(pool)
	sshKeyService := services.NewSSHKeyService(queries)
	deployKeyService := services.NewDeployKeyService(queries)
	labelService := services.NewLabelService(queries)

	searchService := services.NewSearchService(queries)
	notificationService := services.NewNotificationServiceWithPool(queries, pool)

	mentionService := services.NewMentionService(queries, notificationService, services.WithMentionEmailSender(emailService))
	commitStatusService := services.NewCommitStatusService(queries, services.WithCommitStatusWebhookDispatcher(webhookDispatcher))
	gitHubBudgetTracker := services.NewBudgetTracker()
	repoConnectionService := services.NewRepoConnectionService(pool)
	repoConnectionService.SetGitHubBudgetTracker(gitHubBudgetTracker)
	gitHubRepoListService := services.NewGitHubRepoListService(pool, repoConnectionService)
	// The continuously-synced GitHub mirror: registry + issue/PR/comment store.
	// The metadata proxy serves from it (live GitHub is the fallback), the App
	// webhooks keep it fresh, and github-sync reads its registry feed instead of
	// a static mapping. Its ref mirrorer is attached once the import service —
	// which owns the clone → repo-host → ImportRefs path — has been built.
	gitHubSyncedRepoService := services.NewGitHubSyncedRepoService(queries,
		// R5: sync draws from the same per-installation budget as the proxy.
		services.WithGitHubSyncedRepoBudget(gitHubBudgetTracker),
	)
	gitHubUserReposService := services.NewGitHubUserReposService(queries, authService,
		services.WithGitHubUserReposTokenRefresher(authService),
		services.WithGitHubUserReposSyncedStore(gitHubSyncedRepoService),
	)
	repoConnectionService.SetGitHubRepoAccessVerifier(gitHubUserReposService)
	// github-sync writes to GitHub with the platform token; a mirror is bound
	// and advertised only while its binding user can push with their own
	// GitHub credential.
	gitHubSyncedRepoService.SetPushAccess(gitHubUserReposService)
	gitHubSyncedRepoService.SetMirrorFailureObserver(smithersMetrics)
	// R2: backfills and the reconciliation sweep fetch with cached App
	// installation tokens whenever the registry row has an installation;
	// request-bound user tokens remain only the fallback for rows without one.
	gitHubSyncedRepoService.SetFetcherFactory(
		gitHubUserReposService.SyncedRepoInstallationFetcherFactory(repoConnectionService))
	gitHubCheckRunService := services.NewGitHubCheckRunService(repoConnectionService)
	webhookSecretCodec, err := newSecretCodec(cfg.Webhook.SecretEncryptionKey)
	if err != nil {
		slog.Error("failed to initialize webhook secret codec", "error", err)
		return err
	}
	agentEnvironmentService := services.NewAgentEnvironmentService(
		queries,
		webhookSecretCodec,
		services.WithAgentEnvironmentOwnershipGuard(repoOwnershipFence),
		services.WithAgentEnvironmentSubscriptionTokens(cfg.FeatureFlags.SubscriptionConnections),
	)
	secretInjector := services.NewSecretInjector(queries, webhookSecretCodec, services.WithSecretInjectorSubscriptionTokens(cfg.FeatureFlags.SubscriptionConnections))
	workflowParser := services.NewWorkflowParser()
	workflowSyncService := services.NewWorkflowSyncService(queries, repoHostClient, workflowParser)
	workflowRunService := services.NewWorkflowRunService(
		runtimeStores.WorkflowRuns,
		services.WithWorkflowRunMetrics(smithersMetrics),
		services.WithWorkflowRunWebhookDispatcher(webhookDispatcher),
		services.WithWorkflowRunCommitStatusWriter(commitStatusService),
		services.WithWorkflowRunGitHubCheckRunService(gitHubCheckRunService),
		services.WithWorkflowRunGitHubInstallationResolver(repoConnectionService),
		services.WithWorkflowRunSecretInjector(secretInjector),
		services.WithWorkflowRunBillingPolicy(billingPolicy),
		services.WithWorkflowRunDefinitionCommitLoader(workflowSyncService),
		services.WithWorkflowRunBookmarkCommitResolver(workflowSyncService),
	)

	auditService := services.NewAuditService(queries)
	configSyncService := configsync.NewService(queries, repoHostClient, webhookSecretCodec, auditService)

	landingOptions := []services.LandingServiceOption{
		services.WithLandingWebhookDispatcher(webhookDispatcher),
		services.WithLandingMentionService(mentionService),
		services.WithLandingNotificationService(notificationService),
	}
	if cfg.FeatureFlags.Workflows {
		landingOptions = append(landingOptions, services.WithLandingWorkflowRunService(workflowRunService))
	}
	landingOptions = append(landingOptions, services.WithLandingMetrics(smithersMetrics))
	landingService := services.NewLandingServiceWithPool(queries, repoHostClient, pool, landingOptions...)
	stackOptions := []services.StackServiceOption{
		services.WithStackGitHubInstallationResolver(repoConnectionService),
	}
	if cfg.FeatureFlags.Workflows {
		stackOptions = append(stackOptions, services.WithStackWorkflowRunDispatcher(workflowRunService))
	}
	stackService := services.NewStackServiceWithPool(queries, pool, stackOptions...)
	issueService := services.NewIssueService(queries,
		services.WithIssueWebhookDispatcher(webhookDispatcher),
		services.WithIssueMentionService(mentionService),
		services.WithIssueNotificationService(notificationService),
		services.WithIssueOwnershipGuard(repoOwnershipFence),
	)
	adminOrgService := services.NewAdminOrgService(queries)
	adminRepoService := services.NewAdminRepoService(queries)
	webhookService := services.NewWebhookService(queries, webhookSecretCodec, services.WithWebhookOwnershipGuard(repoOwnershipFence))
	secretService := services.NewSecretService(queries, webhookSecretCodec, services.WithSecretOwnershipGuard(repoOwnershipFence), services.WithSecretSubscriptionTokens(cfg.FeatureFlags.SubscriptionConnections))
	variableService := services.NewVariableService(queries, services.WithVariableOwnershipGuard(repoOwnershipFence), services.WithVariableSubscriptionTokens(cfg.FeatureFlags.SubscriptionConnections))

	blobConfig := cfg.Blob
	blobConfig.TransferBaseURL = publicBaseURL
	blobStore, blobCloser, expiryDuration, err := selectBlobStore(ctx, blobConfig, options.Blobs)
	if err != nil {
		slog.Error("failed to initialize blob store", "error", err)
		return err
	}
	if blobCloser != nil {
		defer func() { _ = blobCloser.Close() }()
	}
	transferStore := blobStore
	wikiService := services.NewWikiService(queries, webhookDispatcher, services.WithWikiCollaboration(queries, repoHostClient), services.WithWikiContent(blobStore))

	lfsVerifyTokenManager, err := lfsauth.NewManager(cfg.Auth.LFSSigningSecret)
	if err != nil {
		slog.Error("failed to initialize lfs verify credentials", "error", err)
		return err
	}

	lfsService := services.NewLFSService(
		runtimeStores.LFS,
		blobStore,
		expiryDuration,
		services.WithLFSBillingPolicy(billingPolicy),
		services.WithLFSVerifyBaseURL(publicBaseURL),
		services.WithLFSVerifyTokenManager(lfsVerifyTokenManager),
	)
	workflowCacheTTL, err := time.ParseDuration(cfg.Blob.WorkflowCacheTTL)
	if err != nil {
		slog.Error("invalid blob.workflow_cache_ttl", "ttl", cfg.Blob.WorkflowCacheTTL, "error", err)
		return err
	}
	workflowCacheStore, ok := blobStore.(services.WorkflowCacheStore)
	if !ok {
		slog.Error("blob store does not implement workflow cache storage requirements")
		return errors.New("blob store does not implement workflow cache storage requirements")
	}
	workflowCacheService := services.NewWorkflowCacheService(runtimeStores.WorkflowCache, workflowCacheStore, services.WorkflowCacheConfig{
		Prefix:          cfg.Blob.WorkflowCachePrefix,
		SignedURLExpiry: expiryDuration,
		TTL:             workflowCacheTTL,
		RepoQuotaBytes:  cfg.Blob.WorkflowCacheRepoQuotaBytes,
		ArchiveMaxBytes: cfg.Blob.WorkflowCacheArchiveMaxBytes,
	}, services.WithWorkflowCacheBillingPolicy(billingPolicy))
	workflowArtifactService := services.NewWorkflowArtifactService(
		runtimeStores.WorkflowArtifacts,
		blobStore,
		expiryDuration,
		services.WithWorkflowArtifactWebhookDispatcher(webhookDispatcher),
		services.WithWorkflowArtifactWorkflowRunService(workflowRunService),
		services.WithWorkflowArtifactBillingPolicy(billingPolicy),
	)

	issueEventService := services.NewIssueEventService(queries)

	var sandboxClient services.SandboxVMClient
	var workflowSandboxClient services.WorkflowSandboxVMClient
	var retiredGatewaySandbox services.RepoGatewayRetirementVMClient
	var goldenSnapshotSandbox services.GoldenSnapshotVMClient
	var orphanSandbox services.SandboxOrphanVMClient
	provider := options.ComputeProvider
	if provider != nil {
		bindComputeProviderTelemetry(provider, smithersMetrics)
		sandboxClient = provider
		workflowSandboxClient = provider
		retiredGatewaySandbox = provider
		goldenSnapshotSandbox = provider
		orphanSandbox = provider
		if accessRevoker, ok := provider.(sandbox.AccessGrantRevoker); ok {
			unsubscribeAccessRevocations := revocationBus.Subscribe(revocation.NewAccessGrantHandler(ctx, accessRevoker))
			defer unsubscribeAccessRevocations()
		}
	}
	// Backstop for micro-VMs whose owning workspace row was cascade-
	// deleted with its repository: nothing else can see them, because every
	// other sweep starts from the row that is gone.
	var sandboxOrphanReaper *services.SandboxOrphanReaper
	if runtimeStores.Orphans != nil && orphanSandbox != nil {
		sandboxOrphanReaper = services.NewSandboxOrphanReaper(runtimeStores.Orphans, orphanSandbox, smithersMetrics)
	}

	// The deployment may inject its transcript adapter; local storage shares the
	// durable filesystem blob root.
	agentLogStore, err := selectAgentLogStore(blobStore, options.AgentLogs)
	if err != nil {
		return err
	}

	agentSnapshotID := cfg.Sandbox.AgentSnapshotID
	// Platform model seats reach providers only through the metered model
	// proxy; no provider key is bound into a guest.
	modelSeats := modelproxy.OfferedSeats(options.PlatformModelKeys)
	changesetService := services.NewChangesetService(queries, repoHostClient, repoService, pool, services.WithChangesetLandingPolicy(landingService))
	// Bring-your-own subscriptions (RFD-003): connections are encrypted with
	// the same codec as agent-environment secrets and refreshed by a worker.
	providerConnectionService := services.NewProviderConnectionService(
		queries,
		webhookSecretCodec,
		services.NewHTTPProviderTokenRefresher(services.ProviderConnectionsConfig{
			CodexTokenURL: cfg.ProviderConnections.CodexTokenURL,
			CodexClientID: cfg.ProviderConnections.CodexClientID,
		}, nil),
		services.WithProviderConnectionAudit(auditService),
		services.WithSubscriptionConnectionsEnabled(cfg.FeatureFlags.SubscriptionConnections),
	)
	providerConnectionRefreshWorker := services.NewProviderConnectionRefreshWorker(providerConnectionService, time.Minute, slog.Default())
	// Self-host only: with feature_flags.subscription_connections off (the
	// hosted product) no run or workspace is offered the pool, so a stored
	// subscription token can never serve. Keep this a nil interface, not a
	// typed nil pointer.
	var subscriptionPool services.ProviderPoolOffer
	if cfg.FeatureFlags.SubscriptionConnections {
		subscriptionPool = providerConnectionService
	}
	neverStartedTimeout, _ := time.ParseDuration(cfg.Agents.NeverStartedTimeout)
	agentService := services.NewAgentServiceWithPool(queries, pool,
		services.WithAgentDispatchQuerier(runtimeStores.AgentDispatch),
		services.WithAgentNeverStartedTimeout(neverStartedTimeout),
		services.WithAgentChangesetMaterializer(changesetService),
		services.WithAgentLogStore(agentLogStore),
		services.WithAgentSecretService(secretService),
		services.WithAgentSecretInjector(secretInjector),
		services.WithAgentAPIBaseURL(agentAPIBaseURL),
		services.WithAgentGitBaseURL(publicBaseURL),
		services.WithAgentSandboxClient(sandboxClient),
		services.WithAgentSandboxConfig(services.AgentSandboxConfig{
			MemoryMB:     cfg.Sandbox.AgentMemoryMB,
			VCPUCount:    cfg.Sandbox.AgentVCPUCount,
			RootfsSizeMB: cfg.Sandbox.AgentRootfsSizeMB,
			MaxRuntime:   time.Duration(cfg.Sandbox.AgentMaxRuntimeSecs) * time.Second,
			IdleTimeout:  time.Duration(cfg.Sandbox.AgentIdleTimeoutSecs) * time.Second,
			ModelSeats:   modelSeats,
		}),
		services.WithAgentEnvironmentVariables(agentEnvironmentService),
		services.WithAgentEnvironmentBoundSecrets(agentEnvironmentService),
		services.WithAgentSandboxMetrics(smithersMetrics),
		services.WithAgentWorkflowMetrics(smithersMetrics),
		services.WithAgentSessionMetrics(smithersMetrics),
		services.WithAgentSnapshotID(agentSnapshotID),
		services.WithAgentBillingPolicy(billingPolicy),
		// Fleet-wide capacity guard: cap concurrent agent sandboxes via a DB
		// COUNT of live agent sessions (correct across all API pods). 0 =
		// unlimited/disabled, so this no-ops until
		// SMITHERS_SANDBOX_AGENT_MAX_CONCURRENT is set. queries (*db.Queries)
		// supplies CountActiveAgentSessionVMs.
		services.WithAgentConcurrencyCap(queries, int(cfg.Sandbox.AgentMaxConcurrent)),
	)
	landingService.SetAgentTurnDispatcher(agentService)

	if binder, ok := options.Workspace.(workspace.SourceFilesBinder); ok {
		binder.BindSourceFiles(repositorySourceFiles{client: repoHostClient})
	}
	commandJobs, err := jobs.NewStore(pool)
	if err != nil {
		return fmt.Errorf("workspace commands: %w", err)
	}
	workspaceService := services.NewWorkspaceService(runtimeStores.Workspaces,
		services.WithWorkspaceCommandJobs(commandJobs, webhookSecretCodec),
		services.WithWorkspaceRuntime(options.Workspace),
		services.WithWorkspaceTransactions(pool),
		services.WithWorkspaceBillingPolicy(billingPolicy),
		services.WithWorkspaceSandboxClient(sandboxClient),
		services.WithWorkspaceSourceReader(repoHostClient),
		services.WithWorkspaceRefDeleter(repoHostClient),
		services.WithWorkspaceSandboxMetrics(smithersMetrics),
		services.WithWorkspaceGitBaseURL(workspaceGitBaseURL),
		services.WithWorkspaceSSHHost(cfg.Sandbox.WorkspaceSSHHost),
		services.WithWorkspaceSSHDialHost(cfg.Sandbox.WorkspaceSSHDialHost),
		// Advertise the SSH gateway's host key so the terminal client
		// can pin it before credentials are sent. Same directory as the
		// SSH server reads at boot (cfg.SSH.HostKeyDir).
		services.WithWorkspaceSSHHostKeyDir(cfg.SSH.HostKeyDir),
		services.WithWorkspaceSandboxConfig(
			cfg.Sandbox.WorkspaceIdleTimeout,
			sandbox.PersistenceMode(cfg.Sandbox.WorkspacePersistence),
		),
		services.WithWorkspaceResources(cfg.Sandbox.WorkspaceMemoryMB, cfg.Sandbox.WorkspaceVCPUCount),
		services.WithWorkspaceAgentResources(cfg.Sandbox.AgentMemoryMB, cfg.Sandbox.AgentVCPUCount),
		services.WithWorkspaceDesktopResources(cfg.Sandbox.DesktopMemoryMB, cfg.Sandbox.DesktopVCPUCount),
		services.WithWorkspaceDesktopObserveText(cfg.Sandbox.DesktopObserveText),
		services.WithWorkspaceLeaseDeleteAfter(time.Duration(cfg.Sandbox.WorkspaceLeaseDeleteAfter)*time.Second),
		// Supply setup-only secrets and persistent nonsecret variables to fresh
		// repository workspace VMs; secrets exist only during the setup phase
		// and are stripped before the agent runs.
		services.WithWorkspaceAgentEnvironment(agentEnvironmentService),
		services.WithWorkspaceProviderConnections(subscriptionPool),
		services.WithWorkspaceProviderBootstrap(modelSeats, cfg.Sandbox.WorkspaceCodingDefaultModel),
	)
	adminUserService := services.NewAdminUserService(queries,
		services.WithTokenCreator(authService),
		services.WithAdminAuditor(auditService),
		services.WithAccountErasure(services.AccountErasure{Pool: pool, Repos: repoService, Workspaces: workspaceService}),
		services.WithAccountExport(services.AccountExport{Pool: pool, Git: repoHostClient}),
	)

	// Golden sandbox snapshot: the pre-baked toolchain image fresh
	// workspace/gateway VMs boot from. Baked in the background from the exact
	// workspace VM request; provisioning falls back to the bare base image
	// whenever no ready snapshot exists.
	var goldenSnapshotService *services.GoldenSnapshotService
	if runtimeStores.GoldenSnapshots != nil && goldenSnapshotSandbox != nil {
		goldenSnapshotService = services.NewGoldenSnapshotService(runtimeStores.GoldenSnapshots, goldenSnapshotSandbox, workspaceService.GoldenBakeVMRequest)
		services.WithWorkspaceGoldenSnapshots(goldenSnapshotService)(workspaceService)
	}
	// NixOS environment images: the kind=vm/desktop compute path. Registering
	// an image bakes its closure-keyed golden snapshot from the same request
	// workspaces boot (NixBakeVMRequest), so the second boot clones a disk.
	var environmentImageService *services.SandboxEnvironmentImageService
	if runtimeStores.EnvironmentImages != nil {
		environmentImageService = services.NewSandboxEnvironmentImageService(runtimeStores.EnvironmentImages,
			services.WithSandboxEnvironmentImageGoldenSnapshots(goldenSnapshotService, workspaceService.NixBakeVMRequest))
		services.WithWorkspaceEnvironmentImages(environmentImageService)(workspaceService)
	}

	// Smithers Pair sessions: the server-authoritative pairing backend
	// (fork-and-swap, ACL ladder, roles, invites, per-link slugs, serial FIFO
	// queue with executor election, co-compose draft). Identity is the real
	// signed-in user; the paid-plan gate rides billingPolicy and the fork rides
	// workspaceService. Invites deliver via emailTransport when configured and
	// degrade to invite-record-only ("email delivery unavailable") otherwise.
	pairSessionService := services.NewPairSessionService(
		db.New(pool),
		billingPolicy,
		workspaceService,
		services.PairSessionServiceConfig{
			EmailFrom:     emailFrom,
			Transport:     emailTransport,
			InviteBaseURL: publicBaseURL,
			TxBeginner:    pool,
		},
	)
	pairSessionHandler := routes.NewPairSessionHandler(pairSessionService)

	// One-release convergence (#2198): discard the retired box gateways still
	// running from before. Delete with services.RepoGatewayRetirement.
	var repoGatewayRetirement *services.RepoGatewayRetirement
	if runtimeStores.RepoGateways != nil && retiredGatewaySandbox != nil {
		repoGatewayRetirement = services.NewRepoGatewayRetirement(runtimeStores.RepoGateways, queries, retiredGatewaySandbox)
	}
	gitHubImportService := services.NewGitHubImportService(
		pool,
		queries,
		queries,
		repoHostClient,
		authService,
		publicBaseURL,
		services.WithGitHubImportOrgs(queries),
		services.WithGitHubImportMetrics(smithersMetrics),
		services.WithGitHubImportBillingPolicy(billingPolicy),
		services.WithGitHubImportStorageSet(activeStorageSetID),
		services.WithGitHubImportWorkspaceProvisioner(workspaceService),
		services.WithGitHubImportTokenRefresher(authService),
		services.WithGitHubImportInstallationTokens(repoConnectionService),
		services.WithGitHubImportReadAccess(gitHubUserReposService),
		services.WithGitHubImportSyncedRepos(gitHubSyncedRepoService),
		services.WithGitHubImportProvisioningStore(options.RepositoryProvisioning),
	)
	gitHubSyncedRepoService.SetMirrorer(gitHubImportService)
	if !options.topology.hosted() {
		services.WithGitHubImportProductProvisioning(pool)(gitHubImportService)
	}
	if !options.topology.hosted() || provisioningEnforced {
		gitHubImportService.EnableDurableWorker()
	}

	landingWorker := services.NewLandingWorker(queries, repoHostClient,
		services.WithLandingWorkerMetrics(smithersMetrics),
		services.WithLandingWorkerWebhookDispatcher(webhookDispatcher),
		services.WithLandingWorkerTaskStore(services.NewPgxLandingTaskStore(pool)),
		services.WithLandingWorkerAutoLandProcessor(landingService),
	)
	cronSchedulerWorker := services.NewCronSchedulerWorker(queries, workflowRunService)
	workflowLogBudgetBackfiller := services.NewWorkflowLogBudgetBackfiller(queries)
	workflowRunTerminalPublisher, ok := workflowRunService.(services.WorkflowRunTerminalPublisher)
	if !ok {
		return errors.New("workflow run service does not publish terminal run outcomes")
	}
	var workflowSandboxSchedulerWorker *services.WorkflowSandboxSchedulerWorker
	if runtimeStores.WorkflowScheduler != nil && workflowSandboxClient != nil {
		workflowSandboxSchedulerWorker = services.NewWorkflowSandboxSchedulerWorker(
			runtimeStores.WorkflowScheduler,
			workflowSandboxClient,
			services.WithWorkflowSandboxSchedulerAPIBaseURL(agentAPIBaseURL),
			services.WithWorkflowSandboxSchedulerGitBaseURL(publicBaseURL),
			services.WithWorkflowSandboxSchedulerSecretInjector(secretInjector),
			// NixOS CI: a sandbox-plane run with a rendered job graph runs each job
			// in its own kind=vm guest, built by the same code a workspace uses.
			services.WithWorkflowSandboxSchedulerCIGuests(workspaceService),
			// Each CI job gets its own token for the /internal workflow cache
			// and artifact routes, deleted when the job ends (smithers#1768).
			services.WithWorkflowSandboxSchedulerCIJobCredentials(queries, publicBaseURL+"/internal"),
			// The run service settles the commit status, check run and
			// workflow_run webhook it announced when it created the run.
			services.WithWorkflowSandboxSchedulerTerminalPublisher(workflowRunTerminalPublisher),
		)
	}
	gitHubWebhookEventWorker := services.NewGitHubWebhookEventWorker(queries, workflowRunService)
	gitHubWebhookEventWorker.SetTextStamper(services.NewGitHubTextStamper(repoConnectionService))
	webhookWorker := webhook.NewWorker(
		queries,
		webhook.DefaultHTTPClient(),
		webhookSecretCodec,
		webhook.WithMetricsObserver(smithersMetrics),
	)
	authCleanupInterval, err := time.ParseDuration(cfg.Cleanup.AuthInterval)
	if err != nil {
		slog.Error("invalid cleanup.auth_interval", "interval", cfg.Cleanup.AuthInterval, "error", err)
		return err
	}
	smithersMetrics.MustRegister(cleanup.SweepFailures, middleware.AuthLoaderFailures, middleware.QuotaCounterErrors, middleware.HandlerPanics, lfsauth.Rejections)
	authCleaner := cleanup.NewAuthCleaner(queries, authCleanupInterval)
	authCleaner.SetRevocationPublisher(revocationPublisher)
	workflowCacheCleanupInterval, err := time.ParseDuration(cfg.Cleanup.WorkflowCacheInterval)
	if err != nil {
		slog.Error("invalid cleanup.workflow_cache_interval", "interval", cfg.Cleanup.WorkflowCacheInterval, "error", err)
		return err
	}
	workflowCacheCleaner := cleanup.NewWorkflowCacheCleaner(workflowCacheService, workflowCacheCleanupInterval)
	workflowArtifactCleaner := cleanup.NewWorkflowArtifactCleaner(workflowArtifactService, time.Hour, 250)

	auditCleaner := cleanup.NewAuditCleaner(queries, time.Hour, 90*24*time.Hour)
	webhookDeliveryCleaner := cleanup.NewWebhookDeliveryCleaner(queries, time.Hour, 30, 1000)
	workflowLogCleaner := cleanup.NewWorkflowLogCleaner(queries)

	workspaceCleaner := cleanup.NewWorkspaceCleaner(workspaceService, 5*time.Minute)
	repoSyncService := services.NewRepoSyncService("", repoConnectionService)
	// Smithers main follows GitHub main for `mirror: "pull"` repositories.
	gitHubMainPullService := services.NewGitHubMainPullService(queries, repoHostClient, repoConnectionService, repoConnectionService)
	gitHubSyncedRepoService.SetPullMirror(gitHubMainPullService.PullMirror)
	gitHubWebhookEventWorker.SetMainPull(gitHubMainPullService)
	// The mythical stack folds every main the pull brings in, admits every
	// issue, works it on lane workspaces and proposes it to GitHub.
	mythicalService := services.NewMythicalService(pool, repoHostClient)
	gitHubMainPullService.SetMainMoved(mythicalService.MainMoved)
	gitHubMainPullService.SetSynced(services.NewLandingGitHubMergeService(queries, repoHostClient, repoConnectionService, webhookDispatcher).Reconcile)
	gitHubWebhookEventWorker.SetMythical(mythicalService)
	mythicalService.SetWiki(wikiService)
	mythicalService.SetOrchestration(services.NewMythicalGitHub(queries, repoConnectionService, gitHubUserReposService, repoConnectionService),
		nil, services.NewWorkspaceMythicalLanes(workspaceService))
	userRefHandler := &routes.UserRefHandler{Service: services.NewUserRefService(repoHostClient, queries)}
	mythicalHandler := &routes.MythicalHandler{Service: mythicalService, Broker: sseBroker,
		MainHead: func(ctx context.Context, owner, repo, bookmark string) (string, error) {
			return mythicalService.MainHead(ctx, owner, repo, bookmark)
		}}
	gitMirrorSyncService := services.NewGitMirrorSyncService(queries, services.WithGitMirrorCredentials(queries, gitHubUserReposService, publicBaseURL, repoConnectionService),
		services.WithGitMirrorPullPolicy(gitHubMainPullService.PullPolicyRecorded))

	repoHandler := &routes.RepoHandler{
		Service:               repoService,
		RepoConnectionService: repoConnectionService,
		RepoSyncService:       repoSyncService,
		SSHHost:               cfg.Server.SSHHost,
		AuditService:          auditService,
	}
	mirrorSyncHandler := &routes.GitMirrorSyncHandler{Service: gitMirrorSyncService,
		MainPull: &routes.GitHubMainPullHandler{Service: gitHubMainPullService}}
	authHandler := &routes.AuthHandler{
		Service:      authService,
		AuthConfig:   cfg.Auth,
		PublicOrigin: publicBaseURL,
		AuditService: auditService,
		// Login is a free warm of the per-user GitHub repo listing cache.
		RepoListingWarmer: gitHubUserReposService,
	}
	if config.IsSingleOwner(cfg.Auth) {
		authHandler.LocalService = authService
	}
	userHandler := &routes.UserHandler{
		TokenService:   authService,
		ProfileService: userService,
		SessionService: authService,
		EmailService:   emailService,
		DeviceService:  userDeviceService,
		AuditService:   auditService,
	}
	sshKeyHandler := &routes.SSHKeyHandler{
		Service:      sshKeyService,
		AuditService: auditService,
	}
	deployKeyHandler := &routes.DeployKeyHandler{
		Service:      deployKeyService,
		AuditService: auditService,
	}
	labelHandler := &routes.LabelHandler{
		Service: labelService,
	}

	orgHandler := &routes.OrgHandler{
		Service:      orgService,
		AuditService: auditService,
		SSHHost:      cfg.Server.SSHHost,
	}
	landingHandler := &routes.LandingHandler{
		Service: landingService,
		// A send-upstream repository delivers a landing as a GitHub pull request.
		GitHubPull: services.NewLandingGitHubPullService(landingService, queries, repoConnectionService, gitHubUserReposService, publicBaseURL, repoConnectionService),
	}
	changesetHandler := &routes.ChangesetHandler{
		Service: changesetService,
	}
	buildCacheService := services.NewBuildCacheService(services.NewPgxBuildCacheStore(queries, pool), blobStore, cfg.Blob.BuildCacheArtifactMaxBytes)
	buildCacheService.MaxAge = time.Duration(cfg.Blob.BuildCacheMaxAgeDays) * 24 * time.Hour
	buildCacheService.MaxRepositoryBytes = cfg.Blob.BuildCacheRepoQuotaBytes
	buildCacheHandler := &routes.BuildCacheHandler{Service: buildCacheService}
	buildCacheCleaner := cleanup.NewPeriodic("build_cache", time.Minute, time.Minute)
	stackHandler := &routes.StackHandler{
		Service: stackService,
	}
	searchHandler := &routes.SearchHandler{
		Service: searchService,
	}
	issueHandler := &routes.IssueHandler{
		Service: issueService,
	}
	issueHandler.LinearLink = services.NewLinearIssueLinkService(queries, linearIntegrationSvc, linearClient)

	gitHandler := &routes.GitSmartHandler{
		Service: gitHTTPProxyService,
		Metrics: smithersMetrics,
	}
	notificationHandler := &routes.NotificationHandler{
		Service: notificationService,
		Broker:  sseBroker,
		Metrics: smithersMetrics,
	}

	adminUserHandler := &routes.AdminUserHandler{
		Service: adminUserService,
	}
	adminOrgHandler := &routes.AdminOrgHandler{
		Service: adminOrgService,
	}
	adminRepoHandler := &routes.AdminRepoHandler{
		Service: adminRepoService,
	}
	adminGitHubAppHandler := &routes.AdminGitHubAppHandler{
		Service: repoConnectionService,
	}
	adminAuditHandler := &routes.AdminAuditHandler{
		Queries: queries,
	}
	adminSystemHealthHandler := &routes.AdminSystemHealthHandler{DB: pool}
	adminAnalyticsHandler := &routes.AdminAnalyticsHandler{Service: services.NewAdminAnalyticsServiceWithPool(pool)}
	adminSystemStatusHandler := &routes.AdminSystemStatusHandler{
		Service: services.NewAdminSystemStatusService(services.AdminSystemStatusServiceConfig{
			DB: pool, Runtime: queries, SSE: sseBroker,
		}),
	}
	webhookHandler := &routes.WebhookHandler{
		Service: webhookService,
	}
	gitHubWebhookHandler := &routes.GitHubWebhookHandler{
		Service: services.NewGitHubWebhookService(pool, cfg.Webhook.GitHubAppSecret,
			services.WithGitHubWebhookSyncedRepos(gitHubSyncedRepoService)),
	}
	gitHubSyncedReposHandler := &routes.GitHubSyncedReposHandler{
		Service: gitHubSyncedRepoService,
	}
	providerConnectionHandler := &routes.ProviderConnectionHandler{Service: providerConnectionService,
		Pool: &routes.ProviderPoolHandler{Pool: providerConnectionService, Scopes: services.NewProviderPoolScopes(queries, pool, webhookSecretCodec), Uses: queries}}
	secretHandler := &routes.SecretHandler{
		Service:          secretService,
		AgentEnvironment: agentEnvironmentService,
	}
	variableHandler := &routes.VariableHandler{
		Service: variableService,
	}
	var billingHandler *routes.BillingHandler
	if billingCommerce != nil {
		billingHandler = &routes.BillingHandler{Service: billingCommerce}
	}
	protectedBookmarkHandler := &routes.ProtectedBookmarkHandler{
		Service: services.NewProtectedBookmarkService(queries),
	}
	commitStatusHandler := &routes.CommitStatusHandler{
		Service: commitStatusService,
	}
	lfsHandler := &routes.LFSHandler{
		Service: lfsService,
	}
	changeService := services.NewChangeService(
		queries,
		repoHostClient,
		pool,
		services.WithChangeConflictAgent(agentService),
	)
	changeRevertService := services.NewChangeRevertService(queries, repoHostClient, landingService, changesetService, changeService)
	changeOperationService := services.NewChangeOperationService(queries, repoHostClient, workspaceService, pool)
	jjVCSHandler := &routes.JJVCSHandler{
		RepoHost:           repoHostClient,
		RepoResolver:       queries,
		ChangeService:      changeService,
		FindingsService:    changeService,
		ConflictResolver:   changeService,
		ChangeReverter:     changeRevertService,
		ChangeSplitter:     changeService,
		ChangeOperations:   changeOperationService,
		WalkthroughService: changeService,
		Broker:             sseBroker,
		Metrics:            smithersMetrics,
		WebhookDispatcher:  webhookDispatcher,
	}
	agentInternalHandler := &routes.AgentInternalHandler{
		Service:      agentService,
		TokenQuerier: queries,
	}
	var egressAuditService *services.SandboxEgressAuditService
	if runtimeStores.EgressAudit != nil {
		egressAuditService = services.NewSandboxEgressAuditService(runtimeStores.EgressAudit)
	}
	agentSessionHandler := &routes.AgentSessionHandler{
		Service:     agentService,
		EgressAudit: egressAuditService,
	}
	// Ticket 0110: approvals flow handler. Feature-gated on
	// cfg.FeatureFlags.ApprovalsFlowEnabled; when the flag is off the
	// handler returns 404 without calling into the service.
	// Ticket 0134: wire the AuditService into ApprovalsService so every
	// create/decide transition emits an immutable audit row.
	approvalsService := services.NewApprovalsServiceWithAudit(queries, auditService)
	approvalsHandler := &routes.ApprovalsHandler{
		Service: approvalsService,
		Enabled: cfg.FeatureFlags.ApprovalsFlowEnabled,
	}
	branchJoinAuthorizer, ok := billingPolicy.(services.BranchLockJoinAuthorizer)
	if !ok {
		return errors.New("billing policy does not authorize branch-lock joins")
	}
	branchLockHandler := &routes.BranchLockHandler{
		Service: services.NewBranchLockService(
			queries,
			services.WithBranchLockJoinAuthorizer(branchJoinAuthorizer),
			services.WithBranchLockNotifier(notificationService),
		),
	}
	agentSessionStreamHandler := &routes.AgentSessionStreamHandler{
		Service: agentService,
		Broker:  sseBroker,
		Metrics: smithersMetrics,
	}
	workspaceHandler := &routes.WorkspaceHandler{
		Service:     workspaceService,
		EgressAudit: egressAuditService,
		Broker:      sseBroker,
		Metrics:     smithersMetrics,
		Desktop:     &routes.WorkspaceDesktopHandler{Service: workspaceService, RelayToken: cfg.Sandbox.PreviewRelayToken},
		// User previews are private: hosted preview redirects carry a ticket
		// signed with a key derived from the relay token the gateway holds.
		PreviewTickets: previewgateway.NewTickets(cfg.Sandbox.PreviewRelayToken),
	}
	if environmentImageService != nil {
		workspaceHandler.EnvironmentImages = &routes.SandboxEnvironmentImageHandler{Service: environmentImageService}
	}
	// RFD-004: agent runs execute in kind=agent workspaces.
	agentService.SetWorkspaceBackend(workspaceService)
	adminManageService := services.NewAdminManageService(queries, agentService, workspaceService)
	var deploymentAdminRoutes []ports.AdminRoute
	if options.AdminRoutes != nil && options.topology.servesHTTP() {
		deploymentAdminRoutes = options.AdminRoutes(services.NewAdminOperationLog(queries))
	}
	// The box's coding host calls repository jobs back with its flowhost
	// binding ID and control credential (#2198).
	repositoryJobService := services.NewRepositoryJobService(queries, services.NewFlowHostCallbacks(pool, queries), pool)
	gitHubMainPullService.SetFactoryReconciler(repositoryJobService.ReconcileFactoryRules)
	mythicalService.SetFactoryReconciler(repositoryJobService.ReconcileFactoryRules)
	repositoryJobService.SetGitHubReadAccess(gitHubUserReposService)
	repositoryJobService.SetOutsiderEgress(workspaceService)
	repositoryJobService.SetRepositoryPolicyReader(repoHostClient)
	mythicalService.SetPolicyReader(repoHostClient)
	repositorySetupService := services.NewRepositorySetupService(pool, repositoryJobService, workspaceService)
	// InvokeWorkflow runs a file flow through the same Flow dispatcher.
	invokedFlowService := services.NewInvokedFlowService(pool, repositoryJobService, workspaceService)
	invokedFlowService.SetSecretInjector(secretInjector)
	invokedFlowService.SetFlowSourceReader(repoHostClient)
	invokedFlowService.SetTerminalPublisher(workflowRunTerminalPublisher)
	if participant, ok := workflowRunService.(interface {
		SetCancelParticipant(services.WorkflowRunCancelParticipant)
	}); ok {
		participant.SetCancelParticipant(invokedFlowService)
	} else {
		return errors.New("workflow run service cannot cancel invoked Flow runs")
	}
	flow, err := newFlowComposition(options, cfg, pool, webhookSecretCodec, agentService, repositoryJobService, billingPolicy, mythicalService, workspaceService, invokedFlowService, repositorySetupService)
	if err != nil {
		return err
	}
	var workspaceCommandWorker *criticalWorker
	if options.topology.workers() && options.Workspace != nil && options.Workspace.Capabilities().Execution {
		workspaceCommandWorker = newCriticalWorker()
	}
	var messageDispatchWorker *criticalWorker
	if options.topology.workers() {
		messageDispatchWorker = newCriticalWorker()
	}
	var flowWorker *criticalWorker
	if flow != nil {
		agentService.SetFlowDispatcher(flow.dispatcher)
		repositoryJobService.SetFlowDispatcher(flow.dispatcher)
		repositorySetupService.SetFlowDispatcher(flow.dispatcher)
		invokedFlowService.SetFlowDispatcher(flow.dispatcher)
		mythicalService.SetLauncher(flow.dispatcher)
		if options.topology.workers() {
			flowWorker = newCriticalWorker()
		}
	}
	chatSizing, err := chatRuntimeOptions(cfg.Chat, options.topology.hosted(), slog.Default())
	if err != nil {
		return fmt.Errorf("initialize chat runtime: %w", err)
	}
	chatService, err := newChatComposition(options, pool, chatSizing)
	if err != nil {
		return fmt.Errorf("initialize chat runtime: %w", err)
	}
	if chatService != nil {
		smithersMetrics.MustRegister(chatService.runtime.Collectors()...)
		defer chatService.close()
		if closer, ok := options.ChatHost.(interface{ Close(context.Context) error }); ok {
			defer func() {
				closeCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
				defer cancel()
				runErr = errors.Join(runErr, closer.Close(closeCtx))
			}()
		}
	}
	var chatWorker, chatCallbackWorker *criticalWorker
	if chatService != nil {
		// Every instance with a ChatHost can recover accepted turns. Hosted API
		// replicas serve chat without requiring a separate worker deployment;
		// the PostgreSQL producer claim fences concurrent recovery candidates.
		chatWorker = newCriticalWorker()
		if chatService.server != nil {
			chatCallbackWorker = newCriticalWorker()
		}
	}
	workflowAPIService := services.NewWorkflowAPIService(queries, workflowRunService,
		services.WithWorkflowAPIBillingPolicy(billingPolicy), services.WithWorkflowAPIFlowInvoker(invokedFlowService))
	workspaceInternalHandler := &routes.WorkspaceInternalHandler{
		Service: workspaceService,
	}
	gitHubWebhookEventWorker.SetRepositoryJobs(repositoryJobService)
	repositoryJobHandler := &routes.RepositoryJobHandler{
		RepositoryJobs:  repositoryJobService,
		SourceRetention: services.NewRepositorySourceRetentionService(queries, repositoryJobService, gitHubImportService),
	}

	gitHubProxyHandler := &routes.GitHubProxyHandler{
		Service: services.NewGitHubProxyService(
			repoConnectionService,
			services.WithGitHubProxyBudgetTracker(gitHubBudgetTracker),
			services.WithGitHubProxyUserTokens(gitHubUserReposService),
		),
	}
	gitHubRepoListHandler := &routes.GitHubRepoListHandler{Service: gitHubRepoListService}
	gitHubUserReposHandler := &routes.GitHubUserReposHandler{Service: gitHubUserReposService}
	gitHubImportHandler := &routes.GitHubImportHandler{Service: gitHubImportService, Metrics: smithersMetrics}
	// Ticket 0132: per-user active-connection cap on terminal WebSockets,
	// with Prometheus hooks so operators can see current counts + rejects.
	// The ActiveCounter uses its scope string ("workspace_terminal_active")
	// as the "scope" label value for every rejection emission, so the
	// existing smithers_rate_limit_rejections_total CounterVec is shared
	// across all 429 sources.
	terminalActiveCounter := middleware.NewActiveCounter(
		"workspace_terminal_active",
		cfg.RateLimit.TerminalActiveMax,
		&middleware.ActiveCounterMetrics{
			Rejections: smithersMetrics.RateLimitRejectionsTotal,
			Gauge:      smithersMetrics.WorkspaceTerminalActiveConnections,
		},
	)
	workspaceTerminalHandler := &routes.WorkspaceTerminalHandler{
		Service:           workspaceService,
		Metrics:           smithersMetrics,
		AllowedOrigins:    apiAllowedOrigins(cfg),
		SessionCookieName: cfg.Auth.SessionCookieName,
		ActiveConnections: terminalActiveCounter,
	}
	telemetryHandler := &routes.TelemetryHandler{
		Metrics: smithersMetrics,
	}
	featureFlagHandler := &routes.FeatureFlagHandler{
		Config: cfg.FeatureFlags,
	}

	oauth2Service := services.NewOAuth2ServiceWithPool(queries, pool)
	// AlphaAccess checker is used by the OAuth2 authorize endpoint to gate
	// code issuance behind the closed-alpha whitelist (ticket 0106). When
	// the closed-alpha gate is disabled (Community Edition / open builds),
	// the handler passes any authenticated user through.
	var oauth2AlphaAccess routes.OAuth2AlphaAccessChecker
	if queries != nil && cfg.Auth.ClosedAlphaEnabled {
		oauth2AlphaAccess = services.NewAlphaAccessService(queries)
	}
	devAutoAuthorizeUserID := int64(0)
	if strings.EqualFold(os.Getenv("SMITHERS_ENABLE_E2E_TEST_ROUTES"), "true") {
		devAutoAuthorizeUserID = 1
	}
	oauth2UpstreamAuthorizePath := "/api/auth/github"
	// If GitHub isn't configured but Auth0 is, route the browser detour
	// through Auth0 so /api/oauth2/authorize still completes end-to-end.
	if githubClient == nil && auth0Configured {
		oauth2UpstreamAuthorizePath = "/api/auth/auth0/authorize"
	}
	oauth2Handler := &routes.OAuth2Handler{
		Service:                  oauth2Service,
		AuditService:             auditService,
		Metrics:                  smithersMetrics,
		CookieSecure:             cfg.Auth.CookieSecure,
		AlphaAccess:              oauth2AlphaAccess,
		DevAutoAuthorizeUserID:   devAutoAuthorizeUserID,
		DevAutoAuthorizeClientID: services.FirstPartyClientID,
		UpstreamAuthorizePath:    oauth2UpstreamAuthorizePath,
	}

	// Linear integration (multi-tenant sync engine embedded in Go API).
	var linearHandler *routes.LinearIntegrationHandler
	if linearEnabled {
		linearHandler = &routes.LinearIntegrationHandler{
			Service:        linearIntegrationSvc,
			Sync:           linearSyncSvc,
			SyncOperations: linearSyncSvc,
			AuthConfig:     routes.NewLinearAuthConfig(cfg.Auth.CookieSecure),
			Repos:          queries,
		}
		slog.Info("linear integration enabled")
	}

	searchIndexer := services.NewSearchIndexer(queries, repoHostClient, pool)
	pushHookHandler := &routes.InternalPushHookHandler{
		RepoResolver:   queries,
		Dispatcher:     webhookDispatcher,
		ConfigSync:     configSyncService,
		SearchIndex:    searchIndexer,
		ChangeRecorder: changeService,
		Events:         queries,
	}
	if cfg.FeatureFlags.Workflows {
		pushHookHandler.WorkflowSync = workflowSyncService
		pushHookHandler.WorkflowRun = workflowRunService
	}
	// The push callback only records the event; this worker runs its
	// webhooks, change sync, workflow runs and indexing with retries.
	repoPushEventWorker := services.NewRepoPushEventWorker(queries, pushHookHandler)
	workflowHandler := &routes.WorkflowHandler{
		Service: workflowAPIService,
	}
	workflowCacheHandler := &routes.WorkflowCacheHandler{
		Service: workflowCacheService,
	}
	workflowArtifactHandler := &routes.WorkflowArtifactHandler{
		Service: workflowArtifactService,
	}

	issueEventHandler := &routes.IssueEventHandler{
		Service: issueEventService,
		Broker:  sseBroker,
	}

	authService.SetRevocationPublisher(revocationPublisher)
	oauth2Service.SetRevocationPublisher(revocationPublisher)
	adminUserService.SetRevocationPublisher(revocationPublisher)
	orgService.SetRevocationPublisher(revocationPublisher)
	pairSessionService.SetRevocationPublisher(revocationPublisher)
	agentService.SetRevocationPublisher(revocationPublisher)
	repoService.SetRevocationPublisher(revocationPublisher)
	sshKeyService.SetRevocationPublisher(revocationPublisher)
	deployKeyService.SetRevocationPublisher(revocationPublisher)
	publicCatalog := routes.NewPublicRepositoryCatalog(queries)
	// Every platform-key model call is charged in the deployment's ledger,
	// so a first call creates the account with its signup grant.
	modelLedger := credits.Ledger{DB: pool}
	if options.Commerce != nil {
		modelLedger = options.Commerce.CreditLedger()
	}
	modelMeter := &modelproxy.Meter{Ledger: modelLedger, DailyCapNanos: modelDailyCap}
	var modelProxyHandler http.Handler
	if len(modelSeats) > 0 {
		callers := services.NewModelProxyCallers(queries, pool, webhookSecretCodec)
		if options.Commerce != nil {
			callers.PaidPlan = options.Commerce.OwnerHasPaidPlan
		}
		modelProxyHandler = &modelproxy.Handler{Meter: *modelMeter, Keys: options.PlatformModelKeys, Callers: callers, Upstreams: options.ModelProxyUpstreams}
	}
	var recommendationHandler *routes.RecommendationHandler
	recommender := options.Recommender
	if recommender == nil && options.PlatformModelKeys != nil {
		// Jev on the platform AI Gateway key, resolved per call.
		if jev, err := modelhost.NewJevRecommender(options.PlatformModelKeys, "", nil); err == nil {
			recommender = jev
		}
	}
	recommendationLog := options.RecommendationLog
	if recommender != nil && recommendationLog == nil {
		recommendationLog = routes.NewPostgresRecommendationLog(pool)
	}
	if recommender != nil && recommendationLog != nil {
		// A multitenant deployment pays for Jev and meters it; a single-owner
		// installation runs it on its owner's key.
		var recommendationMeter *modelproxy.Meter
		if options.topology.hosted() || options.PlatformModelKeys != nil {
			recommendationMeter = modelMeter
		}
		recommendationHandler = routes.NewRecommendationHandler(recommender, recommendationLog, recommendationMeter)
	}
	var modelStreamHandler *routes.ModelStreamHandler
	modelStreamHost := options.ModelStreamHost
	if modelStreamHost == nil {
		modelStreamHost, _ = options.ChatHost.(ports.ModelStreamHost)
	}
	if modelStreamHost != nil {
		modelStreamHandler = routes.NewModelStreamHandler(modelStreamHost)
	}
	router := buildRouter(
		cfg,
		queries,
		pool,
		repoHandler,
		mirrorSyncHandler,
		authHandler,
		userHandler,
		sshKeyHandler,
		deployKeyHandler,
		labelHandler,

		orgHandler,
		landingHandler,
		changesetHandler,
		buildCacheHandler,
		stackHandler,
		searchHandler,
		issueHandler,

		wikiService,
		gitHandler,
		notificationHandler,
		pairSessionHandler,

		adminUserHandler,
		adminOrgHandler,
		adminRepoHandler,
		adminGitHubAppHandler,
		adminAuditHandler,
		webhookHandler,
		secretHandler,
		providerConnectionHandler,
		variableHandler,
		billingHandler,
		protectedBookmarkHandler,
		commitStatusHandler,
		lfsHandler,
		jjVCSHandler,
		agentInternalHandler,
		agentSessionHandler,
		agentSessionStreamHandler,
		approvalsHandler,
		branchLockHandler,
		pushHookHandler,
		workflowHandler,
		workflowCacheHandler,
		workflowArtifactHandler,

		issueEventHandler,
		workspaceHandler,
		workspaceInternalHandler,
		repositoryJobHandler,
		gitHubProxyHandler,
		gitHubRepoListHandler,
		gitHubUserReposHandler,
		gitHubSyncedReposHandler,
		gitHubImportHandler,
		workspaceTerminalHandler,
		telemetryHandler,
		featureFlagHandler,
		oauth2Handler,
		linearHandler,
		gitHubWebhookHandler,
		smithersMetrics,
		routerExtras{CanaryRuns: options.CanaryRuns, Admission: billingPolicy, BillingCapabilities: billingCapabilities, Catalog: publicCatalog, Recommender: recommendationHandler, ModelStream: modelStreamHandler,
			Mythical: mythicalHandler, UserRefs: userRefHandler, ModelProxy: modelProxyHandler, AdminSystemStatus: adminSystemStatusHandler,
			AdminSystemHealth: adminSystemHealthHandler, AdminAnalytics: adminAnalyticsHandler,
			AdminAgentSessions: &routes.AdminAgentSessionHandler{Service: adminManageService},
			AdminWorkspaces:    &routes.AdminWorkspaceHandler{Service: adminManageService},
			AdminTokens:        &routes.AdminTokenHandler{Service: adminManageService},
			DeploymentAdmin:    deploymentAdminRoutes},
	)
	if flow != nil && options.topology.servesHTTP() {
		browser := &browserFlowAPI{registrationPool: pool, repos: repoService, queries: queries, dispatcher: flow.dispatcher, boxes: workspaceService,
			resumes: background.Jobs[string]{Timeout: 6 * time.Minute, FailureTTL: time.Minute},
			limit:   middleware.GlobalAPIRateLimit(queries)}
		mountBrowserFlow(router, cfg, queries, browser, &repositorySetupAPI{repos: repoService, setup: repositorySetupService})
	}
	if chatService != nil && options.topology.servesHTTP() {
		mountChatPublic(router, chatService.runtime, queries, cfg)
		mountChatProducerOnSharedListener(router, chatService)
		ownerModels := modelhost.OwnerModels{Pool: pool, Codec: webhookSecretCodec}
		if tester, ok := options.ChatHost.(modelhost.ModelTester); ok {
			ownerModels.Tester = tester
		}
		mountModelPublic(router, ownerModels, queries, cfg)
	}
	if root := strings.TrimSpace(os.Getenv("SMITHERS_WEB_ROOT")); root != "" {
		mode := webapp.SelfHosted
		if options.topology.hosted() {
			mode = webapp.Hosted
		}
		assets, err := webapp.New(root, mode)
		if err != nil {
			return fmt.Errorf("initialize browser assets: %w", err)
		}
		defer assets.Close()
		router.NotFound(assets.ServeHTTP)
	}
	var r http.Handler = withAppBootstrap(router, newAppBootstrap(bootstrapFeatures{
		role: options.topology, identity: authHandler != nil,
		agent:        options.ChatHost != nil && chatService != nil && options.topology.servesHTTP(),
		redirectAuth: strings.TrimSpace(cfg.Auth.GitHubClientID) != "" || strings.TrimSpace(cfg.Auth.Auth0ClientID) != "",
		github:       gitHubImportHandler != nil && strings.TrimSpace(cfg.Auth.GitHubClientID) != "",
		// A configured model turn is available only when the durable journal
		// routes are mounted; it does not imply a separate agent executor.
		modelTurn:        modelStreamHandler != nil && options.topology.servesHTTP(),
		recommend:        recommendationHandler != nil && options.topology.servesHTTP(),
		workspace:        options.Workspace != nil && options.topology.servesHTTP(),
		terminal:         options.Workspace != nil && options.topology.servesHTTP(),
		billingBalance:   billingCapabilities.Overview,
		billingOverview:  billingCapabilities.Overview,
		billingPlans:     billingCapabilities.Plans,
		billingPortal:    billingCapabilities.Portal,
		billingCheckout:  billingCapabilities.Checkout,
		workspaceRuntime: options.Workspace != nil,
		isolatedSandbox:  provider != nil || (options.Workspace != nil && options.Workspace.Isolation() == workspace.IsolationSandboxed),
	}), apiCORSOptions(cfg))
	// An in-process repository has no network health endpoint; a remote
	// client, whatever the identity mode, is probed at repo_host.url by the router.
	if options.Repository != nil && options.Repository.InProcess() {
		r = withLocalReadiness(r, pool, options.Repository)
	}
	r = mountBlobTransferHandler(r, transferStore, cfg)
	connectorHost, err := chatconnector.FromEnvironment(os.Getenv, os.Getenv("SMITHERS_DATA_ROOT"), cfg.Server.Addr)
	if err != nil {
		return err
	}
	var connectorWorker *criticalWorker
	if connectorHost != nil {
		if cfg.Auth.Mode != "selfhost" || !options.topology.workers() || !options.topology.servesHTTP() {
			return errors.New("environment chat connectors require the combined self-host backend")
		}
		connectorWorker = newCriticalWorker()
	}
	r = withCriticalWorkerReadiness(r, connectorWorker)
	r = withCriticalWorkerReadiness(r, workspaceCommandWorker)
	r = withCriticalWorkerReadiness(r, messageDispatchWorker)
	r = withCriticalWorkerReadiness(r, flowWorker)
	r = withCriticalWorkerReadiness(r, chatWorker)
	r = withCriticalWorkerReadiness(r, chatCallbackWorker)

	requestTracker := newInFlightRequestTracker()
	handler := requestTracker.Wrap(r)
	srv := buildHTTPServer(cfg, handler)

	if options.ReadyBindings != nil {
		options.ReadyBindings(operations.Bindings{
			Blobs:            blobStore,
			WorkflowsEnabled: cfg.FeatureFlags.Workflows, WorkersRunning: options.topology.workers(), HTTPEnabled: options.topology.servesHTTP(),
			Agents: agentService, Workspaces: workspaceService, Workflows: workflowRunService,
			CommitStatuses: commitStatusService, GitHubChecks: gitHubCheckRunService,
			GitHubInstallations: repoConnectionService, Secrets: secretInjector,
			Webhooks: webhookDispatcher, Metrics: smithersMetrics, Streams: sseBroker,
			Access: deploymentAccess(queries, cfg),
			HTTP: operations.HTTPSettings{Address: srv.Addr, ReadTimeout: srv.ReadTimeout,
				ReadHeaderTimeout: srv.ReadHeaderTimeout, WriteTimeout: srv.WriteTimeout,
				IdleTimeout: srv.IdleTimeout, ShutdownTimeout: shutdownTimeout},
		})
	}

	// Deployment collectors register after every product collector, so a
	// name collision is reported here rather than panicking a later
	// MustRegister, and before any worker can observe a metric.
	if err := smithersMetrics.Register(options.MetricsCollectors...); err != nil {
		return fmt.Errorf("register deployment metrics: %w", err)
	}
	var workerMetrics *workerMetricsServer
	if cfg.Observability.MetricsAddr != "" {
		workerMetrics, err = startWorkerMetricsServer(cfg.Observability.MetricsAddr, smithersMetrics)
		if err != nil {
			return err
		}
		// Shutdown drains it on the normal path; this covers startup failures.
		defer workerMetrics.Close()
	}

	// Start landing worker in a background goroutine.
	workerCtx, workerCancel := context.WithCancel(ctx)
	defer workerCancel()
	var connectorFailure <-chan error
	if connectorWorker != nil {
		connectorWorker.Start(workerCtx, "chat connectors", func(ctx context.Context) error {
			return connectorHost.Run(ctx, func(ctx context.Context, owner, repo, bootstrap string) (string, func(), error) {
				return issueService.IssueChatConnectorCredential(ctx, queries, owner, repo, bootstrap)
			})
		})
		connectorFailure = connectorWorker.Failed()
	}
	var workspaceCommandFailure <-chan error
	if workspaceCommandWorker != nil {
		workspaceCommandWorker.Start(workerCtx, "workspace commands", func(ctx context.Context) error {
			return workspaceService.RunWorkspaceCommandWorker(ctx, jobs.WorkerConfig{
				WorkerID: "workspace-command-" + uuid.NewString(), Capacity: 32, Lease: 2 * time.Minute, HeartbeatInterval: time.Second,
				PollInterval: 250 * time.Millisecond, RetryDelay: time.Second,
				OnError: func(err error) { slog.Error("workspace command failed", "error", err) },
			})
		})
		workspaceCommandFailure = workspaceCommandWorker.Failed()
	}
	var messageDispatchFailure <-chan error
	if messageDispatchWorker != nil {
		messageDispatchWorker.Start(workerCtx, "message dispatch", func(ctx context.Context) error {
			return agentService.RunMessageDispatchWorker(ctx, jobs.WorkerConfig{
				WorkerID: "agent-message-" + uuid.NewString(), Capacity: 4, Lease: 30 * time.Second,
				PollInterval: 250 * time.Millisecond, RetryDelay: time.Second,
				OnError: func(err error) { slog.Error("message dispatch failed", "error", err) },
			})
		})
		messageDispatchFailure = messageDispatchWorker.Failed()
	}
	var flowWorkerFailure <-chan error
	if flowWorker != nil {
		if err := flow.recover(ctx); err != nil {
			return err
		}
		flowWorker.Start(workerCtx, "Flow dispatch", func(ctx context.Context) error {
			return flow.dispatcher.RunWorker(ctx, jobs.WorkerConfig{
				WorkerID: "flow-" + uuid.NewString(), Capacity: 4, Lease: 30 * time.Second,
				PollInterval: 250 * time.Millisecond, RetryDelay: time.Second,
				RecoveryInterval: 10 * time.Second, RecoveryLimit: 100,
				OnError: func(err error) { slog.Error("Flow operation failed", "error", err) },
			})
		})
		flowWorkerFailure = flowWorker.Failed()
	}
	var chatWorkerFailure, chatCallbackFailure <-chan error
	if chatWorker != nil {
		chatWorker.Start(workerCtx, "chat dispatch", chatService.runtime.Run)
		chatWorkerFailure = chatWorker.Failed()
	}
	if chatCallbackWorker != nil {
		chatCallbackWorker.Start(workerCtx, "chat producer callbacks", func(context.Context) error {
			return chatService.server.Serve(chatService.listener)
		})
		chatCallbackFailure = chatCallbackWorker.Failed()
	}
	var joinedWorkers []*joinedBackgroundWorker
	launchWorker := func(run func()) {
		joinedWorkers = append(joinedWorkers, startJoinedBackgroundWorker(run))
	}
	if flowWorker != nil {
		launchWorker(func() { flow.maintainRetired(workerCtx) })
	}
	var wikiHistoryWorker *joinedBackgroundWorker
	if options.topology.workers() && cfg.FeatureFlags.Wiki {
		wikiHistoryWorker = startJoinedBackgroundWorker(func() { services.RunWikiHistory(workerCtx, pool, repoHostClient) })
	}
	if options.topology.workers() {
		// Re-drive workspaces and sessions a stopped process left pending.
		// Per-workspace advisory locks make every worker replica safe to run it.
		launchWorker(func() { workspaceService.RunProvisioningReconciler(workerCtx) })
		launchWorker(func() { landingWorker.Start(workerCtx) })
		launchWorker(func() {
			services.RunRuntimeMetricsCollector(workerCtx, queries, smithersMetrics, services.RuntimeMetricsInterval)
		})
		if cfg.FeatureFlags.SubscriptionConnections {
			launchWorker(func() { providerConnectionRefreshWorker.Start(workerCtx) })
		}
		launchWorker(func() { workflowLogBudgetBackfiller.Start(workerCtx) })
		// #2777: remove stored Claude subscription tokens on every start of
		// every deployment; #2206: flag the ChatGPT ones a hosted deployment
		// refuses, once per database. Both mark the workspaces built with them.
		launchWorker(func() {
			services.RunStoredSubscriptionTokenScan(workerCtx, pool, webhookSecretCodec, cfg.FeatureFlags.SubscriptionConnections)
		})
		// #2237: case variants of reserved refs that predate their refusal
		// block the canonical refs; the repair is idempotent.
		// #1866: then index repositories that predate push indexing or whose
		// first index failed; the watermark makes reruns no-ops. Repair runs
		// first so a legacy-cased default bookmark is not indexed as empty.
		launchWorker(func() {
			services.RunRefCaseCollisionRepair(workerCtx, queries, repoHostClient)
			services.RunCodeSearchBackfill(workerCtx, searchIndexer, services.CodeSearchBackfillInterval)
		})
	}
	var gitHubImportWorker *joinedBackgroundWorker
	if options.topology.workers() && (!options.topology.hosted() || provisioningEnforced) {
		gitHubImportWorker = startJoinedBackgroundWorker(func() {
			gitHubImportService.Start(workerCtx)
		})
	} else if options.topology.hosted() && options.topology.workers() {
		slog.Error("durable GitHub import worker is disabled until repository provisioning enforcement is enabled")
	}
	if options.topology.workers() {
		// The poll catches missed webhooks even where workflows are off.
		launchWorker(func() { gitHubMainPullService.Start(workerCtx) })
		launchWorker(func() { gitMirrorSyncService.StartRecovery(workerCtx) })
		launchWorker(func() { mythicalService.Start(workerCtx) })
	}
	if options.topology.workers() && cfg.FeatureFlags.Workflows {
		launchWorker(func() { cronSchedulerWorker.Start(workerCtx) })
		launchWorker(func() { gitHubWebhookEventWorker.Start(workerCtx) })
		launchWorker(func() { repositoryJobService.Start(workerCtx) })
		if workflowSandboxSchedulerWorker != nil {
			launchWorker(func() { workflowSandboxSchedulerWorker.Start(workerCtx) })
		}
	}
	if options.topology.workers() {
		launchWorker(func() { webhookWorker.Start(workerCtx) })
		launchWorker(func() { repoPushEventWorker.Start(workerCtx) })
	}
	// R3: the reconciliation backstop for the synced GitHub metadata store —
	// webhooks are hints; this sweep (oldest staleness first, adaptive
	// interval clamped 45s–8h, 14-strike hard fail) is the truth.
	if options.topology.workers() {
		if !options.topology.hosted() {
			launchWorker(func() { repositoryStorageReconciler.Start(workerCtx) })
		}
		launchWorker(func() { gitHubSyncedRepoService.StartReconciler(workerCtx) })
		launchWorker(func() { pairSessionService.StartStaleSweeper(workerCtx) })
		agentService.StartSessionReaper(workerCtx, time.Duration(cfg.Sandbox.AgentMaxRuntimeSecs)*time.Second)
		authCleaner.Start(workerCtx)
		buildCacheCleaner.Start(workerCtx, buildCacheService.Cleanup)
		workflowCacheCleaner.Start(workerCtx)
		workflowArtifactCleaner.Start(workerCtx)
		auditCleaner.Start(workerCtx)
		webhookDeliveryCleaner.Start(workerCtx)
		workflowLogCleaner.Start(workerCtx)
		workspaceCleaner.Start(workerCtx)
	}
	if options.topology.hosted() && options.topology.workers() {
		launchWorker(func() { repositoryStorageReconciler.Start(workerCtx) })
		launchWorker(func() { repositoryProvisioningReconciler.Start(workerCtx) })
	}
	if options.topology.workers() {
		if repoGatewayRetirement != nil {
			launchWorker(func() { repoGatewayRetirement.Run(workerCtx) })
		}
		if sandboxOrphanReaper != nil {
			launchWorker(func() { sandboxOrphanReaper.Start(workerCtx) })
		}
		if cfg.Sandbox.GoldenSnapshotsEnabled && goldenSnapshotService != nil {
			goldenSnapshotService.Start(workerCtx)
		}
	}

	// Reconcile github_app_installation_repositories from live installation
	// state on boot and then hourly. The table is otherwise written only by
	// webhook events, so pre-webhook installs and missed webhooks are repaired
	// only here. One worker per tick wins the advisory lock. Non-blocking so a
	// slow/failed GitHub round-trip never delays serving; no-ops cleanly when app
	// credentials are unconfigured.
	if options.topology.workers() {
		launchWorker(func() {
			repoConnectionService.StartGitHubAppInstallationReconciler(
				workerCtx,
				services.NewPgGitHubAppReconcileLocker(pool),
				services.GitHubAppInstallationReconcileInterval,
			)
		})
	}

	// Register signals before listening so the first SIGTERM is never lost.
	sigCh := make(chan os.Signal, 1)
	if !options.externalHTTP && options.topology.servesHTTP() {
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		defer signal.Stop(sigCh)
	}

	// Graceful shutdown
	shutdownDone := make(chan struct{})
	abortShutdown := make(chan struct{})
	var shutdownFailure error // synchronized by shutdownDone closing
	go func() {
		defer close(shutdownDone)
		var fatalWorkerErr error
		select {
		case <-sigCh:
		case <-ctx.Done():
		case <-abortShutdown:
		case fatalWorkerErr = <-connectorFailure:
		case fatalWorkerErr = <-workspaceCommandFailure:
		case fatalWorkerErr = <-messageDispatchFailure:
		case fatalWorkerErr = <-flowWorkerFailure:
		case fatalWorkerErr = <-chatWorkerFailure:
		case fatalWorkerErr = <-chatCallbackFailure:
		case fatalWorkerErr = <-workerMetrics.Failed():
		}
		if !options.externalHTTP && options.topology.servesHTTP() {
			signal.Stop(sigCh)
		}
		inFlightAtSIGTERM := requestTracker.BeginShutdown()
		slog.Info("shutting down", "shutdown_timeout", shutdownTimeout.String(), "in_flight_requests_at_sigterm", inFlightAtSIGTERM)
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		shutdownErr := errors.Join(fatalWorkerErr, srv.Shutdown(shutdownCtx))
		if drainErr := requestTracker.WaitForDrain(shutdownCtx); drainErr != nil {
			shutdownErr = errors.Join(shutdownErr, drainErr)
		}
		if linearDispatcher != nil {
			if err := linearDispatcher.Shutdown(shutdownCtx); err != nil {
				shutdownErr = errors.Join(shutdownErr, fmt.Errorf("Linear sync did not drain: %w", err))
			}
		}
		drained, killed, activeRemaining := requestTracker.Snapshot()

		// Keep background services alive while in-flight HTTP requests drain. A
		// request may still enqueue work or read from a service-owned stream; stopping
		// those dependencies before Shutdown returns makes otherwise drainable
		// requests fail during a rollout.
		poolStatsCancel()
		workerCancel()
		if chatService != nil && chatService.server != nil {
			if err := chatService.server.Shutdown(shutdownCtx); err != nil {
				_ = chatService.server.Close()
				shutdownErr = errors.Join(shutdownErr, fmt.Errorf("chat callback listener did not drain: %w", err))
			}
		}
		if flowWorker != nil {
			flowStopCtx, stopFlow := context.WithTimeout(context.Background(), shutdownTimeout)
			if err := flowWorker.Wait(flowStopCtx); err != nil && !errors.Is(err, fatalWorkerErr) {
				shutdownErr = errors.Join(shutdownErr, fmt.Errorf("Flow dispatch did not stop: %w", err))
			}
			stopFlow()
		}
		for name, worker := range map[string]*criticalWorker{"workspace commands": workspaceCommandWorker, "message dispatch": messageDispatchWorker, "chat connectors": connectorWorker, "chat dispatch": chatWorker, "chat producer callbacks": chatCallbackWorker} {
			if worker == nil {
				continue
			}
			workerStopCtx, stopWorker := context.WithTimeout(context.Background(), shutdownTimeout)
			if err := worker.Wait(workerStopCtx); err != nil && !errors.Is(err, fatalWorkerErr) {
				shutdownErr = errors.Join(shutdownErr, fmt.Errorf("%s did not stop: %w", name, err))
			}
			stopWorker()
		}
		if wikiHistoryWorker != nil {
			wikiShutdownCtx, cancelWikiShutdown := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
			if err := wikiHistoryWorker.Wait(wikiShutdownCtx); err != nil {
				slog.Error("wiki history worker shutdown timed out", "error", err)
			}
			cancelWikiShutdown()
		}
		if gitHubImportWorker != nil {
			// The HTTP drain may consume its whole deadline. Give the durable
			// worker its own bounded drain window so cancellation-triggered claim
			// release finishes before run returns and closes the shared DB pool.
			workerShutdownCtx, workerShutdownCancel := context.WithTimeout(context.Background(), shutdownTimeout)
			if err := gitHubImportWorker.Wait(workerShutdownCtx); err != nil {
				slog.Warn("durable GitHub import worker did not stop before shutdown deadline", "error", err)
			}
			workerShutdownCancel()
		}
		workerWaitCtx, stopWorkers := context.WithTimeout(context.Background(), shutdownTimeout)
		for _, worker := range joinedWorkers {
			if err := worker.Wait(workerWaitCtx); err != nil {
				shutdownErr = errors.Join(shutdownErr, fmt.Errorf("background worker did not stop: %w", err))
				break
			}
		}
		stopWorkers()
		if options.topology.workers() {
			authCleaner.Stop()
			buildCacheCleaner.Stop()
			buildCacheCleaner.Wait()
			workflowCacheCleaner.Stop()
			workflowArtifactCleaner.Stop()
			auditCleaner.Stop()
			webhookDeliveryCleaner.Stop()
			workflowLogCleaner.Stop()
			workspaceCleaner.Stop()
		}
		// Detached provisioning goroutines outlive the HTTP drain; join them
		// before run closes the shared pool.
		provisionDrainCtx, cancelProvisionDrain := context.WithTimeout(context.Background(), services.WorkspaceProvisioningDrainTimeout)
		if err := workspaceService.WaitForProvisioning(provisionDrainCtx); err != nil {
			slog.Error("workspace provisioning drain failed", "error", err)
		}
		cancelProvisionDrain()
		if goldenSnapshotService != nil {
			goldenSnapshotService.Stop()
		}
		// Keep exporting until the workers have stopped.
		metricsStopCtx, stopMetrics := context.WithTimeout(context.Background(), shutdownTimeout)
		shutdownErr = errors.Join(shutdownErr, workerMetrics.Shutdown(metricsStopCtx))
		stopMetrics()
		// Release the LISTEN connection before run closes the shared pool.
		stopRevocationBus()

		attrs := []any{
			"in_flight_requests_at_sigterm", inFlightAtSIGTERM,
			"drained", drained,
			"killed", killed,
			"active_remaining", activeRemaining,
			"shutdown_timeout", shutdownTimeout.String(),
		}
		if shutdownErr != nil {
			shutdownFailure = shutdownErr
			attrs = append(attrs, "error", shutdownErr)
			slog.Warn(fmt.Sprintf("in-flight requests at SIGTERM: %d, drained: %d, killed: %d", inFlightAtSIGTERM, drained, killed), attrs...)
			return
		}
		slog.Info(fmt.Sprintf("in-flight requests at SIGTERM: %d, drained: %d, killed: %d", inFlightAtSIGTERM, drained, killed), attrs...)
	}()
	if options.externalHTTP && options.BeforeShutdown != nil {
		defer func() { runErr = errors.Join(runErr, options.BeforeShutdown()) }()
	}
	if options.externalHTTP || !options.topology.servesHTTP() {
		if err := ctx.Err(); err != nil {
			<-shutdownDone
			return errors.Join(err, shutdownFailure)
		}
		if options.ready != nil {
			if options.topology.servesHTTP() {
				options.ready(handler)
			} else {
				options.ready(nil)
			}
		}
		<-shutdownDone
		return shutdownFailure
	}

	slog.Info("API server listening", "addr", cfg.Server.Addr)
	ln, err := netListen("tcp", srv.Addr)
	if err != nil {
		slog.Error("server error", "error", err)
		close(abortShutdown)
		<-shutdownDone
		return err
	}
	onListen(ln)
	if err := srv.Serve(ln); err != http.ErrServerClosed {
		slog.Error("server error", "error", err)
		close(abortShutdown)
		<-shutdownDone
		return err
	}
	<-shutdownDone
	return shutdownFailure
}

// revocationBusStopTimeout bounds how long shutdown waits for the revocation
// listener to release its pooled connection.
const revocationBusStopTimeout = 5 * time.Second

// stopRevocationListener cancels the revocation bus's LISTEN loop and waits,
// bounded by timeout, for it to exit and release its pooled connection. It is
// safe to call again from deferred cleanup after the signal shutdown path.
func stopRevocationListener(cancel context.CancelFunc, bus *revocation.Bus, timeout time.Duration) {
	cancel()
	select {
	case <-bus.Done():
	case <-time.After(timeout):
		slog.Warn("revocation bus did not stop before the shutdown deadline",
			"timeout", timeout.String())
	}
}

func validateProductionConfig(environment string, e2eTestRoutes bool) error {
	if strings.EqualFold(strings.TrimSpace(environment), "production") && e2eTestRoutes {
		return errors.New("SMITHERS_ENABLE_E2E_TEST_ROUTES must not be enabled in production")
	}
	return nil
}

// validateProductionBlobStore fails startup unless one durable adapter is
// configured. Local filesystem storage is the ordinary self-hosted default;
// Deployments with injected storage bypass this local-adapter validation.
func validateProductionBlobStore(environment string, cfg config.BlobConfig) error {
	if strings.EqualFold(strings.TrimSpace(environment), "production") &&
		strings.TrimSpace(cfg.DataDir) == "" {
		return fmt.Errorf("SMITHERS_BLOB_DATA_DIR or an injected blob adapter is required in production")
	}
	return nil
}
