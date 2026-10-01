package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Owner conflicts come only from the common transactional admission guard.
// A declaration, worker lease or failure to inspect a run is not ownership.
type factoryIssueOwner struct {
	ClaimID string `json:"claimId"`
	Kind    string `json:"ownerKind"`
	ID      string `json:"ownerId"`
	Digest  string `json:"approvedDigest"`
}

func factoryIssueOwned(err error) (factoryIssueOwner, bool) {
	var pgerr *pgconn.PgError
	var owner factoryIssueOwner
	if !errors.As(err, &pgerr) || pgerr.Code != "P2081" || json.Unmarshal([]byte(pgerr.Detail), &owner) != nil || owner.ClaimID == "" || owner.Kind == "" || owner.ID == "" || owner.Digest == "" {
		return owner, false
	}
	return owner, true
}
func (owner factoryIssueOwner) reason() string {
	return fmt.Sprintf("Deferred to %s %s (claim %s, approved text %s)", owner.Kind, owner.ID, owner.ClaimID, owner.Digest)
}

// Current registration controls new launches and approvals. This snapshot is
// used solely to finish observation/cancellation of its already admitted run.
type factoryIssueAuthority struct {
	Claim       db.FactoryIssueClaim
	OperationID string
	Signal      bool
}

func (s *RepositoryJobService) originalRepositoryJobRegistration(ctx context.Context, dispatch db.RepositoryJobDispatch, current db.RepositoryJobRegistration) (db.RepositoryJobRegistration, *factoryIssueAuthority, error) {
	claim, err := s.q.GetFactoryIssueClaimByOwner(ctx, db.GetFactoryIssueClaimByOwnerParams{OwnerKind: "repository-job", OwnerID: dispatch.ID})
	signal := false
	if errors.Is(err, pgx.ErrNoRows) {
		claim, err = s.q.GetFactoryIssueClaimByContinuation(ctx, dispatch.ID)
		signal = true
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return current, nil, nil
	}
	if err != nil {
		return current, nil, err
	}
	type snapshot struct {
		Registration *db.RepositoryJobRegistration `json:"registration"`
		OperationID  string                        `json:"operationId"`
	}
	var pinned struct {
		Registration  *db.RepositoryJobRegistration `json:"registration"`
		Continuations map[string]snapshot           `json:"continuations"`
	}
	binding := &factoryIssueAuthority{Claim: claim, OperationID: uuidString(claim.OperationID), Signal: signal}
	decodeErr := json.Unmarshal(claim.Authority, &pinned)
	if decodeErr == nil && signal {
		continuation, found := pinned.Continuations[dispatch.ID]
		if !found || continuation.OperationID == "" {
			return current, binding, errors.New("the admitted reply's original authority is unavailable")
		}
		pinned.Registration = continuation.Registration
		binding.OperationID = continuation.OperationID
	}
	if decodeErr != nil || pinned.Registration == nil {
		return current, binding, errors.New("the admitted factory owner's original authority is unavailable; ownership remains fenced")
	}
	original := *pinned.Registration
	if original.ID != dispatch.RegistrationID || original.RepositoryID != claim.RepositoryID || original.Revision != dispatch.Revision || original.Digest != dispatch.Digest || original.WorkspaceID == "" {
		return current, binding, errors.New("the admitted factory owner's original authority is invalid; ownership remains fenced")
	}
	return original, binding, nil
}
func repositoryJobOwnsIssue(config RegisterRepositoryJobInput, dispatch db.RepositoryJobDispatch) bool {
	return config.Mode == "enabled" && dispatch.Source == "github" && dispatch.IssueNumber > 0 &&
		(NormalizeTriggerName(dispatch.EventType) == "issue" || dispatch.EventType == "issue_comment") && strings.EqualFold(strings.TrimSpace(config.Label), todoLabel)
}

// Deferred work must still carry currently approved text when it wakes. The
// latest signed event can revoke a label or replace the exact text; a stale
// dispatch payload never grants new authority on its own.
func (s *RepositoryJobService) repositoryJobCurrentIssueApproval(ctx context.Context, reg db.RepositoryJobRegistration, dispatch db.RepositoryJobDispatch, config RegisterRepositoryJobInput) error {
	if !repositoryJobOwnsIssue(config, dispatch) {
		return nil
	}
	current, err := s.q.GetLatestFactoryIssueEvent(ctx, db.GetLatestFactoryIssueEventParams{RepositoryID: reg.RepositoryID, IssueNumber: dispatch.IssueNumber})
	if err != nil {
		return err
	}
	original, ok := repositoryJobSubjectText(dispatch.Payload)
	latest, latestOK := repositoryJobSubjectText(current.Payload)
	if !ok || !latestOK || original.Revision != latest.Revision {
		return errors.New("the issue text changed; a new approved delivery is required")
	}
	var payload struct {
		Issue struct {
			State  string        `json:"state"`
			Labels []gitHubLabel `json:"labels"`
		} `json:"issue"`
	}
	if json.Unmarshal(current.Payload, &payload) != nil || strings.EqualFold(payload.Issue.State, "closed") {
		return errors.New("the issue is closed or its current approval is unavailable")
	}
	if config.Label != "" && !issueCarriesLabel(issueLabelNames(payload.Issue.Labels), config.Label) {
		return errors.New("the issue's trigger label was removed; a new approved delivery is required")
	}
	trigger := config.Label
	if trigger == "" {
		trigger = issueApprovalLabel
	}
	allowed := []string(nil)
	if repositoryJobEventTextSource(current.Payload) != "" {
		allowed, err = s.agentIssueSources(ctx, reg)
		if err != nil {
			return err
		}
	}
	if !gitHubIssueEventApproves(current.EventType, current.EventAction, current.Payload, trigger, allowed) {
		return errors.New("the issue's current text is not approved; a new approved delivery is required")
	}
	return nil
}
func (s *RepositoryJobService) deferRepositoryJobOwner(ctx context.Context, dispatch db.RepositoryJobDispatch, owner factoryIssueOwner) error {
	_, err := s.q.DeferFactoryIssueFollower(ctx, db.DeferFactoryIssueFollowerParams{ID: dispatch.ID, ClaimToken: dispatch.ClaimToken, Error: owner.reason(), NextAttemptAt: s.now().Add(10 * time.Second)})
	return err
}
