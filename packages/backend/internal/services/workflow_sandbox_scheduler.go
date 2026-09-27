package services

import (
	"context"
	"encoding/json"
	stdErrors "errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/runtimeports"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
)

const (
	defaultWorkflowSandboxSchedulerInterval = 5 * time.Second
	defaultWorkflowSandboxSchedulerClaim    = int32(5)

	defaultWorkflowSandboxVCPUCount = int32(2)
	defaultWorkflowSandboxMemoryMB  = int32(4096)
	defaultWorkflowSandboxRootfsMB  = int64(2048)
	defaultWorkflowSandboxTimeout   = 10 * time.Minute
	maxWorkflowSandboxTimeout       = 30 * time.Minute
	workflowSandboxFinalizeTimeout  = 15 * time.Second
	// Claims expire after two minutes in SQL. Refresh every 30 seconds so a
	// healthy worker has several chances to renew through a transient database
	// error, while a crashed worker becomes reclaimable promptly.
	workflowSandboxClaimHeartbeatInterval = 30 * time.Second
	// Stop accepting work slightly before the database lease expires. This
	// absorbs ordinary clock skew and response latency so a replacement worker
	// cannot reclaim the row while the previous sandbox is still executing.
	workflowSandboxClaimExpirySafetyMargin = 5 * time.Second
	// workflowSandboxDeleteTimeout bounds the best-effort VM teardown so a hung
	// sandbox provider DeleteSandbox cannot block the delete goroutine forever.
	workflowSandboxDeleteTimeout = 30 * time.Second
	// workflowSandboxIdleTimeoutSeconds is a leak backstop: if the scheduler pod
	// crashes between CreateSandbox and the deferred DeleteSandbox, sandbox provider reclaims the
	// idle VM on its own. It sits safely ABOVE maxWorkflowSandboxTimeout so it can
	// never reap a run that is still within its own execution budget.
	workflowSandboxIdleTimeoutSeconds = int64((maxWorkflowSandboxTimeout + 10*time.Minute) / time.Second)
	defaultWorkflowSandboxService     = "smithers-workflow"
	defaultWorkflowSandboxWorkdir     = "/workspace/repo"
	defaultWorkflowSandboxRunnerSH    = "/opt/smithers/run-workflow.sh"
)

var defaultWorkflowSandboxPackages = []string{"git", "curl", "jj", "nodejs_26"}
var defaultWorkflowSandboxRegistries = []string{
	"registry.npmjs.org",
	"registry.yarnpkg.com",
	"pypi.org",
	"files.pythonhosted.org",
}

// WorkflowSandboxSchedulerQuerier is the DB contract needed by the sandbox scheduler.
type WorkflowSandboxSchedulerQuerier interface {
	ClaimQueuedWorkflowRuns(ctx context.Context, limitCount int32) ([]runtimeports.ClaimQueuedWorkflowRunsRow, error)
	RenewWorkflowSandboxClaim(ctx context.Context, arg runtimeports.RenewWorkflowSandboxClaimParams) (pgtype.Timestamptz, error)
	MarkWorkflowRunSuccess(ctx context.Context, arg runtimeports.MarkWorkflowRunSuccessParams) (db.WorkflowRun, error)
	MarkWorkflowRunFailure(ctx context.Context, arg runtimeports.MarkWorkflowRunFailureParams) (db.WorkflowRun, error)
	// ResumeWorkflowRun flips a cancelled/failure run back to queued. The
	// scheduler uses it only to requeue a run whose sandbox create was
	// refused for fleet capacity; terminal semantics are unchanged otherwise.
	ResumeWorkflowRun(ctx context.Context, id int64) error

	GetWorkflowDefinition(ctx context.Context, arg db.GetWorkflowDefinitionParams) (db.WorkflowDefinition, error)
	GetRepoByID(ctx context.Context, id int64) (db.Repository, error)
	GetUserByID(ctx context.Context, id int64) (db.User, error)
	GetOrgByID(ctx context.Context, id int64) (db.Organization, error)
	GetOrgCredentialOwnerID(ctx context.Context, organizationID int64) (int64, error)

	CancelWorkflowTasks(ctx context.Context, workflowRunID int64) error

	ListWorkflowStepsByRunID(ctx context.Context, runID int64) ([]db.WorkflowStep, error)
	// NixOS CI plane: a sandbox-plane run that carries a rendered job graph
	// runs each job in its own kind=vm guest (see workflow_nix_ci.go).
	ListTaskStepInfoForRun(ctx context.Context, workflowRunID int64) ([]db.ListTaskStepInfoForRunRow, error)
	GetWorkflowTask(ctx context.Context, arg db.GetWorkflowTaskParams) (db.WorkflowTask, error)
	MarkWorkflowTaskVMRunning(ctx context.Context, arg db.MarkWorkflowTaskVMRunningParams) (int64, error)
	MarkWorkflowTaskTerminalByID(ctx context.Context, arg db.MarkWorkflowTaskTerminalByIDParams) (int64, error)
	UnblockWorkflowTask(ctx context.Context, id int64) error
	SkipBlockedWorkflowTask(ctx context.Context, id int64) error
	CreateWorkflowStep(ctx context.Context, arg db.CreateWorkflowStepParams) (db.WorkflowStep, error)
	UpdateWorkflowStepStatusRunning(ctx context.Context, stepID int64) (int64, error)
	UpdateWorkflowStepStatusTerminal(ctx context.Context, arg db.UpdateWorkflowStepStatusTerminalParams) (int64, error)

	InsertWorkflowRunLogNextSequence(ctx context.Context, arg db.InsertWorkflowRunLogNextSequenceParams) (db.InsertWorkflowRunLogNextSequenceRow, error)
	NotifyWorkflowRunLog(ctx context.Context, arg db.NotifyWorkflowRunLogParams) error
	NotifyWorkflowRunEvent(ctx context.Context, arg db.NotifyWorkflowRunEventParams) error

	CreateAccessToken(ctx context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error)
	DeleteAccessToken(ctx context.Context, arg db.DeleteAccessTokenParams) error
	UpdateWorkflowRunJJHubTokenID(ctx context.Context, arg db.UpdateWorkflowRunJJHubTokenIDParams) error
	ClearWorkflowRunJJHubTokenID(ctx context.Context, id int64) error
}

// WorkflowSandboxVMClient is the minimal sandbox provider API surface for run execution.
type WorkflowSandboxVMClient interface {
	CreateSandbox(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error)
	Execute(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error)
	DeleteSandbox(ctx context.Context, vmID string) error
}

type WorkflowSandboxSchedulerOption func(*WorkflowSandboxSchedulerWorker)

// WorkflowSandboxSchedulerWorker claims queued sandbox-plane workflow runs
// (workflow_runs.execution_plane = 'sandbox') and executes them whole inside
// sandbox provider VMs. ClaimQueuedWorkflowRuns enforces the plane filter
// atomically, so runner-plane CI runs and agent-plane runs are never claimed
// here even while their tasks sit pending for the gVisor runner.
type WorkflowSandboxSchedulerWorker struct {
	queries  WorkflowSandboxSchedulerQuerier
	sandbox  WorkflowSandboxVMClient
	logger   *slog.Logger
	interval time.Duration
	limit    int32

	timeout         time.Duration
	finalizeTimeout time.Duration
	claimHeartbeat  time.Duration
	vcpuCount       int32
	memoryMB        int32
	rootfsSizeMB    int64

	apiBaseURL      string
	gitBaseURL      string
	secretInjector  *SecretInjector
	allowedRegistry []string
	apiGatewayURL   string

	// ciGuests builds the kind=vm NixOS guest request for a CI task. Unset,
	// every sandbox-plane run falls back to the whole-workflow orchestrator VM.
	ciGuests WorkflowCIGuestProvisioner
	// ciPollInterval is the live-log flush cadence for NixOS CI guests.
	ciPollInterval time.Duration
	// ciJobCredentials mints each NixOS CI job's cache/artifact token, and
	// ciInternalBaseURL is where the guest reaches the /internal routes.
	ciJobCredentials  WorkflowCIJobCredentialStore
	ciInternalBaseURL string

	// terminalPublisher settles the commit status, check run and workflow_run
	// webhook the run announced at creation, and fires downstream triggers.
	terminalPublisher WorkflowRunTerminalPublisher
}

func WithWorkflowSandboxSchedulerLogger(logger *slog.Logger) WorkflowSandboxSchedulerOption {
	return func(w *WorkflowSandboxSchedulerWorker) {
		if logger != nil {
			w.logger = logger
		}
	}
}

func WithWorkflowSandboxSchedulerAPIBaseURL(apiBaseURL string) WorkflowSandboxSchedulerOption {
	return func(w *WorkflowSandboxSchedulerWorker) {
		w.apiBaseURL = strings.TrimSpace(apiBaseURL)
	}
}

func WithWorkflowSandboxSchedulerGitBaseURL(gitBaseURL string) WorkflowSandboxSchedulerOption {
	return func(w *WorkflowSandboxSchedulerWorker) {
		w.gitBaseURL = strings.TrimSpace(gitBaseURL)
	}
}

// WithWorkflowSandboxSchedulerCIPollInterval overrides the NixOS CI live-log
// flush cadence. Production keeps nixCIPollInterval, which mirrors the runner's
// LOG_FLUSH_INTERVAL_MS; tests shorten it so a job's log order is observable
// without waiting on wall clock.
func WithWorkflowSandboxSchedulerCIPollInterval(interval time.Duration) WorkflowSandboxSchedulerOption {
	return func(w *WorkflowSandboxSchedulerWorker) {
		if interval > 0 {
			w.ciPollInterval = interval
		}
	}
}

// WithWorkflowSandboxSchedulerCIGuests wires the NixOS CI guest provisioner.
// WorkspaceService supplies it, so a CI task guest and a kind=vm workspace are
// built by the same code from the same closure image.
func WithWorkflowSandboxSchedulerCIGuests(provisioner WorkflowCIGuestProvisioner) WorkflowSandboxSchedulerOption {
	return func(w *WorkflowSandboxSchedulerWorker) {
		w.ciGuests = provisioner
	}
}

// WithWorkflowSandboxSchedulerTerminalPublisher wires the publisher that every
// won terminal transition calls. The workflow run service supplies it, so a
// run's external announcements are settled by the service that made them.
func WithWorkflowSandboxSchedulerTerminalPublisher(publisher WorkflowRunTerminalPublisher) WorkflowSandboxSchedulerOption {
	return func(w *WorkflowSandboxSchedulerWorker) {
		w.terminalPublisher = publisher
	}
}

func WithWorkflowSandboxSchedulerSecretInjector(injector *SecretInjector) WorkflowSandboxSchedulerOption {
	return func(w *WorkflowSandboxSchedulerWorker) {
		w.secretInjector = injector
	}
}

func NewWorkflowSandboxSchedulerWorker(
	queries WorkflowSandboxSchedulerQuerier,
	sandboxClient WorkflowSandboxVMClient,
	opts ...WorkflowSandboxSchedulerOption,
) *WorkflowSandboxSchedulerWorker {
	worker := &WorkflowSandboxSchedulerWorker{
		queries:         queries,
		sandbox:         sandboxClient,
		logger:          slog.Default(),
		interval:        envDuration("SMITHERS_WORKFLOW_SANDBOX_POLL_INTERVAL", defaultWorkflowSandboxSchedulerInterval),
		limit:           envInt32("SMITHERS_WORKFLOW_SANDBOX_CLAIM_LIMIT", defaultWorkflowSandboxSchedulerClaim),
		timeout:         clampWorkflowSandboxTimeout(envDuration("SMITHERS_WORKFLOW_SANDBOX_TIMEOUT", defaultWorkflowSandboxTimeout)),
		finalizeTimeout: workflowSandboxFinalizeTimeout,
		claimHeartbeat:  workflowSandboxClaimHeartbeatInterval,
		vcpuCount:       envInt32("SMITHERS_WORKFLOW_SANDBOX_VCPU_COUNT", defaultWorkflowSandboxVCPUCount),
		memoryMB:        envInt32("SMITHERS_WORKFLOW_SANDBOX_MEMORY_MB", defaultWorkflowSandboxMemoryMB),
		rootfsSizeMB:    envInt64("SMITHERS_WORKFLOW_SANDBOX_DISK_MB", defaultWorkflowSandboxRootfsMB),
		allowedRegistry: parseWorkflowSandboxRegistries(os.Getenv("SMITHERS_WORKFLOW_SANDBOX_ALLOWED_REGISTRIES")),
		apiGatewayURL:   strings.TrimSpace(os.Getenv("SMITHERS_WORKFLOW_SANDBOX_API_GATEWAY_URL")),
		ciPollInterval:  nixCIPollInterval,
	}

	for _, opt := range opts {
		if opt != nil {
			opt(worker)
		}
	}

	if worker.timeout <= 0 {
		worker.timeout = defaultWorkflowSandboxTimeout
	}
	if worker.vcpuCount <= 0 {
		worker.vcpuCount = defaultWorkflowSandboxVCPUCount
	}
	if worker.memoryMB <= 0 {
		worker.memoryMB = defaultWorkflowSandboxMemoryMB
	}
	if worker.rootfsSizeMB <= 0 {
		worker.rootfsSizeMB = defaultWorkflowSandboxRootfsMB
	}
	if worker.limit <= 0 {
		worker.limit = defaultWorkflowSandboxSchedulerClaim
	}
	if worker.interval <= 0 {
		worker.interval = defaultWorkflowSandboxSchedulerInterval
	}

	return worker
}

// workflowSandboxRunClaim couples the workflow data needed for execution with
// the durable ownership generation required by every terminal write.
type workflowSandboxRunClaim struct {
	Run            db.WorkflowRun
	Token          string
	Generation     int64
	LeaseExpiresAt time.Time
}

func workflowSandboxRunClaimFromRow(row runtimeports.ClaimQueuedWorkflowRunsRow) workflowSandboxRunClaim {
	return workflowSandboxRunClaim{
		Run: db.WorkflowRun{
			ID:                   row.ID,
			RepositoryID:         row.RepositoryID,
			WorkflowDefinitionID: row.WorkflowDefinitionID,
			TriggerRef:           row.TriggerRef,
			TriggerCommitSha:     row.TriggerCommitSha,
			TriggerEvent:         row.TriggerEvent,
		},
		Token:          UUIDString(row.ClaimToken),
		Generation:     row.ClaimGeneration,
		LeaseExpiresAt: row.ClaimLeaseExpiresAt.Time,
	}
}

func (claim workflowSandboxRunClaim) successParams() runtimeports.MarkWorkflowRunSuccessParams {
	return runtimeports.MarkWorkflowRunSuccessParams{
		ID: claim.Run.ID, ClaimToken: claim.Token, ClaimGeneration: claim.Generation,
	}
}

func (claim workflowSandboxRunClaim) failureParams() runtimeports.MarkWorkflowRunFailureParams {
	return runtimeports.MarkWorkflowRunFailureParams{
		ID: claim.Run.ID, ClaimToken: claim.Token, ClaimGeneration: claim.Generation,
	}
}

func (claim workflowSandboxRunClaim) renewalParams() runtimeports.RenewWorkflowSandboxClaimParams {
	return runtimeports.RenewWorkflowSandboxClaimParams{
		ID: claim.Run.ID, ClaimToken: claim.Token, ClaimGeneration: claim.Generation,
	}
}

// Start runs the scheduler loop until the context is cancelled. Each poll is
// recovered individually so a panic in one iteration becomes a logged error
// instead of permanently stopping the scheduler goroutine. Shutdown is
// decided solely by the scheduler's own context (ctx.Err()), never by
// inspecting the poll error's identity: pgx/pgconn wraps transient DB
// connect timeouts as context.DeadlineExceeded, and a live parent ctx (no
// deadline of its own) must not let that transient error be mistaken for a
// shutdown signal and permanently stop the loop.
func (w *WorkflowSandboxSchedulerWorker) Start(ctx context.Context) {
	w.logger.Info("workflow sandbox scheduler started", "interval", w.interval, "limit", w.limit)

	for {
		if err := w.pollOnceRecovering(ctx); err != nil {
			if ctx.Err() != nil {
				w.logger.Info("workflow sandbox scheduler stopping", "reason", err)
				return
			}
			w.logger.Error("workflow sandbox scheduler poll failed", "error", err)
		}

		select {
		case <-ctx.Done():
			w.logger.Info("workflow sandbox scheduler stopped")
			return
		case <-time.After(w.interval):
		}
	}
}

// PollOnce claims queued workflow runs and executes each in an ephemeral sandbox provider VM.
func (w *WorkflowSandboxSchedulerWorker) PollOnce(ctx context.Context) error {
	if w.queries == nil {
		return fmt.Errorf("workflow sandbox scheduler store unavailable")
	}
	if w.sandbox == nil {
		return fmt.Errorf("workflow sandbox scheduler sandbox provider unavailable")
	}

	rows, err := w.queries.ClaimQueuedWorkflowRuns(ctx, w.limit)
	if err != nil {
		return err
	}
	claims := make([]workflowSandboxRunClaim, 0, len(rows))
	for _, row := range rows {
		claim := workflowSandboxRunClaimFromRow(row)
		// Skip a claim this worker cannot own instead of aborting the batch:
		// every other row is already claimed in the database and would sit
		// idle until its lease expires. A skipped row is re-claimed once its
		// own lease lapses; it cannot be fenced-finalized without ownership.
		if claim.Token == "" || claim.Generation <= 0 || !row.ClaimLeaseExpiresAt.Valid {
			w.logger.Error("workflow sandbox claim missing durable ownership; skipping", "run_id", claim.Run.ID, "generation", claim.Generation)
			continue
		}
		if !claim.LeaseExpiresAt.After(time.Now()) {
			w.logger.Error("workflow sandbox claim already expired on arrival; skipping (check host clock skew against the database)",
				"run_id", claim.Run.ID, "generation", claim.Generation, "lease_expires_at", claim.LeaseExpiresAt)
			continue
		}
		claims = append(claims, claim)
	}

	type claimControl struct {
		ctx    context.Context
		cancel context.CancelFunc
	}
	controls := make([]claimControl, len(claims))
	for i, claim := range claims {
		claimCtx, cancelClaim := context.WithCancel(ctx)
		controls[i] = claimControl{ctx: claimCtx, cancel: cancelClaim}
		go w.maintainClaimLease(claimCtx, claim, cancelClaim)
	}
	defer func() {
		for _, control := range controls {
			control.cancel()
		}
	}()

	for i, claim := range claims {
		select {
		case <-ctx.Done():
			// Shutdown arrived mid-batch. Leases make these runs recoverable if
			// the process dies, but an orderly shutdown can settle them now and
			// give users immediate, resumable failures instead of waiting for
			// lease expiry.
			w.failUnstartedClaimedRuns(ctx, claims[i:])
			return ctx.Err()
		default:
		}

		if err := w.executeRunRecovering(controls[i].ctx, claim); err != nil {
			w.logger.Error("workflow sandbox execution failed", "run_id", claim.Run.ID, "error", err)
		}
		controls[i].cancel()
	}

	return nil
}

// workflowSandboxClaimCancellationDeadline returns a conservative local
// deadline derived from the database-authoritative lease expiry. Short test
// leases use a proportional margin so the watchdog remains deterministic.
func workflowSandboxClaimCancellationDeadline(expiresAt, now time.Time) time.Time {
	remaining := expiresAt.Sub(now)
	if remaining <= 0 {
		return now
	}
	margin := workflowSandboxClaimExpirySafetyMargin
	if proportional := remaining / 4; margin > proportional {
		margin = proportional
	}
	return expiresAt.Add(-margin)
}

// maintainClaimLease keeps both executing and not-yet-started claims in a
// batch alive. Losing the token/generation or reaching the last confirmed
// database lease expiry cancels the run context so a stale worker tears down
// its VM and its fenced finalizer becomes a no-op. Renewal calls themselves
// are bounded by that deadline, so a wedged database connection cannot strand
// the watchdog inside the query past ownership expiry.
func (w *WorkflowSandboxSchedulerWorker) maintainClaimLease(
	ctx context.Context,
	claim workflowSandboxRunClaim,
	cancelClaim context.CancelFunc,
) {
	interval := w.claimHeartbeat
	if interval <= 0 {
		interval = workflowSandboxClaimHeartbeatInterval
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	deadline := workflowSandboxClaimCancellationDeadline(claim.LeaseExpiresAt, time.Now())

	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			w.logger.Warn("workflow sandbox claim lease expired; canceling execution", "run_id", claim.Run.ID, "generation", claim.Generation)
			cancelClaim()
			return
		}
		expiryTimer := time.NewTimer(remaining)

		select {
		case <-ctx.Done():
			expiryTimer.Stop()
			return
		case <-expiryTimer.C:
			w.logger.Warn("workflow sandbox claim lease expired; canceling execution", "run_id", claim.Run.ID, "generation", claim.Generation)
			cancelClaim()
			return
		case <-ticker.C:
			if !expiryTimer.Stop() {
				select {
				case <-expiryTimer.C:
				default:
				}
			}
			renewCtx, cancelRenew := context.WithDeadline(ctx, deadline)
			renewedUntil, err := w.queries.RenewWorkflowSandboxClaim(renewCtx, claim.renewalParams())
			cancelRenew()
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				if stdErrors.Is(err, pgx.ErrNoRows) {
					w.logger.Info("workflow sandbox claim lost; canceling stale execution", "run_id", claim.Run.ID, "generation", claim.Generation)
					cancelClaim()
					return
				}
				w.logger.Warn("failed to renew workflow sandbox claim", "run_id", claim.Run.ID, "generation", claim.Generation, "error", err)
				continue
			}
			if !renewedUntil.Valid {
				w.logger.Warn("workflow sandbox claim renewal returned no expiry; canceling execution", "run_id", claim.Run.ID, "generation", claim.Generation)
				cancelClaim()
				return
			}
			deadline = workflowSandboxClaimCancellationDeadline(renewedUntil.Time, time.Now())
		}
	}
}

// pollOnceRecovering converts a panicking poll into an ordinary error so the
// scheduler loop keeps running.
func (w *WorkflowSandboxSchedulerWorker) pollOnceRecovering(ctx context.Context) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("workflow sandbox scheduler poll panicked: %v", r)
		}
	}()
	return w.PollOnce(ctx)
}

// executeRunRecovering converts a panic while executing one claimed run into a
// terminal failure for that run, so a single malformed workflow can neither
// kill the scheduler nor leave its run stuck 'running'. executeRun's defers
// (VM delete, token revocation) have already run by the time recover fires.
func (w *WorkflowSandboxSchedulerWorker) executeRunRecovering(ctx context.Context, claim workflowSandboxRunClaim) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = w.failRun(ctx, claim, 0, fmt.Sprintf("workflow sandbox execution panicked: %v", r))
		}
	}()
	return w.executeRun(ctx, claim)
}

// failUnstartedClaimedRuns terminalizes claimed-but-never-executed runs during
// shutdown. failRun mints a context detached from the cancelled ctx, so the
// writes still land.
func (w *WorkflowSandboxSchedulerWorker) failUnstartedClaimedRuns(ctx context.Context, claims []workflowSandboxRunClaim) {
	for _, claim := range claims {
		err := w.failRun(ctx, claim, 0, "workflow sandbox scheduler shut down before execution started")
		w.logger.Warn("failed claimed workflow run on scheduler shutdown", "run_id", claim.Run.ID, "detail", err)
	}
}

func (w *WorkflowSandboxSchedulerWorker) executeRun(ctx context.Context, claim workflowSandboxRunClaim) error {
	run := claim.Run

	// A sandbox-plane run that carries a rendered job graph is CI and runs one
	// NixOS kind=vm guest per job. A run without tasks is an InvokeWorkflow run
	// and keeps the single-VM smithers-orchestrator path below. See
	// runHasTaskGraph.
	nixCI, err := runHasTaskGraph(ctx, w.queries, run.ID)
	if err != nil {
		return w.failRun(ctx, claim, 0, "failed to load workflow job graph")
	}
	if nixCI && w.ciGuests == nil {
		return w.failRun(ctx, claim, 0, "CI guests are not configured on this deployment")
	}

	budget := w.timeout
	if nixCI {
		// Each job carries its own 120m ceiling; this is the whole-run backstop.
		budget = w.nixCIRunTimeout()
	}
	runCtx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()

	logger := middleware.LoggerWithWorkflowRun(runCtx, run.ID)

	// The claim flipped the row to running; tell status streamers (the run's
	// lifecycle SSE subscribers) that execution has actually started.
	NotifyWorkflowRunEvent(runCtx, w.queries, run.ID, "workflow_sandbox.running")

	def, err := w.queries.GetWorkflowDefinition(runCtx, db.GetWorkflowDefinitionParams{
		ID:           run.WorkflowDefinitionID,
		RepositoryID: run.RepositoryID,
	})
	if err != nil {
		return w.failRun(runCtx, claim, 0, "failed to load workflow definition")
	}

	repository, owner, cloneUserID, err := w.resolveRepositoryOwner(runCtx, run.RepositoryID)
	if err != nil {
		return w.failRun(runCtx, claim, 0, "failed to resolve workflow repository owner")
	}

	// The NixOS CI path owns its steps: each job's step is marked running when
	// its guest boots and terminal when the job ends, so the single-step
	// bookkeeping the orchestrator path needs would be wrong here.
	var step db.WorkflowStep
	if !nixCI {
		step, err = w.ensureRunningStep(runCtx, run.ID)
		if err != nil {
			return w.failRun(runCtx, claim, 0, "failed to prepare workflow step")
		}
	}

	var cloneURL, cloneToken string
	revokeCloneToken := func() {}
	if !nixCI {
		cloneURL, cloneToken, revokeCloneToken, err = w.buildCloneURL(runCtx, repository.ID, owner, repository.Name, cloneUserID)
		if err != nil {
			return w.failRun(runCtx, claim, step.ID, "failed to build clone url")
		}
	}
	defer revokeCloneToken()

	// redactEnv collects every sensitive value injected into the sandbox (true
	// repository/org secrets plus per-run tokens, NOT plain variables) so run
	// logs can be scrubbed before insertion and SSE broadcast — mirroring the
	// gVisor runner's RepositorySecrets redaction layer.
	redactEnv := map[string]string{}
	if cloneToken != "" {
		redactEnv["SMITHERS_REPO_CLONE_TOKEN"] = cloneToken
	}

	secrets := map[string]string{}
	if w.secretInjector != nil {
		var repoSecrets map[string]string
		secrets, repoSecrets, err = w.secretInjector.RepositoryEnvironmentAndSecrets(runCtx, run.RepositoryID, workflowRunOnTrustedMain(run, repository))
		if err != nil {
			message := "failed to load repository secrets"
			var apiErr *pkgerrors.APIError
			if stdErrors.As(err, &apiErr) && apiErr.Status == http.StatusForbidden {
				// A stored subscription-token refusal names the secret, never its value.
				message = apiErr.Message
			}
			return w.failRun(runCtx, claim, step.ID, message)
		}
		for name, value := range repoSecrets {
			redactEnv[name] = value
		}
	}

	// Mint a per-run scoped jjhub API token so the workflow's runner tools can
	// call the REST API as the owning user. Best-effort: a mint failure must not
	// fail the run (the tools simply 401 if used). Org-owned repos have no
	// user-scoped token (cloneUserID == 0), so skip them.
	if repository.UserID.Valid && cloneUserID > 0 {
		if apiToken, apiErr := issueTemporaryRepoAPIToken(runCtx, w.queries, cloneUserID, run.RepositoryID, fmt.Sprintf("sandbox-run-%d", run.ID)); apiErr != nil {
			logger.Warn("failed to mint per-run jjhub api token", "error", apiErr)
		} else {
			secrets["SMITHERS_JJHUB_TOKEN"] = apiToken.Plaintext
			secrets["SMITHERS_JJHUB_API_URL"] = w.apiBaseURL
			redactEnv["SMITHERS_JJHUB_TOKEN"] = apiToken.Plaintext
			if persistErr := w.queries.UpdateWorkflowRunJJHubTokenID(runCtx, db.UpdateWorkflowRunJJHubTokenIDParams{
				JjhubTokenID: pgtype.Int8{Int64: apiToken.ID, Valid: true},
				ID:           run.ID,
			}); persistErr != nil {
				logger.Warn("failed to persist per-run jjhub api token id", "error", persistErr)
			}
			defer func() {
				if apiToken.ID > 0 {
					revokeTemporaryRepoCloneToken(context.Background(), w.queries, cloneUserID, apiToken.ID)
					_ = w.queries.ClearWorkflowRunJJHubTokenID(context.Background(), run.ID)
				}
			}()
		}
	}

	// EGRESS: buildFirewallPolicy is deny-by-default and always allows the
	// SMITHERS_JJHUB_API_URL host, so the runner's jjhub tools work under the
	// firewall enforced by the self-hosted sandbox network policy.

	if nixCI {
		return w.executeNixCIRun(runCtx, claim, nixCIRunEnvironment{
			RepositoryID:   run.RepositoryID,
			Owner:          owner,
			RepositoryName: repository.Name,
			CloneUserID:    cloneUserID,
			Revision:       resolveWorkflowTargetRevision(run),
			Secrets:        secrets,
			RedactEnv:      redactEnv,
		})
	}

	createReq := w.buildCreateVMRequest(run, def, step, cloneURL, secrets)
	createCtx := sandboxProvisionContext(runCtx, "create", "workflow_run", fmt.Sprint(run.ID), fmt.Sprintf("step-%d", step.ID))
	vm, err := w.sandbox.CreateSandbox(createCtx, createReq)
	if err != nil {
		// A capacity refusal is a transient verdict on the fleet, not on the
		// run: the control plane rejected placement BEFORE any VM existed, so
		// the run returns to the re-claimable queue and a later poll retries
		// it once a guest slot frees. Every other create error stays terminal.
		if isNoCapacityError(err) {
			return w.requeueRunAfterCapacityRefusal(runCtx, claim, err)
		}
		return w.failRun(runCtx, claim, step.ID, "failed to create workflow sandbox")
	}

	// The sandbox clones the repository during VM creation, so the clone token
	// is spent the moment CreateSandbox returns. Revoke it NOW instead of at run end:
	// the run can last up to 30 minutes, and the token is embedded in the clone
	// URL sandbox provider received. (The deferred revoke covers earlier failure paths
	// and is a no-op after this.)
	revokeCloneToken()

	defer func() {
		deleteCtx, cancel := context.WithTimeout(context.WithoutCancel(runCtx), workflowSandboxDeleteTimeout)
		defer cancel()
		if deleteErr := w.sandbox.DeleteSandbox(deleteCtx, vm.ID); deleteErr != nil {
			logger.Warn("failed to delete workflow sandbox", "vm_id", vm.ID, "error", deleteErr)
		}
	}()

	timeoutMS := int64(w.timeout / time.Millisecond)
	execResp, err := w.sandbox.Execute(runCtx, vm.ID, sandbox.ExecRequest{
		Command:   workflowSandboxExecCommand(),
		TimeoutMS: &timeoutMS,
	})

	// The workflow may have run for many minutes, so runCtx can be at or past
	// its deadline here. Finalization (logs + terminal status) must run on a
	// context minted NOW — after the long exec — rather than at function entry,
	// so its own short budget is not consumed by the run itself. Deriving via
	// WithoutCancel keeps it alive even when runCtx has already expired.
	finalizeCtx, finalizeCancel := w.finalizeContext(runCtx)
	defer finalizeCancel()

	if err != nil {
		failureMessage := "workflow execution failed"
		if stdErrors.Is(err, context.DeadlineExceeded) || stdErrors.Is(runCtx.Err(), context.DeadlineExceeded) {
			failureMessage = fmt.Sprintf("workflow execution exceeded timeout of %s", w.timeout)
		}
		_ = w.appendLog(finalizeCtx, run.ID, step.ID, "system", RedactSecretValues(redactEnv, "exec failed: "+err.Error()))
		return w.finalizeFailure(finalizeCtx, claim, step.ID, failureMessage)
	}

	w.appendOutputLogs(finalizeCtx, run.ID, step.ID, execResp.Stdout, execResp.Stderr, redactEnv)

	exitCode := int32(1)
	if execResp.StatusCode != nil {
		exitCode = *execResp.StatusCode
	}
	if exitCode != 0 {
		_ = w.appendLog(finalizeCtx, run.ID, step.ID, "system", fmt.Sprintf("workflow exited with status %d", exitCode))
		return w.finalizeFailure(finalizeCtx, claim, step.ID, "workflow execution failed")
	}

	terminal, err := w.queries.MarkWorkflowRunSuccess(finalizeCtx, claim.successParams())
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			// The run left this token/generation underneath us (for example a
			// cancel, resume, or lease reclaim). Do not overwrite step state or
			// emit a terminal event for the newer owner.
			logger.Info("workflow run already terminal, skipping sandbox success finalization")
			return nil
		}
		return err
	}
	_, _ = w.queries.UpdateWorkflowStepStatusTerminal(finalizeCtx, db.UpdateWorkflowStepStatusTerminalParams{
		StepID: step.ID,
		Status: "success",
	})
	RevokeWorkflowRunCredentials(finalizeCtx, w.queries, run.ID, run.RepositoryID)
	w.cancelRunTasks(finalizeCtx, run.ID)
	NotifyWorkflowRunEvent(finalizeCtx, w.queries, run.ID, "workflow_sandbox.success")
	w.publishTerminal(finalizeCtx, terminal)
	return nil
}

// publishTerminal settles the run's external announcements. Call it only
// after this worker's claim-fenced write moved the run to a terminal status;
// a lost fence means the run's new owner publishes instead.
func (w *WorkflowSandboxSchedulerWorker) publishTerminal(ctx context.Context, run db.WorkflowRun) {
	if w.terminalPublisher != nil {
		w.terminalPublisher.PublishWorkflowRunTerminal(ctx, run)
	}
}

// cancelRunTasks terminalizes any dispatched runner tasks still active for a
// run the sandbox just terminalized. The sandbox executes the whole workflow
// itself, so leftover pending/blocked/running tasks would disagree with the
// aggregate run status and stay claimable by runners. Only called after
// winning the run's atomic queued/running -> terminal transition.
func (w *WorkflowSandboxSchedulerWorker) cancelRunTasks(ctx context.Context, runID int64) {
	if err := w.queries.CancelWorkflowTasks(ctx, runID); err != nil {
		w.logger.Warn("failed to cancel workflow tasks after sandbox terminalization", "run_id", runID, "error", err)
	}
}

// failRun mints its own finalize context (detached from the caller's, which may
// be at or past its run deadline) so the terminal-status write always has a
// fresh short budget, then records the failure.
func (w *WorkflowSandboxSchedulerWorker) failRun(ctx context.Context, claim workflowSandboxRunClaim, stepID int64, message string) error {
	finalizeCtx, cancel := w.finalizeContext(ctx)
	defer cancel()
	return w.finalizeFailure(finalizeCtx, claim, stepID, message)
}

// requeueRunAfterCapacityRefusal returns a claimed run to the queued pool
// after the sandbox control plane refuses placement because the fleet is full
// (HTTP 503, code no_capacity). No VM exists — the refusal precedes placement —
// so there is nothing to tear down and no terminal side effects (step verdict,
// task cancel, failure event, credential revocation) may fire.
//
// The release is two claim-safe writes on a detached finalize context. First
// the claim-fenced MarkWorkflowRunFailure: it is the only write that both
// proves this worker still owns the token/generation and clears
// workflow_sandbox_claims (its DB trigger), exactly as failRun's terminal
// write does. Then ResumeWorkflowRun flips that failure back to queued — it
// matches only cancelled/failure rows, so it is a no-op unless the fenced
// write just landed — leaving the run immediately re-claimable by
// ClaimQueuedWorkflowRuns in its original created_at order. A lost fence
// (pgx.ErrNoRows) means a newer owner holds the run and decides its fate.
func (w *WorkflowSandboxSchedulerWorker) requeueRunAfterCapacityRefusal(ctx context.Context, claim workflowSandboxRunClaim, cause error) error {
	finalizeCtx, cancel := w.finalizeContext(ctx)
	defer cancel()
	if _, err := w.queries.MarkWorkflowRunFailure(finalizeCtx, claim.failureParams()); err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			w.logger.Info("workflow run left this claim before capacity requeue; leaving it to the new owner", "run_id", claim.Run.ID)
			return nil
		}
		return fmt.Errorf("release workflow sandbox claim after capacity refusal: %w", err)
	}
	if err := w.queries.ResumeWorkflowRun(finalizeCtx, claim.Run.ID); err != nil {
		return fmt.Errorf("requeue capacity-refused workflow run %d: %w", claim.Run.ID, err)
	}
	w.logger.Info("workflow sandbox run requeued after capacity refusal", "run_id", claim.Run.ID, "error", cause)
	return nil
}

// finalizeFailure performs the terminal-failure writes on the given context. The
// caller is responsible for supplying a context with an unexpired budget (see
// workflowSandboxFinalizeContext); executeRun reuses the finalizeCtx it already
// minted after the exec so a single fresh budget covers log + status writes.
// The atomic, claim-fenced run transition goes first: if the token/generation
// is no longer current, we must not overwrite step status or emit a terminal
// event for the replacement owner.
func (w *WorkflowSandboxSchedulerWorker) finalizeFailure(ctx context.Context, claim workflowSandboxRunClaim, stepID int64, message string) error {
	runID := claim.Run.ID
	if strings.TrimSpace(message) == "" {
		message = "workflow sandbox run failed"
	}
	run, err := w.queries.MarkWorkflowRunFailure(ctx, claim.failureParams())
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			w.logger.Info("workflow run already terminal, skipping sandbox failure finalization", "run_id", runID)
			return stdErrors.New(message)
		}
		return err
	}
	if stepID > 0 {
		_, _ = w.queries.UpdateWorkflowStepStatusTerminal(ctx, db.UpdateWorkflowStepStatusTerminalParams{
			StepID: stepID,
			Status: "failure",
		})
		_ = w.appendLog(ctx, runID, stepID, "system", message)
	}
	RevokeWorkflowRunCredentials(ctx, w.queries, runID, run.RepositoryID)
	w.cancelRunTasks(ctx, runID)
	NotifyWorkflowRunEvent(ctx, w.queries, runID, "workflow_sandbox.failure")
	w.publishTerminal(ctx, run)
	return stdErrors.New(message)
}

// finalizeContext returns a context detached from ctx's cancellation/deadline
// (so it survives an already-expired run context) with its own short budget.
// It MUST be minted at finalization time, not at run start, or the budget is
// consumed by the run itself.
func (w *WorkflowSandboxSchedulerWorker) finalizeContext(ctx context.Context) (context.Context, context.CancelFunc) {
	timeout := w.finalizeTimeout
	if timeout <= 0 {
		timeout = workflowSandboxFinalizeTimeout
	}
	return context.WithTimeout(context.WithoutCancel(ctx), timeout)
}

func (w *WorkflowSandboxSchedulerWorker) ensureRunningStep(ctx context.Context, runID int64) (db.WorkflowStep, error) {
	steps, err := w.queries.ListWorkflowStepsByRunID(ctx, runID)
	if err != nil {
		return db.WorkflowStep{}, err
	}
	if len(steps) > 0 {
		step := steps[0]
		_, _ = w.queries.UpdateWorkflowStepStatusRunning(ctx, step.ID)
		return step, nil
	}
	step, err := w.queries.CreateWorkflowStep(ctx, db.CreateWorkflowStepParams{
		WorkflowRunID: runID,
		Name:          "sandbox",
		Position:      1,
		Status:        "running",
	})
	if err != nil {
		return db.WorkflowStep{}, err
	}
	return step, nil
}

func (w *WorkflowSandboxSchedulerWorker) buildCloneURL(
	ctx context.Context,
	repositoryID int64,
	owner string,
	repo string,
	cloneUserID int64,
) (string, string, func(), error) {
	return w.buildCloneURLWithToken(ctx, owner, repo, cloneUserID, func() (temporaryRepoCloneToken, error) {
		return issueTemporaryBoundRepoCloneToken(ctx, w.queries, cloneUserID, repositoryID, "workflow-sandbox-clone")
	})
}

func (w *WorkflowSandboxSchedulerWorker) buildCloneURLWithToken(
	ctx context.Context,
	owner, repo string,
	cloneUserID int64,
	mint func() (temporaryRepoCloneToken, error),
) (string, string, func(), error) {
	if cloneUserID > 0 {
		token, err := mint()
		if err == nil {
			cloneURL, cloneErr := buildAuthenticatedRepoCloneURL(w.gitBaseURL, owner, repo, token.Plaintext)
			if cloneErr == nil {
				return cloneURL, token.Plaintext, func() {
					revokeTemporaryRepoCloneToken(context.Background(), w.queries, cloneUserID, token.ID)
				}, nil
			}
			revokeTemporaryRepoCloneToken(ctx, w.queries, cloneUserID, token.ID)
		}
	}

	cloneURL, err := buildPublicRepoCloneURL(w.gitBaseURL, owner, repo)
	if err != nil {
		return "", "", nil, err
	}
	return cloneURL, "", func() {}, nil
}

func (w *WorkflowSandboxSchedulerWorker) resolveRepositoryOwner(
	ctx context.Context,
	repositoryID int64,
) (db.Repository, string, int64, error) {
	repository, err := w.queries.GetRepoByID(ctx, repositoryID)
	if err != nil {
		return db.Repository{}, "", 0, err
	}
	if repository.UserID.Valid {
		user, userErr := w.queries.GetUserByID(ctx, repository.UserID.Int64)
		if userErr != nil {
			return db.Repository{}, "", 0, userErr
		}
		return repository, user.Username, user.ID, nil
	}
	if repository.OrgID.Valid {
		org, orgErr := w.queries.GetOrgByID(ctx, repository.OrgID.Int64)
		if orgErr != nil {
			return db.Repository{}, "", 0, orgErr
		}
		ownerID, ownerErr := w.queries.GetOrgCredentialOwnerID(ctx, org.ID)
		if stdErrors.Is(ownerErr, pgx.ErrNoRows) {
			return repository, org.Name, 0, nil
		}
		if ownerErr != nil {
			return db.Repository{}, "", 0, ownerErr
		}
		return repository, org.Name, ownerID, nil
	}
	return db.Repository{}, "", 0, fmt.Errorf("repository owner not set")
}

func (w *WorkflowSandboxSchedulerWorker) buildCreateVMRequest(
	run db.WorkflowRun,
	def db.WorkflowDefinition,
	step db.WorkflowStep,
	cloneURL string,
	secrets map[string]string,
) sandbox.CreateRequest {
	waitForReady := false
	deleteOnStop := sandbox.DeleteOnStop
	idleTimeoutSeconds := workflowSandboxIdleTimeoutSeconds

	workflowPath := strings.TrimPrefix(strings.TrimSpace(def.Path), "/")
	if workflowPath == "" {
		workflowPath = "flows/workflow/flow.ts"
	}

	files := map[string]sandbox.SandboxFile{
		defaultWorkflowSandboxRunnerSH: {
			Content:    workflowSandboxRunnerScript(run.ID, workflowPath),
			Executable: true,
		},
	}

	enable := false
	service := sandbox.ServiceSpec{
		Name:    defaultWorkflowSandboxService,
		Mode:    sandbox.ServiceModeOneshot,
		Exec:    []string{defaultWorkflowSandboxRunnerSH},
		User:    "smithers",
		Workdir: defaultWorkflowSandboxWorkdir,
		Env:     cloneSandboxEnvironment(secrets),
		Enable:  &enable,
	}

	req := sandbox.CreateRequest{
		GitRepos: []sandbox.GitRepositorySpec{
			{
				Repo: cloneURL,
				Path: defaultWorkflowSandboxWorkdir,
				Rev:  resolveWorkflowTargetRevision(run),
			},
		},
		Packages: append([]string(nil), defaultWorkflowSandboxPackages...),
		Files:    files,
		Users: []sandbox.LinuxUserSpec{
			{
				Name:  "smithers",
				Home:  "/home/smithers",
				Shell: "/bin/bash",
			},
		},
		Init: &sandbox.ServiceConfig{
			Enabled:  true,
			Services: []sandbox.ServiceSpec{service},
		},
		Persistence: &sandbox.PersistencePolicy{
			Type:        sandbox.PersistenceEphemeral,
			DeleteEvent: &deleteOnStop,
		},
		IdleTimeoutSeconds: &idleTimeoutSeconds,
		VCPUCount:          &w.vcpuCount,
		MemSizeMB:          &w.memoryMB,
		RootfsSizeMB:       &w.rootfsSizeMB,
		WaitForReady:       &waitForReady,
		Workdir:            defaultWorkflowSandboxWorkdir,
		Firewall:           w.buildFirewallPolicy(),
	}

	_ = step // Keep step in the signature so future VM templates can include step-specific metadata.
	_ = run  // Keep run in the signature so future VM templates can include trigger metadata.
	return req
}

func (w *WorkflowSandboxSchedulerWorker) buildFirewallPolicy() *sandbox.FirewallPolicy {
	allowHosts := make([]string, 0, len(w.allowedRegistry)+2)
	if gatewayHost := hostForFirewallRule(w.apiGatewayURL); gatewayHost != "" {
		allowHosts = append(allowHosts, gatewayHost)
	}
	// The jjhub API host must always be reachable: the sandbox env carries
	// SMITHERS_JJHUB_API_URL (= apiBaseURL) for the runner's issue/landing/
	// bookmark tools, and deny-by-default egress would fail those calls closed
	// whenever a distinct gateway host is configured.
	if apiHost := hostForFirewallRule(w.apiBaseURL); apiHost != "" {
		allowHosts = append(allowHosts, apiHost)
	}
	for _, host := range w.allowedRegistry {
		if trimmed := strings.TrimSpace(host); trimmed != "" {
			allowHosts = append(allowHosts, trimmed)
		}
	}
	allowHosts = uniqueSortedStrings(allowHosts)

	egressRules := make([]sandbox.FirewallEgressRule, 0, len(allowHosts))
	for _, host := range allowHosts {
		egressRules = append(egressRules, sandbox.FirewallEgressRule{
			Host:     host,
			Port:     443,
			Protocol: "tcp",
		})
	}

	// Always return an explicit deny policy, even when configuration produced no
	// valid allow hosts. A nil policy means provider defaults and would turn a
	// typo such as an empty registry allow-list into unrestricted sandbox
	// egress—the opposite of the execution boundary's fail-closed contract.
	// The worker renders this closed allowlist into the guest network policy.
	return &sandbox.FirewallPolicy{
		DefaultEgressAction: "deny",
		EgressAllow:         egressRules,
	}
}

func (w *WorkflowSandboxSchedulerWorker) appendOutputLogs(
	ctx context.Context,
	runID, stepID int64,
	stdout string,
	stderr string,
	redactEnv map[string]string,
) {
	writeStream := func(stream string, value string) {
		normalized := strings.ReplaceAll(value, "\r\n", "\n")
		for _, line := range strings.Split(normalized, "\n") {
			if strings.TrimSpace(line) == "" {
				continue
			}
			_ = w.appendLog(ctx, runID, stepID, stream, RedactSecretValues(redactEnv, line))
		}
	}
	writeStream("stdout", stdout)
	writeStream("stderr", stderr)
}

func (w *WorkflowSandboxSchedulerWorker) appendLog(
	ctx context.Context,
	runID int64,
	stepID int64,
	stream string,
	entry string,
) error {
	entry = storableWorkflowLogEntry(entry)
	if starter, ok := w.queries.(runnerTxStarter); ok {
		return w.appendLogWithTx(ctx, starter, runID, stepID, stream, entry)
	}

	inserted, err := w.queries.InsertWorkflowRunLogNextSequence(ctx, db.InsertWorkflowRunLogNextSequenceParams{
		WorkflowRunID:  runID,
		WorkflowStepID: stepID,
		Stream:         stream,
		Entry:          entry,
	})
	if err != nil {
		return err
	}

	payloadBytes, _ := json.Marshal(map[string]any{
		"log_id":           inserted.ID,
		"workflow_step_id": inserted.WorkflowStepID,
		"sequence":         inserted.Sequence,
		"stream":           inserted.Stream,
		"entry":            inserted.Entry,
	})
	return w.queries.NotifyWorkflowRunLog(ctx, db.NotifyWorkflowRunLogParams{
		RunID:   runID,
		Payload: string(payloadBytes),
	})
}

// PostgreSQL TEXT rejects NUL and invalid UTF-8. Replace them so a malformed
// CI output line cannot strand a log batch or disappear from the run stream.
func storableWorkflowLogEntry(entry string) string {
	return strings.ReplaceAll(strings.ToValidUTF8(entry, "\uFFFD"), "\x00", "\uFFFD")
}

// appendLogWithTx serializes MAX(sequence)+1 allocation per workflow run on a
// single database connection. The advisory lock is deliberately a separate
// statement: hiding it inside the insert's CTE does not guarantee PostgreSQL
// acquires it before evaluating the sibling MAX(sequence) expression.
func (w *WorkflowSandboxSchedulerWorker) appendLogWithTx(
	ctx context.Context,
	starter runnerTxStarter,
	runID int64,
	stepID int64,
	stream string,
	entry string,
) error {
	tx, err := starter.BeginTx(ctx)
	if err != nil {
		return fmt.Errorf("begin workflow run log transaction: %w", err)
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()

	if _, err := tx.Exec(ctx, `SELECT id FROM workflow_runs WHERE id = $1 FOR UPDATE`, runID); err != nil {
		return fmt.Errorf("lock workflow run log stream: %w", err)
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, runID); err != nil {
		return fmt.Errorf("lock workflow run log sequence: %w", err)
	}

	inserted, err := db.New(tx).InsertWorkflowRunLogNextSequence(ctx, db.InsertWorkflowRunLogNextSequenceParams{
		WorkflowRunID:  runID,
		WorkflowStepID: stepID,
		Stream:         stream,
		Entry:          entry,
	})
	if err != nil {
		return err
	}

	payloadBytes, _ := json.Marshal(map[string]any{
		"log_id":           inserted.ID,
		"workflow_step_id": inserted.WorkflowStepID,
		"sequence":         inserted.Sequence,
		"stream":           inserted.Stream,
		"entry":            inserted.Entry,
	})
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit workflow run log transaction: %w", err)
	}

	return w.queries.NotifyWorkflowRunLog(ctx, db.NotifyWorkflowRunLogParams{
		RunID:   runID,
		Payload: string(payloadBytes),
	})
}

func workflowSandboxExecCommand() string {
	return strings.Join([]string{
		"set -euo pipefail",
		"systemctl start " + defaultWorkflowSandboxService + ".service",
		"while systemctl is-active --quiet " + defaultWorkflowSandboxService + ".service; do",
		"  sleep 1",
		"done",
		"if systemctl is-failed --quiet " + defaultWorkflowSandboxService + ".service; then",
		"  journalctl -u " + defaultWorkflowSandboxService + ".service --no-pager -n 200",
		"  exit 1",
		"fi",
		"journalctl -u " + defaultWorkflowSandboxService + ".service --no-pager -n 200",
	}, "\n")
}

func workflowSandboxRunnerScript(runID int64, workflowPath string) string {
	return strings.Join([]string{
		"#!/usr/bin/env bash",
		"set -euo pipefail",
		"export SMITHERS_WORKFLOW_PATH=" + shellQuote(path.Join(defaultWorkflowSandboxWorkdir, workflowPath)),
		"export SMITHERS_WORKFLOW_ROOT=" + shellQuote(defaultWorkflowSandboxWorkdir),
		"export SMITHERS_WORKFLOW_RUN_ID=" + shellQuote(strconv.FormatInt(runID, 10)),
		`export HOME="${HOME:-/home/smithers}"`,
		`cli_dir="$HOME/.local/lib/smithers-cli"`,
		`mkdir -p "$cli_dir" "$HOME/.local/bin"`,
		"test -s " + shellQuote(workspaceCLIPackageB64Path+".part0000"),
		"cat " + shellQuote(workspaceCLIPackageB64Path) + `.part* | base64 -d | tar -xzf - -C "$cli_dir"`,
		"base64 -d " + shellQuote(workspaceJJExportB64Path) + ` | gzip -d > "$HOME/.local/bin/smithers-jj-export"`,
		`chmod 755 "$HOME/.local/bin/smithers-jj-export"`,
		`export SMITHERS_WORKSPACE_JJ_EXPORT_BINARY="$HOME/.local/bin/smithers-jj-export"`,
		"cd " + shellQuote(defaultWorkflowSandboxWorkdir),
		// sandbox provider clones via a token-bearing URL that persists in
		// .git/config's remote.origin.url. The token is revoked server-side
		// right after VM creation, but the dead credential must not linger
		// where `git remote -v`, tooling, or logs can pick it up. Best-effort.
		`origin_url="$(git remote get-url origin 2>/dev/null || true)"`,
		`scrubbed_url="$(printf '%s' "$origin_url" | sed -E 's#^([a-z][a-z0-9+.-]*://)[^@/]+@#\1#')"`,
		`if [ -n "$origin_url" ] && [ "$scrubbed_url" != "$origin_url" ]; then`,
		`  git remote set-url origin "$scrubbed_url" || true`,
		"fi",
		`exec node "$cli_dir/node_modules/@smthrs/cli/bin/smithers.mjs" flow start ` + shellQuote(strings.TrimSuffix(strings.TrimPrefix(workflowPath, "flows/"), "/flow.ts")) + " --root " + shellQuote(defaultWorkflowSandboxWorkdir),
	}, "\n")
}

func cloneSandboxEnvironment(environment map[string]string) map[string]string {
	if len(environment) == 0 {
		return nil
	}
	cloned := make(map[string]string, len(environment))
	for name, value := range environment {
		cloned[name] = value
	}
	return cloned
}

func resolveWorkflowTargetRevision(run db.WorkflowRun) string {
	if sha := strings.TrimSpace(run.TriggerCommitSha); sha != "" {
		return sha
	}
	return strings.TrimSpace(run.TriggerRef)
}

func parseWorkflowSandboxRegistries(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return append([]string(nil), defaultWorkflowSandboxRegistries...)
	}
	return uniqueSortedStrings(splitCSV(raw))
}

func splitCSV(raw string) []string {
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func uniqueSortedStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		if _, exists := seen[trimmed]; exists {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	sort.Strings(out)
	return out
}

func hostForFirewallRule(rawURL string) string {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		return ""
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(parsed.Hostname())
}

func clampWorkflowSandboxTimeout(timeout time.Duration) time.Duration {
	switch {
	case timeout <= 0:
		return defaultWorkflowSandboxTimeout
	case timeout > maxWorkflowSandboxTimeout:
		return maxWorkflowSandboxTimeout
	default:
		return timeout
	}
}

func envDuration(key string, fallback time.Duration) time.Duration {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func envInt32(key string, fallback int32) int32 {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseInt(value, 10, 32)
	if err != nil {
		return fallback
	}
	return int32(parsed)
}

func envInt64(key string, fallback int64) int64 {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return fallback
	}
	return parsed
}

func buildPublicRepoCloneURL(baseURL, owner, repo string) (string, error) {
	baseURL = strings.TrimSpace(baseURL)
	if baseURL == "" {
		return "", fmt.Errorf("git base url is required")
	}
	if strings.TrimSpace(owner) == "" || strings.TrimSpace(repo) == "" {
		return "", fmt.Errorf("repository owner and name are required")
	}

	parsed, err := url.Parse(baseURL)
	if err != nil {
		return "", fmt.Errorf("parse git base url: %w", err)
	}
	if parsed.Scheme == "" || parsed.Host == "" {
		return "", fmt.Errorf("git base url must include scheme and host")
	}

	parsed.Path = path.Join(parsed.Path, owner, repo+".git")
	parsed.User = nil
	return parsed.String(), nil
}
