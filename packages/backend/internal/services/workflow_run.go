package services

import (
	"context"
	"encoding/json"
	stdErrors "errors"
	"fmt"
	"log/slog"
	pathpkg "path"
	"sort"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/runtimeports"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

// WorkflowRunQuerier is the DB interface required for workflow run orchestration.
type WorkflowRunQuerier = runtimeports.WorkflowRunQuerier

// WorkflowRunQueryRebinder preserves deployment extensions inside the caller's
// exact transaction. In particular, alert claim binding must commit with its run.
type WorkflowRunQueryRebinder interface {
	RebindWorkflowRunQueries(pgx.Tx) WorkflowRunQuerier
}

type workflowQueryTxStarter interface {
	BeginTx(context.Context) (pgx.Tx, error)
}

func BeginWorkflowQueryTx(ctx context.Context, queries any) (pgx.Tx, WorkflowRunQuerier, bool, error) {
	starter, canStart := queries.(workflowQueryTxStarter)
	if !canStart {
		return nil, nil, false, nil
	}
	if !canBindWorkflowQueryTx(queries) {
		// A composite that starts transactions but cannot retain its capabilities
		// must not silently execute a multi-statement workflow outside a transaction.
		return nil, nil, true, fmt.Errorf("workflow query store does not support transaction rebinding")
	}
	tx, err := starter.BeginTx(ctx)
	if err != nil {
		return nil, nil, true, err
	}
	rebound, err := BindWorkflowQueryTx(queries, tx)
	if err != nil {
		_ = tx.Rollback(context.Background())
		return nil, nil, true, err
	}
	return tx, rebound, true, nil
}

func canBindWorkflowQueryTx(queries any) bool {
	switch queries.(type) {
	case WorkflowRunQueryRebinder, *db.Queries:
		return true
	}
	return false
}

// BindWorkflowQueryTx binds the workflow store to a transaction the caller
// owns, keeping deployment extensions such as alert claim binding.
func BindWorkflowQueryTx(queries any, tx pgx.Tx) (WorkflowRunQuerier, error) {
	var rebound WorkflowRunQuerier
	switch store := queries.(type) {
	case WorkflowRunQueryRebinder:
		rebound = store.RebindWorkflowRunQueries(tx)
	case *db.Queries:
		rebound = store.WithTx(tx)
	default:
		return nil, fmt.Errorf("workflow query store does not support transaction rebinding")
	}
	if rebound == nil {
		return nil, fmt.Errorf("workflow transaction rebinding returned no store")
	}
	return rebound, nil
}

func LockWorkflowRun(ctx context.Context, tx pgx.Tx, runID int64) error {
	var lockedID int64
	return tx.QueryRow(ctx,
		`SELECT id FROM workflow_runs WHERE id = $1 FOR UPDATE`,
		runID,
	).Scan(&lockedID)
}

func lockWorkflowRunForRepository(ctx context.Context, tx pgx.Tx, runID, repositoryID int64) error {
	var lockedID int64
	return tx.QueryRow(ctx,
		`SELECT id FROM workflow_runs WHERE id = $1 AND repository_id = $2 FOR UPDATE`,
		runID,
		repositoryID,
	).Scan(&lockedID)
}

func markWorkflowRunFailed(ctx context.Context, queries WorkflowRunQuerier, runID int64) {
	if err := queries.FailWorkflowRun(ctx, runID); err != nil {
		middleware.LoggerWithWorkflowRun(ctx, runID).
			Error("failed to mark workflow run as failed after dispatch error", "error", err)
	}
}

// workflowRunCredentialRevoker is the DB surface needed to revoke a
// terminal workflow run's live runtime credentials. It is satisfied by
// *db.Queries in production; the duck-type assertion in
// RevokeWorkflowRunCredentials lets existing narrower test-mock queriers
// keep compiling without implementing it (same pattern as
// workflowRunFailureMarker above).
type workflowRunCredentialRevoker interface {
	UpdateWorkflowRunAgentToken(ctx context.Context, arg db.UpdateWorkflowRunAgentTokenParams) (db.WorkflowRun, error)
	GetWorkflowRunJJHubTokenID(ctx context.Context, id int64) (pgtype.Int8, error)
	ClearWorkflowRunJJHubTokenID(ctx context.Context, id int64) error
	DeleteAccessToken(ctx context.Context, arg db.DeleteAccessTokenParams) error
	GetRepoByID(ctx context.Context, id int64) (db.Repository, error)
}

// RevokeWorkflowRunCredentials clears a terminal workflow run's live agent
// token and revokes any per-run jjhub API token, so neither credential
// remains usable after the run finishes.
//
// This is safe to call for every terminalization path (cancel, complete,
// sandbox finalize): resumed runs (cancelled/failed -> queued) need no stored
// per-run token because the sandbox scheduler never injects the per-run agent
// token and mints its own per-run credentials when it claims a run, and agent
// dispatch mints a fresh token per dispatch. So clearing the stored
// credentials here never breaks a legitimate resume.
//
// All work is best-effort: failures are logged, not returned, so credential
// cleanup never blocks the terminalization it is attached to. repositoryID
// of 0 skips jjhub token revocation (used at dispatch-abort time, before any
// jjhub token could have been minted for the run).
func RevokeWorkflowRunCredentials(ctx context.Context, queries any, runID, repositoryID int64) {
	// NixOS CI job tokens die with their job; this sweeps any a crashed
	// scheduler left behind. The middleware also rejects them once the run is
	// terminal.
	if jobTokens, ok := queries.(interface {
		RevokeWorkflowRunGuestTokens(ctx context.Context, workflowRunID int64) error
	}); ok {
		if err := jobTokens.RevokeWorkflowRunGuestTokens(ctx, runID); err != nil {
			middleware.LoggerWithWorkflowRun(ctx, runID).Warn("failed to revoke workflow run job tokens", "error", err)
		}
	}
	revoker, ok := queries.(workflowRunCredentialRevoker)
	if !ok {
		return
	}
	logger := middleware.LoggerWithWorkflowRun(ctx, runID)

	if _, err := revoker.UpdateWorkflowRunAgentToken(ctx, db.UpdateWorkflowRunAgentTokenParams{
		AgentTokenHash: pgtype.Text{Valid: false},
		AgentTokenExpiresAt: pgtype.Timestamptz{
			Time:  time.Now().UTC().Add(-1 * time.Hour),
			Valid: true,
		},
		ID: runID,
	}); err != nil {
		logger.Warn("failed to revoke workflow run agent token", "error", err)
	}

	if repositoryID <= 0 {
		return
	}

	tokenID, err := revoker.GetWorkflowRunJJHubTokenID(ctx, runID)
	if err != nil {
		logger.Warn("failed to load workflow run jjhub token id", "error", err)
		return
	}
	if !tokenID.Valid || tokenID.Int64 <= 0 {
		return
	}

	repository, err := revoker.GetRepoByID(ctx, repositoryID)
	if err != nil {
		logger.Warn("failed to load repository for jjhub token revocation", "error", err)
		return
	}
	if !repository.UserID.Valid || repository.UserID.Int64 <= 0 {
		// jjhub API tokens are only ever minted for the repo-owner user
		// (org repos never mint one); nothing to revoke.
		return
	}

	revokeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), temporaryRepoTokenRevokeTimeout)
	defer cancel()
	if err := revoker.DeleteAccessToken(revokeCtx, db.DeleteAccessTokenParams{
		ID:     tokenID.Int64,
		UserID: repository.UserID.Int64,
	}); err != nil {
		logger.Warn("failed to delete workflow run jjhub token", "error", err)
	}
	if err := revoker.ClearWorkflowRunJJHubTokenID(ctx, runID); err != nil {
		logger.Warn("failed to clear workflow run jjhub token id", "error", err)
	}
}

// RerunInput carries the parameters for rerunning a workflow run.
type RerunInput struct {
	RepositoryID int64
	RunID        int64
	UserID       int64
}

// WorkflowRunCommitStatusWriter manages commit status rows linked to workflow runs.
type WorkflowRunCommitStatusWriter interface {
	PublishCommitStatus(ctx context.Context, status db.CommitStatus)
	UpdateCommitStatusForWorkflowRun(ctx context.Context, workflowRunID int64, status string, description string, targetURL string) (db.CommitStatus, error)
}

// WorkflowRunService manages workflow run lifecycle: from event trigger to task dispatch.
type WorkflowRunService interface {
	// DispatchForEvent finds matching workflow definitions for the given event and creates
	// workflow runs with steps and tasks for each matching definition.
	DispatchForEvent(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error)
	// CancelRun cancels an in-progress workflow run.
	CancelRun(ctx context.Context, repositoryID, runID int64) error
	// RerunRun creates a new workflow run based on an existing run.
	RerunRun(ctx context.Context, input RerunInput) (*WorkflowRunResult, error)
	// ResumeRun resumes a cancelled or failed workflow run by re-queuing incomplete tasks.
	ResumeRun(ctx context.Context, repositoryID, runID int64) error
}

// DispatchForEventInput carries the trigger event details for workflow dispatch.
// SystemPushTriggerEvent is the trigger a run records when an unreviewed
// push started it (DispatchForEventInput.SystemPush).
const SystemPushTriggerEvent = "system_push"

// replayedEventType is the event a rerun of a run with this recorded trigger
// evaluates: a system_push run replays its push (and records system_push
// again through DispatchForEventInput.SystemPush).
func replayedEventType(recorded string) string {
	if recorded == SystemPushTriggerEvent {
		return "push"
	}
	return recorded
}

type DispatchForEventInput struct {
	RepositoryID         int64
	UserID               int64
	Event                TriggerEvent
	UseLoadedDefinitions bool
	LoadedDefinitions    []LoadedWorkflowDefinition
	WorkflowDefinitionID *int64 // If set, only dispatch for this specific definition
	// SystemPush marks a push event whose credential is not Reviewed (an
	// agent run's, the platform's sync, an unattributed push, or a GitHub
	// push other than a person's to the default branch). Its runs record
	// SystemPushTriggerEvent: they restore workflow caches and save none.
	SystemPush bool
	// AlertRemediationBinding is set only by the trusted alert worker. The run
	// and this exact job/attempt binding are committed atomically.
	AlertRemediationBinding *AlertRemediationRunBinding
}

type AlertRemediationRunBinding struct {
	JobID            int64
	IncidentRowID    int64
	DispatchToken    string
	ExpectedAttempts int32
}

type alertRemediationRunBinder interface {
	BindAlertRemediationJobWorkflowRunAtAttempt(ctx context.Context, arg runtimeports.BindAlertRemediationJobWorkflowRunAtAttemptParams) (int64, error)
}

// WorkflowRunResult captures the run and tasks created for a workflow definition.
type WorkflowRunResult struct {
	WorkflowDefinitionID int64
	WorkflowRunID        int64
	Steps                []WorkflowStepResult
	// pendingCommitStatus is created in the same transaction as the run and its
	// tasks, then published only after that transaction commits.
	pendingCommitStatus *db.CommitStatus
}

// WorkflowStepResult captures step and task created for a workflow step.
type WorkflowStepResult struct {
	StepID   int64 `json:"step_id"`
	TaskID   int64 `json:"task_id"`
	Position int64 `json:"position"`
}

// Workflow run execution planes. Exactly one consumer claims work per run:
// sandbox-plane CI runs are claimed whole by the sandbox workflow scheduler
// (ClaimQueuedWorkflowRuns), agent-plane runs are driven solely by agent
// dispatch, and flow-plane runs solely by their Flow launch. The plane is fixed at run creation and
// never changes.
const (
	WorkflowRunPlaneSandbox = "sandbox"
	WorkflowRunPlaneAgent   = "agent"
	// WorkflowRunPlaneFlow runs are invoked flows that the canonical Flow
	// runtime executes (InvokedFlowService).
	WorkflowRunPlaneFlow = "flow"
)

// JobConfig represents a single job extracted from the workflow config.
type JobConfig struct {
	Name   string       `json:"-"` // set from map key
	Steps  []StepConfig `json:"steps,omitempty"`
	RunsOn string       `json:"runs-on,omitempty"`
	Needs  []string     `json:"needs,omitempty"`
	If     string       `json:"if,omitempty"`
	// Secrets is nil for the legacy expose-all behavior. An explicit empty
	// list creates a credential-free task; otherwise only named repository
	// secrets/variables are delivered to the job's guest.
	Secrets *[]string                 `json:"secrets,omitempty"`
	Cache   []WorkflowCacheDescriptor `json:"cache,omitempty"`
}

// StepConfig represents a single step within a job.
type StepConfig struct {
	Name  string         `json:"name,omitempty"`
	Run   string         `json:"run,omitempty"`
	Uses  string         `json:"uses,omitempty"`
	Agent map[string]any `json:"agent,omitempty"`
}

type WorkflowCacheDescriptor struct {
	Action    string   `json:"action"`
	Key       string   `json:"key"`
	HashFiles []string `json:"hash_files,omitempty"`
	Paths     []string `json:"paths,omitempty"`
}

type workflowRunService struct {
	queries              WorkflowRunQuerier
	cancelParticipant    WorkflowRunCancelParticipant
	dispatcher           webhooks.Dispatcher
	commitStatusWriter   WorkflowRunCommitStatusWriter
	checkRunService      GitHubCheckRunService
	installationResolver GitHubRepositoryInstallationResolver
	definitionLoader     WorkflowDefinitionCommitLoader
	bookmarkResolver     WorkflowBookmarkCommitResolver
	metrics              WorkflowRunMetricsObserver
	billing              BillingPolicy
	secretInjector       *SecretInjector
}

// WorkflowDefinitionCommitLoader loads workflow definitions from one immutable
// repository snapshot without consulting or mutating the persisted definition
// cache. Alert remediation uses it to bind the executed config to the same
// commit that the CI guest checks out.
type WorkflowDefinitionCommitLoader interface {
	LoadDefinitionsFromCommit(ctx context.Context, repoID int64, commitSHA string) (WorkflowLoadResult, error)
}

// WorkflowBookmarkCommitResolver resolves a moving bookmark through the
// authoritative repository host. PostgreSQL bookmark mirrors are not populated
// on production push paths and must not be used to pin remediation checkouts.
type WorkflowBookmarkCommitResolver interface {
	ResolveBookmarkCommit(ctx context.Context, repoID int64, bookmark string) (string, error)
}

// WorkflowRunServiceOption applies optional configuration to a workflowRunService.
// WorkflowRunCancelParticipant cancels what a run owns beyond its own rows in
// the transaction that cancels the run, so both commit or neither does.
type WorkflowRunCancelParticipant interface {
	CancelWorkflowRunInTx(ctx context.Context, tx pgx.Tx, run db.WorkflowRun) error
}

// SetCancelParticipant joins a participant to every run cancellation.
func (s *workflowRunService) SetCancelParticipant(participant WorkflowRunCancelParticipant) {
	s.cancelParticipant = participant
}

type WorkflowRunServiceOption func(*workflowRunService)

// WithWorkflowRunWebhookDispatcher wires a webhook dispatcher into WorkflowRunService.
func WithWorkflowRunWebhookDispatcher(dispatcher webhooks.Dispatcher) WorkflowRunServiceOption {
	return func(s *workflowRunService) {
		s.dispatcher = dispatcher
	}
}

// WithWorkflowRunCommitStatusWriter wires commit-status persistence into WorkflowRunService.
func WithWorkflowRunCommitStatusWriter(writer WorkflowRunCommitStatusWriter) WorkflowRunServiceOption {
	return func(s *workflowRunService) {
		s.commitStatusWriter = writer
	}
}

// WithWorkflowRunGitHubCheckRunService wires GitHub Checks API publishing.
func WithWorkflowRunGitHubCheckRunService(service GitHubCheckRunService) WorkflowRunServiceOption {
	return func(s *workflowRunService) {
		s.checkRunService = service
	}
}

// WithWorkflowRunGitHubInstallationResolver wires connection-scoped GitHub App
// installation resolution for check-run publishing.
func WithWorkflowRunGitHubInstallationResolver(resolver GitHubRepositoryInstallationResolver) WorkflowRunServiceOption {
	return func(s *workflowRunService) {
		s.installationResolver = resolver
	}
}

// WithWorkflowRunMetrics wires terminal workflow metrics into WorkflowRunService.
func WithWorkflowRunMetrics(metrics WorkflowRunMetricsObserver) WorkflowRunServiceOption {
	return func(s *workflowRunService) {
		s.metrics = metrics
	}
}

func WithWorkflowRunBillingPolicy(policy BillingPolicy) WorkflowRunServiceOption {
	return func(s *workflowRunService) {
		s.billing = policy
	}
}

func WithWorkflowRunSecretInjector(injector *SecretInjector) WorkflowRunServiceOption {
	return func(s *workflowRunService) {
		s.secretInjector = injector
	}
}

// WithWorkflowRunDefinitionCommitLoader wires commit-scoped workflow loading
// into WorkflowRunService. Push and alert remediation dispatch fail closed
// when this dependency is unavailable.
func WithWorkflowRunDefinitionCommitLoader(loader WorkflowDefinitionCommitLoader) WorkflowRunServiceOption {
	return func(s *workflowRunService) {
		s.definitionLoader = loader
	}
}

// WithWorkflowRunBookmarkCommitResolver wires authoritative repo-host bookmark
// resolution into workflow dispatch, including the push current-head check.
func WithWorkflowRunBookmarkCommitResolver(resolver WorkflowBookmarkCommitResolver) WorkflowRunServiceOption {
	return func(s *workflowRunService) {
		s.bookmarkResolver = resolver
	}
}

// NewWorkflowRunService creates a new workflow run service.
func NewWorkflowRunService(queries WorkflowRunQuerier, opts ...WorkflowRunServiceOption) WorkflowRunService {
	s := &workflowRunService{queries: queries}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

func (s *workflowRunService) DispatchForEvent(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error) {
	if input.RepositoryID <= 0 {
		return nil, pkgerrors.BadRequest("repository id must be positive")
	}
	if input.Event.Type == "" {
		return nil, pkgerrors.BadRequest("event type is required")
	}
	if s.queries == nil {
		return nil, pkgerrors.Internal("workflow run store unavailable")
	}
	pushEvent := NormalizeTriggerName(normalizeTriggerEvent(input.Event).Type) == "push"

	type dispatchDefinition struct {
		definition    db.WorkflowDefinition
		config        json.RawMessage
		enforceActive bool
	}

	var defs []dispatchDefinition

	if input.WorkflowDefinitionID != nil {
		// Targeted dispatch: fetch only the specified definition
		def, err := s.queries.GetWorkflowDefinition(ctx, db.GetWorkflowDefinitionParams{
			ID:           *input.WorkflowDefinitionID,
			RepositoryID: input.RepositoryID,
		})
		if err != nil {
			if stdErrors.Is(err, pgx.ErrNoRows) {
				return nil, pkgerrors.NotFound("workflow definition not found")
			}
			return nil, pkgerrors.Internal("failed to fetch workflow definition").WithCause(err)
		}
		defs = []dispatchDefinition{{definition: def, config: def.Config, enforceActive: true}}
	} else if input.UseLoadedDefinitions && !pushEvent {
		for _, loaded := range input.LoadedDefinitions {
			ref, err := s.queries.EnsureWorkflowDefinitionReference(ctx, db.EnsureWorkflowDefinitionReferenceParams{
				RepositoryID: input.RepositoryID,
				Name:         loaded.Name,
				Path:         loaded.Path,
				Config:       loaded.Config,
			})
			if err != nil {
				return nil, pkgerrors.Internal("failed to ensure workflow definition reference").WithCause(err)
			}
			defs = append(defs, dispatchDefinition{
				definition:    ref,
				config:        loaded.Config,
				enforceActive: false,
			})
		}
	} else {
		// Broadcast dispatch: match against all active definitions
		var err error
		rows, err := s.queries.ListWorkflowDefinitionsByRepo(ctx, db.ListWorkflowDefinitionsByRepoParams{
			RepositoryID: input.RepositoryID,
			PageSize:     int32(100),
			PageOffset:   int32(0),
		})
		if err != nil {
			return nil, pkgerrors.Internal("failed to list workflow definitions").WithCause(err)
		}
		for _, def := range rows {
			defs = append(defs, dispatchDefinition{definition: def, config: def.Config, enforceActive: true})
		}
	}

	var results []WorkflowRunResult
	var pushConfigs map[string]json.RawMessage
	if pushEvent {
		current, err := s.isCurrentRefHeadPush(ctx, input)
		if err != nil || !current {
			return nil, err
		}
		if s.definitionLoader == nil {
			return nil, pkgerrors.Internal("commit-scoped workflow loader unavailable for push")
		}
		// Every push entry point uses the exact tree, including targeted GitHub
		// deliveries and a push-hook load failure. Never fall back to DB config.
		loaded, err := s.definitionLoader.LoadDefinitionsFromCommit(ctx, input.RepositoryID, input.Event.CommitSHA)
		if err != nil {
			return nil, pkgerrors.Internal("failed to load push workflows at trigger commit").WithCause(err)
		}
		pushConfigs = make(map[string]json.RawMessage, len(loaded.Definitions))
		for _, def := range loaded.Definitions {
			pushConfigs[def.Path] = def.Config
		}
		for _, fileErr := range loaded.FileErrors {
			delete(pushConfigs, fileErr.Path)
		}
	}

	// 2. For each definition, check trigger match and create a run if matched.
	for _, candidate := range defs {
		def := candidate.definition
		// For alert remediation the persisted row is only a stable ID/path
		// reference. Activity, trigger matching, and jobs all come from the exact
		// commit loaded in createRunForDefinition below.
		commitScopedAlert := input.Event.Type == AlertRemediationTriggerEvent
		if candidate.enforceActive && !def.IsActive && !commitScopedAlert {
			continue
		}
		if pushConfigs != nil {
			config, exists := pushConfigs[def.Path]
			if !def.IsActive || !exists {
				continue
			}
			candidate.config = config
		}

		if !commitScopedAlert {
			matched, err := MatchTrigger(candidate.config, input.Event)
			if err != nil {
				// For targeted dispatch the caller named an exact definition, so a
				// silently skipped unparseable trigger config would surface as a
				// confusing 201 {"runs":[]}. Report it instead.
				if input.WorkflowDefinitionID != nil {
					return nil, pkgerrors.UnprocessableEntity("invalid workflow trigger configuration: " + err.Error())
				}
				continue
			}
			if !matched {
				// Same reasoning for a manual dispatch against a workflow that does
				// not declare a workflow_dispatch trigger.
				if input.WorkflowDefinitionID != nil && NormalizeTriggerName(input.Event.Type) == "workflow_dispatch" {
					return nil, pkgerrors.UnprocessableEntity("workflow does not declare a workflow_dispatch trigger")
				}
				continue
			}
		}

		// A head may move while files are loaded or earlier definitions run.
		if pushConfigs != nil {
			current, err := s.isCurrentRefHeadPush(ctx, input)
			if err != nil || !current {
				return results, err
			}
		}
		result, err := s.createRunForDefinition(ctx, def, candidate.config, input)
		if err != nil {
			return nil, err
		}
		results = append(results, result)
	}

	return results, nil
}

func (s *workflowRunService) isCurrentRefHeadPush(ctx context.Context, input DispatchForEventInput) (bool, error) {
	commit := strings.TrimSpace(input.Event.CommitSHA)
	if commit == "" {
		return false, nil // ref deletion or a push without an immutable revision
	}
	if s.bookmarkResolver == nil {
		return false, pkgerrors.Internal("workflow ref head resolver unavailable for push")
	}
	repository, err := s.resolveRunRepository(ctx, input.RepositoryID)
	if err != nil {
		return false, err
	}
	bookmark := normalizeBranchRef(strings.TrimSpace(input.Event.Ref))
	if bookmark == "" {
		bookmark = repository.DefaultBookmark
	}
	// Dispatch follows the pushed ref; only persistence follows the default ref.
	head, err := s.bookmarkResolver.ResolveBookmarkCommit(ctx, input.RepositoryID, bookmark)
	if err != nil || strings.TrimSpace(head) == "" {
		return false, pkgerrors.Internal("failed to resolve workflow ref head for push").WithCause(err)
	}
	return workflowPushHeadIsFresh(ctx, s.bookmarkResolver, input.RepositoryID, head, commit)
}

func (s *workflowRunService) createRunForDefinition(
	ctx context.Context,
	def db.WorkflowDefinition,
	configJSON json.RawMessage,
	input DispatchForEventInput,
) (WorkflowRunResult, error) {
	result := WorkflowRunResult{WorkflowDefinitionID: def.ID}

	repository, err := s.resolveRunRepository(ctx, input.RepositoryID)
	if err != nil {
		return WorkflowRunResult{}, err
	}
	triggerRef := strings.TrimSpace(input.Event.Ref)
	if triggerRef == "" {
		triggerRef = repository.DefaultBookmark
	}
	// Alert remediation is a multi-task trust boundary: proposal, validation,
	// and publication each receive a fresh checkout. Pin the run to one exact
	// Git object at dispatch so a moving default bookmark cannot make us publish
	// a patch against a different tree than the one that passed validation.
	if input.Event.Type == AlertRemediationTriggerEvent {
		commitSHA := strings.TrimSpace(input.Event.CommitSHA)
		if commitSHA == "" {
			if s.bookmarkResolver == nil {
				return WorkflowRunResult{}, pkgerrors.Internal("alert remediation base revision resolver unavailable")
			}
			var resolveErr error
			commitSHA, resolveErr = s.bookmarkResolver.ResolveBookmarkCommit(ctx, input.RepositoryID, triggerRef)
			commitSHA = strings.TrimSpace(commitSHA)
			if resolveErr != nil {
				return WorkflowRunResult{}, pkgerrors.Internal("failed to resolve immutable alert remediation base revision").WithCause(resolveErr)
			}
		}
		if !isImmutableGitObjectID(commitSHA) {
			return WorkflowRunResult{}, pkgerrors.Internal("failed to resolve immutable alert remediation base revision")
		}
		input.Event.CommitSHA = commitSHA

		configJSON, err = s.loadAlertRemediationDefinitionAtCommit(ctx, input.RepositoryID, commitSHA, def.Path, input.Event)
		if err != nil {
			return WorkflowRunResult{}, err
		}
	}

	// Schedule, workflow_dispatch, issue, and other ref-backed triggers do not
	// carry a commit SHA. A workflow commit status cannot be created without a
	// SHA or jj change ID, while terminal publication updates every run by
	// workflow_run_id. Resolve the authoritative bookmark target before writing
	// any rows so these runs are commit-backed just like push-triggered runs.
	if s.commitStatusWriter != nil && strings.TrimSpace(input.Event.CommitSHA) == "" && strings.TrimSpace(input.Event.ChangeID) == "" {
		if s.bookmarkResolver == nil {
			return WorkflowRunResult{}, pkgerrors.Internal("workflow commit resolver unavailable")
		}
		commitSHA, resolveErr := s.bookmarkResolver.ResolveBookmarkCommit(ctx, input.RepositoryID, triggerRef)
		commitSHA = strings.TrimSpace(commitSHA)
		if resolveErr != nil || !isImmutableGitObjectID(commitSHA) {
			return WorkflowRunResult{}, pkgerrors.Internal("failed to resolve workflow trigger commit")
		}
		input.Event.CommitSHA = commitSHA
	}

	preparedJobs, err := prepareWorkflowJobsForDispatch(configJSON, input.Event)
	if err != nil {
		return WorkflowRunResult{}, pkgerrors.BadRequest(err.Error())
	}
	resolvedBookmark := normalizeWorkflowCacheBookmark(triggerRef, repository.DefaultBookmark)
	repoOwner := s.resolveRepoOwner(ctx, repository)

	// Serialize dispatch inputs for persistence (nil when empty).
	var dispatchInputs []byte
	if len(input.Event.Inputs) > 0 {
		dispatchInputs, _ = json.Marshal(input.Event.Inputs)
	}

	var run db.WorkflowRun
	insert := func(ctx context.Context, admission pgx.Tx) error {
		var err error
		result, run, err = s.insertWorkflowRun(ctx, admission, func(ctx context.Context, queries WorkflowRunQuerier) (WorkflowRunResult, db.WorkflowRun, error) {
			return createWorkflowRunRows(ctx, queries, def, input, repository, repoOwner, triggerRef, resolvedBookmark, dispatchInputs, preparedJobs, s.commitStatusWriter != nil)
		})
		return err
	}
	// Billing gate: every non-agent run creation funnels through here (manual
	// dispatch, push/release/schedule triggers, targeted and broadcast event
	// dispatch), so the owner's CI-minute admission and the run insert commit
	// together. Agent runs are created by agent_dispatch.go, which applies its
	// own AuthorizeAgentRunCommitted gate.
	if s.billing != nil {
		err = s.billing.AuthorizeWorkflowDispatchCommitted(ctx, input.RepositoryID, insert)
	} else {
		err = insert(ctx, nil)
	}
	if err != nil {
		return WorkflowRunResult{}, err
	}

	// A newer push to a ref replaces the older pushes to it. Reap those runs
	// before publishing this run's own external state, so the freshly created
	// run is the last writer for the concurrency group. Without this, seven
	// consecutive pushes to one repository queued seven full runs at once
	// (2026-09-15: runs 11751-11757, six grouped tasks each) and starved every
	// other repository on the shared CI capacity for over an hour.
	s.cancelSupersededRuns(ctx, run, configJSON)

	// All database rows are durable before publishing external state. A
	// malformed definition therefore cannot leave a queued run with no work.
	_ = s.dispatchWorkflowRunEvent(ctx, run, input.RepositoryID)
	if result.pendingCommitStatus != nil {
		s.commitStatusWriter.PublishCommitStatus(ctx, *result.pendingCommitStatus)
		result.pendingCommitStatus = nil
	}
	s.createInProgressCheckRun(ctx, run, def, repository, repoOwner)

	return result, nil
}

func (s *workflowRunService) loadAlertRemediationDefinitionAtCommit(
	ctx context.Context,
	repositoryID int64,
	commitSHA string,
	definitionPath string,
	event TriggerEvent,
) (json.RawMessage, error) {
	config, err := s.loadDefinitionConfigAtCommit(ctx, repositoryID, commitSHA, definitionPath, "alert remediation workflow", "immutable base revision")
	if err != nil {
		return nil, err
	}

	matched, err := MatchTrigger(config, event)
	if err != nil {
		return nil, pkgerrors.UnprocessableEntity("invalid alert remediation workflow trigger at immutable base revision")
	}
	if !matched {
		return nil, pkgerrors.UnprocessableEntity("workflow does not declare the alert remediation trigger at immutable base revision")
	}
	return config, nil
}

// loadDefinitionConfigAtCommit reads one workflow file's config from an
// immutable commit. Definition rows are mutable (sync overwrites them on every
// push), so any run pinned to a commit must take its config from that commit.
func (s *workflowRunService) loadDefinitionConfigAtCommit(
	ctx context.Context,
	repositoryID int64,
	commitSHA string,
	definitionPath string,
	subject string,
	revision string,
) (json.RawMessage, error) {
	if s.definitionLoader == nil {
		return nil, pkgerrors.Internal("commit-scoped workflow loader unavailable for " + subject)
	}

	loaded, err := s.definitionLoader.LoadDefinitionsFromCommit(ctx, repositoryID, commitSHA)
	if err != nil {
		return nil, pkgerrors.Internal("failed to load " + subject + " at " + revision).WithCause(err)
	}

	for _, fileErr := range loaded.FileErrors {
		if fileErr.Path == definitionPath {
			return nil, pkgerrors.UnprocessableEntity(subject + " is invalid at " + revision)
		}
	}

	var config json.RawMessage
	for _, candidate := range loaded.Definitions {
		if candidate.Path != definitionPath {
			continue
		}
		if config != nil {
			return nil, pkgerrors.UnprocessableEntity(subject + " path is ambiguous at " + revision)
		}
		config = candidate.Config
	}
	if config == nil {
		return nil, pkgerrors.UnprocessableEntity(subject + " is absent at " + revision)
	}
	return config, nil
}

func isImmutableGitObjectID(value string) bool {
	if len(value) != 40 && len(value) != 64 {
		return false
	}
	for _, ch := range value {
		if (ch < '0' || ch > '9') && (ch < 'a' || ch > 'f') {
			return false
		}
	}
	return true
}

type preparedWorkflowJob struct {
	job       JobConfig
	shouldRun bool
}

func prepareWorkflowJobsForDispatch(configJSON json.RawMessage, event TriggerEvent) ([]preparedWorkflowJob, error) {
	jobs, err := parseJobsFromConfig(configJSON)
	if err != nil {
		return nil, fmt.Errorf("invalid workflow config: %w", err)
	}
	return validateAndPrepareWorkflowJobs(jobs, event, true)
}

func validateWorkflowConfigJobs(cfg *WorkflowConfig) error {
	if cfg == nil {
		return fmt.Errorf("workflow config is empty")
	}
	_, err := validateAndPrepareWorkflowJobs(workflowJobsFromConfig(cfg), TriggerEvent{}, false)
	return err
}

func validateAndPrepareWorkflowJobs(jobs []JobConfig, event TriggerEvent, requireJobs bool) ([]preparedWorkflowJob, error) {
	if requireJobs && len(jobs) == 0 {
		return nil, fmt.Errorf("workflow must declare at least one job")
	}
	if err := validateWorkflowJobLimits(jobs); err != nil {
		return nil, err
	}
	if err := ValidateDAG(jobs); err != nil {
		return nil, fmt.Errorf("invalid workflow DAG: %w", err)
	}

	// Conditions that refer to needs are evaluated after their dependencies
	// finish. Evaluate them once with a complete placeholder map now so syntax
	// errors are rejected before any run or external side effect exists.
	validationNeeds := make(map[string]string, len(jobs))
	for _, job := range jobs {
		validationNeeds[job.Name] = "success"
	}

	prepared := make([]preparedWorkflowJob, 0, len(jobs))
	for _, job := range jobs {
		if err := validateWorkflowJobSecrets(job); err != nil {
			return nil, err
		}
		if err := ValidateIfExpression(job.If); err != nil {
			return nil, fmt.Errorf("invalid if expression for job %s: %w", job.Name, err)
		}
		needsResults := validationNeeds
		if !IfExpressionReferencesNeeds(job.If) {
			needsResults = nil
		}
		shouldRun, err := EvaluateIfExpression(job.If, event, needsResults)
		if err != nil {
			return nil, fmt.Errorf("invalid if expression for job %s: %w", job.Name, err)
		}
		if IfExpressionReferencesNeeds(job.If) {
			shouldRun = true
		}
		prepared = append(prepared, preparedWorkflowJob{job: job, shouldRun: shouldRun})
	}
	return prepared, nil
}

func validateWorkflowJobSecrets(job JobConfig) error {
	if job.Secrets == nil {
		return nil
	}
	if len(*job.Secrets) > MaxInjectedEnvEntries {
		return fmt.Errorf("job %s declares too many secrets", job.Name)
	}
	seen := make(map[string]struct{}, len(*job.Secrets))
	for _, rawName := range *job.Secrets {
		name := strings.TrimSpace(rawName)
		if name == "" || name != rawName || !IsInjectedSecretName(name) {
			return fmt.Errorf("job %s declares invalid secret name %q", job.Name, rawName)
		}
		if _, exists := seen[name]; exists {
			return fmt.Errorf("job %s declares duplicate secret %q", job.Name, name)
		}
		seen[name] = struct{}{}
	}
	return nil
}

func workflowJobsFromConfig(cfg *WorkflowConfig) []JobConfig {
	if cfg == nil {
		return nil
	}
	jobs := make([]JobConfig, 0, len(cfg.Jobs))
	for name, job := range cfg.Jobs {
		job.Name = name
		jobs = append(jobs, job)
	}
	sort.Slice(jobs, func(i, j int) bool {
		return jobs[i].Name < jobs[j].Name
	})
	return jobs
}

func createWorkflowRunRows(
	ctx context.Context,
	queries WorkflowRunQuerier,
	def db.WorkflowDefinition,
	input DispatchForEventInput,
	repository db.Repository,
	repoOwner, triggerRef, resolvedBookmark string,
	dispatchInputs []byte,
	jobs []preparedWorkflowJob,
	createPendingCommitStatus bool,
) (WorkflowRunResult, db.WorkflowRun, error) {
	result := WorkflowRunResult{WorkflowDefinitionID: def.ID}
	triggerEvent := input.Event.Type
	if input.SystemPush {
		triggerEvent = SystemPushTriggerEvent
	}
	run, err := queries.CreateWorkflowRun(ctx, db.CreateWorkflowRunParams{
		RepositoryID:         input.RepositoryID,
		WorkflowDefinitionID: def.ID,
		Status:               "queued",
		TriggerEvent:         triggerEvent,
		TriggerRef:           triggerRef,
		TriggerCommitSha:     input.Event.CommitSHA,
		DispatchInputs:       dispatchInputs,
		// Every CI run executes on the sandbox plane: each job in its own
		// NixOS kind=vm guest booted from the repository's closure image, or
		// the platform base closure when the repository has not registered
		// one. `runs-on` is workflow metadata and never selects a plane, so
		// untrusted CI can never redirect itself into the agent plane.
		ExecutionPlane: WorkflowRunPlaneSandbox,
	})
	if err != nil {
		return result, db.WorkflowRun{}, pkgerrors.Internal(fmt.Sprintf("failed to create workflow run: %v", err))
	}
	result.WorkflowRunID = run.ID

	if binding := input.AlertRemediationBinding; binding != nil {
		binder, ok := queries.(alertRemediationRunBinder)
		if !ok {
			return result, run, pkgerrors.Internal("alert remediation run binding is unavailable")
		}
		rowsAffected, bindErr := binder.BindAlertRemediationJobWorkflowRunAtAttempt(ctx, runtimeports.BindAlertRemediationJobWorkflowRunAtAttemptParams{
			WorkflowRunID:    pgtype.Int8{Int64: run.ID, Valid: true},
			JobID:            binding.JobID,
			IncidentRowID:    binding.IncidentRowID,
			DispatchToken:    binding.DispatchToken,
			ExpectedAttempts: binding.ExpectedAttempts,
		})
		if bindErr != nil || rowsAffected != 1 {
			return result, run, pkgerrors.Internal(fmt.Sprintf(
				"failed to bind alert remediation workflow run: rows_affected=%d: %v", rowsAffected, bindErr))
		}
	}

	jobHasNeeds := make(map[string]bool, len(jobs))
	for _, prepared := range jobs {
		jobHasNeeds[prepared.job.Name] = len(prepared.job.Needs) > 0
	}

	for pos, prepared := range jobs {
		job := prepared.job
		stepStatus := "queued"
		taskStatus := "pending"
		if !prepared.shouldRun {
			stepStatus = "skipped"
			taskStatus = "skipped"
		} else if jobHasNeeds[job.Name] {
			taskStatus = "blocked"
		}

		step, err := queries.CreateWorkflowStep(ctx, db.CreateWorkflowStepParams{
			WorkflowRunID: run.ID,
			Name:          job.Name,
			Position:      int64(pos + 1),
			Status:        stepStatus,
		})
		if err != nil {
			return result, run, pkgerrors.Internal(fmt.Sprintf(
				"failed to create workflow step: %s (status=%s): %v", job.Name, stepStatus, err))
		}

		payloadMap := map[string]any{
			"job":     job.Name,
			"runs_on": job.RunsOn,
			"steps":   job.Steps,
			"event":   input.Event.Type,
			"ref":     triggerRef,
			"commit":  input.Event.CommitSHA,
			// No credential is ever persisted in the payload: the sandbox
			// scheduler mints each guest's clone token and injects the
			// repository secrets the job allows when the guest boots.
			"default_bookmark":  repository.DefaultBookmark,
			"resolved_bookmark": resolvedBookmark,
			"workflow_path":     def.Path,
			"repo_name":         repository.Name,
			"repo_owner":        repoOwner,
		}
		if job.Secrets != nil {
			payloadMap["secret_names"] = *job.Secrets
		}
		if len(job.Needs) > 0 {
			payloadMap["needs"] = job.Needs
		}
		if job.If != "" {
			payloadMap["if"] = job.If
		}
		if len(job.Cache) > 0 {
			payloadMap["cache"] = job.Cache
		}
		if len(input.Event.Inputs) > 0 {
			payloadMap["inputs"] = input.Event.Inputs
		}
		if input.Event.ChangeID != "" {
			payloadMap["change_id"] = input.Event.ChangeID
		}
		payload, _ := json.Marshal(payloadMap)

		task, err := queries.CreateWorkflowTask(ctx, db.CreateWorkflowTaskParams{
			WorkflowRunID:  run.ID,
			WorkflowStepID: step.ID,
			RepositoryID:   input.RepositoryID,
			Status:         taskStatus,
			Priority:       int16(0),
			Payload:        payload,
			AvailableAt:    time.Now(),
		})
		if err != nil {
			return result, run, pkgerrors.Internal(fmt.Sprintf(
				"failed to create workflow task: %s (status=%s): %v", job.Name, taskStatus, err))
		}

		result.Steps = append(result.Steps, WorkflowStepResult{
			StepID:   step.ID,
			TaskID:   task.ID,
			Position: step.Position,
		})
	}

	if createPendingCommitStatus {
		params := pendingWorkflowCommitStatusParams(input, def, run.ID)
		status, err := queries.CreateCommitStatus(ctx, params)
		if err != nil {
			middleware.LoggerWithWorkflowRun(ctx, run.ID).
				Error("failed to create pending commit status for workflow run", "repository_id", input.RepositoryID, "error", err)
			return result, run, pkgerrors.Internal(fmt.Sprintf("failed to create pending commit status: %v", err))
		}
		result.pendingCommitStatus = &status
	}

	return result, run, nil
}

// insertWorkflowRun writes one run's rows inside the billing admission
// transaction when one is supplied, and otherwise in the workflow store's own
// transaction (or, for a store without transactions, with abort on failure).
func (s *workflowRunService) insertWorkflowRun(
	ctx context.Context,
	admission pgx.Tx,
	write func(context.Context, WorkflowRunQuerier) (WorkflowRunResult, db.WorkflowRun, error),
) (WorkflowRunResult, db.WorkflowRun, error) {
	if admission != nil {
		queries, err := BindWorkflowQueryTx(s.queries, admission)
		if err != nil {
			return WorkflowRunResult{}, db.WorkflowRun{}, pkgerrors.Internal("failed to bind workflow run admission transaction").WithCause(err)
		}
		return write(ctx, queries)
	}
	tx, txQueries, transactional, err := BeginWorkflowQueryTx(ctx, s.queries)
	if err != nil {
		return WorkflowRunResult{}, db.WorkflowRun{}, pkgerrors.Internal("failed to begin workflow run transaction").WithCause(err)
	}
	if !transactional {
		result, run, err := write(ctx, s.queries)
		if err != nil && result.WorkflowRunID > 0 {
			abortWorkflowRunDispatch(ctx, s.queries, result.WorkflowRunID)
		}
		return result, run, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	result, run, err := write(ctx, txQueries)
	if err != nil {
		return WorkflowRunResult{}, db.WorkflowRun{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return WorkflowRunResult{}, db.WorkflowRun{}, pkgerrors.Internal("failed to commit workflow run").WithCause(err)
	}
	return result, run, nil
}

func abortWorkflowRunDispatch(ctx context.Context, queries WorkflowRunQuerier, runID int64) {
	// A dispatch abort is a failure, not a user cancellation: mark the run
	// 'failure' via markWorkflowRunFailed below rather than routing it through
	// the user-facing CancelWorkflowRun path, which would report 'cancelled'.
	if err := queries.CancelWorkflowTasks(ctx, runID); err != nil {
		middleware.LoggerWithWorkflowRun(ctx, runID).
			Warn("failed to cancel partially-created workflow tasks", "error", err)
	}
	markWorkflowRunFailed(ctx, queries, runID)
	// repositoryID is unknown/0 here: a jjhub token can't exist yet at
	// dispatch-abort time, so this only clears the agent token.
	RevokeWorkflowRunCredentials(ctx, queries, runID, 0)
}

type workflowRunCheckRunUpdater interface {
	UpdateWorkflowRunCheckRun(ctx context.Context, arg db.UpdateWorkflowRunCheckRunParams) (db.WorkflowRun, error)
}

func (s *workflowRunService) createInProgressCheckRun(
	ctx context.Context,
	run db.WorkflowRun,
	def db.WorkflowDefinition,
	repository db.Repository,
	repoOwner string,
) {
	if s.checkRunService == nil {
		return
	}

	status := strings.ToLower(strings.TrimSpace(run.Status))
	if status != "queued" && status != "running" {
		return
	}
	if strings.TrimSpace(run.TriggerCommitSha) == "" {
		return
	}

	owner, repoName, installationID, repositoryID, ok := s.gitHubCheckRunTarget(ctx, repository, repoOwner)
	if !ok {
		return
	}

	result, err := s.checkRunService.PostCheckRun(ctx, installationID, repositoryID, owner, repoName, GitHubCheckRunInput{
		Name:    workflowCheckRunName(def),
		HeadSHA: run.TriggerCommitSha,
		Status:  "in_progress",
		Output: &GitHubCheckRunOutput{
			Title:   "Workflow in progress",
			Summary: fmt.Sprintf("Workflow `%s` is running (run #%d).", def.Name, run.ID),
		},
	})
	if err != nil {
		middleware.LoggerWithWorkflowRun(ctx, run.ID).
			Warn("failed to post github check run", "owner", owner, "repo", repoName, "error", err)
		return
	}

	updater, ok := s.queries.(workflowRunCheckRunUpdater)
	if !ok {
		return
	}
	checkRunID := pgtype.Int8{}
	if result.ID > 0 {
		checkRunID = pgtype.Int8{Int64: result.ID, Valid: true}
	}
	checkRunURL := pgtype.Text{}
	if trimmed := strings.TrimSpace(result.HTMLURL); trimmed != "" {
		checkRunURL = pgtype.Text{String: trimmed, Valid: true}
	} else if trimmed := strings.TrimSpace(result.URL); trimmed != "" {
		checkRunURL = pgtype.Text{String: trimmed, Valid: true}
	}
	if _, err := updater.UpdateWorkflowRunCheckRun(ctx, db.UpdateWorkflowRunCheckRunParams{
		ID:          run.ID,
		CheckRunID:  checkRunID,
		CheckRunUrl: checkRunURL,
	}); err != nil {
		middleware.LoggerWithWorkflowRun(ctx, run.ID).
			Warn("failed to persist github check run metadata", "error", err)
	}
}

// gitHubCheckRunTarget is the GitHub repository a run's check run is written
// to and the installation bound to it: the repository's one GitHub destination
// (its mirror destination or single recorded GitHub source), else its own
// owner/name. A mirror's commits are its source's commits, so its check runs
// land where that repository's branch protection and release gates read them.
// ok is false when no installation is bound to the target.
func (s *workflowRunService) gitHubCheckRunTarget(ctx context.Context, repository db.Repository, repoOwner string) (string, string, int64, int64, bool) {
	if s.installationResolver == nil {
		return "", "", 0, 0, false
	}
	owner := strings.TrimSpace(repoOwner)
	repoName := strings.TrimSpace(repository.Name)
	if store, ok := s.queries.(gitHubDestinationStore); ok {
		if githubOwner, githubRepo, err := resolveGitHubDestination(ctx, store, nil, 0, repository.ID, "", ""); err == nil {
			owner, repoName = githubOwner, githubRepo
		}
	}
	if owner == "" || repoName == "" {
		return "", "", 0, 0, false
	}
	installationID, repositoryID, err := s.installationResolver.GetGitHubRepositoryForRepositoryOwner(
		ctx,
		repository.UserID.Int64,
		repository.OrgID.Int64,
		owner,
		repoName,
	)
	if err != nil || installationID <= 0 {
		return "", "", 0, 0, false
	}
	return owner, repoName, installationID, repositoryID, true
}

func workflowCheckRunName(def db.WorkflowDefinition) string {
	name := strings.TrimSpace(def.Name)
	if name == "" {
		name = "workflow"
	}
	return "smithers / " + name
}

func (s *workflowRunService) resolveRunRepository(ctx context.Context, repositoryID int64) (db.Repository, error) {
	repository, err := s.queries.GetRepoByID(ctx, repositoryID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.Repository{}, pkgerrors.NotFound("repository not found")
		}
		return db.Repository{}, pkgerrors.Internal("failed to load repository").WithCause(err)
	}
	return repository, nil
}

func (s *workflowRunService) resolveRepoOwner(ctx context.Context, repository db.Repository) string {
	if repository.UserID.Valid {
		user, err := s.queries.GetUserByID(ctx, repository.UserID.Int64)
		if err != nil {
			slog.Error("failed to resolve repository owner user", "repository_id", repository.ID, "user_id", repository.UserID.Int64, "error", err)
			return ""
		}
		return user.Username
	}
	if repository.OrgID.Valid {
		org, err := s.queries.GetOrgByID(ctx, repository.OrgID.Int64)
		if err != nil {
			slog.Error("failed to resolve repository owner org", "repository_id", repository.ID, "org_id", repository.OrgID.Int64, "error", err)
			return ""
		}
		return org.Name
	}
	return ""
}

func pendingWorkflowCommitStatusParams(input DispatchForEventInput, def db.WorkflowDefinition, workflowRunID int64) db.CreateCommitStatusParams {
	changeID := strings.TrimSpace(input.Event.ChangeID)
	sha := strings.TrimSpace(input.Event.CommitSHA)
	return db.CreateCommitStatusParams{
		RepositoryID:  input.RepositoryID,
		ChangeID:      pgtype.Text{String: changeID, Valid: changeID != ""},
		CommitSha:     pgtype.Text{String: sha, Valid: sha != ""},
		Context:       workflowCommitStatusContext(def.Name, def.Path),
		Status:        "pending",
		Description:   "Workflow queued",
		WorkflowRunID: pgtype.Int8{Int64: workflowRunID, Valid: true},
	}
}

func workflowCommitStatusContext(name, path string) string {
	trimmedName := strings.TrimSpace(name)
	if trimmedName != "" {
		return "smithers/" + trimmedName
	}
	stem := strings.TrimSuffix(pathpkg.Base(strings.TrimSpace(path)), pathpkg.Ext(strings.TrimSpace(path)))
	if stem == "" {
		stem = "workflow"
	}
	return "smithers/" + stem
}

// dispatchWorkflowRunEvent enqueues a "workflow_run" webhook event (non-fatal).
func (s *workflowRunService) dispatchWorkflowRunEvent(ctx context.Context, run db.WorkflowRun, repositoryID int64) error {
	if s.dispatcher == nil {
		return nil
	}
	payload := webhooks.WorkflowRunEventPayload{
		Action: "queued",
		WorkflowRun: webhooks.WorkflowRunPayload{
			ID:           run.ID,
			Status:       run.Status,
			TriggerEvent: run.TriggerEvent,
			TriggerRef:   run.TriggerRef,
			CommitSHA:    run.TriggerCommitSha,
			CreatedAt:    run.CreatedAt,
		},
		Repository: webhooks.RepositoryPayload{ID: repositoryID},
	}
	if err := s.dispatcher.DispatchEvent(ctx, repositoryID, webhooks.EventTypeWorkflowRun, payload); err != nil {
		return fmt.Errorf("dispatch workflow_run webhook: %w", err)
	}
	return nil
}

// parseJobsFromConfig extracts job definitions from the workflow config JSON.
func parseJobsFromConfig(configJSON json.RawMessage) ([]JobConfig, error) {
	if len(configJSON) == 0 {
		return nil, nil
	}
	if len(configJSON) > maxWorkflowFileBytes {
		return nil, fmt.Errorf("workflow config too large (%d bytes, max %d)", len(configJSON), maxWorkflowFileBytes)
	}

	var cfg WorkflowConfig
	if err := json.Unmarshal(configJSON, &cfg); err != nil {
		return nil, err
	}
	return workflowJobsFromConfig(&cfg), nil
}

// CancelRun cancels an in-progress workflow run and all non-terminal tasks.
func (s *workflowRunService) CancelRun(ctx context.Context, repositoryID, runID int64) error {
	if s.queries == nil {
		return pkgerrors.Internal("workflow run store unavailable")
	}

	if tx, txQueries, transactional, err := BeginWorkflowQueryTx(ctx, s.queries); transactional {
		if err != nil {
			return pkgerrors.Internal("failed to begin workflow run transaction").WithCause(err)
		}
		defer func() { _ = tx.Rollback(context.Background()) }()
		if err := lockWorkflowRunForRepository(ctx, tx, runID, repositoryID); err != nil {
			if stdErrors.Is(err, pgx.ErrNoRows) {
				return pkgerrors.NotFound("workflow run not found")
			}
			return pkgerrors.Internal("failed to lock workflow run").WithCause(err)
		}
		run, err := txQueries.GetWorkflowRun(ctx, db.GetWorkflowRunParams{
			ID:           runID,
			RepositoryID: repositoryID,
		})
		if err != nil {
			if stdErrors.Is(err, pgx.ErrNoRows) {
				return pkgerrors.NotFound("workflow run not found")
			}
			return pkgerrors.Internal("failed to fetch workflow run").WithCause(err)
		}
		if IsTerminalWorkflowRunStatus(run.Status) {
			if err := tx.Commit(ctx); err != nil {
				return pkgerrors.Internal("failed to commit workflow run transaction").WithCause(err)
			}
			return nil
		}
		if err := txQueries.CancelWorkflowTasks(ctx, run.ID); err != nil {
			return pkgerrors.Internal("failed to cancel workflow tasks").WithCause(err)
		}
		if err := txQueries.CancelWorkflowRun(ctx, run.ID); err != nil {
			return pkgerrors.Internal("failed to cancel workflow run").WithCause(err)
		}
		if s.cancelParticipant != nil {
			if err := s.cancelParticipant.CancelWorkflowRunInTx(ctx, tx, run); err != nil {
				return pkgerrors.Internal("failed to cancel the Flow run").WithCause(err)
			}
		}
		if err := tx.Commit(ctx); err != nil {
			return pkgerrors.Internal("failed to commit workflow run transaction").WithCause(err)
		}
		RevokeWorkflowRunCredentials(ctx, s.queries, run.ID, repositoryID)
		s.publishCancelledWorkflowRun(ctx, repositoryID, run)
		return nil
	}

	run, err := s.queries.GetWorkflowRun(ctx, db.GetWorkflowRunParams{
		ID:           runID,
		RepositoryID: repositoryID,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("workflow run not found")
		}
		return pkgerrors.Internal("failed to fetch workflow run").WithCause(err)
	}
	if IsTerminalWorkflowRunStatus(run.Status) {
		return nil
	}
	if s.cancelParticipant != nil && run.ExecutionPlane == WorkflowRunPlaneFlow {
		// A flow-plane run's cancel must commit with its Flow launch's.
		return pkgerrors.Internal("workflow run store cannot cancel a Flow run atomically")
	}

	if err := s.queries.CancelWorkflowRun(ctx, run.ID); err != nil {
		return pkgerrors.Internal("failed to cancel workflow run").WithCause(err)
	}
	if err := s.queries.CancelWorkflowTasks(ctx, run.ID); err != nil {
		return pkgerrors.Internal("failed to cancel workflow tasks").WithCause(err)
	}
	RevokeWorkflowRunCredentials(ctx, s.queries, run.ID, repositoryID)
	s.publishCancelledWorkflowRun(ctx, repositoryID, run)
	return nil
}

func (s *workflowRunService) publishCancelledWorkflowRun(ctx context.Context, repositoryID int64, run db.WorkflowRun) {
	ObserveWorkflowRunCompletion(s.metrics, run, "cancelled")
	if s.commitStatusWriter != nil {
		if _, err := s.commitStatusWriter.UpdateCommitStatusForWorkflowRun(ctx, run.ID, "cancelled", WorkflowRunStatusDescription("cancelled"), ""); err != nil {
			middleware.LoggerWithWorkflowRun(ctx, run.ID).
				Error("failed to update commit status for cancelled workflow run", "repository_id", repositoryID, "error", err)
		}
	}
	if s.checkRunService != nil {
		if err := s.completeGitHubCheckRunForCancellation(ctx, run); err != nil {
			middleware.LoggerWithWorkflowRun(ctx, run.ID).
				Warn("failed to update github check run for cancelled workflow run", "repository_id", repositoryID, "error", err)
		}
	}
}

func (s *workflowRunService) completeGitHubCheckRunForCancellation(ctx context.Context, run db.WorkflowRun) error {
	if s.checkRunService == nil {
		return nil
	}
	if !run.CheckRunID.Valid || run.CheckRunID.Int64 <= 0 {
		return nil
	}

	repository, err := s.queries.GetRepoByID(ctx, run.RepositoryID)
	if err != nil {
		return nil
	}
	owner, repoName, installationID, repositoryID, ok := s.gitHubCheckRunTarget(ctx, repository, s.resolveRepoOwner(ctx, repository))
	if !ok {
		return nil
	}

	_, err = s.checkRunService.UpdateCheckRun(ctx, installationID, repositoryID, owner, repoName, run.CheckRunID.Int64, GitHubCheckRunUpdate{
		Status:     "completed",
		Conclusion: "cancelled",
		Output: &GitHubCheckRunOutput{
			Title:   "Workflow cancelled",
			Summary: fmt.Sprintf("Workflow run #%d was cancelled.", run.ID),
		},
	})
	return err
}

// ResumeRun resumes a cancelled or failed workflow run by re-queuing its
// incomplete (cancelled/failed) tasks and steps, then setting the run status
// back to queued. Only cancelled or failed runs may be resumed.
func (s *workflowRunService) ResumeRun(ctx context.Context, repositoryID, runID int64) error {
	if s.queries == nil {
		return pkgerrors.Internal("workflow run store unavailable")
	}

	if tx, txQueries, transactional, err := BeginWorkflowQueryTx(ctx, s.queries); transactional {
		if err != nil {
			return pkgerrors.Internal("failed to begin workflow run transaction").WithCause(err)
		}
		defer func() { _ = tx.Rollback(context.Background()) }()
		if err := lockWorkflowRunForRepository(ctx, tx, runID, repositoryID); err != nil {
			if stdErrors.Is(err, pgx.ErrNoRows) {
				return pkgerrors.NotFound("workflow run not found")
			}
			return pkgerrors.Internal("failed to lock workflow run").WithCause(err)
		}
		run, err := txQueries.GetWorkflowRun(ctx, db.GetWorkflowRunParams{
			ID:           runID,
			RepositoryID: repositoryID,
		})
		if err != nil {
			if stdErrors.Is(err, pgx.ErrNoRows) {
				return pkgerrors.NotFound("workflow run not found")
			}
			return pkgerrors.Internal("failed to fetch workflow run").WithCause(err)
		}
		if err := rejectUnreplayableRun(run); err != nil {
			return err
		}
		if run.Status != "cancelled" && run.Status != "failure" {
			return pkgerrors.Conflict(fmt.Sprintf("cannot resume workflow run with status %q; only cancelled or failed runs can be resumed", run.Status))
		}
		if err := txQueries.ResumeWorkflowTasks(ctx, run.ID); err != nil {
			return pkgerrors.Internal("failed to resume workflow tasks").WithCause(err)
		}
		if err := txQueries.ResumeWorkflowSteps(ctx, run.ID); err != nil {
			return pkgerrors.Internal("failed to resume workflow steps").WithCause(err)
		}
		if err := txQueries.ResumeWorkflowRun(ctx, run.ID); err != nil {
			return pkgerrors.Internal("failed to resume workflow run").WithCause(err)
		}
		if err := tx.Commit(ctx); err != nil {
			return pkgerrors.Internal("failed to commit workflow run transaction").WithCause(err)
		}
		NotifyWorkflowRunEvent(ctx, s.queries, run.ID, "workflow.resume")
		return nil
	}
	run, err := s.queries.GetWorkflowRun(ctx, db.GetWorkflowRunParams{
		ID:           runID,
		RepositoryID: repositoryID,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("workflow run not found")
		}
		return pkgerrors.Internal("failed to fetch workflow run").WithCause(err)
	}
	if err := rejectUnreplayableRun(run); err != nil {
		return err
	}

	if run.Status != "cancelled" && run.Status != "failure" {
		return pkgerrors.Conflict(fmt.Sprintf("cannot resume workflow run with status %q; only cancelled or failed runs can be resumed", run.Status))
	}

	if err := s.queries.ResumeWorkflowTasks(ctx, run.ID); err != nil {
		return pkgerrors.Internal("failed to resume workflow tasks").WithCause(err)
	}
	if err := s.queries.ResumeWorkflowSteps(ctx, run.ID); err != nil {
		return pkgerrors.Internal("failed to resume workflow steps").WithCause(err)
	}
	if err := s.queries.ResumeWorkflowRun(ctx, run.ID); err != nil {
		return pkgerrors.Internal("failed to resume workflow run").WithCause(err)
	}

	NotifyWorkflowRunEvent(ctx, s.queries, run.ID, "workflow.resume")
	return nil
}

// RerunRun creates a new workflow run based on an existing run.
// It fetches the original run and definition, then dispatches a new run
// with the same configuration.
func (s *workflowRunService) RerunRun(ctx context.Context, input RerunInput) (*WorkflowRunResult, error) {
	if s.queries == nil {
		return nil, pkgerrors.Internal("workflow run store unavailable")
	}

	// Fetch the original run
	originalRun, err := s.queries.GetWorkflowRun(ctx, db.GetWorkflowRunParams{
		ID:           input.RunID,
		RepositoryID: input.RepositoryID,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return nil, pkgerrors.NotFound("workflow run not found")
		}
		return nil, pkgerrors.Internal("failed to fetch workflow run").WithCause(err)
	}
	if err := rejectUnreplayableRun(originalRun); err != nil {
		return nil, err
	}

	// Fetch the workflow definition
	def, err := s.queries.GetWorkflowDefinition(ctx, db.GetWorkflowDefinitionParams{
		ID:           originalRun.WorkflowDefinitionID,
		RepositoryID: input.RepositoryID,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return nil, pkgerrors.NotFound("workflow definition not found")
		}
		return nil, pkgerrors.Internal("failed to fetch workflow definition").WithCause(err)
	}

	// The definition row is mutable: sync overwrote its config on every push
	// since the original run. The rerun checks out the original commit, so its
	// tasks must come from the workflow file at that commit.
	if !isImmutableGitObjectID(originalRun.TriggerCommitSha) {
		return nil, pkgerrors.Conflict("original workflow revision is unavailable")
	}
	config, err := s.loadDefinitionConfigAtCommit(ctx, input.RepositoryID, originalRun.TriggerCommitSha, def.Path, "original workflow", "original revision")
	if err != nil {
		return nil, err
	}

	// Reconstruct dispatch inputs from the original run.
	var inputs map[string]interface{}
	if len(originalRun.DispatchInputs) > 0 {
		if err := json.Unmarshal(originalRun.DispatchInputs, &inputs); err != nil {
			slog.Warn("rerun refused: stored dispatch inputs are not a JSON object", "run_id", originalRun.ID, "error", err)
			return nil, pkgerrors.Conflict("the original run's dispatch inputs are not a JSON object, so a rerun cannot reproduce them")
		}
	}

	// Create a new run using the same trigger details as the original
	result, err := s.createRunForDefinition(ctx, def, config, DispatchForEventInput{
		RepositoryID: input.RepositoryID,
		UserID:       input.UserID,
		Event: TriggerEvent{
			Type:      replayedEventType(originalRun.TriggerEvent),
			Ref:       originalRun.TriggerRef,
			CommitSHA: originalRun.TriggerCommitSha,
			Inputs:    inputs,
		},
		SystemPush: originalRun.TriggerEvent == SystemPushTriggerEvent,
	})
	if err != nil {
		return nil, err
	}

	return &result, nil
}

func rejectUnreplayableRun(run db.WorkflowRun) error {
	if run.TriggerEvent == AlertRemediationTriggerEvent {
		return pkgerrors.Conflict("internal alert remediation runs cannot be resumed or rerun")
	}
	// No queue claims a flow-plane run: its Flow launch was its only
	// executor, so a replay is a new invocation.
	if run.ExecutionPlane == WorkflowRunPlaneFlow {
		return pkgerrors.Conflict("an invoked flow run cannot be resumed or rerun; invoke the flow again")
	}
	return nil
}
