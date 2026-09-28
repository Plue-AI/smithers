package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/ownership"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

const (
	// landingClaimAdvisoryLockKey serializes ClaimPendingLandingTask across all
	// worker replicas. The claim query's per-repo NOT EXISTS(status='running')
	// guard is not race-safe under READ COMMITTED: two concurrent claimers can
	// each lock a different pending task for the same repo before either
	// commits, breaking the one-running-landing-per-repo invariant.
	landingClaimAdvisoryLockKey int64 = 0x6C616E64696E6771 // "landingq"

	// landingTaskLease is how long a landing task may stay 'running' before the
	// reaper treats its worker as dead and reclaims it. It must exceed the
	// worst-case legitimate runtime (landChangesTimeout plus DB finalization).
	landingTaskLease = 15 * time.Minute

	// landingTaskMaxAttempts bounds reclaim retries; past it the task and its
	// landing request are marked failed so the repo queue can drain.
	landingTaskMaxAttempts = 3

	// landingReapInterval throttles the stale-task sweep in the poll loop.
	landingReapInterval = 30 * time.Second

	// landChangesTimeout bounds the repo-host land call so a live worker can
	// never outrun landingTaskLease and get its task double-claimed.
	landChangesTimeout = 10 * time.Minute

	// landingFinalizeAttempts is how many times the post-land DB writes are
	// retried before the task is left 'running' for the reaper.
	landingFinalizeAttempts = 5
)

// errPostLandFinalize marks failures that happen after repo-host LandChanges
// has succeeded. The landing must not be reported as failed at that point: the
// changes are already on the target bookmark.
var errPostLandFinalize = errors.New("landing finalization failed after changes landed")

// LandingWorkerQuerier contains the database methods needed by the landing
// queue worker. Keeping a separate interface from LandingQuerier avoids
// coupling the worker to the full service.
type LandingWorkerQuerier interface {
	ClaimPendingLandingTask(ctx context.Context) (db.LandingTask, error)
	GetLandingRequestByID(ctx context.Context, id int64) (db.LandingRequest, error)
	ListLandingRequestChanges(ctx context.Context, arg db.ListLandingRequestChangesParams) ([]db.LandingRequestChange, error)
	GetRepoByID(ctx context.Context, id int64) (db.Repository, error)
	GetUserByID(ctx context.Context, id int64) (db.User, error)
	GetOrgByID(ctx context.Context, id int64) (db.Organization, error)
	ListAllProtectedBookmarksByRepo(ctx context.Context, repositoryID int64) ([]db.ProtectedBookmark, error)
	GetRepositoryCiLandingPolicy(ctx context.Context, repositoryID int64) (db.GetRepositoryCiLandingPolicyRow, error)
	GetLatestCommitStatusesByChangeIDsAndContexts(ctx context.Context, arg db.GetLatestCommitStatusesByChangeIDsAndContextsParams) ([]db.GetLatestCommitStatusesByChangeIDsAndContextsRow, error)
	CountUnresolvedLandingRequestThreads(ctx context.Context, landingRequestID int64) (int64, error)
	ListChangesRequestedLandingReviewers(ctx context.Context, landingRequestID int64) ([]string, error)
	MarkLandingStarted(ctx context.Context, id int64) (db.LandingRequest, error)
	MergeLandingRequest(ctx context.Context, id int64) (db.LandingRequest, error)
	MarkLandingTaskDone(ctx context.Context, id int64) (db.LandingTask, error)
	MarkLandingRequestFailed(ctx context.Context, id int64) (db.LandingRequest, error)
	FailLandingTask(ctx context.Context, arg db.FailLandingTaskParams) (db.LandingTask, error)
	DeferHeldLanding(ctx context.Context, arg db.DeferHeldLandingParams) (db.DeferHeldLandingRow, error)
}

type landingIssueFixer interface {
	FixIssuesForLanding(context.Context, db.FixIssuesForLandingParams) ([]int64, error)
}

type AutoLandProcessor interface {
	ProcessNextAutoLand(context.Context) error
}

// StaleLandingTask identifies a reclaimed landing task whose attempts are
// exhausted, so its landing request must be marked failed.
type StaleLandingTask struct {
	TaskID           int64
	LandingRequestID int64
}

// LandingTaskStore provides the landing-task operations that need raw SQL or
// an explicit transaction beyond the sqlc-generated LandingWorkerQuerier: the
// serialized claim and the stale-running-task reclaim sweep.
type LandingTaskStore interface {
	// ClaimPendingLandingTask claims the next pending task while holding an
	// advisory lock so concurrent replicas cannot both start a landing for the
	// same repository. Returns pgx.ErrNoRows when no task is claimable.
	ClaimPendingLandingTask(ctx context.Context) (db.LandingTask, error)
	// FailStaleLandingTasks marks running tasks whose lease expired and whose
	// attempts are exhausted as failed, returning them for landing-request
	// cleanup.
	FailStaleLandingTasks(ctx context.Context, lease time.Duration, maxAttempts int32) ([]StaleLandingTask, error)
	// RequeueStaleLandingTasks resets running tasks whose lease expired but
	// that still have attempts left back to pending, returning how many were
	// requeued.
	RequeueStaleLandingTasks(ctx context.Context, lease time.Duration, maxAttempts int32) (int64, error)
}

// pgxLandingTaskStore is the production LandingTaskStore backed by pgxpool.
type pgxLandingTaskStore struct {
	pool *pgxpool.Pool
}

// NewPgxLandingTaskStore returns the production LandingTaskStore.
func NewPgxLandingTaskStore(pool *pgxpool.Pool) LandingTaskStore {
	return &pgxLandingTaskStore{pool: pool}
}

func (s *pgxLandingTaskStore) ClaimPendingLandingTask(ctx context.Context) (db.LandingTask, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return db.LandingTask{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", landingClaimAdvisoryLockKey); err != nil {
		return db.LandingTask{}, err
	}
	task, err := db.New(tx).ClaimPendingLandingTask(ctx)
	if err != nil {
		return db.LandingTask{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return db.LandingTask{}, err
	}
	return task, nil
}

func (s *pgxLandingTaskStore) FailStaleLandingTasks(ctx context.Context, lease time.Duration, maxAttempts int32) ([]StaleLandingTask, error) {
	rows, err := s.pool.Query(ctx, `
		UPDATE landing_tasks
		SET status = 'failed',
		    last_error = 'landing task lease expired (worker crashed or shut down) and attempts are exhausted',
		    finished_at = NOW(),
		    updated_at = NOW()
		WHERE status = 'running'
		  AND started_at < NOW() - make_interval(secs => $1)
		  AND attempt >= $2
		RETURNING id, landing_request_id`,
		lease.Seconds(), maxAttempts,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var stale []StaleLandingTask
	for rows.Next() {
		var st StaleLandingTask
		if err := rows.Scan(&st.TaskID, &st.LandingRequestID); err != nil {
			return nil, err
		}
		stale = append(stale, st)
	}
	return stale, rows.Err()
}

func (s *pgxLandingTaskStore) RequeueStaleLandingTasks(ctx context.Context, lease time.Duration, maxAttempts int32) (int64, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE landing_tasks
		SET status = CASE WHEN append_request IS NULL THEN 'pending' ELSE 'append_pending' END,
		    available_at = NOW(),
		    updated_at = NOW()
		WHERE status = 'running'
		  AND started_at < NOW() - make_interval(secs => $1)
		  AND attempt < $2`,
		lease.Seconds(), maxAttempts,
	)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// LandingWorkerRepoHostClient is the subset of repo-host methods needed by the
// landing worker.
type LandingWorkerRepoHostClient interface {
	LandChanges(ctx context.Context, owner, repo string, req repohost.LandRequest) (repohost.LandResult, error)
}

type landingWorkerOwnershipQueries interface {
	ownershipQueries
	UpsertChange(ctx context.Context, arg db.UpsertChangeParams) (db.Change, error)
	CountApprovedLandingRequestReviews(ctx context.Context, landingRequestID int64) (int64, error)
	CountCurrentApprovedLandingRequestReviews(ctx context.Context, arg db.CountCurrentApprovedLandingRequestReviewsParams) (int64, error)
	CountCurrentAgentLandingReviewCommits(ctx context.Context, arg db.CountCurrentAgentLandingReviewCommitsParams) (int64, error)
}

type landingWorkerOwnershipRepoHost interface {
	ownershipRepoHost
	GetChange(ctx context.Context, owner, repo, changeID string) (repohost.Change, error)
	GetChangeFiles(ctx context.Context, owner, repo, changeID string) ([]repohost.ChangeFile, error)
	ListBookmarks(ctx context.Context, owner, repo string, cursor string, limit int) ([]repohost.Bookmark, string, error)
}

// LandingWorkerOption configures optional dependencies on LandingWorker.
type LandingWorkerOption func(*LandingWorker)

func WithLandingWorkerMetrics(metrics LandingMetricsObserver) LandingWorkerOption {
	return func(w *LandingWorker) { w.metrics = metrics }
}

func (w *LandingWorker) observeLanding(operation string) {
	if w.metrics != nil {
		w.metrics.ObserveLandingOperation(operation)
	}
}

// WithLandingWorkerWebhookDispatcher wires a webhook Dispatcher into the
// LandingWorker so it can fire "landed" and "failed" events after the merge
// completes or fails.
func WithLandingWorkerWebhookDispatcher(d webhooks.Dispatcher) LandingWorkerOption {
	return func(w *LandingWorker) {
		w.dispatcher = d
	}
}

// WithLandingWorkerTaskStore wires a LandingTaskStore into the LandingWorker,
// enabling the race-safe serialized claim and the stale-running-task reaper.
// Production wiring must always provide it.
func WithLandingWorkerTaskStore(s LandingTaskStore) LandingWorkerOption {
	return func(w *LandingWorker) {
		w.taskStore = s
	}
}

func WithLandingWorkerAutoLandProcessor(processor AutoLandProcessor) LandingWorkerOption {
	return func(w *LandingWorker) { w.autoLandProcessor = processor }
}

// LandingWorker polls for pending landing tasks and executes them.
type LandingWorker struct {
	metrics            LandingMetricsObserver
	queries            LandingWorkerQuerier
	repoHost           LandingWorkerRepoHostClient
	taskStore          LandingTaskStore
	dispatcher         webhooks.Dispatcher
	autoLandProcessor  AutoLandProcessor
	logger             *slog.Logger
	interval           time.Duration
	landTimeout        time.Duration
	finalizeRetryDelay time.Duration
	nextReap           time.Time
}

// NewLandingWorker creates a LandingWorker with default settings.
func NewLandingWorker(q LandingWorkerQuerier, rh LandingWorkerRepoHostClient, opts ...LandingWorkerOption) *LandingWorker {
	w := &LandingWorker{
		queries:            q,
		repoHost:           rh,
		logger:             slog.Default(),
		interval:           2 * time.Second,
		landTimeout:        landChangesTimeout,
		finalizeRetryDelay: 500 * time.Millisecond,
	}
	for _, opt := range opts {
		if opt != nil {
			opt(w)
		}
	}
	return w
}

// Start runs the polling loop until ctx is cancelled.
func (w *LandingWorker) Start(ctx context.Context) {
	w.logger.Info("landing worker started")
	for {
		if err := w.PollOnce(ctx); err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				w.logger.Info("landing worker stopping", "reason", err)
				return
			}
			w.logger.Error("landing worker poll error", "error", err)
		}

		select {
		case <-ctx.Done():
			w.logger.Info("landing worker stopped")
			return
		case <-time.After(w.interval):
		}
	}
}

// PollOnce attempts to claim and process one landing task, reaping stale
// running tasks first.
func (w *LandingWorker) PollOnce(ctx context.Context) error {
	if w.taskStore != nil && time.Now().After(w.nextReap) {
		w.nextReap = time.Now().Add(landingReapInterval)
		w.reapStaleTasks(ctx)
	}
	if w.autoLandProcessor != nil {
		if err := w.autoLandProcessor.ProcessNextAutoLand(ctx); err != nil {
			w.logger.Error("failed to process auto-land intent", "error", err)
		}
	}

	task, err := w.claimTask(ctx)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil // no work available
		}
		return fmt.Errorf("claim landing task: %w", err)
	}

	w.logger.Info("claimed landing task",
		"task_id", task.ID,
		"landing_request_id", task.LandingRequestID,
		"repository_id", task.RepositoryID,
	)

	if err := w.executeTask(ctx, task); err != nil {
		if errors.Is(err, errPostLandFinalize) {
			// The changes already landed on the target bookmark; marking the
			// landing request failed would contradict repository reality. Leave
			// the task 'running' so the reaper reclaims it once its lease
			// expires and the merge is recorded then.
			w.logger.Error("landing succeeded but finalization failed; leaving task for reclaim",
				"task_id", task.ID,
				"landing_request_id", task.LandingRequestID,
				"error", err,
			)
			return nil
		}
		if delay, held := repohost.HeldRetryAfter(err); held {
			w.deferHeldTask(ctx, task, delay, err)
			return nil
		}
		w.logger.Error("landing task failed",
			"task_id", task.ID,
			"landing_request_id", task.LandingRequestID,
			"error", err,
		)
		w.handleFailure(ctx, task, err)
		return nil // failure handled, don't propagate
	}

	return nil
}

// claimTask claims the next pending landing task, preferring the serialized
// task-store claim that is race-safe across concurrent worker replicas.
func (w *LandingWorker) claimTask(ctx context.Context) (db.LandingTask, error) {
	if w.taskStore != nil {
		return w.taskStore.ClaimPendingLandingTask(ctx)
	}
	return w.queries.ClaimPendingLandingTask(ctx)
}

// reapStaleTasks reclaims landing tasks stuck in 'running' after a worker
// crash or shutdown. Without it, the claim query's one-running-per-repo guard
// blocks the whole repository's landing queue forever. Tasks with attempts
// left go back to 'pending'; exhausted ones are failed together with their
// landing request so it can be re-landed.
func (w *LandingWorker) reapStaleTasks(ctx context.Context) {
	stale, err := w.taskStore.FailStaleLandingTasks(ctx, landingTaskLease, landingTaskMaxAttempts)
	if err != nil {
		w.logger.Error("failed to fail stale landing tasks", "error", err)
	}
	for _, st := range stale {
		if _, err := w.queries.MarkLandingRequestFailed(ctx, st.LandingRequestID); err != nil {
			w.logger.Error("failed to mark landing request failed after stale task reclaim",
				"task_id", st.TaskID,
				"landing_request_id", st.LandingRequestID,
				"error", err,
			)
			continue
		}
		w.observeLanding("fail")
		w.logger.Warn("failed stale landing task; attempts exhausted",
			"task_id", st.TaskID,
			"landing_request_id", st.LandingRequestID,
		)
	}

	requeued, err := w.taskStore.RequeueStaleLandingTasks(ctx, landingTaskLease, landingTaskMaxAttempts)
	if err != nil {
		w.logger.Error("failed to requeue stale landing tasks", "error", err)
		return
	}
	if requeued > 0 {
		w.logger.Warn("requeued stale landing tasks", "count", requeued)
	}
}

// executeTask performs the full landing: mark started -> land changes -> merge -> mark done -> dispatch webhook.
func (w *LandingWorker) executeTask(ctx context.Context, task db.LandingTask) error {
	lr, err := w.queries.GetLandingRequestByID(ctx, task.LandingRequestID)
	if err != nil {
		return fmt.Errorf("get landing request: %w", err)
	}

	// A reclaimed task can belong to a landing request whose merge was already
	// recorded (the previous worker died between MergeLandingRequest and
	// MarkLandingTaskDone). Never land those changes a second time.
	if lr.State == landingStateMerged {
		if err := w.fixLinkedIssues(ctx, lr); err != nil {
			return fmt.Errorf("%w: fix linked issues: %v", errPostLandFinalize, err)
		}
		if _, err := w.queries.MarkLandingTaskDone(ctx, task.ID); err != nil {
			return fmt.Errorf("%w: mark already-merged task done: %v", errPostLandFinalize, err)
		}
		w.logger.Info("landing task already merged; marked done without re-landing",
			"task_id", task.ID,
			"landing_request_id", task.LandingRequestID,
		)
		return nil
	}

	changes, err := w.queries.ListLandingRequestChanges(ctx, db.ListLandingRequestChangesParams{
		LandingRequestID: task.LandingRequestID,
		PageOffset:       0,
		PageSize:         maxLandingStackChanges + 1,
	})
	if err != nil {
		return fmt.Errorf("list landing changes: %w", err)
	}
	if len(changes) > maxLandingStackChanges {
		return fmt.Errorf("landing request has more than %d changes; refusing to land a partial stack", maxLandingStackChanges)
	}

	changeIDs := make([]string, len(changes))
	for i, c := range changes {
		changeIDs[i] = c.ChangeID
	}

	repo, err := w.queries.GetRepoByID(ctx, task.RepositoryID)
	if err != nil {
		return fmt.Errorf("get repository: %w", err)
	}
	ownerName, err := w.resolveRepoOwner(ctx, repo)
	if err != nil {
		return fmt.Errorf("resolve repo owner: %w", err)
	}
	appendRequest, err := decodeLandingAppend(task, lr)
	if err != nil {
		return err
	}
	if appendRequest != nil {
		recovered, err := lookupLandingAppend(ctx, w.repoHost, ownerName, repo.Name, *appendRequest)
		if _, held := repohost.HeldRetryAfter(err); held {
			// The held repository answered nothing; the next attempt looks again.
			return fmt.Errorf("look up append receipt: %w", err)
		}
		if err != nil {
			return fmt.Errorf("%w: append receipt is unconfirmed: %v", errPostLandFinalize, err)
		}
		if recovered {
			return w.finalizeTask(ctx, task, lr, repo, changeIDs)
		}
	}
	unresolvedThreads, err := w.queries.CountUnresolvedLandingRequestThreads(ctx, lr.ID)
	if err != nil {
		return fmt.Errorf("count unresolved review comments: %w", err)
	}
	if unresolvedThreads > 0 {
		return fmt.Errorf("landing request has %d unresolved review comments", unresolvedThreads)
	}
	changesRequested, err := changesRequestedBlocks(ctx, w.queries, lr.ID)
	if err != nil {
		return err
	}
	if len(changesRequested) > 0 {
		return errors.New(changesRequestedMessage(changesRequested))
	}

	// Re-check required status checks right before landing: statuses may have
	// regressed (or a required check may have been added) while the task sat
	// in the queue behind other landings.
	rules, err := w.queries.ListAllProtectedBookmarksByRepo(ctx, repo.ID)
	if err != nil {
		return fmt.Errorf("list protected bookmarks: %w", err)
	}
	requiredHumanApprovals, requireAgentLGTM, protectedContexts, err := landingProtectionRequirements(rules, lr.TargetBookmark)
	if err != nil {
		return fmt.Errorf("evaluate protected bookmark rules: %w", err)
	}
	requiredContexts := unionLandingStatusContexts(protectedContexts, repo.LandingQueueRequiredChecks)
	// A registered repository CI policy gates the landings the repository's own
	// automation authored. A human landing in the same repository is untouched.
	if appendRequest != nil || lr.AgentAuthored {
		ci, err := w.queries.GetRepositoryCiLandingPolicy(ctx, repo.ID)
		switch {
		case err == nil:
			requiredContexts = unionLandingStatusContexts(requiredContexts, []string{repositoryCiRequiredContext(ci.ID, ci.Revision, ci.Digest)})
		case errors.Is(err, pgx.ErrNoRows):
			// A missing row is no policy. A failed read is not.
		default:
			return fmt.Errorf("read repository CI policy: %w", err)
		}
	}

	pinnedRevisions := make(map[string]string, len(changeIDs))
	if err := w.recheckOwnershipAt(ctx, repo, ownerName, lr, changeIDs, rules, requiredHumanApprovals, requireAgentLGTM, appendRequest, pinnedRevisions); err != nil {
		return fmt.Errorf("ownership gate: %w", err)
	}

	if len(requiredContexts) > 0 {
		failing, err := failingLandingStatusContexts(ctx, w.queries, repo.ID, changeIDs, requiredContexts, pinnedRevisions)
		if err != nil {
			return fmt.Errorf("check required statuses: %w", err)
		}
		if len(failing) > 0 {
			return fmt.Errorf("required status checks are not passing: %s", strings.Join(failing, ", "))
		}
	}

	if appendRequest != nil {
		if len(changeIDs) != len(appendRequest.ChangeIDs) {
			return fmt.Errorf("append stack changed after enqueue")
		}
		for i, id := range changeIDs {
			if pinnedRevisions[id] != appendRequest.ChangeIDs[i] {
				return fmt.Errorf("append revision changed after enqueue")
			}
		}
	}
	_, err = w.queries.MarkLandingStarted(ctx, lr.ID)
	if err != nil {
		return fmt.Errorf("mark landing started: %w", err)
	}

	// Cancellation is still honored through validation and MarkLandingStarted.
	// Once repo-host landing begins, keep the storage result and the DB
	// finalization on cancellation-independent bounded contexts so shutdown
	// cannot report a landed stack as failed.
	landCtx, cancelLand, err := beginRepoHostMutationConsistency(ctx, w.landTimeout)
	if err != nil {
		return fmt.Errorf("begin land changes: %w", err)
	}
	revisions := make([]string, len(changeIDs))
	for i, id := range changeIDs {
		revisions[i] = id
		if commit := pinnedRevisions[id]; commit != "" {
			revisions[i] = commit
		}
	}
	landRequest := repohost.LandRequest{ChangeIDs: revisions, TargetBookmark: lr.TargetBookmark}
	if appendRequest != nil {
		landRequest = *appendRequest
	}
	_, err = w.repoHost.LandChanges(landCtx, ownerName, repo.Name, landRequest)
	cancelLand()
	if err != nil {
		if _, held := repohost.HeldRetryAfter(err); held {
			// repo-host refused before landing anything: queue it again.
			return fmt.Errorf("land changes: %w", err)
		}
		if appendRequest != nil {
			var status *repohost.StatusError
			if !errors.As(err, &status) || (status.StatusCode != 400 && status.StatusCode != 409 && status.StatusCode != 422) {
				// A lost storage ACK is not a failed landing. Preserve the task
				// for the existing lease/reaper to recover its exact receipt.
				return fmt.Errorf("%w: append outcome unconfirmed: %v", errPostLandFinalize, err)
			}
		}
		return fmt.Errorf("land changes: %w", err)
	}

	return w.finalizeTask(ctx, task, lr, repo, changeIDs)
}

func (w *LandingWorker) finalizeTask(ctx context.Context, task db.LandingTask, lr db.LandingRequest, repo db.Repository, changeIDs []string) error {
	// The land is irreversible from here on: record the outcome on a context
	// that survives worker shutdown and retry transient DB errors instead of
	// ever reporting the landed request as failed.
	finalizeCtx, cancelFinalize := context.WithTimeout(context.WithoutCancel(ctx), time.Minute)
	defer cancelFinalize()

	mergedLR, err := retryLandingFinalize(finalizeCtx, w.finalizeRetryDelay, func(ctx context.Context) (db.LandingRequest, error) {
		return w.queries.MergeLandingRequest(ctx, lr.ID)
	})
	if err != nil {
		return fmt.Errorf("%w: merge landing request: %v", errPostLandFinalize, err)
	}
	w.observeLanding("merge")
	if err := w.fixLinkedIssues(finalizeCtx, mergedLR); err != nil {
		return fmt.Errorf("%w: fix linked issues: %v", errPostLandFinalize, err)
	}

	if _, err := retryLandingFinalize(finalizeCtx, w.finalizeRetryDelay, func(ctx context.Context) (db.LandingTask, error) {
		return w.queries.MarkLandingTaskDone(ctx, task.ID)
	}); err != nil {
		return fmt.Errorf("%w: mark task done: %v", errPostLandFinalize, err)
	}

	w.logger.Info("landing task completed",
		"task_id", task.ID,
		"landing_request_id", task.LandingRequestID,
		"landed_changes", len(changeIDs),
	)

	// Dispatch "landed" webhook AFTER the merge has succeeded and the task is done.
	w.dispatchLandedEvent(finalizeCtx, repo, mergedLR, changeIDs)

	return nil
}

func (w *LandingWorker) fixLinkedIssues(ctx context.Context, landing db.LandingRequest) error {
	fixer, ok := w.queries.(landingIssueFixer)
	if !ok {
		return nil
	}
	_, err := retryLandingFinalize(ctx, w.finalizeRetryDelay, func(ctx context.Context) ([]int64, error) {
		return fixer.FixIssuesForLanding(ctx, db.FixIssuesForLandingParams{
			LandingRequestID:      landing.ID,
			FixedByID:             pgtype.Int8{Int64: landing.AuthorID, Valid: true},
			FixedByAgentSessionID: uuidString(landing.AuthorAgentSessionID),
		})
	})
	return err
}

// recheckOwnership evaluates the target bookmark and current change revisions
// immediately before the irreversible land call. The type assertions keep
// legacy test doubles source-compatible; production always wires *db.Queries
// and *repohost.Client, which implement both contracts.
func (w *LandingWorker) recheckOwnership(ctx context.Context, repository db.Repository, owner string, lr db.LandingRequest, changeIDs []string, rules []db.ProtectedBookmark, requiredHumanApprovals int64, requireAgentLGTM bool, pinned ...map[string]string) error {
	return w.recheckOwnershipAt(ctx, repository, owner, lr, changeIDs, rules, requiredHumanApprovals, requireAgentLGTM, nil, pinned...)
}
func (w *LandingWorker) recheckOwnershipAt(ctx context.Context, repository db.Repository, owner string, lr db.LandingRequest, changeIDs []string, rules []db.ProtectedBookmark, requiredHumanApprovals int64, requireAgentLGTM bool, exact *repohost.LandRequest, pinned ...map[string]string) error {
	q, qOK := w.queries.(landingWorkerOwnershipQueries)
	rh, rhOK := w.repoHost.(landingWorkerOwnershipRepoHost)
	outsider, err := isOutsiderLanding(ctx, w.queries, lr.ID)
	if err != nil {
		return err
	}
	if !qOK || !rhOK {
		if exact != nil || outsider || agentLandingOntoDefault(repository, lr.AgentAuthored, lr.TargetBookmark) {
			return fmt.Errorf("append requires the complete ownership inspection capability")
		}
		return nil
	}
	touched := make([]OwnershipTouchedFile, 0)
	currentCommitIDs := make([]string, 0, len(changeIDs))
	seenCommitIDs := make(map[string]struct{}, len(changeIDs))
	exactPins := make(map[string]string, len(changeIDs))
	if exact != nil && len(exact.ChangeIDs) != len(changeIDs) {
		return fmt.Errorf("append stack changed after enqueue")
	}
	for i, changeID := range changeIDs {
		selector := changeID
		if exact != nil {
			selector = exact.ChangeIDs[i]
		}
		change, err := rh.GetChange(ctx, owner, repository.Name, selector)
		if err != nil {
			return err
		}
		if exact != nil && (change.CommitID != selector || change.ChangeID != changeID || change.HasConflict) {
			return fmt.Errorf("append immutable revision does not match reviewed native identity")
		}
		exactPins[changeID] = change.CommitID
		if len(pinned) > 0 {
			pinned[0][changeID] = change.CommitID
		}
		parents, err := json.Marshal(change.ParentChangeIDs)
		if err != nil {
			return err
		}
		stored, err := q.UpsertChange(ctx, db.UpsertChangeParams{RepositoryID: repository.ID, ChangeID: change.ChangeID, CommitID: change.CommitID, Description: change.Description, AuthorName: change.AuthorName, AuthorEmail: change.AuthorEmail, HasConflict: change.HasConflict, IsEmpty: change.IsEmpty, ParentChangeIds: parents})
		if err != nil {
			return err
		}
		if _, seen := seenCommitIDs[change.CommitID]; change.CommitID != "" && !seen {
			seenCommitIDs[change.CommitID] = struct{}{}
			currentCommitIDs = append(currentCommitIDs, change.CommitID)
		}
		files, err := rh.GetChangeFiles(ctx, owner, repository.Name, change.CommitID)
		if err != nil {
			return err
		}
		for _, file := range files {
			touched = append(touched, OwnershipTouchedFile{Path: file.Path, ChangeID: changeID, CommitID: change.CommitID, RevisionSeq: stored.RevisionSeq})
		}
	}
	dismiss, err := landingDismissStaleReviews(rules, lr.TargetBookmark)
	if err != nil {
		return err
	}
	// personApprovals counts the people who approved: of exactly the pinned
	// revisions for an append, of the current ones when current, else any.
	personApprovals := func(current bool) (int64, error) {
		switch {
		case exact != nil:
			approvals, err := q.ListSubmittedLandingApprovals(ctx, lr.ID)
			if err != nil {
				return 0, err
			}
			seen := map[int64]bool{}
			for _, approval := range approvals {
				var revisions map[string]approvalRevision
				if !approval.ReviewerID.Valid || json.Unmarshal(approval.ChangeRevisions, &revisions) != nil {
					continue
				}
				matches := true
				for id, commit := range exactPins {
					if revisions[id].CommitID != commit {
						matches = false
						break
					}
				}
				if matches {
					seen[approval.ReviewerID.Int64] = true
				}
			}
			return int64(len(seen)), nil
		case current:
			return q.CountCurrentApprovedLandingRequestReviews(ctx, db.CountCurrentApprovedLandingRequestReviewsParams{LandingRequestID: lr.ID, RepositoryID: repository.ID})
		default:
			return q.CountApprovedLandingRequestReviews(ctx, lr.ID)
		}
	}
	if agentLandingOntoDefault(repository, lr.AgentAuthored, lr.TargetBookmark) {
		count, err := personApprovals(true)
		if err != nil {
			return err
		}
		if count == 0 {
			return errors.New(agentLandingApprovalReason)
		}
	}
	if requiredHumanApprovals > 0 {
		count, err := personApprovals(dismiss)
		if err != nil {
			return err
		}
		if count < requiredHumanApprovals {
			return fmt.Errorf("missing required human approval")
		}
	}
	// agentLGTMs reports whether a named reviewer agent's LGTM covers every
	// current commit (D-22).
	agentLGTMs := func() (bool, error) {
		if len(currentCommitIDs) == 0 {
			return false, nil
		}
		reviewers, err := repositoryReviewerAgents(ctx, rh, owner, repository)
		if err != nil {
			return false, err
		}
		count, err := q.CountCurrentAgentLandingReviewCommits(ctx, db.CountCurrentAgentLandingReviewCommitsParams{LandingRequestID: lr.ID, CommitIds: currentCommitIDs, ReviewerLogins: reviewers})
		return count == int64(len(currentCommitIDs)), err
	}
	if requireAgentLGTM {
		ok, err := agentLGTMs()
		if err != nil {
			return err
		}
		if !ok {
			return fmt.Errorf("missing current agent LGTM")
		}
	}
	targetRevision := ""
	if exact != nil && exact.ExpectedCommitID != nil {
		targetRevision = *exact.ExpectedCommitID
	} else {
		targetRevision, err = workerTargetBookmarkRevision(ctx, rh, owner, repository.Name, lr.TargetBookmark)
	}
	if err != nil {
		return err
	}
	touchedPaths := make([]string, 0, len(touched))
	for _, file := range touched {
		touchedPaths = append(touchedPaths, file.Path)
	}
	if outsider {
		if err := refuseProtectedPaths(ctx, rh, owner, repository.Name, targetRevision, touchedPaths); err != nil {
			return err
		}
	}
	resolved, err := resolveChangeOwnership(ctx, q, rh, repository.ID, owner, repository.Name, targetRevision, touched, lr.ID, exact != nil)
	if err != nil {
		return err
	}
	approvals, err := loadOwnershipApprovals(ctx, q, repository.ID, lr.ID)
	if err != nil {
		return err
	}
	var agentLGTMCurrent *bool
	for _, item := range resolved.TouchedPaths {
		candidates := approvingCandidates(item.Owners)
		if lr.AgentAuthored && item.AgentPolicy == ownership.PolicyDeny {
			return fmt.Errorf("agent policy denies %s", item.Path)
		}
		if len(candidates) == 0 || item.SatisfiedBy != nil {
			continue
		}
		if dismiss, _ := landingDismissStaleReviews(rules, lr.TargetBookmark); exact == nil && !dismiss && anyPrincipalApproval(approvals, item.Owners) {
			continue
		}
		if lr.AgentAuthored && item.AgentPolicy == ownership.PolicyAutoLand {
			if agentLGTMCurrent == nil {
				ok, err := agentLGTMs()
				if err != nil {
					return err
				}
				agentLGTMCurrent = &ok
			}
			if *agentLGTMCurrent {
				continue
			}
		}
		return fmt.Errorf("missing owner approval for %s (candidates: %s)", item.Path, strings.Join(candidates, ", "))
	}
	return nil
}

func workerTargetBookmarkRevision(ctx context.Context, rh landingWorkerOwnershipRepoHost, owner, repo, target string) (string, error) {
	cursor := ""
	for {
		bookmarks, next, err := rh.ListBookmarks(ctx, owner, repo, cursor, 100)
		if err != nil {
			return "", err
		}
		for _, bookmark := range bookmarks {
			if bookmark.Name == target && bookmark.TargetChangeID != "" {
				return bookmark.TargetChangeID, nil
			}
		}
		if next == "" {
			return "", fmt.Errorf("target bookmark does not exist")
		}
		cursor = next
	}
}

// retryLandingFinalize retries a post-land database write with exponential
// backoff. These writes are idempotent unconditional updates; a transient
// failure must not surface as a landing failure (see errPostLandFinalize).
func retryLandingFinalize[T any](ctx context.Context, delay time.Duration, op func(context.Context) (T, error)) (T, error) {
	var zero T
	var lastErr error
	for attempt := 0; attempt < landingFinalizeAttempts; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return zero, lastErr
			case <-time.After(delay << (attempt - 1)):
			}
		}
		v, err := op(ctx)
		if err == nil {
			return v, nil
		}
		lastErr = err
	}
	return zero, lastErr
}

// handleFailure marks the landing request as failed, marks the task as failed,
// and dispatches a "failed" webhook event.
// heldLandingMaxDelay bounds how long a landing into a held repository waits
// before it is tried again, whatever repo-host's Retry-After says.
const heldLandingMaxDelay = time.Minute

// deferHeldTask queues a landing its repository's host refused while holding
// the repository: the task is tried again after delay (at least a second, at
// most heldLandingMaxDelay) without spending an attempt, and the landing
// request is queued again rather than failed.
func (w *LandingWorker) deferHeldTask(ctx context.Context, task db.LandingTask, delay time.Duration, taskErr error) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancel()
	delay = min(max(delay, time.Second), heldLandingMaxDelay)
	_, err := w.queries.DeferHeldLanding(ctx, db.DeferHeldLandingParams{
		TaskID: task.ID, LastError: taskErr.Error(), DelaySeconds: delay.Seconds(),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		// No longer running (the reaper took it back): it is queued already.
		w.logger.Warn("landing into a held repository was already queued again", "task_id", task.ID)
		return
	}
	if err != nil {
		w.logger.Error("failed to queue a landing into a held repository again; failing it",
			"task_id", task.ID, "landing_request_id", task.LandingRequestID, "error", err)
		w.handleFailure(ctx, task, taskErr)
		return
	}
	w.observeLanding("held")
	w.logger.Warn("repository is held; landing queued again",
		"task_id", task.ID, "landing_request_id", task.LandingRequestID, "retry_in", delay.String())
}

func (w *LandingWorker) handleFailure(ctx context.Context, task db.LandingTask, taskErr error) {
	// Record the failure even when ctx was cancelled by graceful shutdown:
	// writing with the dead context would silently fail, leaving the task
	// 'running' and the landing request 'landing', which blocks the whole
	// repository's landing queue until the reaper's lease expires.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancel()

	revertedLR, err := w.queries.MarkLandingRequestFailed(ctx, task.LandingRequestID)
	if err != nil {
		w.logger.Error("failed to mark landing request as failed",
			"task_id", task.ID,
			"landing_request_id", task.LandingRequestID,
			"error", err,
		)
	}

	if err == nil {
		w.observeLanding("fail")
	}
	if _, err := w.queries.FailLandingTask(ctx, db.FailLandingTaskParams{
		ID:        task.ID,
		LastError: pgtype.Text{String: taskErr.Error(), Valid: true},
	}); err != nil {
		w.logger.Error("failed to mark landing task as failed",
			"task_id", task.ID,
			"error", err,
		)
	}

	// Dispatch "failed" webhook so downstream consumers know the landing did not complete.
	w.dispatchFailedEvent(ctx, task, revertedLR)
}

// dispatchLandedEvent fires the "landed" webhook event after a successful merge.
func (w *LandingWorker) dispatchLandedEvent(ctx context.Context, repo db.Repository, lr db.LandingRequest, changeIDs []string) {
	if w.dispatcher == nil {
		return
	}
	owner, err := w.resolveRepoOwner(ctx, repo)
	if err != nil {
		w.logger.Error("failed to load repository owner for landed webhook",
			"landing_request_id", lr.ID,
			"error", err,
		)
		return
	}
	dispatchLandingLandedEvent(ctx, w.dispatcher, w.queries, w.logger, repo, owner, lr, changeIDs)
}

// dispatchLandingLandedEvent fires the "landed" webhook after a landing merged.
func dispatchLandingLandedEvent(ctx context.Context, dispatcher webhooks.Dispatcher, users interface {
	GetUserByID(ctx context.Context, id int64) (db.User, error)
}, logger *slog.Logger, repo db.Repository, owner string, lr db.LandingRequest, changeIDs []string) {
	if dispatcher == nil {
		return
	}

	author, err := users.GetUserByID(ctx, lr.AuthorID)
	if err != nil {
		logger.Error("failed to load author for landed webhook",
			"landing_request_id", lr.ID,
			"error", err,
		)
		return
	}

	payload := webhooks.LandingRequestEventPayload{
		Action: "landed",
		LandingRequest: webhooks.LandingRequestPayload{
			Number:         lr.Number,
			Title:          lr.Title,
			Body:           lr.Body,
			State:          lr.State,
			Author:         webhooks.UserPayload{ID: author.ID, Login: author.Username},
			ChangeIDs:      changeIDs,
			TargetBookmark: lr.TargetBookmark,
			ConflictStatus: lr.ConflictStatus,
			StackSize:      lr.StackSize,
			CreatedAt:      lr.CreatedAt,
			UpdatedAt:      lr.UpdatedAt,
		},
		Repository: webhookRepositoryPayload(owner, repo),
		Sender:     webhooks.UserPayload{ID: author.ID, Login: author.Username},
	}

	if err := dispatcher.DispatchEvent(ctx, repo.ID, webhooks.EventTypeLandingRequest, payload); err != nil {
		logger.Error("failed to dispatch landed webhook",
			"landing_request_id", lr.ID,
			"error", err,
		)
	}
}

// dispatchFailedEvent fires the "failed" webhook event after a landing attempt fails.
func (w *LandingWorker) dispatchFailedEvent(ctx context.Context, task db.LandingTask, lr db.LandingRequest) {
	if w.dispatcher == nil {
		return
	}

	// If revert failed, lr may be zero-value. Load fresh if needed.
	if lr.ID == 0 {
		var err error
		lr, err = w.queries.GetLandingRequestByID(ctx, task.LandingRequestID)
		if err != nil {
			w.logger.Error("failed to load landing request for failed webhook",
				"task_id", task.ID,
				"error", err,
			)
			return
		}
	}

	repo, err := w.queries.GetRepoByID(ctx, task.RepositoryID)
	if err != nil {
		w.logger.Error("failed to load repository for failed webhook",
			"task_id", task.ID,
			"error", err,
		)
		return
	}

	owner, err := w.resolveRepoOwner(ctx, repo)
	if err != nil {
		w.logger.Error("failed to load repository owner for failed webhook",
			"task_id", task.ID,
			"error", err,
		)
		return
	}

	author, err := w.queries.GetUserByID(ctx, lr.AuthorID)
	if err != nil {
		w.logger.Error("failed to load author for failed webhook",
			"landing_request_id", lr.ID,
			"error", err,
		)
		return
	}

	// Collect change IDs for the payload.
	changes, err := w.queries.ListLandingRequestChanges(ctx, db.ListLandingRequestChangesParams{
		LandingRequestID: lr.ID,
		PageOffset:       0,
		PageSize:         maxLandingStackChanges,
	})
	if err != nil {
		w.logger.Error("failed to list changes for failed webhook",
			"landing_request_id", lr.ID,
			"error", err,
		)
		return
	}
	changeIDs := make([]string, len(changes))
	for i, c := range changes {
		changeIDs[i] = c.ChangeID
	}

	payload := webhooks.LandingRequestEventPayload{
		Action: "failed",
		LandingRequest: webhooks.LandingRequestPayload{
			Number:         lr.Number,
			Title:          lr.Title,
			Body:           lr.Body,
			State:          lr.State,
			Author:         webhooks.UserPayload{ID: author.ID, Login: author.Username},
			ChangeIDs:      changeIDs,
			TargetBookmark: lr.TargetBookmark,
			ConflictStatus: lr.ConflictStatus,
			StackSize:      lr.StackSize,
			CreatedAt:      lr.CreatedAt,
			UpdatedAt:      lr.UpdatedAt,
		},
		Repository: webhookRepositoryPayload(owner, repo),
		Sender:     webhooks.UserPayload{ID: author.ID, Login: author.Username},
	}

	if err := w.dispatcher.DispatchEvent(ctx, repo.ID, webhooks.EventTypeLandingRequest, payload); err != nil {
		w.logger.Error("failed to dispatch failed webhook",
			"landing_request_id", lr.ID,
			"error", err,
		)
	}
}

// resolveRepoOwner returns the owner username for a repository.
func (w *LandingWorker) resolveRepoOwner(ctx context.Context, repo db.Repository) (string, error) {
	if repo.UserID.Valid {
		user, err := w.queries.GetUserByID(ctx, repo.UserID.Int64)
		if err != nil {
			return "", err
		}
		return user.Username, nil
	}
	if repo.OrgID.Valid {
		org, err := w.queries.GetOrgByID(ctx, repo.OrgID.Int64)
		if err != nil {
			return "", err
		}
		return org.Name, nil
	}
	return "", fmt.Errorf("repository %d has neither user nor org owner", repo.ID)
}
