package services

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

var repositoryJobManualStep = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,100}$`)

type RepositoryJobManualSubject struct {
	Source string `json:"source"`
	Kind   string `json:"kind"`
	Number int64  `json:"number"`
}

type RepositoryJobManualInput struct {
	Repo        string                      `json:"repo"`
	WorkspaceID string                      `json:"workspace_id"`
	Revision    int64                       `json:"revision"`
	Digest      string                      `json:"digest"`
	StepID      string                      `json:"step_id"`
	Prompt      string                      `json:"prompt"`
	Subject     *RepositoryJobManualSubject `json:"subject,omitempty"`
}

type RepositoryJobManualResult struct {
	DispatchID     string `json:"dispatch_id"`
	RegistrationID string `json:"registration_id"`
	Revision       int64  `json:"revision"`
	Digest         string `json:"digest"`
	DeliveryKey    string `json:"delivery_key"`
	Status         string `json:"status"`
	RunID          string `json:"run_id,omitempty"`
}

// RunManual admits a deliberate user request against the exact applied policy.
// It never takes configuration, event payloads or an actor identity from the
// request. The ordinary worker supplies durable Plan/Run and human node gates.
func (s *RepositoryJobService) RunManual(ctx context.Context, hostID, bearer, job, requestID string, input RepositoryJobManualInput) (RepositoryJobManualResult, error) {
	var empty RepositoryJobManualResult
	if !isRepositoryJobName(job) || strings.TrimSpace(requestID) == "" || len(requestID) > 200 ||
		strings.ContainsAny(requestID, "\r\n\x00/") || input.Revision <= 0 || !repositoryJobDigest.MatchString(input.Digest) ||
		!repositoryJobManualStep.MatchString(input.StepID) || len(input.Prompt) > 16000 || (input.Subject == nil && strings.TrimSpace(input.Prompt) == "") {
		return empty, pkgerrors.BadRequest("manual run requires an exact candidate, selected step and request")
	}
	if input.Subject != nil && ((input.Subject.Source != "smithers-cloud" && input.Subject.Source != "github") ||
		(input.Subject.Kind != "issue" && input.Subject.Kind != "pr") || input.Subject.Number <= 0) {
		return empty, pkgerrors.BadRequest("manual subject requires its source, kind and number")
	}
	if err := validateSafeText("RepositoryJob", "prompt", input.Prompt); err != nil {
		return empty, err
	}
	repo, target, err := s.authorizeHostCallback(ctx, hostID, bearer, input.Repo, input.WorkspaceID)
	if err != nil {
		return empty, err
	}
	if s.transactions == nil {
		return empty, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "manual run transactions unavailable")
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return empty, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, repoOwnershipSharedLockSQL, repo.ID); err != nil {
		return empty, err
	}
	q := db.New(tx)
	fresh, err := (&RepositoryJobService{q: q}).authorizedRepo(ctx, repo.ID, target.UserID, true)
	if err != nil {
		return empty, err
	}
	if fresh.UserID != repo.UserID || fresh.OrgID != repo.OrgID || fresh.Name != repo.Name {
		return empty, pkgerrors.Conflict("repository ownership changed")
	}
	if err = q.LockRepositoryJobManual(ctx, db.LockRepositoryJobManualParams{RepositoryID: repo.ID, Job: job, RequestID: requestID}); err != nil {
		return empty, err
	}
	key := "manual:" + requestID
	find := db.GetRepositoryJobManualDispatchParams{RepositoryID: repo.ID, Job: job, DeliveryKey: key}
	existing, err := q.GetRepositoryJobManualDispatch(ctx, find)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return empty, err
	}
	wire, err := json.Marshal(input)
	if err != nil {
		return empty, err
	}
	if existing.RepositoryJobDispatch.ID != "" {
		var saved struct {
			Request json.RawMessage `json:"_manualRequest"`
		}
		if json.Unmarshal(existing.RepositoryJobDispatch.Payload, &saved) != nil || !sameRepositoryJobJSON(saved.Request, wire) ||
			existing.RepositoryJobRegistration.WorkspaceID != target.WorkspaceID || existing.RepositoryJobRegistration.UserID != target.UserID {
			return empty, pkgerrors.Conflict("manual request already belongs to different input or authority")
		}
		if err = tx.Commit(ctx); err != nil {
			return empty, err
		}
		return repositoryJobManualResult(existing.RepositoryJobDispatch), nil
	}
	reg, err := q.GetEnabledRepositoryJobForManual(ctx, db.GetEnabledRepositoryJobForManualParams{RepositoryID: repo.ID, Job: job})
	if errors.Is(err, pgx.ErrNoRows) {
		return empty, pkgerrors.Conflict("set up and enable this repository job first")
	}
	if err != nil {
		return empty, err
	}
	if reg.UserID != target.UserID || reg.WorkspaceID != target.WorkspaceID || reg.Revision != input.Revision || reg.Digest != input.Digest {
		return empty, pkgerrors.Conflict("manual run must use the current applied candidate and owning workspace")
	}
	var config RegisterRepositoryJobInput
	if json.Unmarshal(reg.Configuration, &config) != nil {
		return empty, pkgerrors.Internal("invalid applied repository job")
	}
	// A registered flow has no setup draft to select a step from; its whole
	// registration is the one thing a manual request can fire.
	if repositoryFlowJobKey.MatchString(job) {
		if input.StepID != "fire" {
			return empty, pkgerrors.BadRequest("selected step is absent or switched off")
		}
	} else {
		var draft struct {
			Steps []struct {
				ID   string `json:"id"`
				Mode string `json:"mode"`
			} `json:"steps"`
		}
		if json.Unmarshal(config.Input, &draft) != nil {
			return empty, pkgerrors.Internal("invalid applied repository job")
		}
		selected := false
		for _, step := range draft.Steps {
			if step.ID == input.StepID && (step.Mode == "manual" || step.Mode == "automatic" || step.Mode == "approved") {
				selected = true
			}
		}
		if !selected {
			return empty, pkgerrors.BadRequest("selected step is absent or switched off")
		}
	}
	payload, source, number, err := repositoryJobManualPayload(ctx, q, repo.ID, input, wire, func(owner, name string) bool {
		return s.githubRead != nil && s.githubRead.GitHubRepoReadAuthorized(ctx, target.UserID, owner, name)
	})
	if err != nil {
		return empty, err
	}
	if err = q.EnqueueRepositoryJobDispatch(ctx, db.EnqueueRepositoryJobDispatchParams{ID: reg.ID, Revision: reg.Revision,
		DeliveryKey: key, Source: source, EventType: "manual", EventAction: "manual:" + input.StepID,
		IssueNumber: number, Payload: payload, Status: "queued"}); err != nil {
		return empty, err
	}
	created, err := q.GetRepositoryJobManualDispatch(ctx, find)
	if err != nil {
		return empty, err
	}
	if err = tx.Commit(ctx); err != nil {
		return empty, err
	}
	return repositoryJobManualResult(created.RepositoryJobDispatch), nil
}

func repositoryJobManualResult(d db.RepositoryJobDispatch) RepositoryJobManualResult {
	return RepositoryJobManualResult{DispatchID: d.ID, RegistrationID: d.RegistrationID, Revision: d.Revision,
		Digest: d.Digest, DeliveryKey: d.DeliveryKey, Status: d.Status, RunID: d.RunID}
}

func repositoryJobManualPayload(ctx context.Context, q *db.Queries, repoID int64, input RepositoryJobManualInput, wire json.RawMessage, canReadGitHub func(owner, repo string) bool) (json.RawMessage, string, int64, error) {
	payload := map[string]interface{}{"_manualRequest": wire, "manual": map[string]string{"stepId": input.StepID, "prompt": input.Prompt}, "repository": map[string]interface{}{"id": repoID, "full_name": input.Repo}}
	source, number := "smithers-cloud", int64(0)
	if subject := input.Subject; subject != nil {
		source, number = subject.Source, subject.Number
		field := "issue"
		if subject.Kind == "pr" {
			field = "pull_request"
		}
		var data json.RawMessage
		var err error
		if subject.Source == "github" {
			rows, sourceErr := q.ListRepositoryGitHubSources(ctx, repoID)
			if sourceErr != nil {
				return nil, "", 0, sourceErr
			}
			if len(rows) != 1 {
				return nil, "", 0, pkgerrors.Conflict("repository needs one verified GitHub source")
			}
			// Import provenance only proves the importer could read the repo
			// once; the shared store keeps filling after that. The caller's own
			// credential must still read it.
			if !canReadGitHub(rows[0].GithubOwner, rows[0].GithubRepo) {
				return nil, "", 0, pkgerrors.Forbidden("your GitHub account cannot read this repository's GitHub source; reconnect GitHub and retry")
			}
			resource := "issues"
			if subject.Kind == "pr" {
				resource = "pulls"
			}
			data, err = q.GetRepositoryJobGitHubSubject(ctx, db.GetRepositoryJobGitHubSubjectParams{GithubOwner: rows[0].GithubOwner, GithubRepo: rows[0].GithubRepo, Resource: resource, Number: number})
			payload["repository"] = map[string]string{"full_name": rows[0].GithubOwner + "/" + rows[0].GithubRepo}
		} else if subject.Kind == "issue" {
			data, err = q.GetRepositoryJobNativeIssueSubject(ctx, db.GetRepositoryJobNativeIssueSubjectParams{RepositoryID: repoID, Number: number})
		} else {
			var landing db.GetLandingRequestWithChangeIDsByNumberRow
			landing, err = q.GetLandingRequestWithChangeIDsByNumber(ctx, db.GetLandingRequestWithChangeIDsByNumberParams{RepositoryID: repoID, Number: number})
			if err == nil {
				data, err = json.Marshal(map[string]interface{}{"id": landing.ID, "number": landing.Number, "title": landing.Title, "body": landing.Body,
					"state": landing.State, "author_id": landing.AuthorID, "change_ids": landing.ChangeIds, "source_bookmark": landing.SourceBookmark, "target_bookmark": landing.TargetBookmark})
			}
		}
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, "", 0, pkgerrors.NotFound("the requested issue or PR is unavailable in this repository's source")
		}
		if err != nil {
			return nil, "", 0, err
		}
		if subject.Source == "github" {
			var identity struct {
				ID          int64           `json:"id"`
				Number      int64           `json:"number"`
				PullRequest json.RawMessage `json:"pull_request"`
			}
			if json.Unmarshal(data, &identity) != nil || identity.ID <= 0 || identity.Number != number {
				return nil, "", 0, pkgerrors.Conflict("the cached GitHub subject needs to be refreshed")
			}
			// GitHub's issues collection also contains pull requests. The
			// caller's selected kind cannot turn one into an issue workflow.
			if subject.Kind == "issue" && len(identity.PullRequest) > 0 && string(identity.PullRequest) != "null" {
				return nil, "", 0, pkgerrors.BadRequest("the selected GitHub subject is a pull request")
			}
		}
		payload[field] = data
	}
	data, err := json.Marshal(payload)
	return data, source, number, err
}
