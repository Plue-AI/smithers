package routes

import (
	"context"
	stdErrors "errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/configsync"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

// pushWorkflowSyncSlots bounds concurrent post-push workflow sync/dispatch
// workers so a push flood cannot pile up unbounded goroutines doing
// repo-host fetches; waiting goroutines are cheap and drain because each
// worker is deadline-bounded (see pushWorkflowSyncTimeout).
var pushWorkflowSyncSlots = make(chan struct{}, 8)

// pushSearchIndexSlots bounds concurrent code-search indexing jobs separately
// from workflow work so a large first index cannot starve workflow dispatch.
var pushSearchIndexSlots = make(chan struct{}, 8)

// History imports can take much longer than repo-host's callback deadline.
// Keep their database work separate from workflow discovery and indexing.
var pushChangeSyncSlots = make(chan struct{}, 2)

const pushChangeSyncTimeout = time.Hour

// pushWorkflowSyncTimeout bounds how long a single post-push workflow
// sync/dispatch worker may run before its context is cancelled.
const pushWorkflowSyncTimeout = 5 * time.Minute

const pushSearchIndexTimeout = 5 * time.Minute

type PushHookRepoResolver interface {
	GetRepoOwnerSlugAndNameByID(ctx context.Context, repositoryID int64) (db.GetRepoOwnerSlugAndNameByIDRow, error)
	GetRepoByID(ctx context.Context, id int64) (db.Repository, error)
	// RepoPermQuerier lets the handler resolve the pusher's effective
	// permission so config-sync only applies admin-only settings for admins.
	services.RepoPermQuerier
}

// PushHookWorkflowSyncer discovers and syncs workflow definitions after a push.
type PushHookWorkflowSyncer interface {
	LoadDefinitionsFromCommit(ctx context.Context, repoID int64, commitSHA string) (services.WorkflowLoadResult, error)
	PersistDefinitions(ctx context.Context, repoID int64, result services.WorkflowLoadResult, pushRef ...string) error
}

// PushHookWorkflowRunner dispatches workflow runs for push events.
type PushHookWorkflowRunner interface {
	DispatchForEvent(ctx context.Context, input services.DispatchForEventInput) ([]services.WorkflowRunResult, error)
}

type PushHookConfigSyncer interface {
	SyncFromCommit(ctx context.Context, input configsync.SyncInput) (configsync.SyncResult, error)
}

type PushHookSearchIndexer interface {
	IndexPush(ctx context.Context, input services.SearchIndexPushInput) error
}

type PushHookChangeRecorder interface {
	RecordPush(ctx context.Context, repositoryID int64, owner, repo string) error
}

// PushEventStore records push events before the callback is acknowledged.
// InsertRepoPushEvent returns 0 rows for a delivery_id it already holds.
type PushEventStore interface {
	InsertRepoPushEvent(ctx context.Context, arg db.InsertRepoPushEventParams) (int64, error)
}

// InternalPushHookHandler accepts repo-host push callbacks and runs the
// side effects of a stored push event. PostPushEvent only records the event;
// services.RepoPushEventWorker claims it and calls ProcessRepoPushEvent, so an
// API restart or a failing step retries instead of dropping the push.
type InternalPushHookHandler struct {
	RepoResolver   PushHookRepoResolver
	Dispatcher     webhooks.Dispatcher
	WorkflowSync   PushHookWorkflowSyncer
	WorkflowRun    PushHookWorkflowRunner
	ConfigSync     PushHookConfigSyncer
	SearchIndex    PushHookSearchIndexer
	ChangeRecorder PushHookChangeRecorder
	Events         PushEventStore

	changeSyncs changeSyncCoalescer
}

type PushHookEventRequest struct {
	RepositoryID int64  `json:"repository_id"`
	DeliveryID   string `json:"delivery_id"`
	Owner        string `json:"owner"`
	Repo         string `json:"repo"`
	Ref          string `json:"ref_name"`
	BeforeSHA    string `json:"before_sha"`
	CommitSHA    string `json:"commit_sha"`
	PusherID     int64  `json:"pusher_id"`
	PusherLogin  string `json:"pusher_login"`
	// PusherCredential is the kind of credential behind the push
	// (middleware.CredentialKind); empty when unattributed.
	PusherCredential string `json:"pusher_credential,omitempty"`
}

// Push event side effects. Each one that succeeds is recorded on the event
// row, so a retry after a partial failure runs only the steps that failed.
const (
	PushStepWebhooks    = "webhooks"
	PushStepChanges     = "changes"
	PushStepWorkflows   = "workflows"
	PushStepSearchIndex = "search_index"
)

func (h *InternalPushHookHandler) PostPushEvent(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	var req PushHookEventRequest
	if !decodeJSONBodyWithMessage(w, r, &req, "Invalid JSON payload") {
		return
	}

	if h.RepoResolver == nil || h.Events == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("push hook handler not configured"))
		return
	}

	if req.RepositoryID < 0 {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("Invalid repository identity"))
		return
	}
	if req.RepositoryID == 0 {
		// An old durable payload cannot distinguish a moved repository from
		// a replacement at the same name. Keep it pending for reconciliation.
		middleware.LoggerFromContext(ctx).Warn("push event missing repository identity; reconciliation required",
			"delivery_id", req.DeliveryID, "owner", req.Owner, "repo", req.Repo)
		pkgerrors.WriteError(w, pkgerrors.Conflict("Push event requires repository identity reconciliation"))
		return
	}
	// Names can move or be reused while a durable callback waits. Resolve
	// only the original ID, and record its current coordinates on transfer.
	current, err := h.RepoResolver.GetRepoOwnerSlugAndNameByID(ctx, req.RepositoryID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			pkgerrors.WriteError(w, pkgerrors.NotFound("Repository not found"))
			return
		}
		writeRouteError(w, r, fmt.Errorf("resolve push hook repository %s/%s: %w", req.Owner, req.Repo, err))
		return
	}

	deliveryID := strings.TrimSpace(req.DeliveryID)
	if deliveryID == "" {
		// A repo-host older than the outbox sends no id. Accept the event
		// without redelivery deduplication rather than drop it.
		deliveryID = "legacy-" + uuid.NewString()
		middleware.LoggerFromContext(ctx).Warn("push event without delivery_id; redeliveries will not deduplicate",
			"repo_id", req.RepositoryID, "ref", req.Ref)
	}
	inserted, err := h.Events.InsertRepoPushEvent(ctx, db.InsertRepoPushEventParams{
		DeliveryID:   deliveryID,
		RepositoryID: req.RepositoryID,
		Owner:        current.OwnerSlug,
		Repo:         current.RepoName,
		RefName:      req.Ref,
		BeforeSha:    req.BeforeSHA,
		CommitSha:    req.CommitSHA,
		PusherID:     req.PusherID,
		PusherLogin:  req.PusherLogin,
		// Repo-host forwards the kind the API authenticated; an unknown
		// value is recorded as an agent run's.
		PusherCredential: string(middleware.ParseCredentialKind(req.PusherCredential)),
	})
	if err != nil {
		// A non-2xx answer keeps the event in repo-host's outbox for replay.
		writeRouteError(w, r, fmt.Errorf("record push event %s: %w", deliveryID, err))
		return
	}
	if inserted == 0 {
		middleware.LoggerFromContext(ctx).Info("duplicate push event ignored",
			"delivery_id", deliveryID, "repo_id", req.RepositoryID, "ref", req.Ref)
	}

	w.WriteHeader(http.StatusNoContent)
}

// ProcessRepoPushEvent runs every side effect of a stored push event not
// already in event.StepsDone. The steps run concurrently so a slow history
// import cannot delay workflow dispatch. markStep is called after each step
// succeeds; the returned error joins the failures of the remaining steps.
// releaseSlot, when set, is called once every step but the change sync has
// finished, so a job waiting only on a slow sync stops holding a worker slot.
func (h *InternalPushHookHandler) ProcessRepoPushEvent(ctx context.Context, event db.RepoPushEvent, markStep func(context.Context, string) error, releaseSlot func()) error {
	req := PushHookEventRequest{
		DeliveryID:  event.DeliveryID,
		Owner:       event.Owner,
		Repo:        event.Repo,
		Ref:         event.RefName,
		BeforeSHA:   event.BeforeSha,
		CommitSHA:   event.CommitSha,
		PusherID:    event.PusherID,
		PusherLogin: event.PusherLogin,

		PusherCredential: event.PusherCredential,
	}
	repoID := event.RepositoryID
	steps := map[string]func(context.Context) error{}
	if h.Dispatcher != nil {
		steps[PushStepWebhooks] = func(ctx context.Context) error { return h.dispatchPushWebhooks(ctx, repoID, req) }
	}
	if h.ChangeRecorder != nil {
		steps[PushStepChanges] = func(ctx context.Context) error { return h.handleChangesForPush(ctx, repoID, req.Owner, req.Repo) }
	}
	if h.WorkflowSync != nil || h.WorkflowRun != nil || h.ConfigSync != nil {
		steps[PushStepWorkflows] = func(ctx context.Context) error { return h.handleWorkflowsForPush(ctx, repoID, req) }
	}
	if h.SearchIndex != nil {
		steps[PushStepSearchIndex] = func(ctx context.Context) error { return h.handleSearchIndexForPush(ctx, repoID, req) }
	}

	var (
		fast, changes sync.WaitGroup
		mu            sync.Mutex
		errs          []error
	)
	for name, run := range steps {
		if slices.Contains(event.StepsDone, name) {
			continue
		}
		wg := &fast
		if name == PushStepChanges {
			wg = &changes
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			err := runPushStep(ctx, name, run)
			if err == nil && markStep != nil {
				err = markStep(ctx, name)
			}
			if err != nil {
				mu.Lock()
				errs = append(errs, fmt.Errorf("%s: %w", name, err))
				mu.Unlock()
			}
		}()
	}
	fast.Wait()
	if releaseSlot != nil {
		releaseSlot()
	}
	changes.Wait()
	slices.SortFunc(errs, func(a, b error) int { return strings.Compare(a.Error(), b.Error()) })
	return stdErrors.Join(errs...)
}

func runPushStep(ctx context.Context, name string, run func(context.Context) error) (err error) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("push event step panic", "step", name, "panic", r)
			err = fmt.Errorf("panic: %v", r)
		}
	}()
	return run(ctx)
}

func (h *InternalPushHookHandler) dispatchPushWebhooks(ctx context.Context, repoID int64, req PushHookEventRequest) error {
	payload := webhooks.PushEventPayload{
		Ref: req.Ref,
		Repository: webhooks.RepositoryPayload{
			ID:       repoID,
			Name:     req.Repo,
			FullName: req.Owner + "/" + req.Repo,
		},
		Sender: webhooks.UserPayload{
			ID:    req.PusherID,
			Login: req.PusherLogin,
		},
	}
	if err := h.Dispatcher.DispatchEvent(ctx, repoID, webhooks.EventTypePush, payload); err != nil {
		return fmt.Errorf("enqueue push webhooks: %w", err)
	}
	return nil
}

// acquirePushSlot waits for a concurrency slot or ctx, whichever comes first.
func acquirePushSlot(ctx context.Context, slots chan struct{}) (func(), error) {
	select {
	case slots <- struct{}{}:
		return func() { <-slots }, nil
	case <-ctx.Done():
		return nil, fmt.Errorf("wait for push work slot: %w", ctx.Err())
	}
}

// handleChangesForPush waits for a full change sync of the repository that
// starts after this call. RecordPush syncs every change, so pushes queued
// behind a running sync share the one sync that runs next.
func (h *InternalPushHookHandler) handleChangesForPush(ctx context.Context, repoID int64, owner, repo string) error {
	run := h.changeSyncs.join(ctx, repoID, func(ctx context.Context) error {
		ctx, cancel := context.WithTimeout(ctx, pushChangeSyncTimeout)
		defer cancel()
		release, err := acquirePushSlot(ctx, pushChangeSyncSlots)
		if err != nil {
			return err
		}
		defer release()
		if err := h.ChangeRecorder.RecordPush(ctx, repoID, owner, repo); err != nil {
			return fmt.Errorf("change revision sync: %w", err)
		}
		return nil
	})
	select {
	case <-run.done:
		return run.err
	case <-ctx.Done():
		return fmt.Errorf("wait for change sync: %w", ctx.Err())
	}
}

// changeSyncCoalescer runs at most one change sync per repository and queues
// at most one more: every caller that arrives while a sync runs joins the
// next one. Syncs run detached from callers so one caller giving up does not
// cancel the sync the others wait on. The zero value is ready to use.
type changeSyncCoalescer struct {
	mu    sync.Mutex
	repos map[int64]*repoChangeSyncs
}

type repoChangeSyncs struct {
	running, next *changeSyncRun
}

type changeSyncRun struct {
	ctx  context.Context
	fn   func(context.Context) error
	done chan struct{}
	err  error
}

func (c *changeSyncCoalescer) join(ctx context.Context, repoID int64, fn func(context.Context) error) *changeSyncRun {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.repos == nil {
		c.repos = map[int64]*repoChangeSyncs{}
	}
	runs := c.repos[repoID]
	if runs == nil {
		runs = &repoChangeSyncs{}
		c.repos[repoID] = runs
	}
	if runs.running == nil {
		runs.running = &changeSyncRun{ctx: context.WithoutCancel(ctx), fn: fn, done: make(chan struct{})}
		go c.execute(repoID, runs.running)
		return runs.running
	}
	if runs.next == nil {
		runs.next = &changeSyncRun{done: make(chan struct{})}
	}
	// The latest caller's repository coordinates are the freshest.
	runs.next.ctx, runs.next.fn = context.WithoutCancel(ctx), fn
	return runs.next
}

func (c *changeSyncCoalescer) execute(repoID int64, run *changeSyncRun) {
	run.err = runPushStep(run.ctx, PushStepChanges, run.fn)
	close(run.done)

	c.mu.Lock()
	defer c.mu.Unlock()
	runs := c.repos[repoID]
	runs.running, runs.next = runs.next, nil
	if runs.running == nil {
		delete(c.repos, repoID)
		return
	}
	go c.execute(repoID, runs.running)
}

func (h *InternalPushHookHandler) handleSearchIndexForPush(ctx context.Context, repoID int64, req PushHookEventRequest) error {
	ctx, cancel := context.WithTimeout(ctx, pushSearchIndexTimeout)
	defer cancel()
	release, err := acquirePushSlot(ctx, pushSearchIndexSlots)
	if err != nil {
		return err
	}
	defer release()

	err = h.SearchIndex.IndexPush(ctx, services.SearchIndexPushInput{
		RepositoryID:   repoID,
		Owner:          req.Owner,
		RepositoryName: req.Repo,
		Ref:            req.Ref,
		CommitSHA:      req.CommitSHA,
	})
	if err != nil {
		return fmt.Errorf("code search indexing: %w", err)
	}
	return nil
}

// handleWorkflowsForPush syncs workflow definitions and config, then
// dispatches runs. Only a dispatch failure fails the step: a load or
// persistence failure falls back to persisted definitions as before, and
// retrying the whole step after a successful dispatch would duplicate runs.
func (h *InternalPushHookHandler) handleWorkflowsForPush(ctx context.Context, repoID int64, req PushHookEventRequest) error {
	ctx, cancel := context.WithTimeout(ctx, pushWorkflowSyncTimeout)
	defer cancel()
	release, err := acquirePushSlot(ctx, pushWorkflowSyncSlots)
	if err != nil {
		return err
	}
	defer release()

	var loadResult services.WorkflowLoadResult
	loadAttempted := false
	loadedDefinitions := false

	if h.WorkflowSync != nil && req.CommitSHA != "" {
		loadAttempted = true
		result, err := h.WorkflowSync.LoadDefinitionsFromCommit(ctx, repoID, req.CommitSHA)
		if err != nil {
			slog.Error("workflow load failed after push", "repo_id", repoID, "commit_sha", req.CommitSHA, "error", err)
		} else {
			loadResult = result
			loadedDefinitions = true
			if h.shouldPersistDefinitions(ctx, repoID, req.Ref) {
				if err := h.WorkflowSync.PersistDefinitions(ctx, repoID, result, req.Ref); err != nil {
					slog.Error("workflow persistence failed after push", "repo_id", repoID, "commit_sha", req.CommitSHA, "error", err)
				}
			}
		}
	}

	if h.ConfigSync != nil && req.CommitSHA != "" && h.shouldPersistDefinitions(ctx, repoID, req.Ref) {
		// Config-sync persists admin-only repository settings (visibility,
		// protected bookmarks, webhooks, mirror, landing queue) authored in
		// repo files. These files are controlled by anyone who can push, so we
		// must only apply them when the pusher actually has admin permission on
		// the repo. Otherwise a low-privilege collaborator could push a
		// .smithers/config.yml (or protected-bookmarks.yml) to escalate — e.g.
		// flip the repo public or disable branch protection.
		// Only a person's push applies administrator settings: a
		// system-issued credential acts for its user but never as their
		// administrator (middleware.capCredentialPermission).
		if !middleware.ParseCredentialKind(req.PusherCredential).Reviewed() || !h.pusherCanAdmin(ctx, repoID, req.PusherID) {
			slog.Warn("skipping config sync after push: pusher lacks repo admin permission",
				"repo_id", repoID, "pusher_id", req.PusherID, "commit_sha", req.CommitSHA)
		} else {
			actorID := req.PusherID
			_, err := h.ConfigSync.SyncFromCommit(ctx, configsync.SyncInput{
				RepositoryID: repoID,
				CommitSHA:    req.CommitSHA,
				Trigger:      "push",
				ActorID:      &actorID,
				ActorName:    req.PusherLogin,
			})
			if err != nil {
				slog.Error("config sync failed after push", "repo_id", repoID, "commit_sha", req.CommitSHA, "error", err)
			}
		}
	}

	if h.WorkflowRun != nil {
		input := services.DispatchForEventInput{
			RepositoryID: repoID,
			UserID:       req.PusherID,
			Event: services.TriggerEvent{
				Type:      "push",
				Ref:       req.Ref,
				CommitSHA: req.CommitSHA,
			},
			SystemPush: !middleware.ParseCredentialKind(req.PusherCredential).Reviewed(),
		}
		if loadedDefinitions {
			input.UseLoadedDefinitions = true
			input.LoadedDefinitions = loadResult.Definitions
		} else if loadAttempted {
			slog.Info("workflow dispatch falling back to persisted definitions", "repo_id", repoID, "commit_sha", req.CommitSHA)
		}
		if _, err := h.WorkflowRun.DispatchForEvent(ctx, input); err != nil {
			return fmt.Errorf("workflow dispatch: %w", err)
		}
	}
	return nil
}

// pusherCanAdmin reports whether the pushing user has admin (or owner) access to
// the repository. It fails closed: any lookup error is treated as "not admin" so
// config-sync never applies privileged settings on an unverified pusher.
func (h *InternalPushHookHandler) pusherCanAdmin(ctx context.Context, repoID int64, pusherID int64) bool {
	if h.RepoResolver == nil || pusherID <= 0 {
		return false
	}

	repo, err := h.RepoResolver.GetRepoByID(ctx, repoID)
	if err != nil {
		slog.Error("failed to load repository for config-sync admin check", "repo_id", repoID, "error", err)
		return false
	}

	isAdmin, err := services.CanAdminRepo(ctx, h.RepoResolver, repo, pusherID)
	if err != nil {
		slog.Error("failed to resolve pusher permission for config-sync", "repo_id", repoID, "pusher_id", pusherID, "error", err)
		return false
	}
	return isAdmin
}

func (h *InternalPushHookHandler) shouldPersistDefinitions(ctx context.Context, repoID int64, ref string) bool {
	if h.RepoResolver == nil {
		return false
	}

	repo, err := h.RepoResolver.GetRepoByID(ctx, repoID)
	if err != nil {
		slog.Error("failed to load repository for workflow persistence decision", "repo_id", repoID, "error", err)
		return false
	}

	return normalizeBookmarkRef(ref) == strings.TrimSpace(repo.DefaultBookmark)
}

func normalizeBookmarkRef(ref string) string {
	if strings.HasPrefix(ref, "refs/heads/") {
		return strings.TrimPrefix(ref, "refs/heads/")
	}
	return strings.TrimSpace(ref)
}
