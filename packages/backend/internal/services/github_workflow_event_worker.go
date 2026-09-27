package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

const (
	defaultGitHubWebhookEventWorkerInterval   = 2 * time.Second
	defaultGitHubWebhookEventWorkerClaimLimit = int32(20)

	// GitHub never redelivers a webhook we already acked with 200, so a
	// transiently failing job must be retried (with backoff) rather than
	// terminally failed: it only becomes 'failed' after this many claims or
	// on a permanent error (e.g. an unparseable payload).
	gitHubWebhookJobMaxAttempts = int32(8)

	gitHubWebhookJobRetryBaseBackoff = 5 * time.Second
	gitHubWebhookJobRetryMaxBackoff  = 10 * time.Minute

	// Jobs claimed by a worker that crashed before marking them done/failed
	// stay 'processing'; after this lease they are re-pended for re-dispatch.
	gitHubWebhookJobStalledAfter = 5 * time.Minute
)

// GitHubWebhookEventWorkerQuerier contains DB methods needed by the webhook → workflow bridge worker.
type GitHubWebhookEventWorkerQuerier interface {
	ClaimPendingGitHubWebhookJobs(ctx context.Context, claimLimit int32) ([]db.GithubWebhookJob, error)
	MarkGitHubWebhookJobDone(ctx context.Context, arg db.MarkGitHubWebhookJobDoneParams) (int64, error)
	MarkGitHubWebhookJobFailed(ctx context.Context, arg db.MarkGitHubWebhookJobFailedParams) (int64, error)
	RetryGitHubWebhookJob(ctx context.Context, arg db.RetryGitHubWebhookJobParams) (int64, error)
	ResetStalledGitHubWebhookJobs(ctx context.Context, olderThanSeconds float64) (int64, error)
	ListRepositoryIDsForGitHubWebhookJob(ctx context.Context, arg db.ListRepositoryIDsForGitHubWebhookJobParams) ([]int64, error)
	ListWorkflowTriggersByRepository(ctx context.Context, repositoryID int64) ([]db.WorkflowTrigger, error)
}

// permanentGitHubWebhookJobError marks a processing failure that can never
// succeed on retry, so the job is failed immediately instead of re-pended.
type permanentGitHubWebhookJobError struct{ err error }

func (e *permanentGitHubWebhookJobError) Error() string { return e.err.Error() }
func (e *permanentGitHubWebhookJobError) Unwrap() error { return e.err }

// GitHubWebhookEventRunDispatcher creates workflow runs for matching triggers.
type GitHubWebhookEventRunDispatcher interface {
	DispatchForEvent(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error)
}

// GitHubWebhookEventWorker polls github_webhook_jobs and dispatches workflow runs.
type GitHubWebhookEventWorker struct {
	queries        GitHubWebhookEventWorkerQuerier
	dispatcher     GitHubWebhookEventRunDispatcher
	logger         *slog.Logger
	interval       time.Duration
	claimLimit     int32
	repositoryJobs interface {
		AdmitGitHubEvent(context.Context, int64, db.GithubWebhookJob, TriggerEvent) error
	}
	mythical interface {
		ObserveGitHubEvent(ctx context.Context, eventType string, payload []byte) error
	}
	mainPull  gitHubMainPuller
	issueText *GitHubTextStamper
}

// gitHubMainPuller is the GitHub main pull as the webhook worker uses it.
type gitHubMainPuller interface {
	RequestForGitHub(ctx context.Context, owner, repo string) error
	PullsBranch(ctx context.Context, repositoryID int64, branch string) (bool, error)
}

// SetMythical admits issue events into repositories' mythical stacks.
func (w *GitHubWebhookEventWorker) SetMythical(service interface {
	ObserveGitHubEvent(ctx context.Context, eventType string, payload []byte) error
}) {
	w.mythical = service
}

// SetTextStamper makes the worker read who last wrote an issue's text before
// any consumer applies the trust rule. Without it no GitHub issue text is a
// maintainer's own.
func (w *GitHubWebhookEventWorker) SetTextStamper(stamper *GitHubTextStamper) {
	w.issueText = stamper
}

// SetMainPull makes a push to a GitHub repository's default branch request
// the Smithers main pull for the repositories it is the source of.
func (w *GitHubWebhookEventWorker) SetMainPull(service gitHubMainPuller) {
	w.mainPull = service
}

// SetRepositoryJobs connects authenticated webhook deliveries to the modern
// opt-in host. Legacy definitions keep their existing dispatch path.
func (w *GitHubWebhookEventWorker) SetRepositoryJobs(service interface {
	AdmitGitHubEvent(context.Context, int64, db.GithubWebhookJob, TriggerEvent) error
}) {
	w.repositoryJobs = service
}

func NewGitHubWebhookEventWorker(
	queries GitHubWebhookEventWorkerQuerier,
	dispatcher GitHubWebhookEventRunDispatcher,
) *GitHubWebhookEventWorker {
	return &GitHubWebhookEventWorker{
		queries:    queries,
		dispatcher: dispatcher,
		logger:     slog.Default(),
		interval:   defaultGitHubWebhookEventWorkerInterval,
		claimLimit: defaultGitHubWebhookEventWorkerClaimLimit,
	}
}

// Start runs the polling loop until context cancellation.
func (w *GitHubWebhookEventWorker) Start(ctx context.Context) {
	w.logger.Info("github webhook event worker started")
	for {
		if err := w.PollOnce(ctx); err != nil {
			if ctx.Err() != nil {
				w.logger.Info("github webhook event worker stopping", "reason", ctx.Err())
				return
			}
			w.logger.Error("github webhook event worker poll error", "error", err)
		}

		select {
		case <-ctx.Done():
			w.logger.Info("github webhook event worker stopped")
			return
		case <-time.After(w.interval):
		}
	}
}

// PollOnce claims and processes a batch of GitHub webhook jobs.
func (w *GitHubWebhookEventWorker) PollOnce(ctx context.Context) error {
	if w == nil || w.queries == nil || w.dispatcher == nil {
		return nil
	}

	if reclaimed, err := w.queries.ResetStalledGitHubWebhookJobs(ctx, gitHubWebhookJobStalledAfter.Seconds()); err != nil {
		w.logger.Error("failed to reset stalled github webhook jobs", "error", err)
	} else if reclaimed > 0 {
		w.logger.Warn("reclaimed stalled github webhook jobs", "count", reclaimed)
	}

	jobs, err := w.queries.ClaimPendingGitHubWebhookJobs(ctx, w.claimLimit)
	if err != nil {
		return fmt.Errorf("claim github webhook jobs: %w", err)
	}

	for _, job := range jobs {
		err := w.processJob(ctx, job)
		if err == nil {
			continue
		}

		var permanent *permanentGitHubWebhookJobError
		if errors.As(err, &permanent) || job.Attempts >= gitHubWebhookJobMaxAttempts {
			marked, markErr := w.queries.MarkGitHubWebhookJobFailed(ctx, db.MarkGitHubWebhookJobFailedParams{
				ID:               job.ID,
				ExpectedAttempts: job.Attempts,
				Error:            err.Error(),
			})
			if markErr != nil {
				// The row stays 'processing' and the stalled-job sweep
				// re-pends it, so a failed mark cannot strand the job.
				w.logger.Error("failed to mark github webhook job failed", "job_id", job.ID, "error", markErr)
			} else if marked == 0 {
				w.logLostClaim(job, "fail")
			}
			w.logger.Error("github webhook job failed permanently", "job_id", job.ID, "attempts", job.Attempts, "error", err)
			continue
		}

		backoff := gitHubWebhookJobRetryBackoff(job.Attempts)
		retried, retryErr := w.queries.RetryGitHubWebhookJob(ctx, db.RetryGitHubWebhookJobParams{
			ID:               job.ID,
			ExpectedAttempts: job.Attempts,
			Error:            err.Error(),
			BackoffSeconds:   backoff.Seconds(),
		})
		if retryErr != nil {
			// Same safety net: the stalled-job sweep re-pends the row.
			w.logger.Error("failed to re-pend github webhook job", "job_id", job.ID, "error", retryErr)
		} else if retried == 0 {
			w.logLostClaim(job, "retry")
			continue
		}
		w.logger.Warn("github webhook job failed, will retry", "job_id", job.ID, "attempts", job.Attempts, "backoff", backoff.String(), "error", err)
	}

	return nil
}

// gitHubWebhookJobRetryBackoff doubles the delay per claim attempt (the claim
// query increments attempts before processing, so attempts >= 1 here).
func gitHubWebhookJobRetryBackoff(attempts int32) time.Duration {
	if attempts < 1 {
		attempts = 1
	}
	shift := uint(attempts - 1)
	if shift > 16 {
		return gitHubWebhookJobRetryMaxBackoff
	}
	backoff := gitHubWebhookJobRetryBaseBackoff << shift
	if backoff > gitHubWebhookJobRetryMaxBackoff {
		return gitHubWebhookJobRetryMaxBackoff
	}
	return backoff
}

func (w *GitHubWebhookEventWorker) processJob(ctx context.Context, job db.GithubWebhookJob) error {
	// A change of who may write the repository takes effect at once, not
	// after the cached permission answers expire.
	w.issueText.forgetMaintainers(job.EventType, job.Payload)
	// GitHub names an author's association, not the writer's standing:
	// record whether maintainers wrote the event's text before any consumer
	// reads it. The stack reads every issue event; other events are read
	// only when a repository takes them, so they are stamped then.
	stamp := func() error {
		stamped, err := w.issueText.stampGitHubText(ctx, job.EventType, job.Action, job.Payload)
		if err != nil {
			return fmt.Errorf("read text writers: %w", err)
		}
		job.Payload = stamped
		return nil
	}
	issueEvent := NormalizeTriggerName(job.EventType) == "issue"
	if issueEvent {
		if err := stamp(); err != nil {
			return err
		}
	}
	payload, err := parseGitHubWorkflowEventPayload(job.Payload)
	if err != nil {
		return &permanentGitHubWebhookJobError{err: fmt.Errorf("parse payload: %w", err)}
	}

	// The stack sees every issue event before the trigger trust gate: it
	// applies its own trust rule, and an outsider's approved issue must still
	// be cancelled when it closes.
	if w.mythical != nil {
		if err := w.mythical.ObserveGitHubEvent(ctx, job.EventType, job.Payload); err != nil {
			return fmt.Errorf("admit mythical issue: %w", err)
		}
	}
	event, supported := mapGitHubWebhookJobToTriggerEvent(job, payload)
	if !supported {
		return w.markJobDone(ctx, job)
	}

	if err := w.requestMainPull(ctx, job, payload); err != nil {
		return err
	}

	selector := buildGitHubWebhookRepositorySelector(job, payload)
	if selector.InstallationID == 0 && selector.GitHubRepositoryID == 0 &&
		(strings.TrimSpace(selector.OwnerLoginLower) == "" || strings.TrimSpace(selector.RepoNameLower) == "") {
		return w.markJobDone(ctx, job)
	}
	repoIDs, err := w.queries.ListRepositoryIDsForGitHubWebhookJob(ctx, selector)
	if err != nil {
		return fmt.Errorf("resolve repositories: %w", err)
	}
	if !issueEvent && len(repoIDs) > 0 {
		if err := stamp(); err != nil {
			return err
		}
	}

	// Repository jobs apply the trust rule with their own trigger label when
	// they match the event. Workflow triggers configure none, so only a
	// maintainer's issue text starts them.
	workflowsApprove := gitHubIssueEventApproves(job.EventType, event.Action, job.Payload, "", nil)
	for _, repositoryID := range repoIDs {
		if w.repositoryJobs != nil {
			if err := w.repositoryJobs.AdmitGitHubEvent(ctx, repositoryID, job, event); err != nil {
				return fmt.Errorf("admit repository job event for repository %d: %w", repositoryID, err)
			}
		}
		if !workflowsApprove {
			continue
		}
		triggers, err := w.queries.ListWorkflowTriggersByRepository(ctx, repositoryID)
		if err != nil {
			return fmt.Errorf("list workflow triggers for repository %d: %w", repositoryID, err)
		}

		pulled, err := w.mainPulled(ctx, repositoryID, event.Type, payload)
		if err != nil {
			return fmt.Errorf("read main pull policy for repository %d: %w", repositoryID, err)
		}
		if pulled {
			// The main pull's verified fast-forward starts this push's runs.
			continue
		}
		definitionIDs := matchingWorkflowDefinitionIDs(triggers, event)
		for _, definitionID := range definitionIDs {
			workflowDefinitionID := definitionID
			if _, err := w.dispatcher.DispatchForEvent(ctx, DispatchForEventInput{
				RepositoryID:         repositoryID,
				WorkflowDefinitionID: &workflowDefinitionID,
				Event:                event,
				SystemPush:           event.Type == "push" && !gitHubPushCredential(payload).Reviewed(),
			}); err != nil {
				return fmt.Errorf("dispatch workflow definition %d: %w", workflowDefinitionID, err)
			}
		}
	}

	return w.markJobDone(ctx, job)
}

// requestMainPull runs before workflow dispatch; a replayed job requests
// again, which only coalesces into the same pull.
func (w *GitHubWebhookEventWorker) requestMainPull(ctx context.Context, job db.GithubWebhookJob, payload gitHubWorkflowEventPayload) error {
	if w.mainPull == nil || !strings.EqualFold(strings.TrimSpace(job.EventType), "push") || payload.Repository == nil {
		return nil
	}
	if !gitHubDefaultBranchPush(payload) {
		return nil
	}
	owner := strings.TrimSpace(payload.Repository.Owner.Login)
	name := strings.TrimSpace(payload.Repository.Name)
	if (owner == "" || name == "") && strings.Count(payload.Repository.FullName, "/") == 1 {
		owner, name, _ = strings.Cut(strings.TrimSpace(payload.Repository.FullName), "/")
	}
	if owner == "" || name == "" {
		return nil
	}
	if err := w.mainPull.RequestForGitHub(ctx, owner, name); err != nil {
		return fmt.Errorf("request main pull: %w", err)
	}
	return nil
}

// mainPulled reports whether a push to GitHub's default branch reaches this
// repository through the main pull, whose own push starts its runs.
func (w *GitHubWebhookEventWorker) mainPulled(ctx context.Context, repositoryID int64, eventType string, payload gitHubWorkflowEventPayload) (bool, error) {
	if w.mainPull == nil || eventType != "push" || !gitHubDefaultBranchPush(payload) {
		return false, nil
	}
	return w.mainPull.PullsBranch(ctx, repositoryID, strings.TrimSpace(payload.Repository.DefaultBranch))
}

func gitHubDefaultBranchPush(payload gitHubWorkflowEventPayload) bool {
	if payload.Repository == nil {
		return false
	}
	branch := strings.TrimSpace(payload.Repository.DefaultBranch)
	return branch != "" && strings.TrimSpace(payload.Ref) == "refs/heads/"+branch
}

// gitHubPushCredential classifies a signed GitHub push the way the push hook
// classifies a Smithers push (middleware.CredentialKind), so one rule decides
// whose push runs save workflow caches. A person's push to the GitHub
// repository's default branch is reviewed history: GitHub accepts it only
// from someone with write access to that branch. A push to any other branch
// or tag, and a bot's or app's push (GitHub Actions, an app installation,
// Smithers' own landing branches), is unattributed and saves nothing.
func gitHubPushCredential(payload gitHubWorkflowEventPayload) middleware.CredentialKind {
	var sender struct {
		Type string `json:"type"`
	}
	if !gitHubDefaultBranchPush(payload) || json.Unmarshal(payload.Sender, &sender) != nil || sender.Type != "User" {
		return ""
	}
	return middleware.CredentialPerson
}

// markJobDone finishes this worker's claim generation. A zero-row write means
// the claim was reset as stalled and re-claimed, so the newer claimant owns
// the outcome and this worker only logs.
func (w *GitHubWebhookEventWorker) markJobDone(ctx context.Context, job db.GithubWebhookJob) error {
	marked, err := w.queries.MarkGitHubWebhookJobDone(ctx, db.MarkGitHubWebhookJobDoneParams{
		ID:               job.ID,
		ExpectedAttempts: job.Attempts,
	})
	if err != nil {
		return fmt.Errorf("mark job done: %w", err)
	}
	if marked == 0 {
		w.logLostClaim(job, "done")
	}
	return nil
}

func (w *GitHubWebhookEventWorker) logLostClaim(job db.GithubWebhookJob, write string) {
	w.logger.Warn("github webhook job claim lost to a newer claimant", "job_id", job.ID, "attempts", job.Attempts, "write", write)
}

func matchingWorkflowDefinitionIDs(triggers []db.WorkflowTrigger, event TriggerEvent) []int64 {
	normalizedEvent := normalizeTriggerEvent(event)
	normalizedEventType := normalizeRegisteredEventType(normalizedEvent.Type)
	if normalizedEventType == "" {
		return nil
	}

	unique := make(map[int64]struct{})
	for _, trigger := range triggers {
		if !trigger.Enabled {
			continue
		}
		if normalizeRegisteredEventType(trigger.EventType) != normalizedEventType {
			continue
		}
		triggerAction := strings.ToLower(strings.TrimSpace(trigger.EventAction))
		if triggerAction != "" && triggerAction != strings.ToLower(strings.TrimSpace(normalizedEvent.Action)) {
			continue
		}
		unique[trigger.WorkflowDefinitionID] = struct{}{}
	}

	definitionIDs := make([]int64, 0, len(unique))
	for definitionID := range unique {
		definitionIDs = append(definitionIDs, definitionID)
	}
	sort.Slice(definitionIDs, func(i, j int) bool { return definitionIDs[i] < definitionIDs[j] })
	return definitionIDs
}

type gitHubWorkflowEventPayload struct {
	Action       string `json:"action"`
	Ref          string `json:"ref"`
	After        string `json:"after"`
	Installation *struct {
		ID int64 `json:"id"`
	} `json:"installation"`
	Repository *struct {
		ID            int64  `json:"id"`
		Name          string `json:"name"`
		FullName      string `json:"full_name"`
		DefaultBranch string `json:"default_branch"`
		Owner         struct {
			Login string `json:"login"`
		} `json:"owner"`
	} `json:"repository"`
	Issue       json.RawMessage `json:"issue"`
	Comment     json.RawMessage `json:"comment"`
	Sender      json.RawMessage `json:"sender"`
	PullRequest *struct {
		Head struct {
			Ref string `json:"ref"`
			SHA string `json:"sha"`
		} `json:"head"`
	} `json:"pull_request"`
	CheckSuite *struct {
		HeadBranch string `json:"head_branch"`
		HeadSHA    string `json:"head_sha"`
	} `json:"check_suite"`
	CheckRun *struct {
		HeadSHA    string `json:"head_sha"`
		CheckSuite struct {
			HeadBranch string `json:"head_branch"`
			HeadSHA    string `json:"head_sha"`
		} `json:"check_suite"`
	} `json:"check_run"`
}

func parseGitHubWorkflowEventPayload(payload json.RawMessage) (gitHubWorkflowEventPayload, error) {
	if len(payload) == 0 {
		return gitHubWorkflowEventPayload{}, nil
	}
	var parsed gitHubWorkflowEventPayload
	if err := json.Unmarshal(payload, &parsed); err != nil {
		return gitHubWorkflowEventPayload{}, err
	}
	return parsed, nil
}

func mapGitHubWebhookJobToTriggerEvent(job db.GithubWebhookJob, payload gitHubWorkflowEventPayload) (TriggerEvent, bool) {
	eventType := strings.ToLower(strings.TrimSpace(job.EventType))
	action := strings.ToLower(strings.TrimSpace(job.Action))
	if action == "" {
		action = strings.ToLower(strings.TrimSpace(payload.Action))
	}

	event := TriggerEvent{Type: eventType, Action: action}

	switch eventType {
	case "issues", "issue_comment":
		inputs, ok := gitHubIssueWorkflowInputs(job, payload, action)
		if !ok {
			return TriggerEvent{}, false
		}
		if payload.Repository != nil {
			event.Ref = strings.TrimSpace(payload.Repository.DefaultBranch)
		}
		event.Inputs = inputs
		return event, true
	case "push":
		event.Ref = strings.TrimSpace(payload.Ref)
		event.CommitSHA = strings.TrimSpace(payload.After)
		return event, true
	case "pull_request":
		if action != "opened" && action != "synchronize" {
			return TriggerEvent{}, false
		}
		if payload.PullRequest != nil {
			event.Ref = strings.TrimSpace(payload.PullRequest.Head.Ref)
			event.CommitSHA = strings.TrimSpace(payload.PullRequest.Head.SHA)
		}
		return event, true
	case "pull_request_review":
		if payload.PullRequest != nil {
			event.Ref = strings.TrimSpace(payload.PullRequest.Head.Ref)
			event.CommitSHA = strings.TrimSpace(payload.PullRequest.Head.SHA)
		}
		return event, true
	case "check_suite":
		if payload.CheckSuite != nil {
			event.Ref = strings.TrimSpace(payload.CheckSuite.HeadBranch)
			event.CommitSHA = strings.TrimSpace(payload.CheckSuite.HeadSHA)
		}
		return event, true
	case "check_run":
		if payload.CheckRun != nil {
			event.Ref = strings.TrimSpace(payload.CheckRun.CheckSuite.HeadBranch)
			event.CommitSHA = strings.TrimSpace(payload.CheckRun.HeadSHA)
			if event.CommitSHA == "" {
				event.CommitSHA = strings.TrimSpace(payload.CheckRun.CheckSuite.HeadSHA)
			}
		}
		return event, true
	default:
		return TriggerEvent{}, false
	}
}

// GitHub issue data remains external input, including its actor IDs: none of
// it grants a Plue identity or permission. The delivery ID stored by ingress
// is derived from the HMAC-signed body, so retries retain the same identity
// even if an unsigned X-GitHub-Delivery header changes. Workflows can use it
// for idempotent publications or a durable Control dispatch key.
func gitHubIssueWorkflowInputs(job db.GithubWebhookJob, payload gitHubWorkflowEventPayload, action string) (map[string]interface{}, bool) {
	var issue struct {
		ID          int64           `json:"id"`
		Number      int64           `json:"number"`
		Title       string          `json:"title"`
		Body        string          `json:"body"`
		State       string          `json:"state"`
		HTMLURL     string          `json:"html_url"`
		PullRequest json.RawMessage `json:"pull_request"`
		User        struct {
			Login string `json:"login"`
		} `json:"user"`
		Labels []gitHubLabel `json:"labels"`
	}
	if json.Unmarshal(payload.Issue, &issue) != nil || issue.ID <= 0 || issue.Number <= 0 || action == "" {
		return nil, false
	}
	// GitHub sends PR conversation comments as issue_comment events too. They
	// belong to the PR review setup, not opt-in issue handling.
	if len(issue.PullRequest) > 0 && string(issue.PullRequest) != "null" {
		return nil, false
	}
	if strings.EqualFold(strings.TrimSpace(job.EventType), "issue_comment") {
		var comment struct {
			ID int64 `json:"id"`
		}
		if json.Unmarshal(payload.Comment, &comment) != nil || comment.ID <= 0 {
			return nil, false
		}
	}
	labels := issueLabelNames(issue.Labels)
	inputs := map[string]interface{}{
		"source":             "github",
		"eventType":          strings.ToLower(strings.TrimSpace(job.EventType)),
		"action":             action,
		"githubDeliveryId":   job.DeliveryID,
		"githubWebhookJobId": job.ID,
		"issue":              payload.Issue,
		"sender":             payload.Sender,
		"issueId":            issue.ID,
		"issueNumber":        issue.Number,
		"issueTitle":         issue.Title,
		"issueBody":          issue.Body,
		"issueState":         issue.State,
		"issueAuthor":        issue.User.Login,
		"issueUrl":           issue.HTMLURL,
		"issueLabels":        labels,
	}
	if len(payload.Comment) > 0 {
		inputs["comment"] = payload.Comment
	}
	if payload.Repository != nil {
		inputs["repository"] = payload.Repository
		inputs["repoName"] = payload.Repository.Name
		inputs["repoOwner"] = payload.Repository.Owner.Login
		fullName := payload.Repository.FullName
		if fullName == "" && payload.Repository.Owner.Login != "" && payload.Repository.Name != "" {
			fullName = payload.Repository.Owner.Login + "/" + payload.Repository.Name
		}
		inputs["repoFullName"] = fullName
	}
	return inputs, true
}

func buildGitHubWebhookRepositorySelector(job db.GithubWebhookJob, payload gitHubWorkflowEventPayload) db.ListRepositoryIDsForGitHubWebhookJobParams {
	selector := db.ListRepositoryIDsForGitHubWebhookJobParams{}
	if job.InstallationID.Valid {
		selector.InstallationID = job.InstallationID.Int64
	}
	if job.GithubRepositoryID.Valid {
		selector.GitHubRepositoryID = job.GithubRepositoryID.Int64
	}
	if selector.InstallationID == 0 && payload.Installation != nil {
		selector.InstallationID = payload.Installation.ID
	}
	if selector.GitHubRepositoryID == 0 && payload.Repository != nil {
		selector.GitHubRepositoryID = payload.Repository.ID
	}

	if payload.Repository != nil {
		selector.OwnerLoginLower = strings.ToLower(strings.TrimSpace(payload.Repository.Owner.Login))
		selector.RepoNameLower = strings.ToLower(strings.TrimSpace(payload.Repository.Name))
		if selector.OwnerLoginLower == "" || selector.RepoNameLower == "" {
			parts := strings.SplitN(strings.TrimSpace(payload.Repository.FullName), "/", 2)
			if len(parts) == 2 {
				if selector.OwnerLoginLower == "" {
					selector.OwnerLoginLower = strings.ToLower(strings.TrimSpace(parts[0]))
				}
				if selector.RepoNameLower == "" {
					selector.RepoNameLower = strings.ToLower(strings.TrimSpace(parts[1]))
				}
			}
		}
	}

	return selector
}

// PollScheduledWorkflowTriggers preserves the webhook worker's legacy schedule
// polling entry point by delegating to the dedicated cron scheduler path.
func (w *GitHubWebhookEventWorker) PollScheduledWorkflowTriggers(ctx context.Context, now time.Time) error {
	if w == nil || w.queries == nil || w.dispatcher == nil {
		return nil
	}

	scheduleQueries, ok := w.queries.(CronSchedulerQuerier)
	if !ok {
		return fmt.Errorf("scheduled workflow polling requires workflow schedule queries")
	}

	worker := NewCronSchedulerWorker(scheduleQueries, w.dispatcher)
	worker.logger = w.logger
	worker.claimLimit = w.claimLimit
	return worker.pollOnce(ctx, now)
}
