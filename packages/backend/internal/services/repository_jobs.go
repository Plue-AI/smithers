package services

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

type RepositoryJobStore interface {
	RepoPermQuerier
	GetUserByIDNotDeleted(context.Context, int64) (db.User, error)
	GetRepoByID(context.Context, int64) (db.Repository, error)
	GetRepoByOwnerAndLowerName(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	GetUserByID(context.Context, int64) (db.User, error)
	GetOrgByID(context.Context, int64) (db.Organization, error)
	RegisterRepositoryJob(context.Context, db.RegisterRepositoryJobParams) (db.RegisterRepositoryJobRow, error)
	GetRepositoryJobRegistration(context.Context, string) (db.RepositoryJobRegistration, error)
	GetRepositoryJobDispatch(context.Context, string) (db.RepositoryJobDispatch, error)
	ListRepositoryJobRegistrations(context.Context, int64) ([]db.RepositoryJobRegistration, error)
	PauseRepositoryJob(context.Context, db.PauseRepositoryJobParams) ([]db.RepositoryJobRegistration, error)
	ListRepositoryJobDispatchesForCancellation(context.Context, db.ListRepositoryJobDispatchesForCancellationParams) ([]db.RepositoryJobDispatch, error)
	AdmitRepositoryJobEvent(context.Context, db.AdmitRepositoryJobEventParams) error
	ListRepositoryJobAdmissions(context.Context, int32) ([]db.ListRepositoryJobAdmissionsRow, error)
	EnqueueRepositoryJobDispatch(context.Context, db.EnqueueRepositoryJobDispatchParams) error
	SkipRetiredRepositoryJobDispatches(context.Context) error
	ClaimRepositoryJobDispatches(context.Context, int32) ([]db.RepositoryJobDispatch, error)
	SaveRepositoryJobPlan(context.Context, db.SaveRepositoryJobPlanParams) (int64, error)
	SettleRepositoryJobDispatch(context.Context, db.SettleRepositoryJobDispatchParams) (int64, error)
	ProjectRepositoryJobDispatch(context.Context, db.ProjectRepositoryJobDispatchParams) (int64, error)
	ProjectRepositoryJobSignal(context.Context, db.ProjectRepositoryJobSignalParams) (int64, error)
	RetryProjectedRepositoryJobSignal(context.Context, db.RetryProjectedRepositoryJobSignalParams) (int64, error)
	RetryRepositoryJobSignal(context.Context, db.RetryRepositoryJobSignalParams) (int64, error)
	LatestRepositoryJobIssueRun(context.Context, db.LatestRepositoryJobIssueRunParams) (db.RepositoryJobDispatch, error)
	ListRepositoryJobDispatches(context.Context, db.ListRepositoryJobDispatchesParams) ([]db.RepositoryJobDispatch, error)
	ListDueRepositoryJobSchedules(context.Context, int32) ([]db.RepositoryJobRegistration, error)
	AdvanceRepositoryJobSchedule(context.Context, db.AdvanceRepositoryJobScheduleParams) (int64, error)
	ListRepositoryGitHubSources(context.Context, int64) ([]db.ListRepositoryGitHubSourcesRow, error)
	UpsertRepositoryJobApproval(context.Context, db.UpsertRepositoryJobApprovalParams) (db.RepositoryJobApproval, error)
	GetRepositoryJobApproval(context.Context, db.GetRepositoryJobApprovalParams) (db.RepositoryJobApproval, error)
	ListRepositoryJobApprovals(context.Context, db.ListRepositoryJobApprovalsParams) ([]db.RepositoryJobApproval, error)
	MarkOutsiderWorkspace(context.Context, int64, string) error
}

// RepositoryJobHostCallbacks authorizes a box's coding host calling
// repository jobs back (registrations, trials, replies, manual runs, check
// receipts) with its flowhost binding ID and control credential.
type RepositoryJobHostCallbacks interface {
	AuthorizeHostCallback(context.Context, string, string) (BoxHostTarget, error)
}

// RepositoryJobFlowDispatcher is the common durable Flow boundary. Both
// trusted-owner and isolated modes inject the same flowdispatch.Service; only
// the authorized host resolver beneath it differs by workspace adapter.
type RepositoryJobFlowDispatcher interface {
	Admit(context.Context, flowdispatch.LaunchRequest) (jobs.RequestReceipt, error)
	Approve(context.Context, jobs.Scope, string, string, json.RawMessage) (jobs.RequestReceipt, error)
	Signal(context.Context, flowdispatch.SignalRequest) (jobs.RequestReceipt, error)
	CancelRequest(context.Context, jobs.Scope, string) (jobs.Operation, error)
}

type RepositoryJobService struct {
	q              RepositoryJobStore
	hosts          RepositoryJobHostCallbacks
	flowDispatcher RepositoryJobFlowDispatcher
	now            func() time.Time
	transactions   RepositoryJobTransactions
	githubRead     RepositoryJobGitHubReadAccess
	outsiderEgress RepositoryJobOutsiderEgress
	policy         repositoryPolicyHost
}

// SetRepositoryPolicyReader wires the repo host the worker reads the default
// bookmark's owner-committed policy through (agentIssueSources). Without it,
// an issue an agent source wrote waits.
func (s *RepositoryJobService) SetRepositoryPolicyReader(host repositoryPolicyHost) {
	if s != nil {
		s.policy = host
	}
}

// RepositoryJobOutsiderEgress narrows a marked workspace's box before
// outsider-started work runs on it (*WorkspaceService).
type RepositoryJobOutsiderEgress interface {
	NarrowOutsiderEgress(ctx context.Context, workspaceID string) error
}

// SetOutsiderEgress wires the box narrowing outsider-started runs need.
// Without it those runs fail closed.
func (s *RepositoryJobService) SetOutsiderEgress(egress RepositoryJobOutsiderEgress) {
	if s != nil {
		s.outsiderEgress = egress
	}
}

// RepositoryJobGitHubReadAccess proves that the user's own GitHub credential
// can read owner/repo now. The synced GitHub store is shared and keeps filling
// from other users' installations, so import provenance alone never
// authorizes reading it. Implemented by *GitHubUserReposService.
type RepositoryJobGitHubReadAccess interface {
	GitHubRepoReadAuthorized(ctx context.Context, userID int64, owner, repo string) bool
}

// SetGitHubReadAccess wires the proof GitHub-sourced manual subjects need.
// Without it those subjects fail closed.
func (s *RepositoryJobService) SetGitHubReadAccess(access RepositoryJobGitHubReadAccess) {
	if s != nil {
		s.githubRead = access
	}
}

// SetFlowDispatcher completes the construction cycle shared with AgentService:
// RepositoryJobService projects canonical receipts and admits follow-up
// approvals/signals, while app composition owns the single dispatcher worker.
func (s *RepositoryJobService) SetFlowDispatcher(dispatcher RepositoryJobFlowDispatcher) {
	if s != nil {
		s.flowDispatcher = dispatcher
	}
}

type RepositoryJobTransactions interface {
	Begin(context.Context) (pgx.Tx, error)
}

func NewRepositoryJobService(q RepositoryJobStore, hosts RepositoryJobHostCallbacks, transactions ...RepositoryJobTransactions) *RepositoryJobService {
	s := &RepositoryJobService{q: q, hosts: hosts, now: func() time.Time { return time.Now().UTC() }}
	if len(transactions) > 0 {
		s.transactions = transactions[0]
	}
	return s
}

type RepositoryJobEventRule struct {
	Type    string   `json:"type"`
	Actions []string `json:"actions"`
}

// Registration is called by the box's coding host, using its control credential.
// The browser cannot supply a claimed test result or another actor's identity.
// The input is repository policy, not another executable workflow format.
type RegisterRepositoryJobInput struct {
	FactoryRevision  string                   `json:"factory_revision,omitempty"`
	Repo             string                   `json:"repo"`
	WorkspaceID      string                   `json:"workspace_id"`
	FlowID           string                   `json:"flow_id"`
	Revision         int64                    `json:"revision"`
	Digest           string                   `json:"digest"`
	SourceRevision   string                   `json:"source_revision"`
	ExecutionDigest  string                   `json:"execution_digest"`
	Envelope         json.RawMessage          `json:"envelope"`
	Mode             string                   `json:"mode"`
	TrialIssueNumber int64                    `json:"trial_issue_number,omitempty"`
	TrialSource      string                   `json:"trial_source,omitempty"`
	Events           []RepositoryJobEventRule `json:"events"`
	Label            string                   `json:"label,omitempty"`
	Schedule         string                   `json:"schedule,omitempty"`
	Input            json.RawMessage          `json:"input"`
	// SchedulePayload is the static payload a factory schedule rule declares.
	// When present, a scheduled run starts its flow with exactly this object;
	// absent, it starts with the schedule's own event.
	SchedulePayload json.RawMessage `json:"schedule_payload,omitempty"`
	// A flow trigger names the plan a person approved; the five built-in jobs
	// leave both empty and keep their existing wire body.
	ApprovedPlanID     string `json:"approved_plan_id,omitempty"`
	ApprovedPlanDigest string `json:"approved_plan_digest,omitempty"`
}

var repositoryJobNames = map[string]bool{"issues": true, "review": true, "ci": true, "feature": true, "chores": true}
var repositoryJobFlowName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,199}$`)
var repositoryJobDigest = regexp.MustCompile(`^[a-f0-9]{64}$`)

// The five built-in names carry no colon, so the namespaces are disjoint and a
// registered flow can never take a built-in job's row.
var repositoryFlowJobKey = regexp.MustCompile(`^flow:[a-z0-9][a-z0-9-]{0,63}$`)

func isRepositoryJobName(job string) bool {
	return repositoryJobNames[job] || repositoryFlowJobKey.MatchString(job)
}

func validateRepositoryJobEnvelope(raw json.RawMessage) error {
	var envelope struct {
		Capabilities []string `json:"capabilities"`
		Flows        []string `json:"flows"`
		Budget       struct {
			Tokens       float64 `json:"tokens"`
			Milliseconds float64 `json:"milliseconds"`
		} `json:"budget"`
	}
	if json.Unmarshal(raw, &envelope) != nil || envelope.Capabilities == nil || envelope.Flows == nil ||
		envelope.Budget.Tokens <= 0 || envelope.Budget.Milliseconds <= 0 || envelope.Budget.Milliseconds > float64((6*time.Hour)/time.Millisecond) {
		return pkgerrors.BadRequest("automatic work needs the reviewed envelope and finite token/time limits")
	}
	return nil
}

func validateRepositoryJob(job string, input RegisterRepositoryJobInput, now time.Time) (pgtype.Timestamptz, error) {
	bad := func(message string) (pgtype.Timestamptz, error) {
		return pgtype.Timestamptz{}, pkgerrors.BadRequest(message)
	}
	if !isRepositoryJobName(job) || !repositoryJobFlowName.MatchString(input.FlowID) || strings.Contains(input.FlowID, "..") {
		return bad("invalid repository job or registered flow")
	}
	flowTrigger := repositoryFlowJobKey.MatchString(job)
	if input.FactoryRevision != "" && (!flowTrigger || input.FactoryRevision != input.SourceRevision || input.Mode != "enabled" || (input.Schedule != "") == (len(input.Events) != 0)) {
		return bad("factory registration requires one trigger and the exact owner main revision")
	}
	if _, err := uuid.Parse(input.WorkspaceID); err != nil {
		return bad("workspace_id must identify the owning workspace")
	}
	if input.Revision <= 0 || !repositoryJobDigest.MatchString(input.Digest) || (input.FactoryRevision == "" && !repositoryJobDigest.MatchString(input.ExecutionDigest)) || !isImmutableGitObjectID(input.SourceRevision) {
		return bad("registration requires an exact candidate, executable digest and source revision")
	}
	if input.Mode != "enabled" && input.Mode != "trial" {
		return bad("mode must be enabled or trial")
	}
	if input.Mode == "trial" && (input.TrialIssueNumber <= 0 || (input.TrialSource != "github" && input.TrialSource != "smithers-cloud")) {
		return bad("trial registration requires one real source issue")
	}
	if input.Mode == "enabled" && (input.TrialIssueNumber != 0 || input.TrialSource != "") {
		return bad("an enabled registration cannot retain trial-only scope")
	}
	if flowTrigger && input.FactoryRevision == "" && (input.Mode != "enabled" || len(input.Events) != 0 || input.Label != "" || input.Schedule == "") {
		return bad("a flow trigger registers one enabled five-field UTC or CRON_TZ schedule and no event rules")
	}
	if validateRepositoryJobEnvelope(input.Envelope) != nil {
		return bad("automatic work needs the reviewed envelope and finite token/time limits")
	}
	if len(input.Input) == 0 || !json.Valid(input.Input) || string(input.Input) == "null" {
		return bad("input must contain the reviewed repository configuration")
	}
	if flowTrigger && input.FactoryRevision == "" && (input.ApprovedPlanID == "" || len(input.ApprovedPlanID) > 200 || !repositoryJobDigest.MatchString(input.ApprovedPlanDigest)) {
		return bad("a flow trigger must name the plan a person approved")
	}
	if !flowTrigger && (input.ApprovedPlanID != "" || input.ApprovedPlanDigest != "") {
		return bad("a flow trigger must name the plan a person approved")
	}
	if len(input.Events) > 16 || len(input.Label) > 100 {
		return bad("too many event rules or an invalid label")
	}
	for _, rule := range input.Events {
		switch NormalizeTriggerName(rule.Type) {
		case "issue", "issue_comment", "pull_request", "pull_request_review", "push", "check_run", "check_suite":
		default:
			return bad("unsupported repository job event")
		}
		if len(rule.Actions) > 20 {
			return bad("too many event actions")
		}
		for _, action := range rule.Actions {
			if strings.TrimSpace(action) == "" || len(action) > 100 {
				return bad("invalid event action")
			}
		}
	}
	if input.Schedule == "" {
		return pgtype.Timestamptz{}, nil
	}
	if input.Mode != "enabled" || (job != "chores" && !flowTrigger) || len(input.Schedule) > 200 {
		return bad("only an enabled chores job or an enabled flow trigger may register a schedule")
	}
	fields := strings.Fields(input.Schedule)
	zoned := len(fields) > 0 && strings.HasPrefix(fields[0], "CRON_TZ=")
	if len(fields) != 5 && !(zoned && len(fields) == 6) {
		return bad("schedule must have five UTC cron fields or CRON_TZ=<IANA zone> and five fields")
	}
	next, err := nextFireTime(input.Schedule, now)
	if err != nil {
		return bad("invalid schedule: " + err.Error())
	}
	if next.IsZero() {
		return bad("schedule must be a valid five-field cron expression")
	}
	return pgtype.Timestamptz{Time: next, Valid: true}, nil
}

func (s *RepositoryJobService) authorizedRepo(ctx context.Context, repoID, userID int64, write bool) (db.Repository, error) {
	repo, err := s.q.GetRepoByID(ctx, repoID)
	if err != nil {
		return db.Repository{}, pkgerrors.NotFound("repository not found")
	}
	actor, err := s.q.GetUserByIDNotDeleted(ctx, userID)
	if err != nil || !actor.IsActive || actor.ProhibitLogin {
		return db.Repository{}, pkgerrors.Unauthorized("repository job user is unavailable")
	}
	var allowed bool
	if write {
		if repo.IsArchived {
			return db.Repository{}, pkgerrors.Forbidden("repository is archived")
		}
		allowed, err = canWriteRepo(ctx, s.q, repo, userID)
	} else {
		allowed, err = canReadRepo(ctx, s.q, repo, userID)
	}
	if err != nil {
		return db.Repository{}, err
	}
	if !allowed {
		return db.Repository{}, pkgerrors.Forbidden("repository permission required")
	}
	return repo, nil
}

func (s *RepositoryJobService) authorizeHostCallback(ctx context.Context, hostID, bearer, repoName, workspaceID string) (db.Repository, BoxHostTarget, error) {
	target, err := s.hosts.AuthorizeHostCallback(ctx, hostID, bearer)
	if err != nil {
		return db.Repository{}, target, err
	}
	if target.WorkspaceID == "" || !strings.EqualFold(target.WorkspaceID, workspaceID) {
		return db.Repository{}, target, pkgerrors.Forbidden("registration must come from its own box's coding host")
	}
	owner, name, found := strings.Cut(repoName, "/")
	if !found || owner == "" || name == "" || strings.Contains(name, "/") {
		return db.Repository{}, target, pkgerrors.BadRequest("repo must be owner/name")
	}
	repo, err := s.q.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{Owner: strings.ToLower(owner), LowerName: strings.ToLower(name)})
	if err != nil || repo.ID != target.RepositoryID {
		return db.Repository{}, target, pkgerrors.Forbidden("a coding host cannot configure another repository")
	}
	if _, err := s.authorizedRepo(ctx, repo.ID, target.UserID, true); err != nil {
		return db.Repository{}, target, err
	}
	return repo, target, nil
}

func (s *RepositoryJobService) Register(ctx context.Context, hostID, bearer, job string, input RegisterRepositoryJobInput) (db.RegisterRepositoryJobRow, error) {
	var empty db.RegisterRepositoryJobRow
	if input.FactoryRevision != "" {
		return empty, pkgerrors.Forbidden("factory registrations are reconciled from owner main only")
	}
	repo, target, err := s.authorizeHostCallback(ctx, hostID, bearer, input.Repo, input.WorkspaceID)
	if err != nil {
		return empty, err
	}
	next, err := validateRepositoryJob(job, input, s.now())
	if err != nil {
		return empty, err
	}
	configuration, err := json.Marshal(input)
	if err != nil {
		return empty, pkgerrors.BadRequest("invalid repository job configuration")
	}
	store := s.q
	var tx pgx.Tx
	if s.transactions != nil {
		tx, err = s.transactions.Begin(ctx)
		if err != nil {
			return empty, err
		}
		defer tx.Rollback(ctx)
		if _, err = tx.Exec(ctx, repoOwnershipSharedLockSQL, repo.ID); err != nil {
			return empty, err
		}
		queries := db.New(tx)
		workspace, workspaceErr := queries.GetWorkspaceForUserRepo(ctx, db.GetWorkspaceForUserRepoParams{ID: target.WorkspaceID, RepositoryID: repo.ID, UserID: target.UserID})
		if workspaceErr != nil || workspace.DeletedAt.Valid || workspace.Status == "failed" {
			return empty, pkgerrors.Conflict("the registration workspace is unavailable")
		}
		store = queries
		fresh, checkErr := (&RepositoryJobService{q: store}).authorizedRepo(ctx, repo.ID, target.UserID, true)
		if checkErr != nil {
			return empty, checkErr
		}
		if fresh.UserID != repo.UserID || fresh.OrgID != repo.OrgID || fresh.Name != repo.Name {
			return empty, pkgerrors.Conflict("repository ownership changed")
		}
	}
	if repositoryFlowJobKey.MatchString(job) {
		if err := s.requireApprovedPlan(ctx, store, repo.ID, job, input); err != nil {
			return empty, err
		}
	}
	row, err := store.RegisterRepositoryJob(ctx, db.RegisterRepositoryJobParams{
		RepositoryID: repo.ID, WorkspaceID: target.WorkspaceID, UserID: target.UserID,
		Job: job, Mode: input.Mode, Revision: input.Revision, Digest: input.Digest,
		SourceRevision: input.SourceRevision, FlowID: input.FlowID, Configuration: configuration,
		TrialIssueNumber: input.TrialIssueNumber, TrialSource: input.TrialSource,
		Schedule: input.Schedule, NextFireAt: next,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return empty, pkgerrors.Conflict("registration was paused, replaced, or changed; apply a newer reviewed revision")
	}
	if err != nil {
		return empty, pkgerrors.Internal("could not save repository job registration").WithCause(err)
	}
	if tx != nil {
		if err := tx.Commit(ctx); err != nil {
			return empty, err
		}
	}
	return row, nil
}

// A reader may see evaluation-case identity, never held-out answers. Explicit
// allowlists keep newly added case fields withheld by default.
var readableRepositoryJobCase = map[string]bool{"id": true, "name": true, "required": true}

func readableRepositoryJobCases(evaluations json.RawMessage) json.RawMessage {
	empty := json.RawMessage(`[]`)
	var stored []json.RawMessage
	if json.Unmarshal(evaluations, &stored) != nil {
		return empty
	}
	readable := make([]json.RawMessage, 0, len(stored))
	for _, evaluation := range stored {
		identity, fields := map[string]json.RawMessage{}, map[string]json.RawMessage{}
		if json.Unmarshal(evaluation, &fields) == nil {
			for name, value := range fields {
				if readableRepositoryJobCase[name] {
					identity[name] = value
				}
			}
		}
		encoded, err := json.Marshal(identity)
		if err != nil {
			return empty
		}
		readable = append(readable, encoded)
	}
	encoded, err := json.Marshal(readable)
	if err != nil {
		return empty
	}
	return encoded
}

var readableRepositoryJobDraft = map[string]bool{"steps": true, "checks": true, "cases": true,
	"replies": true, "landing": true, "scope": true, "label": true, "schedule": true,
	"budgetMinutes": true, "connectIssues": true, "choreEvent": true, "trialTitle": true, "trialBody": true}

func readableRepositoryJobConfiguration(job string, configuration json.RawMessage) json.RawMessage {
	withheld := json.RawMessage(`{}`)
	var fields map[string]json.RawMessage
	if json.Unmarshal(configuration, &fields) != nil {
		return withheld
	}
	input, ok := fields["input"]
	if !ok {
		return configuration
	}
	var stored map[string]json.RawMessage
	if repositoryFlowJobKey.MatchString(job) || json.Unmarshal(input, &stored) != nil {
		fields["input"] = withheld
	} else {
		draft := map[string]json.RawMessage{}
		for name, value := range stored {
			if !readableRepositoryJobDraft[name] {
				continue
			}
			if name == "cases" {
				value = readableRepositoryJobCases(value)
			}
			draft[name] = value
		}
		redacted, err := json.Marshal(draft)
		if err != nil {
			return withheld
		}
		fields["input"] = redacted
	}
	result, err := json.Marshal(fields)
	if err != nil {
		return withheld
	}
	return result
}

func (s *RepositoryJobService) List(ctx context.Context, repoID, userID int64) ([]db.RepositoryJobRegistration, error) {
	repo, err := s.authorizedRepo(ctx, repoID, userID, false)
	if err != nil {
		return nil, err
	}
	rows, err := s.q.ListRepositoryJobRegistrations(ctx, repoID)
	if err != nil {
		return nil, err
	}
	writer, err := canWriteRepo(ctx, s.q, repo, userID)
	if err != nil {
		return nil, err
	}
	if writer {
		return rows, nil
	}
	for i := range rows {
		rows[i].Configuration = readableRepositoryJobConfiguration(rows[i].Job, rows[i].Configuration)
	}
	return rows, nil
}

type RepositorySource struct {
	Source   string `json:"source"`
	FullName string `json:"full_name,omitempty"`
}

func (s *RepositoryJobService) Source(ctx context.Context, repoID, userID int64) (RepositorySource, error) {
	if _, err := s.authorizedRepo(ctx, repoID, userID, false); err != nil {
		return RepositorySource{}, err
	}
	rows, err := s.q.ListRepositoryGitHubSources(ctx, repoID)
	if err != nil {
		return RepositorySource{}, err
	}
	if len(rows) > 1 {
		return RepositorySource{}, pkgerrors.Conflict("repository source mappings disagree")
	}
	if len(rows) == 1 {
		return RepositorySource{Source: "github", FullName: rows[0].GithubOwner + "/" + rows[0].GithubRepo}, nil
	}
	return RepositorySource{Source: "smithers-cloud"}, nil
}

func (s *RepositoryJobService) Pause(ctx context.Context, repoID, userID int64, job string) ([]db.RepositoryJobRegistration, error) {
	if !isRepositoryJobName(job) {
		return nil, pkgerrors.BadRequest("unknown repository job")
	}
	if _, err := s.authorizedRepo(ctx, repoID, userID, true); err != nil {
		return nil, err
	}
	registrations, err := s.q.PauseRepositoryJob(ctx, db.PauseRepositoryJobParams{RepositoryID: repoID, Job: job})
	if err != nil {
		return nil, err
	}
	dispatches, err := s.q.ListRepositoryJobDispatchesForCancellation(ctx, db.ListRepositoryJobDispatchesForCancellationParams{
		RepositoryID: repoID,
		Job:          job,
	})
	if err != nil {
		return nil, err
	}
	if len(dispatches) > 0 && s.flowDispatcher == nil {
		return nil, errors.New("repository job Flow dispatcher is unavailable")
	}
	scope := repositoryJobFlowScope(repoID, userID)
	for _, dispatch := range dispatches {
		_, cancelErr := s.flowDispatcher.CancelRequest(ctx, scope, repositoryJobFlowRequestID(dispatch.ID))
		if cancelErr != nil && !errors.Is(cancelErr, jobs.ErrNotFound) {
			return nil, cancelErr
		}
	}
	return registrations, nil
}

type RepositoryJobDispatchReceipt struct {
	ID             string          `json:"id"`
	RegistrationID string          `json:"registration_id"`
	Revision       int64           `json:"revision"`
	Digest         string          `json:"digest"`
	DeliveryKey    string          `json:"delivery_key"`
	Source         string          `json:"source"`
	IssueNumber    int64           `json:"issue_number"`
	Status         string          `json:"status"`
	RunID          string          `json:"run_id"`
	Receipt        json.RawMessage `json:"receipt,omitempty"`
	Error          string          `json:"error,omitempty"`
	CreatedAt      time.Time       `json:"created_at"`
	UpdatedAt      time.Time       `json:"updated_at"`
}

func (s *RepositoryJobService) Dispatches(ctx context.Context, repoID, userID int64, job string) ([]RepositoryJobDispatchReceipt, error) {
	if !isRepositoryJobName(job) {
		return nil, pkgerrors.BadRequest("unknown repository job")
	}
	if _, err := s.authorizedRepo(ctx, repoID, userID, false); err != nil {
		return nil, err
	}
	rows, err := s.q.ListRepositoryJobDispatches(ctx, db.ListRepositoryJobDispatchesParams{RepositoryID: repoID, Job: job})
	if err != nil {
		return nil, err
	}
	result := make([]RepositoryJobDispatchReceipt, 0, len(rows))
	for _, row := range rows {
		result = append(result, RepositoryJobDispatchReceipt{
			ID: row.ID, RegistrationID: row.RegistrationID, Revision: row.Revision, Digest: row.Digest,
			DeliveryKey: row.DeliveryKey, Source: row.Source, IssueNumber: row.IssueNumber,
			Status: row.Status, RunID: row.RunID, Receipt: row.Receipt, Error: row.Error,
			CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
		})
	}
	return result, nil
}

func sameRepositoryJobJSON(a, b json.RawMessage) bool {
	var av, bv interface{}
	if json.Unmarshal(a, &av) != nil || json.Unmarshal(b, &bv) != nil {
		return false
	}
	ac, _ := json.Marshal(av)
	bc, _ := json.Marshal(bv)
	return bytes.Equal(ac, bc)
}
