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

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
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
	pool       *pgxpool.Pool
	review     *reviewMachine
	jobs       *jobs.Store
	dispatcher *flowdispatch.Service
	bindings   *flowhost.Store
	stopper    flowhost.RetirementStopper
	archive    *runArchive
}

func newFlowComposition(options runOptions, cfg *config.Config, pool *pgxpool.Pool, codec flowhost.SecretCodec, agents *services.AgentService, repositoryJobs *services.RepositoryJobService, policy admission.Policy, mythical *services.MythicalService, boxes boxHostPreparer, invoked *services.InvokedFlowService, presence ...*branchPresence) (*flowComposition, error) {
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
	// On an install the proxy spends the install's own keys instead.
	proxyKeys, _ := options.proxyKeys()
	modelSeats := modelproxy.OfferedSeats(proxyKeys)
	modelProxyURL := ""
	if len(modelSeats) > 0 {
		modelProxyURL = productAPIURL + modelproxy.Path
	}
	// With subscription connections allowed, managed coding hosts also
	// reach the account pool: the binding user's connected Codex (ChatGPT)
	// accounts and Anthropic API keys, per request. A Claude subscription is
	// never pooled (#2777).
	accountPoolURL := codingHostAccountPoolURL(cfg, productAPIURL)
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
		// A fixture runtime that installs each box's source binding
		// publishes source as a guest does (PrepareBoxHost binds it).
		if _, binds := options.Workspace.(workspace.WorkspaceCodingBindingInstaller); binds {
			delete(environment, "SMITHERS_CODING_LOCAL_OWNER")
		}
		// This bundled Node fixture exceeded 30s readiness under concurrent
		// database/compiler load. Match the real fresh-box fixture's bound.
		readyTimeout = 2 * time.Minute
	}
	environment["SMITHERS_URL"] = productAPIURL
	environment["SMITHERS_PRODUCT_API_URL"] = productAPIURL
	catalogs := []flowhost.Catalog{
		{
			Key: flowhost.CatalogCoding, Family: flowhost.CatalogCoding,
			Executable: registry.Coding.Executable, ArtifactDigest: registry.Coding.SHA256,
			ServiceName: "smithers-coding-host", ImplementationModel: strings.TrimSpace(cfg.Sandbox.WorkspaceCodingDefaultModel),
			ReviewModel:   strings.TrimSpace(cfg.Sandbox.WorkspaceCodingReviewModel),
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
	if native, ok := options.Workspace.(interface {
		ProtectedManagedHostReady(context.Context, string) error
	}); ok {
		bindings.BindProtectedBranchHost(native.ProtectedManagedHostReady)
	}
	initialized, ok := boxes.(interface {
		FlowHostWorkspaceInitialized(context.Context, flowhost.Authority) error
	})
	if !ok {
		return nil, errors.New("Flow hosts require workspace initialization authority")
	}
	bindings.BindWorkspaceInitialized(initialized.FlowHostWorkspaceInitialized)

	agentTargets, err := services.NewAgentFlowHostTargetResolver(agents)
	if err != nil {
		return nil, fmt.Errorf("agent Flow host targets: %w", err)
	}
	repositoryJobTargets, err := services.NewRepositoryJobFlowHostTargetResolver(repositoryJobs)
	if err != nil {
		return nil, fmt.Errorf("repository job Flow host targets: %w", err)
	}
	browserTarget := browserFlowTarget{queries: db.New(pool)}
	if config.IsSingleOwner(cfg.Auth) {
		browserTarget.install = db.New(pool)
	}
	additionalTargets := []flowhost.TargetResolver{browserTarget}
	projectors := []flowdispatch.Projector{agents, repositoryJobs}
	maxObservationDelay := time.Duration(0)
	if len(presence) > 0 && presence[0] != nil {
		projectors = append(projectors, presence[0])
		maxObservationDelay = 10 * time.Second
	}
	targets := flowTargetResolver(agentTargets, repositoryJobTargets, additionalTargets...)
	if invoked != nil {
		targets = withInvokedFlowTargets(targets, invoked)
		projectors = append(projectors, invoked)
	}
	if mythical != nil {
		// Mythical stack lanes: every item launch is authorized against its
		// persisted item and stack.
		// flow-load runs on its own short-lived workspace after every main move.
		flowLoad := services.NewFlowLoadRuntime(mythical)
		targets = withLearningTargets(withMythicalTargets(targets, services.NewMythicalFlowHostTargetResolver(mythical), flowLoad), mythical.LearningRuntime())
		projectors = append(projectors, mythical, flowLoad, mythical.LearningRuntime())
	}
	// Every host starts through this one configuration, on every resolver.
	hosts := flowHostConfiguration{boxes: boxes, queries: db.New(pool), policy: policy}
	if invoked != nil {
		hosts.targets = invoked
	}
	if config.IsSingleOwner(cfg.Auth) && options.Repository != nil {
		hosts.codingProject = installCodingProject(pool, repositorySourceFiles{client: options.Repository})
		hosts.pinCodingModel = pinCodingHostModel(db.New(pool))
	}
	if _, ownerPaid := options.proxyKeys(); ownerPaid {
		// An install pins no coding model: its hosts run the coding role
		// Model access wrote, on the owner's key through the proxy.
		hosts.codingModel = ownerCodingSeat(db.New(pool), modelSeats)
	}
	admitted, err := hosts.launcher(launcher)
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
	// Both resolvers share this configuration. They differ only in the targets
	// they authorize and the runtime under their launcher.
	resolvers := flowhost.Config{Store: bindings, Catalogs: catalogs, ActiveRuns: activeRuns, Journals: journals}
	mainResolver := resolvers
	mainResolver.AllowTrustedProcessForTests, mainResolver.Targets, mainResolver.Launcher = options.FlowHostConfig.AllowTrustedProcessForTests, targets, launcher
	resolver, err := flowhost.New(mainResolver)
	if err != nil {
		return nil, fmt.Errorf("Flow host resolver: %w", err)
	}
	settlementPending := errors.New("native TODO settlement is pending")
	var settleTodo func(context.Context, int64, db.MythicalItem) error
	if owner, ok := boxes.(interface {
		SetFlowHostCapturePreparation(func(context.Context, string) error)
	}); ok {
		// A durable cancellation authorizes stopping that host. Final capture
		// still waits for StopFlowHost to confirm physical shutdown and for
		// the writer fence; upgrades keep counting cancelled, unsettled runs.
		// A held implementer on another machine cannot prevent its settled
		// reviewer from releasing a slot; each capture stops only its own host.
		captureRuns := flowhost.ActiveRunsFunc(func(ctx context.Context, host flowhost.Binding) (bool, error) {
			return flowdispatch.HasPinnedLaunches(ctx, store, jobs.Scope{TenantID: host.TenantID, PrincipalID: host.PrincipalID},
				flowruntime.Identity{RuntimeArtifactDigest: host.RuntimeArtifactDigest, SourceRevision: host.SourceRevision}, jobs.ActiveReceiptFilter{ExcludeCancelled: true, WorkspaceID: host.WorkspaceID})
		})
		owner.SetFlowHostCapturePreparation(func(ctx context.Context, id string) error {
			if err := bindings.PrepareWorkspaceCapture(ctx, id, stopper, captureRuns); err == nil {
				return nil
			} else {
				q := db.New(pool)
				lane, readErr := q.GetMythicalLane(ctx, id)
				if readErr != nil || lane.RetiredAt.Valid || settleTodo == nil {
					return err
				}
				item, readErr := q.GetMythicalItem(ctx, lane.ItemID)
				if readErr != nil || (item.State != "proposed" && item.State != "proposing" && item.State != "integrating" && item.State != "in_review") || item.Reason != "" || len(item.PendingOp) != 0 || item.RequestRunID == "" || !item.FlowDigest.Valid {
					return err
				}
				branch, branchErr := q.GetMythicalTodoBranchWorkspace(ctx, item)
				if branchErr != nil || branch.ID != id {
					return err
				}
				// Verification and review may occupy the current lane. Settlement
				// still addresses the original root on its canonical coding branch.
				item.WorkspaceID = id
				// CompleteRun accepts only a parked, completed module under this
				// exact attempt pin. It never cancels active work to permit Sleep.
				deadline, cancel := context.WithTimeout(ctx, 30*time.Second)
				defer cancel()
				for {
					if settleErr := settleTodo(deadline, item.RepositoryID, item); settleErr == nil {
						if err := bindings.PrepareWorkspaceCapture(deadline, id, stopper, captureRuns); err == nil {
							return nil
						}
					} else if !errors.Is(settleErr, settlementPending) {
						var transient flowruntime.Failure
						if !errors.As(settleErr, &transient) || !transient.FlowRuntimeRetryable() {
							return settleErr
						}
					}
					select {
					case <-deadline.Done():
						return deadline.Err()
					case <-time.After(100 * time.Millisecond):
					}
				}
			}
		})
	}
	// Each run stays readable after its machine stops: lifecycle pages retain
	// the live host's own answers for it (T-FLW-07).
	archive := &runArchive{pool: pool}
	// Capture the root before TODO settlement can launch verify/review and
	// replace its host binding. Retaining it afterwards races host retirement.
	projectors = append([]flowdispatch.Projector{archive}, projectors...)
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Resolver: installFlowResolver{resolver}, Projector: flowProjector(projectors...), MaxObservationDelay: maxObservationDelay, SteerAuthorizer: mythical, RelayPlans: relayPlanStore{db.New(pool)}})
	if err != nil {
		return nil, fmt.Errorf("Flow dispatcher: %w", err)
	}
	archive.host = dispatcher
	settleTodo = func(ctx context.Context, repository int64, item db.MythicalItem) error {
		itemID := uuid.UUID(item.ID.Bytes).String()
		monitors := &runMonitors{pool: pool, reader: dispatcher}
		checkpoints, err := monitors.checkpoints(ctx, repository, item.WorkspaceID+":"+item.RequestRunID)
		if err != nil {
			return err
		}
		if len(checkpoints) != 1 || checkpoints[0].FlowID != "todo" || checkpoints[0].ExecutionDigest != item.FlowDigest.String || checkpoints[0].Target.BindingID != itemID {
			return errors.New("TODO settlement has no bound native root")
		}
		cp := checkpoints[0]
		retained, err := readRunArchive(ctx, pool, repository, cp.Target.WorkspaceID, cp.RunID)
		if err == nil && (retained.Status == "completed" || retained.Status == "failed" || retained.Status == "cancelled") {
			return nil
		}
		if err := dispatcher.CompleteRun(ctx, cp.Target, cp.RunID, "todo-complete:"+itemID+":"+cp.RunID); err != nil {
			return err
		}
		return settlementPending
	}
	mythical.SetTodoRunSettlement(settleTodo)
	var review *reviewMachine
	reviewWorkspace := options.ReviewWorkspace
	if reviewWorkspace == nil {
		reviewWorkspace = options.Workspace
	}
	if config.IsSingleOwner(cfg.Auth) && reviewWorkspace.Isolation() == workspace.IsolationSandboxed {
		reviewHosts, err := flowhost.NewWorkspaceLauncher(reviewWorkspace)
		if err != nil {
			return nil, err
		}
		// A review host starts through the configuration every host does. Its
		// kind may not land, so it gets no publisher binding, write credential
		// or repository variable (#3612).
		reviewLauncher, err := hosts.launcher(reviewHosts)
		if err != nil {
			return nil, err
		}
		review = &reviewMachine{pool: pool, jobs: store, workspace: reviewWorkspace}
		reviewResolver := resolvers
		reviewResolver.Targets, reviewResolver.Launcher = review, reviewLauncher
		resolved, err := flowhost.New(reviewResolver)
		if err != nil {
			return nil, err
		}
		review.resolver, review.existing = resolved, resolved
		// The composition binds the read-only pinned source once the
		// repository source retention it needs exists (services.ReviewSource).
		// An absent source refuses in Prepare before machine allocation.
	}
	return &flowComposition{pool: pool, review: review, jobs: store, dispatcher: dispatcher, bindings: bindings, stopper: stopper, archive: archive}, nil
}

// relayPlanStore keeps the browser relay's plans in PostgreSQL, so a plan
// saved by one backend replica is known to every replica.
type relayPlanStore struct{ queries *db.Queries }

func (store relayPlanStore) SaveRelayPlan(ctx context.Context, target flowruntime.Target, planID, flowID string) error {
	if _, err := store.queries.PruneFlowRelayPlans(ctx); err != nil {
		return err
	}
	return store.queries.SaveFlowRelayPlan(ctx, db.SaveFlowRelayPlanParams{TenantID: target.TenantID, PrincipalID: target.PrincipalID,
		WorkspaceID: target.WorkspaceID, PlanID: planID, FlowID: flowID})
}

func (store relayPlanStore) RelayPlanFlow(ctx context.Context, target flowruntime.Target, planID string) (string, bool, error) {
	flowID, err := store.queries.GetFlowRelayPlan(ctx, db.GetFlowRelayPlanParams{TenantID: target.TenantID, PrincipalID: target.PrincipalID,
		WorkspaceID: target.WorkspaceID, PlanID: planID})
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	return flowID, err == nil, err
}

// codingHostEnvironment carries no model credential or provider origin in
// any topology: a host shares its workspace (and, in microVM mode, its guest
// user) with repository commands, so its model seats come only from the
// catalog's metered proxy with a per-binding credential (#2187).
func codingHostEnvironment(_ topology) map[string]string {
	return map[string]string{"SMITHERS_WORKSPACE_JJ_EXPORT_BINARY": services.WorkspaceJJExportGuestPath}
}

// The install checks the durable owner setting on each pool request, so
// changing it also applies to coding hosts that are already running.
func codingHostAccountPoolURL(cfg *config.Config, productAPIURL string) string {
	if config.IsSingleOwner(cfg.Auth) || cfg.FeatureFlags.SubscriptionConnections {
		return productAPIURL + services.ProviderPoolPath
	}
	return ""
}

func (flow *flowComposition) recover(ctx context.Context) error {
	if _, err := flow.jobs.RecoverExpiredForOperations(ctx,
		[]string{flowdispatch.OperationLaunch, flowdispatch.OperationApprove, flowdispatch.OperationSignal, flowdispatch.OperationSteer}, 100); err != nil {
		return fmt.Errorf("recover Flow operations: %w", err)
	}
	if err := flow.bindings.ReconcileRetired(ctx, flow.stopper, 100); err != nil {
		return fmt.Errorf("retire Flow hosts: %w", err)
	}
	return nil
}

// A run caller uses its parent's already-running coding host. It cannot wake
// a machine, start a replacement host or mint a child/person credential.
// Other producers retain their ordinary host lifecycle.
type installFlowResolver struct{ *flowhost.Resolver }

func (resolver installFlowResolver) ResolveFlowRuntime(ctx context.Context, target flowruntime.Target) (flowruntime.Runtime, error) {
	if target.BindingKind == services.InstallRunFlowBinding {
		return resolver.ResolveExistingFlowRuntime(ctx, target)
	}
	return resolver.Resolver.ResolveFlowRuntime(ctx, target)
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
		case "browser-flow", services.InstallRunFlowBinding, flowdispatch.DraftBindingKind:
			if len(browserTargets) >= 1 {
				return browserTargets[0].ResolveFlowHostTarget(ctx, target)
			}
			return flowhost.Authority{}, errors.New("browser Flow target unavailable")
		default:
			return flowhost.Authority{}, fmt.Errorf("unsupported Flow host binding kind %q", target.BindingKind)
		}
	})
}

// Retain both projection and installed failure certification when composing
// product consumers. A ProjectorFunc erases the optional certifier interface.
type composedFlowProjector struct{ projectors []flowdispatch.Projector }

func flowProjector(projectors ...flowdispatch.Projector) flowdispatch.Projector {
	return composedFlowProjector{projectors: projectors}
}

func (p composedFlowProjector) ProjectFlowRuntime(ctx context.Context, update flowdispatch.ProjectionUpdate) error {
	var failures []error
	for _, projector := range p.projectors {
		failures = append(failures, projector.ProjectFlowRuntime(ctx, update))
	}
	return errors.Join(failures...)
}

func (p composedFlowProjector) CertifyFlowFailure(ctx context.Context, update flowdispatch.ProjectionUpdate) (*flowdispatch.CertifiedMissingTool, error) {
	for _, projector := range p.projectors {
		if certifier, ok := projector.(flowdispatch.FailureCertifier); ok {
			receipt, err := certifier.CertifyFlowFailure(ctx, update)
			if err != nil || receipt != nil {
				return receipt, err
			}
		}
	}
	return nil, nil
}

var _ flowdispatch.FailureCertifier = composedFlowProjector{}

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

func withMythicalTargets(base, mythical, flowLoad flowhost.TargetResolver) flowhost.TargetResolver {
	return flowhost.TargetResolverFunc(func(ctx context.Context, target flowruntime.Target) (flowhost.Authority, error) {
		switch target.BindingKind {
		case "mythical-item", "mythical-wiki":
			return mythical.ResolveFlowHostTarget(ctx, target)
		case "flow-load":
			return flowLoad.ResolveFlowHostTarget(ctx, target)
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

func withLearningTargets(base, learning flowhost.TargetResolver) flowhost.TargetResolver {
	return flowhost.TargetResolverFunc(func(ctx context.Context, target flowruntime.Target) (flowhost.Authority, error) {
		if target.BindingKind == "learning" {
			return learning.ResolveFlowHostTarget(ctx, target)
		}
		return base.ResolveFlowHostTarget(ctx, target)
	})
}

func installFlowRuns(queries *db.Queries, flow *flowComposition) *services.InstallFlowRuns {
	if flow == nil {
		return nil
	}
	return &services.InstallFlowRuns{Pool: flow.pool, Queries: queries, Dispatcher: flow.dispatcher, Jobs: flow.jobs}
}
