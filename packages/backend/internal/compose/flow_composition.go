package compose

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/admission"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
	"github.com/smithersai/smithers/packages/backend/workspace"
)

type flowComposition struct {
	jobs       *jobs.Store
	dispatcher *flowdispatch.Service
	bindings   *flowhost.Store
	stopper    flowhost.RetirementStopper
}

func newFlowComposition(options runOptions, cfg *config.Config, pool *pgxpool.Pool, codec flowhost.SecretCodec, agents *services.AgentService, repositoryJobs *services.RepositoryJobService, policy admission.Policy, mythical *services.MythicalService, boxes boxHostPreparer, invoked *services.InvokedFlowService) (*flowComposition, error) {
	if options.FlowHostRegistry == nil {
		return nil, nil
	}
	if options.Workspace == nil {
		return nil, errors.New("Flow hosts require the shared workspace runtime")
	}
	// Refuse before consulting product state or creating a binding. The
	// control runtime runs packaged model code and never repository flows.
	launcher, err := flowhost.NewWorkspaceLauncher(options.Workspace, options.FlowHostConfig)
	if err != nil {
		return nil, fmt.Errorf("Flow workspace launcher: %w", err)
	}
	productAPIURL, err := flowHostProductAPIURL(options, cfg.Server.Addr)
	if err != nil {
		return nil, err
	}
	registry := options.FlowHostRegistry
	// Managed hosts reach platform models through the metered proxy with a
	// credential derived from their binding; the repository's owner pays.
	modelSeats := modelproxy.OfferedSeats(options.PlatformModelKeys)
	modelProxyURL := ""
	if len(modelSeats) > 0 {
		modelProxyURL = productAPIURL + modelproxy.Path
	}
	// With subscription connections allowed, managed coding hosts also
	// reach the account pool: the binding user's connected Codex (ChatGPT)
	// accounts and Anthropic API keys, per request. A Claude subscription is
	// never pooled (#2777).
	accountPoolURL := ""
	if cfg.FeatureFlags.SubscriptionConnections {
		accountPoolURL = productAPIURL + services.ProviderPoolPath
	}
	environment := codingHostEnvironment(options.topology)
	readyTimeout := time.Duration(0)
	if options.FlowHostConfig.AllowTrustedProcessForTests && options.Workspace.Isolation() == workspace.IsolationTrustedProcess {
		// Process integration fixtures own a local source publisher. The install
		// cannot enable this branch through an environment setting.
		helper := strings.TrimSpace(os.Getenv("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY"))
		if !filepath.IsAbs(helper) {
			return nil, errors.New("process Flow host tests require an absolute source helper")
		}
		environment = map[string]string{"SMITHERS_CODING_LOCAL_OWNER": "1", "SMITHERS_WORKSPACE_JJ_EXPORT_BINARY": helper}
		// This bundled Node fixture exceeded 30s readiness under concurrent
		// database/compiler load. Match the real fresh-box fixture's bound.
		readyTimeout = 2 * time.Minute
	}
	catalogs := []flowhost.Catalog{
		{
			Key: flowhost.CatalogCoding, Family: flowhost.CatalogCoding,
			Executable: registry.Coding.Executable, ArtifactDigest: registry.Coding.SHA256,
			ServiceName: "smithers-coding-host", ImplementationModel: strings.TrimSpace(cfg.Sandbox.WorkspaceCodingDefaultModel),
			ReadyTimeout:  readyTimeout,
			Environment:   environment,
			SystemFlows:   services.SystemFlows,
			ModelProxyURL: modelProxyURL, ModelSeats: modelSeats, AccountPoolURL: accountPoolURL,
		},
	}
	bindings, err := flowhost.NewStore(pool, codec)
	if err != nil {
		return nil, fmt.Errorf("Flow host bindings: %w", err)
	}
	agentTargets, err := services.NewAgentFlowHostTargetResolver(agents)
	if err != nil {
		return nil, fmt.Errorf("agent Flow host targets: %w", err)
	}
	repositoryJobTargets, err := services.NewRepositoryJobFlowHostTargetResolver(repositoryJobs)
	if err != nil {
		return nil, fmt.Errorf("repository job Flow host targets: %w", err)
	}
	additionalTargets := []flowhost.TargetResolver{browserFlowTarget{queries: db.New(pool)}}
	projectors := []flowdispatch.Projector{agents, repositoryJobs}
	targets := flowTargetResolver(agentTargets, repositoryJobTargets, additionalTargets...)
	if invoked != nil {
		targets = withInvokedFlowTargets(targets, invoked)
		projectors = append(projectors, invoked)
	}
	if mythical != nil {
		// Mythical stack lanes: every item launch is authorized against its
		// persisted item and stack.
		targets = withMythicalTargets(targets, services.NewMythicalFlowHostTargetResolver(mythical))
		projectors = append(projectors, mythical)
	}
	workspaceHosts, ok := launcher.(boxHostBase)
	if !ok {
		return nil, errors.New("Flow workspace launcher cannot resolve sources or stop hosts")
	}
	// Admission first: a refused start never touches the box.
	admitted, err := newAdmittedFlowLauncher(newBoxHostLauncher(workspaceHosts, boxes, invoked), db.New(pool), policy)
	if err != nil {
		return nil, err
	}
	launcher = admitted
	stopper, ok := launcher.(flowhost.RetirementStopper)
	if !ok {
		return nil, errors.New("Flow workspace launcher cannot stop retired hosts")
	}
	store, err := jobs.NewStore(pool)
	if err != nil {
		return nil, fmt.Errorf("Flow jobs: %w", err)
	}
	// A host upgrade waits for the runs pinned to the old host (plue#538).
	activeRuns := flowhost.ActiveRunsFunc(func(ctx context.Context, host flowhost.Binding) (bool, error) {
		return flowdispatch.HasPinnedLaunches(ctx, store, jobs.Scope{TenantID: host.TenantID, PrincipalID: host.PrincipalID},
			flowruntime.Identity{RuntimeArtifactDigest: host.RuntimeArtifactDigest, SourceRevision: host.SourceRevision})
	})
	var journals flowhost.Journals
	if address := strings.TrimSpace(cfg.Sandbox.FlowJournalPostgresURL); address != "" {
		postgres, err := flowhost.NewPostgresJournals(context.Background(), pool, address, flowhost.JournalKey(cfg.Webhook.SecretEncryptionKey))
		if err != nil {
			return nil, err
		}
		owner, ok := boxes.(interface{ SetFlowJournals(services.FlowJournals) })
		if !ok {
			return nil, errors.New("Flow journals need the workspace service to drop deleted workspaces' journals")
		}
		owner.SetFlowJournals(postgres)
		journals = postgres
	}
	resolver, err := flowhost.New(flowhost.Config{AllowTrustedProcessForTests: options.FlowHostConfig.AllowTrustedProcessForTests, Store: bindings, Targets: targets, Launcher: launcher, Catalogs: catalogs, ActiveRuns: activeRuns, Journals: journals})
	if err != nil {
		return nil, fmt.Errorf("Flow host resolver: %w", err)
	}
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Resolver: resolver, Projector: flowProjector(projectors...)})
	if err != nil {
		return nil, fmt.Errorf("Flow dispatcher: %w", err)
	}
	return &flowComposition{jobs: store, dispatcher: dispatcher, bindings: bindings, stopper: stopper}, nil
}

// codingHostEnvironment carries no model credential or provider origin in
// any topology: a host shares its workspace (and, in microVM mode, its guest
// user) with repository commands, so its model seats come only from the
// catalog's metered proxy with a per-binding credential (#2187).
func codingHostEnvironment(_ topology) map[string]string {
	return map[string]string{"SMITHERS_WORKSPACE_JJ_EXPORT_BINARY": services.WorkspaceJJExportGuestPath}
}

func (flow *flowComposition) recover(ctx context.Context) error {
	if _, err := flow.jobs.RecoverExpiredForOperations(ctx,
		[]string{flowdispatch.OperationLaunch, flowdispatch.OperationApprove, flowdispatch.OperationSignal}, 100); err != nil {
		return fmt.Errorf("recover Flow operations: %w", err)
	}
	if err := flow.bindings.ReconcileRetired(ctx, flow.stopper, 100); err != nil {
		return fmt.Errorf("retire Flow hosts: %w", err)
	}
	return nil
}

func flowTargetResolver(agents, repositoryJobs flowhost.TargetResolver, browserTargets ...flowhost.TargetResolver) flowhost.TargetResolver {
	return flowhost.TargetResolverFunc(func(ctx context.Context, target flowruntime.Target) (flowhost.Authority, error) {
		switch target.BindingKind {
		case "agent-session":
			return agents.ResolveFlowHostTarget(ctx, target)
		case "repository-job-dispatch":
			return repositoryJobs.ResolveFlowHostTarget(ctx, target)
		case "browser-flow":
			if len(browserTargets) >= 1 {
				return browserTargets[0].ResolveFlowHostTarget(ctx, target)
			}
			return flowhost.Authority{}, errors.New("browser Flow target unavailable")
		default:
			return flowhost.Authority{}, fmt.Errorf("unsupported Flow host binding kind %q", target.BindingKind)
		}
	})
}

func flowProjector(projectors ...flowdispatch.Projector) flowdispatch.Projector {
	return flowdispatch.ProjectorFunc(func(ctx context.Context, update flowdispatch.ProjectionUpdate) error {
		var failures []error
		for _, projector := range projectors {
			failures = append(failures, projector.ProjectFlowRuntime(ctx, update))
		}
		return errors.Join(failures...)
	})
}

func (flow *flowComposition) maintainRetired(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := flow.bindings.ReconcileRetired(ctx, flow.stopper, 100); err != nil && ctx.Err() == nil {
				slog.Error("retire Flow hosts", "error", err)
			}
		}
	}
}

func flowHostProductAPIURL(options runOptions, listenAddress string) (string, error) {
	if origin := strings.TrimRight(strings.TrimSpace(options.FlowHostProductAPIURL), "/"); origin != "" {
		parsed, err := url.Parse(origin)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" ||
			parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Path != "" {
			return "", errors.New("Flow host product API URL must be an HTTP origin")
		}
		return origin, nil
	}
	if options.topology.hosted() || options.externalHTTP {
		return "", errors.New("Flow hosts require a runtime-reachable product API URL")
	}
	_, port, err := net.SplitHostPort(listenAddress)
	if err != nil || port == "" || port == "0" {
		return "", errors.New("Flow hosts require a fixed local backend port")
	}
	return "http://" + net.JoinHostPort("127.0.0.1", port), nil
}

func withMythicalTargets(base, mythical flowhost.TargetResolver) flowhost.TargetResolver {
	return flowhost.TargetResolverFunc(func(ctx context.Context, target flowruntime.Target) (flowhost.Authority, error) {
		if target.BindingKind == "mythical-item" || target.BindingKind == "mythical-wiki" {
			return mythical.ResolveFlowHostTarget(ctx, target)
		}
		return base.ResolveFlowHostTarget(ctx, target)
	})
}

// withInvokedFlowTargets authorizes an invoked run's launch against its
// persisted invocation and the invoker's repository write access.
func withInvokedFlowTargets(base, invoked flowhost.TargetResolver) flowhost.TargetResolver {
	return flowhost.TargetResolverFunc(func(ctx context.Context, target flowruntime.Target) (flowhost.Authority, error) {
		if target.BindingKind == "workflow-invoke" {
			return invoked.ResolveFlowHostTarget(ctx, target)
		}
		return base.ResolveFlowHostTarget(ctx, target)
	})
}
