package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// ReviewAdmission is immutable input to the background review dispatcher.
// No PR text, credential, working-copy path or caller-selected revision is
// passed to the machine. The consumer must restore and verify Pin before import.
type ReviewAdmission struct {
	RepositoryID   int64           `json:"repository_id"`
	RequesterID    int64           `json:"requester_id"`
	AuthorID       int64           `json:"author_id"`
	Number         int64           `json:"number"`
	Base           string          `json:"base"`
	Head           string          `json:"head"`
	URL            string          `json:"url"`
	Pin            flowruntime.Pin `json:"pin"`
	IdempotencyKey string          `json:"-"`
	OperationID    string          `json:"operationId,omitempty"`
	State          jobs.State      `json:"state,omitempty"`
	Conversation   string          `json:"conversation"`
}

type ReviewRequest struct {
	Number       int64  `json:"number"`
	Conversation string `json:"conversation"`
}

// Review dispatch deliberately does not reuse InvokedFlowService: that service
// resolves the requester's persistent box and supplies write credentials.
// This boundary admits only a current member's PR and a complete Active pin.
func (s *MythicalService) RequestReview(ctx context.Context, repositoryID, requesterID int64, request ReviewRequest, key string) (ReviewAdmission, error) {
	// Reconnect before reading mutable GitHub or Active state. Authorization is
	// still current; a repeated key cannot select a different head or digest.
	if s != nil && s.reviews != nil {
		decision, err := Authorize(ctx, s.queries(), "review")
		if err != nil {
			return ReviewAdmission{}, err
		}
		if decision.UserID != requesterID {
			return ReviewAdmission{}, reviewNonMember()
		}
		if request.Number <= 0 || request.Conversation == "" || len(request.Conversation) > 256 || key == "" || len(key) > 256 {
			return ReviewAdmission{}, &TodoControlError{Status: 400, Class: "user", Code: "invalid_review", Message: "Invalid review request"}
		}
		existing, err := s.reviews.store.GetByRequest(ctx, reviewScope(repositoryID, requesterID), reviewOperation, key)
		if err == nil {
			var payload reviewJob
			if json.Unmarshal(existing.Payload, &payload) != nil {
				return ReviewAdmission{}, reviewUnavailable("review_record_invalid")
			}
			if payload.Request != request {
				return ReviewAdmission{}, todoRequestMismatch()
			}
			if err := s.reviewMembers(ctx, payload.Admission); err != nil {
				return ReviewAdmission{}, err
			}
			result := payload.Admission
			result.OperationID, result.State = existing.ID, existing.State
			return result, nil
		}
		if !errors.Is(err, jobs.ErrNotFound) {
			return ReviewAdmission{}, err
		}
	}
	admission, err := s.prepareReview(ctx, repositoryID, requesterID, request, key)
	if err != nil {
		return ReviewAdmission{}, err
	}
	if s.reviews == nil {
		return ReviewAdmission{}, reviewUnavailable("review_delivery_unavailable")
	}
	return s.reviews.admit(ctx, admission, request)
}

func reviewScope(repositoryID, userID int64) jobs.Scope {
	return jobs.Scope{TenantID: "repository:" + strconv.FormatInt(repositoryID, 10), PrincipalID: "user:" + strconv.FormatInt(userID, 10)}
}

// reviewMembers is a local recheck of the admitted identities, never another
// remote PR lookup that could silently replace the selected head.
func (s *MythicalService) reviewMembers(ctx context.Context, admission ReviewAdmission) error {
	for _, user := range []int64{admission.RequesterID, admission.AuthorID} {
		var member bool
		err := s.store.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users u WHERE u.id=$2 AND u.is_active AND u.deleted_at IS NULL AND NOT u.prohibit_login AND
   (EXISTS(SELECT 1 FROM self_host_owners o WHERE o.singleton AND o.user_id=u.id) OR
    EXISTS(SELECT 1 FROM collaborators c WHERE c.repository_id=$1 AND c.user_id=u.id AND c.permission IN ('admin','write') AND c.suspended_at IS NULL)))`, admission.RepositoryID, user).Scan(&member)
		if err != nil {
			return reviewUnavailable("membership_unavailable")
		}
		if !member {
			return reviewNonMember()
		}
	}
	return nil
}

func (s *MythicalService) prepareReview(ctx context.Context, repositoryID, requesterID int64, request ReviewRequest, key string) (ReviewAdmission, error) {
	if s == nil || s.store == nil {
		return ReviewAdmission{}, reviewUnavailable("review_unavailable")
	}
	decision, err := Authorize(ctx, s.queries(), "review")
	if err != nil {
		return ReviewAdmission{}, err
	}
	if decision.UserID != requesterID {
		return ReviewAdmission{}, &AccessError{Status: 403, Class: "permission", Code: "permission", Message: "Not available"}
	}
	if request.Number <= 0 || request.Conversation == "" || len(request.Conversation) > 256 || key == "" || len(key) > 256 {
		return ReviewAdmission{}, &TodoControlError{Status: 400, Class: "user", Code: "invalid_review", Message: "PR, conversation and Idempotency-Key are required"}
	}
	installRepositoryID, err := InstallRepositoryID(ctx, s.queries())
	if err != nil {
		return ReviewAdmission{}, reviewUnavailable("repository_unavailable")
	}
	if installRepositoryID != repositoryID {
		return ReviewAdmission{}, &AccessError{Status: 403, Class: "permission", Code: "permission", Message: "Not available"}
	}
	if s.github == nil {
		return ReviewAdmission{}, reviewUnavailable("github_unavailable")
	}
	reader, ok := s.github.(interface {
		ResolvePullRead(context.Context, db.Repository, string, int64) (mythicalGitHubRepo, error)
	})
	if !ok {
		return ReviewAdmission{}, reviewUnavailable("github_unavailable")
	}
	repository, owner, err := s.repository(ctx, repositoryID)
	if err != nil {
		return ReviewAdmission{}, reviewUnavailable("repository_unavailable")
	}
	gh, err := reader.ResolvePullRead(ctx, repository, owner, requesterID)
	if err != nil {
		return ReviewAdmission{}, reviewUnavailable("github_unavailable")
	}
	pull, err := s.github.Pull(ctx, gh, request.Number)
	if err != nil {
		return ReviewAdmission{}, reviewUnavailable("github_unavailable")
	}
	// GitHub's immutable numeric identity is the roster key. Login names and
	// repository collaborators alone do not establish active install membership.
	// Install GitHub sign-in retains the historical workos provider key (Auth
	// and Members.AdmitGitHub); a separate legacy github token row grants no
	// owner identity here.
	if pull.Author.ID <= 0 || pull.Author.Type != "User" {
		return ReviewAdmission{}, reviewNonMember()
	}
	var authorID int64
	err = s.store.QueryRow(ctx, `SELECT u.id FROM users u WHERE u.is_active AND u.deleted_at IS NULL AND NOT u.prohibit_login
 AND (EXISTS (SELECT 1 FROM collaborators c WHERE c.user_id=u.id AND c.repository_id=$1
 AND c.github_id=$2 AND c.permission IN ('admin','write') AND c.suspended_at IS NULL)
 OR EXISTS (SELECT 1 FROM self_host_owners o JOIN oauth_accounts a ON a.user_id=o.user_id
 WHERE o.singleton AND o.user_id=u.id AND a.provider='workos' AND a.provider_user_id=$2::text))`, repositoryID, pull.Author.ID).Scan(&authorID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ReviewAdmission{}, reviewNonMember()
	}
	if err != nil {
		return ReviewAdmission{}, reviewUnavailable("membership_unavailable")
	}
	if pull.Number != request.Number || (!flowCommitPattern.MatchString(pull.HeadSHA) || strings.Trim(pull.HeadSHA, "0") == "") {
		return ReviewAdmission{}, reviewUnavailable("pr_head_unavailable")
	}
	// Both ends of the comparison are selected from the same GitHub read.
	// A branch name would silently follow a later base move during execution.
	if !flowCommitPattern.MatchString(pull.BaseSHA) || strings.Trim(pull.BaseSHA, "0") == "" {
		return ReviewAdmission{}, reviewUnavailable("pr_base_unavailable")
	}
	versions, err := db.New(s.store).ListFlowVersions(ctx, repositoryID)
	if err != nil {
		return ReviewAdmission{}, reviewUnavailable("active_flow_unavailable")
	}
	var pin flowruntime.Pin
	for _, version := range versions {
		if version.Name == "review" && version.IsActive && version.Status.Valid && version.Status.String == "loaded" && version.SourceCommit.Valid && version.Digest.Valid {
			pin = flowruntime.Pin{Flow: "review", SourceCommit: version.SourceCommit.String, ExecutionDigest: version.Digest.String}
			break
		}
	}
	// Git's all-zero object ID denotes a missing revision, not restorable
	// source. The shared pin shape checks encoding; review also needs an
	// actual selected source before it can admit repository execution.
	if !pin.Valid() || strings.Trim(pin.SourceCommit, "0") == "" {
		return ReviewAdmission{}, reviewUnavailable("active_flow_unavailable")
	}
	return ReviewAdmission{RepositoryID: repositoryID, RequesterID: requesterID, AuthorID: authorID, Number: request.Number, Base: pull.BaseSHA, Head: pull.HeadSHA, URL: fmt.Sprintf("https://github.com/%s/%s/pull/%d", gh.Owner, gh.Name, request.Number), Pin: pin, IdempotencyKey: key, Conversation: request.Conversation}, nil
}

func reviewUnavailable(code string) error {
	return &TodoControlError{Status: http.StatusServiceUnavailable, Class: "infra", Code: code, Message: "Review unavailable"}
}
func reviewNonMember() error {
	return &TodoControlError{Status: http.StatusForbidden, Class: "permission", Code: "permission", Message: "PR author is not a member"}
}

// ReviewStatus is a requester-scoped projection. Credential identities and
// private job checkpoints never cross the HTTP boundary.
type ReviewStatus struct {
	Admission ReviewAdmission `json:"admission"`
	State     jobs.State      `json:"state"`
	Change    json.RawMessage `json:"change,omitempty"`
	Error     string          `json:"error,omitempty"`
}

func (s *MythicalService) GetReview(ctx context.Context, repositoryID, requesterID int64, id string) (ReviewStatus, error) {
	if s == nil || s.store == nil {
		return ReviewStatus{}, reviewUnavailable("review_unavailable")
	}
	decision, err := Authorize(ctx, s.queries(), "repo.read")
	if err != nil {
		return ReviewStatus{}, err
	}
	if decision.UserID != requesterID {
		return ReviewStatus{}, reviewNonMember()
	}
	if s.reviews == nil {
		return ReviewStatus{}, reviewUnavailable("review_delivery_unavailable")
	}
	if _, err := uuid.Parse(id); err != nil {
		return ReviewStatus{}, &TodoControlError{Status: 404, Class: "user", Code: "review_not_found", Message: "Review not found"}
	}
	operation, err := s.reviews.store.Get(ctx, reviewScope(repositoryID, requesterID), id)
	if errors.Is(err, jobs.ErrNotFound) || err == nil && operation.Operation != reviewOperation {
		return ReviewStatus{}, &TodoControlError{Status: 404, Class: "user", Code: "review_not_found", Message: "Review not found"}
	}
	if err != nil {
		return ReviewStatus{}, err
	}
	var job reviewJob
	if json.Unmarshal(operation.Payload, &job) != nil {
		return ReviewStatus{}, reviewUnavailable("review_record_invalid")
	}
	if err := s.reviewMembers(ctx, job.Admission); err != nil {
		return ReviewStatus{}, err
	}
	result := ReviewStatus{Admission: job.Admission, State: operation.State}
	result.Admission.OperationID, result.Admission.State = operation.ID, operation.State
	if operation.State.Terminal() {
		var observation ReviewObservation
		if len(operation.TerminalReceipt) > 0 && json.Unmarshal(operation.TerminalReceipt, &observation) == nil {
			result.Change, result.Error = observation.Change, observation.Error
		}
		if operation.State != jobs.StateCompleted && result.Error == "" {
			result.Error = "Review failed"
		}
	}
	return result, nil
}
