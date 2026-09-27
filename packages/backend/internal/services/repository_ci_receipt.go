package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// repositoryCiContextPrefix names the reserved commit-status namespace that
// only a check receipt may write. It is deliberately outside "smithers/":
// workflowCommitStatusContext mints "smithers/" + a repository-controlled
// workflow definition name, and the legacy executor then flips that row to
// success, so any namespace under it is forgeable from repository YAML.
const repositoryCiContextPrefix = "repository-ci/"

// repositoryCiRequiredContext names the landing gate for one exact CI policy.
// The registration UUID is stable across revisions, so the revision and digest
// suffix is what makes a replaced policy rename its own required context.
func repositoryCiRequiredContext(registrationID string, revision int64, digest string) string {
	short := digest
	if len(short) > 12 {
		short = short[:12]
	}
	return fmt.Sprintf("%s%s@%d.%s", repositoryCiContextPrefix, registrationID, revision, short)
}

// RepositoryCheckOutcome is one configured check as the host actually executed
// it. A required rule scoped to paths the commit does not touch is honestly
// skipped; it is neither a pass nor a refusal.
type RepositoryCheckOutcome struct {
	ID      string `json:"id"`
	Outcome string `json:"outcome"`
}

type RepositoryCheckReceiptInput struct {
	Repo            string                   `json:"repo"`
	WorkspaceID     string                   `json:"workspace_id"`
	RegistrationID  string                   `json:"registration_id"`
	Revision        int64                    `json:"revision"`
	Digest          string                   `json:"digest"`
	ExecutionDigest string                   `json:"execution_digest"`
	RunID           string                   `json:"run_id"`
	ExecutionID     string                   `json:"execution_id"`
	CommitID        string                   `json:"commit_id"`
	ChangeID        string                   `json:"change_id"`
	BaseCommitID    string                   `json:"base_commit_id"`
	Checks          []RepositoryCheckOutcome `json:"checks"`
	Gate            string                   `json:"gate"`
}

type RepositoryCheckReceiptResponse struct {
	RequestID string `json:"request_id"`
	Context   string `json:"context"`
	CommitID  string `json:"commit_id"`
	Status    string `json:"status"`
	StatusID  int64  `json:"status_id"`
}

const (
	repositoryCheckOutcomePassed  = "passed"
	repositoryCheckOutcomeSkipped = "skipped_no_matching_paths"
	maxRepositoryCheckOutcomes    = 200
	// maxRepositoryCheckIDLength mirrors SetupCheckSchema's id (max 100) in the
	// Smithers RPC package. That bound is a JavaScript string length, so it is
	// counted here in UTF-16 code units, not bytes: 100 "e" and 100 "é" are
	// both legal configured ids, and one astral character costs two units.
	maxRepositoryCheckIDLength = 100
)

func repositoryCheckIDLength(id string) int {
	return len(utf16.Encode([]rune(id)))
}

// repositoryCiRetiredDispatch names the dispatch states that are not evidence
// of a live producing run.
var repositoryCiRetiredDispatch = map[string]bool{"failed": true, "skipped": true}

func validateRepositoryCheckReceipt(requestID string, input RepositoryCheckReceiptInput) error {
	bad := func(message string) error { return pkgerrors.BadRequest(message) }
	if _, err := uuid.Parse(requestID); err != nil {
		return bad("check receipt request id must be one canonical UUID")
	}
	if _, err := uuid.Parse(input.RegistrationID); err != nil {
		return bad("check receipt must name its registration")
	}
	if input.Revision <= 0 || !repositoryJobDigest.MatchString(input.Digest) || !repositoryJobDigest.MatchString(input.ExecutionDigest) {
		return bad("check receipt requires the exact candidate and executable digests")
	}
	if strings.TrimSpace(input.RunID) == "" || len(input.RunID) > 200 || strings.TrimSpace(input.ExecutionID) == "" || len(input.ExecutionID) > 200 {
		return bad("check receipt requires its owning run and execution")
	}
	if !isImmutableGitObjectID(input.CommitID) || !isImmutableGitObjectID(input.BaseCommitID) {
		return bad("check receipt requires the exact checked and base commits")
	}
	if strings.TrimSpace(input.ChangeID) == "" || len(input.ChangeID) > maxCommitStatusRefLength {
		return bad("check receipt requires the change id of the checked commit")
	}
	if input.Gate != "passed" {
		return bad("check receipt requires a passed gate")
	}
	// An empty list is the honest coverage of a policy with no required rule;
	// repositoryCiCoversRequiredChecks decides that against the stored policy.
	// A missing key is still malformed: the empty array is the explicit form.
	if input.Checks == nil || len(input.Checks) > maxRepositoryCheckOutcomes {
		return bad("check receipt requires at most 200 executed checks, and the list itself")
	}
	seen := make(map[string]struct{}, len(input.Checks))
	for _, check := range input.Checks {
		if strings.TrimSpace(check.ID) == "" || repositoryCheckIDLength(check.ID) > maxRepositoryCheckIDLength {
			return bad("each executed check needs its configured id")
		}
		if strings.ContainsRune(check.ID, 0) || !utf8.ValidString(check.ID) {
			return bad("a check id carries no NUL and no invalid UTF-8")
		}
		if check.Outcome != repositoryCheckOutcomePassed && check.Outcome != repositoryCheckOutcomeSkipped {
			return bad("each executed check must be passed or skipped_no_matching_paths")
		}
		if _, duplicate := seen[check.ID]; duplicate {
			return bad("each executed check may appear once")
		}
		seen[check.ID] = struct{}{}
	}
	return nil
}

// repositoryCiPolicyChecks decodes the reviewed check policy from the stored
// registration configuration, which is the marshalled RegisterRepositoryJobInput.
func repositoryCiPolicyChecks(configuration json.RawMessage) (map[string]string, string, error) {
	var stored RegisterRepositoryJobInput
	var draft struct {
		Checks []struct {
			ID     string `json:"id"`
			Policy string `json:"policy"`
		} `json:"checks"`
	}
	if json.Unmarshal(configuration, &stored) != nil || json.Unmarshal(stored.Input, &draft) != nil {
		return nil, "", pkgerrors.Internal("invalid applied repository CI policy")
	}
	policies := make(map[string]string, len(draft.Checks))
	for _, check := range draft.Checks {
		policies[check.ID] = check.Policy
	}
	return policies, stored.ExecutionDigest, nil
}

// repositoryCiCoversRequiredChecks refuses a receipt that does not account for
// every reviewed required check, and one that claims a check the policy does
// not contain.
func repositoryCiCoversRequiredChecks(policies map[string]string, reported []RepositoryCheckOutcome) error {
	accounted := make(map[string]struct{}, len(reported))
	for _, check := range reported {
		if _, known := policies[check.ID]; !known {
			return pkgerrors.UnprocessableEntity("check receipt reports a check the reviewed policy does not contain")
		}
		accounted[check.ID] = struct{}{}
	}
	missing := make([]string, 0)
	for id, policy := range policies {
		if policy != "required" {
			continue
		}
		if _, ok := accounted[id]; !ok {
			missing = append(missing, id)
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		return pkgerrors.UnprocessableEntity("check receipt does not account for every required check: " + strings.Join(missing, ", "))
	}
	return nil
}

// CreateCheckReceipt records the coding host's proof that the reviewed required
// checks ran on one exact commit, and writes the reserved commit status that
// the landing worker requires. The status row and its receipt are written in
// one transaction, so a landing can never see a status with no retained
// identity behind it.
func (s *RepositoryJobService) CreateCheckReceipt(ctx context.Context, hostID, bearer, requestID string, input RepositoryCheckReceiptInput) (RepositoryCheckReceiptResponse, bool, error) {
	var empty RepositoryCheckReceiptResponse
	if err := validateRepositoryCheckReceipt(requestID, input); err != nil {
		return empty, false, err
	}
	repo, target, err := s.authorizeHostCallback(ctx, hostID, bearer, input.Repo, input.WorkspaceID)
	if err != nil {
		return empty, false, err
	}
	if s.transactions == nil {
		return empty, false, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "repository check receipts unavailable")
	}
	checks, err := json.Marshal(input.Checks)
	if err != nil {
		return empty, false, pkgerrors.BadRequest("invalid executed check list")
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return empty, false, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, repoOwnershipSharedLockSQL, repo.ID); err != nil {
		return empty, false, err
	}
	q := db.New(tx)
	policy, err := q.GetRepositoryCiLandingPolicy(ctx, repo.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return empty, false, pkgerrors.NotFound("this repository has no registered CI policy")
	}
	if err != nil {
		return empty, false, err
	}
	if !strings.EqualFold(policy.WorkspaceID, target.WorkspaceID) {
		return empty, false, pkgerrors.Forbidden("the CI policy belongs to another workspace")
	}
	if policy.ID != input.RegistrationID || policy.Revision != input.Revision || policy.Digest != input.Digest {
		return empty, false, pkgerrors.Conflict("the CI policy was replaced; re-run the checks against the current policy")
	}
	policies, executionDigest, err := repositoryCiPolicyChecks(policy.Configuration)
	if err != nil {
		return empty, false, err
	}
	if executionDigest != input.ExecutionDigest {
		return empty, false, pkgerrors.Conflict("the CI policy was replaced; re-run the checks against the current policy")
	}
	// The producing run belongs to whichever job delivered the change, which is
	// normally not the ci registration named above. Ownership comes from the
	// dispatch row; policy identity comes from the registration.
	dispatchStatus, err := q.GetRepositoryCiDispatchRunStatus(ctx, db.GetRepositoryCiDispatchRunStatusParams{
		RepositoryID: repo.ID, WorkspaceID: target.WorkspaceID, RunID: input.RunID,
	})
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && repositoryCiRetiredDispatch[dispatchStatus]) {
		return empty, false, pkgerrors.New(pkgerrors.CodeRepositoryCIRunUnverified, "no retained repository job run in this workspace matches this receipt")
	}
	if err != nil {
		return empty, false, err
	}
	if err = repositoryCiCoversRequiredChecks(policies, input.Checks); err != nil {
		return empty, false, err
	}

	contextName := repositoryCiRequiredContext(policy.ID, policy.Revision, policy.Digest)
	if err = q.LockRepositoryCiCheckReceipt(ctx, db.LockRepositoryCiCheckReceiptParams{RegistrationID: policy.ID, RequestID: requestID}); err != nil {
		return empty, false, err
	}
	stored, err := q.GetRepositoryCiCheckReceipt(ctx, db.GetRepositoryCiCheckReceiptParams{RegistrationID: policy.ID, RequestID: requestID})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return empty, false, err
	}
	if err == nil {
		if !sameRepositoryCheckReceipt(stored, input, contextName, checks) {
			return empty, false, pkgerrors.Conflict("this check receipt request already recorded a different result")
		}
		if err = tx.Commit(ctx); err != nil {
			return empty, false, err
		}
		return repositoryCheckReceiptResponse(stored), false, nil
	}

	status, err := q.CreateCommitStatus(ctx, db.CreateCommitStatusParams{
		RepositoryID: repo.ID,
		ChangeID:     pgtype.Text{String: input.ChangeID, Valid: true},
		CommitSha:    pgtype.Text{String: input.CommitID, Valid: true},
		Context:      contextName,
		Status:       "success",
		Description:  "Repository CI checks passed",
		WorkspaceID:  pgtype.UUID{},
	})
	if err != nil {
		return empty, false, err
	}
	created, err := q.CreateRepositoryCiCheckReceipt(ctx, db.CreateRepositoryCiCheckReceiptParams{
		RepositoryID: repo.ID, RegistrationID: policy.ID, Revision: policy.Revision, Digest: policy.Digest,
		ExecutionDigest: input.ExecutionDigest, WorkspaceID: target.WorkspaceID, RunID: input.RunID, ExecutionID: input.ExecutionID,
		CommitSha: input.CommitID, ChangeID: input.ChangeID, BaseCommitSha: input.BaseCommitID, Checks: checks,
		Context: contextName, CommitStatusID: status.ID, RequestID: requestID,
	})
	if err != nil {
		return empty, false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return empty, false, err
	}
	return repositoryCheckReceiptResponse(created), true, nil
}

func sameRepositoryCheckReceipt(stored db.RepositoryCiCheckReceipt, input RepositoryCheckReceiptInput, contextName string, checks json.RawMessage) bool {
	return stored.Context == contextName && stored.Revision == input.Revision && stored.Digest == input.Digest &&
		stored.ExecutionDigest == input.ExecutionDigest && stored.RunID == input.RunID && stored.ExecutionID == input.ExecutionID &&
		stored.CommitSha == input.CommitID && stored.ChangeID == input.ChangeID && stored.BaseCommitSha == input.BaseCommitID &&
		sameRepositoryJobJSON(stored.Checks, checks)
}

func repositoryCheckReceiptResponse(row db.RepositoryCiCheckReceipt) RepositoryCheckReceiptResponse {
	return RepositoryCheckReceiptResponse{RequestID: row.RequestID, Context: row.Context, CommitID: row.CommitSha,
		Status: "success", StatusID: row.CommitStatusID}
}
