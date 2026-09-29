package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// AdmitGitHubEvent is only called from the signed, deduplicated GitHub job
// worker. The original issue/comment objects never grant repository authority.
func (s *RepositoryJobService) AdmitGitHubEvent(ctx context.Context, repoID int64, job db.GithubWebhookJob, event TriggerEvent) error {
	if strings.TrimSpace(job.DeliveryID) == "" {
		return fmt.Errorf("github job is missing its signed-body delivery identity")
	}
	var payload struct {
		Issue *struct {
			Number int64 `json:"number"`
		} `json:"issue"`
		Pull *struct {
			Number int64 `json:"number"`
		} `json:"pull_request"`
	}
	if err := json.Unmarshal(job.Payload, &payload); err != nil {
		return err
	}
	var number int64
	if payload.Issue != nil {
		number = payload.Issue.Number
	} else if payload.Pull != nil {
		number = payload.Pull.Number
	}
	return s.q.AdmitRepositoryJobEvent(ctx, db.AdmitRepositoryJobEventParams{
		RepositoryID: repoID, DeliveryKey: "github:" + job.DeliveryID, Source: "github",
		EventType: event.Type, EventAction: event.Action, IssueNumber: number, Payload: job.Payload,
	})
}

// Admission and execution are independent durable queues: an accepted webhook
// is retained even when a workspace is asleep, or before the setup host receives
// the newly-created trial issue's number. No network job runs in the UI request.
func (s *RepositoryJobService) Start(ctx context.Context) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		if err := s.PollOnce(ctx); err != nil && ctx.Err() == nil {
			slog.Error("repository job worker", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// repositoryJobMatches reports whether a registration takes an event.
// allowedSources is the repository's owner-committed agentIssueSources.
func repositoryJobMatches(config RegisterRepositoryJobInput, event db.RepositoryJobEvent, allowedSources []string) bool {
	matched := false
	for _, rule := range config.Events {
		if NormalizeTriggerName(rule.Type) != NormalizeTriggerName(event.EventType) {
			continue
		}
		if len(rule.Actions) == 0 {
			matched = true
		}
		for _, action := range rule.Actions {
			if strings.EqualFold(strings.TrimSpace(action), strings.TrimSpace(event.EventAction)) {
				matched = true
			}
		}
	}
	if !matched || config.Mention != "" && !repositoryJobEventNames(event, config.Mention) {
		return false
	}
	// Every issue event, a trial's included, needs its text approved for
	// this job's trigger label (a trial issue a person pressed is theirs).
	trigger := config.Label
	if trigger == "" {
		trigger = issueApprovalLabel
	}
	if !gitHubIssueEventApproves(event.EventType, event.EventAction, event.Payload, trigger, allowedSources) {
		return false
	}
	if config.Label == "" || config.Mode == "trial" {
		return true
	}
	var payload struct {
		Issue struct {
			Labels []gitHubLabel `json:"labels"`
		} `json:"issue"`
	}
	if json.Unmarshal(event.Payload, &payload) != nil {
		return false
	}
	return issueCarriesLabel(issueLabelNames(payload.Issue.Labels), config.Label)
}

// repositoryJobEventNames reports whether an event names login: an issue
// assigned to it (its GitHub App account is login[bot]), or a comment that
// @mentions it outside code.
func repositoryJobEventNames(event db.RepositoryJobEvent, login string) bool {
	var payload struct {
		Assignee *gitHubActor `json:"assignee"`
		Comment  *struct {
			Body string `json:"body"`
		} `json:"comment"`
	}
	if json.Unmarshal(event.Payload, &payload) != nil {
		return false
	}
	switch NormalizeTriggerName(event.EventType) {
	case "issue":
		if payload.Assignee == nil {
			return false
		}
		assignee := strings.ToLower(payload.Assignee.Login)
		return assignee == login || assignee == login+"[bot]"
	case "issue_comment":
		return payload.Comment != nil && slices.Contains(ExtractMentions(payload.Comment.Body), login)
	}
	return false
}

// repositoryJobCommentBody is an issue_comment event's comment text.
func repositoryJobCommentBody(event db.RepositoryJobEvent) (string, bool) {
	var payload struct {
		Comment *struct {
			Body string `json:"body"`
		} `json:"comment"`
	}
	if NormalizeTriggerName(event.EventType) != "issue_comment" || json.Unmarshal(event.Payload, &payload) != nil || payload.Comment == nil {
		return "", false
	}
	return payload.Comment.Body, true
}

func (s *RepositoryJobService) PollOnce(ctx context.Context) error {
	if err := s.q.SkipRetiredRepositoryJobDispatches(ctx); err != nil {
		return err
	}
	admissions, err := s.q.ListRepositoryJobAdmissions(ctx, 100)
	if err != nil {
		return err
	}
	sources := map[int64][]string{}
	for _, row := range admissions {
		reg, event := row.RepositoryJobRegistration, row.RepositoryJobEvent
		var config RegisterRepositoryJobInput
		if err := json.Unmarshal(reg.Configuration, &config); err != nil {
			return fmt.Errorf("invalid repository job registration %s", reg.ID)
		}
		matched := repositoryJobMatches(config, event, nil)
		// The owner-committed agentIssueSources are read only when they could
		// decide: the event's issue an agent source wrote, and nothing else
		// approved it. An unreadable policy approves nothing (fail closed; a
		// maintainer's label still does).
		if !matched && repositoryJobEventTextSource(event.Payload) != "" {
			allowed, known := sources[reg.RepositoryID]
			if !known {
				var err error
				if allowed, err = s.agentIssueSources(ctx, reg); err != nil {
					slog.Warn("repository_jobs.policy_unreadable", "repository_id", reg.RepositoryID, "error", err)
				}
				sources[reg.RepositoryID] = allowed
			}
			matched = repositoryJobMatches(config, event, allowed)
		}
		// A mention proposes work once per text: the same comment again on
		// the issue (a second post, not a redelivery) is not a new proposal.
		if body, ok := repositoryJobCommentBody(event); matched && config.Mention != "" && ok {
			taken, err := s.q.RepositoryJobCommentAlreadyTaken(ctx, db.RepositoryJobCommentAlreadyTakenParams{
				RegistrationID: reg.ID, Source: event.Source, IssueNumber: event.IssueNumber, Body: body,
			})
			if err != nil {
				return err
			}
			matched = !taken
		}
		status := "skipped"
		if matched {
			status = "queued"
		}
		if err := s.q.EnqueueRepositoryJobDispatch(ctx, db.EnqueueRepositoryJobDispatchParams{
			ID: reg.ID, Revision: reg.Revision, DeliveryKey: event.DeliveryKey, Source: event.Source,
			EventType: event.EventType, EventAction: event.EventAction, IssueNumber: event.IssueNumber,
			Payload: event.Payload, Status: status,
		}); err != nil {
			return err
		}
	}
	if err := s.enqueueSchedules(ctx); err != nil {
		return err
	}
	claims, err := s.q.ClaimRepositoryJobDispatches(ctx, 1)
	if err != nil {
		return err
	}
	for _, claim := range claims {
		// A bounded attempt may provision a sleeping workspace, but never holds
		// its DB claim longer than the two-minute fencing lease.
		attemptCtx, cancel := context.WithTimeout(ctx, 80*time.Second)
		err := s.dispatch(attemptCtx, claim)
		cancel()
		if err != nil {
			finalizeCtx, done := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			status := "queued"
			var apiErr *pkgerrors.APIError
			if claim.Attempts >= 8 || errors.As(err, &apiErr) && (apiErr.Status == 401 || apiErr.Status == 403 || apiErr.Status == 404) {
				status = "failed"
			}
			_, saveErr := s.settle(finalizeCtx, claim, status, claim.RunID, nil, err.Error())
			done()
			if saveErr != nil {
				return saveErr
			}
		}
	}
	return nil
}

func (s *RepositoryJobService) enqueueSchedules(ctx context.Context) error {
	registrations, err := s.q.ListDueRepositoryJobSchedules(ctx, 50)
	if err != nil {
		return err
	}
	for _, reg := range registrations {
		paused, err := s.ownerAutonomyPaused(ctx, reg.UserID)
		if err != nil {
			return err
		}
		if paused {
			continue
		}
		next, err := nextFireTime(reg.Schedule, s.now())
		if err != nil || next.IsZero() {
			return fmt.Errorf("invalid stored repository job schedule %s", reg.ID)
		}
		key := "schedule:" + reg.NextFireAt.Time.UTC().Format(time.RFC3339Nano)
		payload, _ := json.Marshal(map[string]interface{}{"scheduledAt": reg.NextFireAt.Time})
		if err := s.q.EnqueueRepositoryJobDispatch(ctx, db.EnqueueRepositoryJobDispatchParams{
			ID: reg.ID, Revision: reg.Revision, DeliveryKey: key, Source: "schedule", EventType: "schedule",
			Payload: payload, Status: "queued",
		}); err != nil {
			return err
		}
		// If the process dies here, the same occurrence inserts once again via
		// the unique key. Only then may its next-fire timestamp advance.
		if _, err := s.q.AdvanceRepositoryJobSchedule(ctx, db.AdvanceRepositoryJobScheduleParams{
			ID: reg.ID, Revision: reg.Revision, NextFireAt: reg.NextFireAt, NextFireAt_2: pgtype.Timestamptz{Time: next, Valid: true},
		}); err != nil {
			return err
		}
	}
	return nil
}

// repositoryJobApprovedText is the text of a dispatch's subject as it was
// when the event was approved: its issue (every issue event a job takes is
// approved, or is its trial or a person's manual run), else its pull request
// when that is a maintainer's text. A run works from it, never from the live
// subject, which may have changed since. An outsider's pull request has none:
// its run is an outsider's anyway.
type repositoryJobApprovedText struct {
	Title    string `json:"title"`
	Body     string `json:"body"`
	Revision string `json:"revision"`
}

func repositoryJobSubjectText(payload json.RawMessage) (repositoryJobApprovedText, bool) {
	type text struct {
		Title            *string `json:"title"`
		Body             *string `json:"body"`
		TextByMaintainer bool    `json:"smithers_text_by_maintainer"`
	}
	var event struct {
		Issue       *text `json:"issue"`
		PullRequest *text `json:"pull_request"`
	}
	if json.Unmarshal(payload, &event) != nil {
		return repositoryJobApprovedText{}, false
	}
	subject := event.Issue
	if subject == nil && event.PullRequest != nil && event.PullRequest.TextByMaintainer {
		subject = event.PullRequest
	}
	if subject == nil || subject.Title == nil {
		return repositoryJobApprovedText{}, false
	}
	approved := repositoryJobApprovedText{Title: *subject.Title}
	if subject.Body != nil {
		approved.Body = *subject.Body
	}
	sum := sha256.Sum256([]byte(approved.Title + "\x00" + approved.Body))
	approved.Revision = "sha256:" + hex.EncodeToString(sum[:])
	return approved, true
}

func repositoryJobDispatchEvent(reg db.RepositoryJobRegistration, claim db.RepositoryJobDispatch) map[string]interface{} {
	event := map[string]interface{}{"source": claim.Source, "type": claim.EventType, "action": claim.EventAction,
		"deliveryKey": claim.DeliveryKey, "issueNumber": claim.IssueNumber, "payload": claim.Payload}
	if approved, ok := repositoryJobSubjectText(claim.Payload); ok {
		event["approvedText"] = approved
	}
	// The source payload is untrusted. Trial authority comes only from the
	// persisted registration and its exact source/issue scope, never its body.
	if reg.Mode == "trial" && reg.TrialIssueNumber > 0 && reg.TrialIssueNumber == claim.IssueNumber && reg.TrialSource == claim.Source {
		event["trial"] = true
	}
	if claim.EventType == "manual" && strings.HasPrefix(claim.DeliveryKey, "manual:") && strings.HasPrefix(claim.EventAction, "manual:") {
		step := strings.TrimPrefix(claim.EventAction, "manual:")
		if repositoryJobManualStep.MatchString(step) {
			event["manualStep"] = step
		}
	}
	return event
}

// repositoryName authorizes the registration's user to write its repository
// and answers the repository's owner/name.
// repositoryJobEventTextSource is the agent source an event's issue text
// names (issueText.Source), or "".
func repositoryJobEventTextSource(payload []byte) string {
	var event struct {
		Issue *authoredText `json:"issue"`
	}
	if json.Unmarshal(payload, &event) != nil || event.Issue == nil {
		return ""
	}
	return event.Issue.TextSource
}

// agentIssueSources are the agent sources the repository's default bookmark
// lets file issues that start credentialed work (agentIssueSources).
func (s *RepositoryJobService) agentIssueSources(ctx context.Context, reg db.RepositoryJobRegistration) ([]string, error) {
	if s.policy == nil {
		return nil, errors.New("repository policy reader unavailable")
	}
	name, err := s.repositoryName(ctx, reg)
	if err != nil {
		return nil, err
	}
	repo, err := s.q.GetRepoByID(ctx, reg.RepositoryID)
	if err != nil {
		return nil, err
	}
	owner, repoName, _ := strings.Cut(name, "/")
	policy, err := readRepositoryPolicy(ctx, s.policy, owner, repoName, repo.DefaultBookmark)
	if err != nil {
		return nil, err
	}
	return policy.AgentIssueSources, nil
}

func (s *RepositoryJobService) repositoryName(ctx context.Context, reg db.RepositoryJobRegistration) (string, error) {
	repo, err := s.authorizedRepo(ctx, reg.RepositoryID, reg.UserID, true)
	if err != nil {
		return "", err
	}
	var configuration RegisterRepositoryJobInput
	if len(reg.Configuration) > 0 && json.Unmarshal(reg.Configuration, &configuration) != nil {
		return "", errors.New("invalid stored repository job configuration")
	}
	factory := configuration.FactoryRevision != ""
	if factory && repo.UserID.Valid && repo.UserID.Int64 != reg.UserID {
		return "", pkgerrors.Forbidden("factory owner changed")
	}
	var owner string
	if repo.UserID.Valid {
		user, err := s.q.GetUserByID(ctx, repo.UserID.Int64)
		if err != nil {
			return "", err
		}
		owner = user.Username
	} else if repo.OrgID.Valid {
		org, err := s.q.GetOrgByID(ctx, repo.OrgID.Int64)
		if err != nil {
			return "", err
		}
		if factory {
			if !org.FactoryOwnerID.Valid || org.FactoryOwnerID.Int64 != reg.UserID {
				return "", pkgerrors.Forbidden("factory owner changed")
			}
			isOwner, err := s.q.IsOrgOwnerForRepoUser(ctx, db.IsOrgOwnerForRepoUserParams{RepositoryID: repo.ID, UserID: reg.UserID})
			if err != nil {
				return "", err
			}
			if !isOwner {
				return "", pkgerrors.Forbidden("factory owner is no longer an organization owner")
			}
		}
		owner = org.Name
	}
	if owner == "" {
		return "", pkgerrors.NotFound("repository owner is unavailable")
	}
	return owner + "/" + repo.Name, nil
}

func (s *RepositoryJobService) dispatch(ctx context.Context, claim db.RepositoryJobDispatch) error {
	if s.flowDispatcher == nil {
		return errors.New("repository job Flow dispatcher is unavailable")
	}
	reg, err := s.q.GetRepositoryJobRegistration(ctx, claim.RegistrationID)
	if err != nil {
		return err
	}
	if !reg.Enabled || reg.Revision != claim.Revision || reg.Digest != claim.Digest {
		_, err := s.settle(ctx, claim, "skipped", "", nil, "Registration was paused or replaced")
		return err
	}
	if claim.Source == "schedule" {
		paused, err := s.ownerAutonomyPaused(ctx, reg.UserID)
		if err != nil {
			return err
		}
		if paused {
			_, err = s.q.SettleRepositoryJobDispatch(ctx, db.SettleRepositoryJobDispatchParams{ID: claim.ID, ClaimToken: claim.ClaimToken, Status: "queued", NextAttemptAt: s.now().Add(5 * time.Minute), Error: "Scheduled work paused at 60% subscription usage"})
			return err
		}
	}
	// Revalidate repository writer and workspace authority before admitting a
	// common Flow operation. Admission persists first and returns without
	// resolving or contacting the canonical host.
	if _, err := s.repositoryName(ctx, reg); err != nil {
		return err
	}
	if claim.EventType == "issue_comment" && claim.IssueNumber > 0 {
		previous, err := s.q.LatestRepositoryJobIssueRun(ctx, db.LatestRepositoryJobIssueRunParams{
			RegistrationID: reg.ID, Revision: reg.Revision, Source: claim.Source, IssueNumber: claim.IssueNumber,
		})
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if err == nil {
			receipt, err := s.admitRepositoryJobSignal(ctx, reg, claim, previous)
			if err != nil {
				return err
			}
			encoded, err := json.Marshal(receipt)
			if err != nil {
				return err
			}
			_, err = s.settle(ctx, claim, "waiting", previous.RunID, encoded, "")
			return err
		}
	}
	receipt, err := s.admitRepositoryJobLaunch(ctx, reg, claim)
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	_, err = s.settle(ctx, claim, "waiting", "", encoded, "")
	return err
}

func (s *RepositoryJobService) settle(ctx context.Context, claim db.RepositoryJobDispatch, status, runID string, receipt json.RawMessage, message string) (int64, error) {
	if len(message) > 1000 {
		message = message[:1000]
	}
	backoff := time.Duration(1<<min(claim.Attempts, 6)) * time.Second
	if status == "waiting" {
		backoff = 10 * time.Second
	}
	return s.q.SettleRepositoryJobDispatch(ctx, db.SettleRepositoryJobDispatchParams{ID: claim.ID, ClaimToken: claim.ClaimToken,
		Status: status, RunID: runID, Receipt: receipt, Error: message, NextAttemptAt: s.now().Add(backoff)})
}
