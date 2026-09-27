package compose

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"os"
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
)

type flowComposition struct {
	jobs       *jobs.Store
	dispatcher *flowdispatch.Service
	bindings   *flowhost.Store
	stopper    flowhost.RetirementStopper
}

func newFlowComposition(options runOptions, cfg *config.Config, pool *pgxpool.Pool, codec flowhost.SecretCodec, agents *services.AgentService, repositoryJobs *services.RepositoryJobService, policy admission.Policy, mythical *services.MythicalService, setupServices ...*services.RepositorySetupService) (*flowComposition, error) {
	if options.FlowHostRegistry == nil {
		return nil, nil
	}
	if options.Workspace == nil {
		return nil, errors.New("Flow hosts require the shared workspace runtime")
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
	// With subscription connections allowed, managed hosts (coding runs,
	// the librarian) also reach the account pool: the binding user's
	// connected Claude and Codex accounts, per request.
	accountPoolURL := ""
	if cfg.FeatureFlags.SubscriptionConnections {
		accountPoolURL = productAPIURL + services.ProviderPoolPath
	}
	catalogs := []flowhost.Catalog{
		{
			Key: flowhost.CatalogCoding, Family: flowhost.CatalogCoding,
			Executable: registry.Coding.Executable, ArtifactDigest: registry.Coding.SHA256,
			ServiceName: "smithers-coding-host", ImplementationModel: strings.TrimSpace(cfg.Sandbox.WorkspaceCodingDefaultModel),
			Environment:   codingHostEnvironment(options.topology),
			ModelProxyURL: modelProxyURL, ModelSeats: modelSeats, AccountPoolURL: accountPoolURL,
		},
		{
			Key: flowhost.CatalogLibrarian, Family: flowhost.CatalogLibrarian,
			Executable: registry.Librarian.Executable, ArtifactDigest: registry.Librarian.SHA256,
			ServiceName: "smithers-librarian-host", ProductAPIURL: productAPIURL,
			ImplementationModel: strings.TrimSpace(os.Getenv("SMITHERS_LIBRARIAN_MODEL")),
			Environment:         librarianHostEnvironment(options.topology),
			ModelProxyURL:       modelProxyURL, ModelSeats: modelSeats, AccountPoolURL: accountPoolURL,
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
	if len(setupServices) == 1 {
		additionalTargets = append(additionalTargets, setupServices[0])
		projectors = append(projectors, setupServices[0])
	}
	targets := flowTargetResolver(agentTargets, repositoryJobTargets, additionalTargets...)
	if mythical != nil {
		// Mythical stack lanes: every item launch is authorized against its
		// persisted item and stack.
		targets = withMythicalTargets(targets, services.NewMythicalFlowHostTargetResolver(mythical))
		projectors = append(projectors, mythical)
	}
	launcher, err := flowhost.NewWorkspaceLauncher(options.Workspace)
	if err != nil {
		return nil, fmt.Errorf("Flow workspace launcher: %w", err)
	}
	admitted, err := newAdmittedFlowLauncher(launcher, db.New(pool), policy)
	if err != nil {
		return nil, err
	}
	launcher = admitted
	stopper, ok := launcher.(flowhost.RetirementStopper)
	if !ok {
		return nil, errors.New("Flow workspace launcher cannot stop retired hosts")
	}
	resolver, err := flowhost.New(flowhost.Config{Store: bindings, Targets: targets, Launcher: launcher, Catalogs: catalogs})
	if err != nil {
		return nil, fmt.Errorf("Flow host resolver: %w", err)
	}
	store, err := jobs.NewStore(pool)
	if err != nil {
		return nil, fmt.Errorf("Flow jobs: %w", err)
	}
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Resolver: resolver, Projector: flowProjector(projectors...)})
	if err != nil {
		return nil, fmt.Errorf("Flow dispatcher: %w", err)
	}
	return &flowComposition{jobs: store, dispatcher: dispatcher, bindings: bindings, stopper: stopper}, nil
}

func codingHostEnvironment(role topology) map[string]string {
	// A hosted host's model seats come from the catalog's model proxy.
	environment := make(map[string]string)
	for _, name := range []string{"SMITHERS_WORKSPACE_JJ_EXPORT_BINARY", "SMITHERS_JJ_PATH"} {
		if value := strings.TrimSpace(os.Getenv(name)); value != "" {
			environment[name] = value
		}
	}
	if !role.hosted() {
		environment["SMITHERS_CODING_LOCAL_OWNER"] = "1"
		for _, name := range []string{"OPENAI_API_KEY", "AI_GATEWAY_API_KEY", "SMITHERS_OPENAI_COMPATIBLE_BASE_URL", "SMITHERS_EVALUATOR_BASE_URL"} {
			if value := strings.TrimSpace(os.Getenv(name)); value != "" {
				environment[name] = value
			}
		}
	}
	return environment
}

func librarianHostEnvironment(role topology) map[string]string {
	environment := make(map[string]string)
	if !role.hosted() {
		for _, name := range []string{"AI_GATEWAY_API_KEY", "SMITHERS_EVALUATOR_BASE_URL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"} {
			if value := strings.TrimSpace(os.Getenv(name)); value != "" {
				environment[name] = value
			}
		}
	}
	return environment
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
		case "repository-setup":
			if len(browserTargets) == 2 {
				return browserTargets[1].ResolveFlowHostTarget(ctx, target)
			}
			return flowhost.Authority{}, errors.New("repository setup Flow target unavailable")
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
