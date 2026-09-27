package services

import (
	"context"
	"errors"
	"net/url"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

type CreateCommitStatusInput struct {
	Context         string  `json:"context"`
	Status          string  `json:"status"`
	Description     string  `json:"description"`
	TargetURL       string  `json:"target_url"`
	ChangeID        *string `json:"change_id,omitempty"`
	WorkflowRunID   *int64  `json:"workflow_run_id,omitempty"`
	TargetsAffected int64   `json:"targets_affected"`
	TargetsRan      int64   `json:"targets_ran"`
	TargetsCached   int64   `json:"targets_cached"`
	DurationMS      int64   `json:"duration_ms"`
	WorkspaceID     *string `json:"workspace_id,omitempty"`
	// RepoName is used for webhook event payloads; not persisted.
	RepoName string `json:"-"`
	// Actor is used for webhook sender payload; not persisted.
	Actor *db.User `json:"-"`
}

type commitStatusWorkspaceQuerier interface {
	GetWorkspaceIncludingDeleted(ctx context.Context, id string) (db.Workspace, error)
}

type CommitStatusQuerier interface {
	GetRepoByID(ctx context.Context, id int64) (db.Repository, error)
	GetWorkflowRun(ctx context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error)
	CreateCommitStatus(ctx context.Context, arg db.CreateCommitStatusParams) (db.CommitStatus, error)
	UpdateLatestCommitStatusByWorkflowRunID(ctx context.Context, arg db.UpdateLatestCommitStatusByWorkflowRunIDParams) (db.CommitStatus, error)
	ListCommitStatusesByRef(ctx context.Context, arg db.ListCommitStatusesByRefParams) ([]db.CommitStatus, error)
	CountCommitStatusesByRef(ctx context.Context, arg db.CountCommitStatusesByRefParams) (int64, error)
}

type CommitStatusService struct {
	queries    CommitStatusQuerier
	dispatcher webhooks.Dispatcher
}

type CommitStatusServiceOption func(*CommitStatusService)

// WithCommitStatusWebhookDispatcher wires a webhook dispatcher into CommitStatusService.
func WithCommitStatusWebhookDispatcher(dispatcher webhooks.Dispatcher) CommitStatusServiceOption {
	return func(s *CommitStatusService) {
		s.dispatcher = dispatcher
	}
}

func NewCommitStatusService(q CommitStatusQuerier, opts ...CommitStatusServiceOption) *CommitStatusService {
	s := &CommitStatusService{queries: q}
	for _, opt := range opts {
		if opt != nil {
			opt(s)
		}
	}
	return s
}

// PublishCommitStatus emits the webhook for a commit status that another
// service inserted transactionally. Workflow dispatch uses this after its
// run/status/task transaction commits so observers never see rolled-back
// pending statuses and runners never see a run without its linked status row.
func (s *CommitStatusService) PublishCommitStatus(ctx context.Context, status db.CommitStatus) {
	_ = s.dispatchCommitStatusEvent(ctx, status.RepositoryID, s.resolveRepoName(ctx, status.RepositoryID, ""), status, nil)
}

var validCommitStatuses = map[string]struct{}{
	"pending":   {},
	"success":   {},
	"failure":   {},
	"error":     {},
	"cancelled": {},
}

const maxCommitStatusURLLength = 2048
const maxCommitStatusDescriptionLength = 2048

// maxCommitStatusRefLength matches the VARCHAR(255) storage width of the
// commit_status.commit_sha and commit_status.change_id columns (db/product/migrations/0001_product_baseline.sql).
// Anything longer would fail the INSERT with an opaque SQLSTATE 22001 (string
// data right truncation), so we reject it up front with a clean 422 instead.
const maxCommitStatusRefLength = 255

func validateCommitStatusDescription(description string) error {
	if err := validateSafeText("CommitStatus", "description", description); err != nil {
		return err
	}
	if len(description) > maxCommitStatusDescriptionLength {
		return pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "CommitStatus", Field: "description", Code: "invalid"})
	}
	return nil
}

func validateCommitStatusTargetURL(targetURL string) error {
	if err := validateSafeText("CommitStatus", "target_url", targetURL); err != nil {
		return err
	}
	if targetURL == "" {
		return nil
	}
	if len(targetURL) > maxCommitStatusURLLength {
		return pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "CommitStatus", Field: "target_url", Code: "invalid"})
	}
	parsed, err := url.Parse(targetURL)
	if err != nil || parsed.Hostname() == "" {
		return pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "CommitStatus", Field: "target_url", Code: "invalid"})
	}
	if !strings.EqualFold(parsed.Scheme, "http") && !strings.EqualFold(parsed.Scheme, "https") {
		return pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "CommitStatus", Field: "target_url", Code: "invalid"})
	}
	return nil
}

func (s *CommitStatusService) CreateCommitStatus(
	ctx context.Context,
	repositoryID int64,
	sha string,
	input CreateCommitStatusInput,
) (db.CommitStatus, error) {
	contextName := strings.TrimSpace(input.Context)
	if contextName == "" {
		return db.CommitStatus{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "CommitStatus", Field: "context", Code: "missing_field"})
	}
	if len(contextName) > 255 {
		return db.CommitStatus{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "CommitStatus", Field: "context", Code: "invalid"})
	}
	// Reject NUL/invalid-UTF8 in the stored text fields so a malformed value does
	// not fail the INSERT (SQLSTATE 22021) as an opaque 500.
	if err := validateSafeText("CommitStatus", "context", contextName); err != nil {
		return db.CommitStatus{}, err
	}
	// The repository CI receipt records its own required context; a reported
	// status cannot stand in for it.
	if strings.HasPrefix(strings.ToLower(contextName), repositoryCiContextPrefix) {
		return db.CommitStatus{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "CommitStatus", Field: "context", Code: "invalid"})
	}
	if err := validateCommitStatusDescription(input.Description); err != nil {
		return db.CommitStatus{}, err
	}
	if err := validateCommitStatusTargetURL(input.TargetURL); err != nil {
		return db.CommitStatus{}, err
	}

	status := strings.ToLower(strings.TrimSpace(input.Status))
	if status == "" {
		return db.CommitStatus{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "CommitStatus", Field: "status", Code: "missing_field"})
	}
	if _, ok := validCommitStatuses[status]; !ok {
		return db.CommitStatus{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "CommitStatus", Field: "status", Code: "invalid"})
	}

	sha = strings.TrimSpace(sha)
	// Reject NUL/invalid-UTF8 and over-length sha before it reaches the
	// VARCHAR(255) storage layer, which would otherwise fail the INSERT
	// (SQLSTATE 22021 / 22001) as an opaque 500.
	if sha != "" {
		if err := validateSafeText("CommitStatus", "sha", sha); err != nil {
			return db.CommitStatus{}, err
		}
		if len(sha) > maxCommitStatusRefLength {
			return db.CommitStatus{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "CommitStatus", Field: "sha", Code: "invalid"})
		}
	}

	changeID := pgtype.Text{}
	if input.ChangeID != nil {
		trimmed := strings.TrimSpace(*input.ChangeID)
		if trimmed != "" {
			if err := validateSafeText("CommitStatus", "change_id", trimmed); err != nil {
				return db.CommitStatus{}, err
			}
			if len(trimmed) > maxCommitStatusRefLength {
				return db.CommitStatus{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "CommitStatus", Field: "change_id", Code: "invalid"})
			}
			changeID = pgtype.Text{String: trimmed, Valid: true}
		}
	}
	if sha == "" && !changeID.Valid {
		return db.CommitStatus{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "CommitStatus", Field: "change_id", Code: "missing_field"})
	}

	workflowRunID := pgtype.Int8{}
	if input.WorkflowRunID != nil {
		// The referenced workflow run MUST belong to this repository. GetWorkflowRun
		// is scoped by (id, repository_id), so a run owned by another repo returns
		// ErrNoRows. Without this a writer could attach an arbitrary cross-tenant
		// workflow_run_id to their commit status (cross-repo IDOR / hijack).
		if _, err := s.queries.GetWorkflowRun(ctx, db.GetWorkflowRunParams{
			ID:           *input.WorkflowRunID,
			RepositoryID: repositoryID,
		}); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return db.CommitStatus{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "CommitStatus", Field: "workflow_run_id", Code: "invalid"})
			}
			return db.CommitStatus{}, pkgerrors.Internal("failed to validate workflow run").WithCause(err)
		}
		workflowRunID = pgtype.Int8{Int64: *input.WorkflowRunID, Valid: true}
	}

	for _, metric := range []struct {
		field string
		value int64
	}{
		{field: "targets_affected", value: input.TargetsAffected},
		{field: "targets_ran", value: input.TargetsRan},
		{field: "targets_cached", value: input.TargetsCached},
		{field: "duration_ms", value: input.DurationMS},
	} {
		if metric.value < 0 {
			return db.CommitStatus{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "CommitStatus", Field: metric.field, Code: "invalid"})
		}
	}

	workspaceID := pgtype.UUID{}
	if input.WorkspaceID != nil && strings.TrimSpace(*input.WorkspaceID) != "" {
		trimmed := strings.TrimSpace(*input.WorkspaceID)
		if err := workspaceID.Scan(trimmed); err != nil {
			return db.CommitStatus{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "CommitStatus", Field: "workspace_id", Code: "invalid"})
		}
		workspaceQueries, ok := s.queries.(commitStatusWorkspaceQuerier)
		if !ok {
			return db.CommitStatus{}, pkgerrors.Internal("workspace validation unavailable")
		}
		workspace, err := workspaceQueries.GetWorkspaceIncludingDeleted(ctx, trimmed)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return db.CommitStatus{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "CommitStatus", Field: "workspace_id", Code: "invalid"})
			}
			return db.CommitStatus{}, pkgerrors.Internal("failed to validate workspace").WithCause(err)
		}
		if workspace.RepositoryID != repositoryID {
			return db.CommitStatus{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "CommitStatus", Field: "workspace_id", Code: "invalid"})
		}
	}

	created, err := s.queries.CreateCommitStatus(ctx, db.CreateCommitStatusParams{
		RepositoryID:    repositoryID,
		ChangeID:        changeID,
		CommitSha:       pgtype.Text{String: sha, Valid: sha != ""},
		Context:         contextName,
		Status:          status,
		Description:     input.Description,
		TargetUrl:       input.TargetURL,
		WorkflowRunID:   workflowRunID,
		TargetsAffected: input.TargetsAffected,
		TargetsRan:      input.TargetsRan,
		TargetsCached:   input.TargetsCached,
		DurationMs:      input.DurationMS,
		WorkspaceID:     workspaceID,
	})
	if err != nil {
		return db.CommitStatus{}, pkgerrors.Internal("failed to create commit status").WithCause(err)
	}

	// Dispatch "status" webhook event (non-fatal).
	_ = s.dispatchCommitStatusEvent(ctx, repositoryID, s.resolveRepoName(ctx, repositoryID, input.RepoName), created, input.Actor)

	return created, nil
}

func (s *CommitStatusService) dispatchCommitStatusEvent(ctx context.Context, repositoryID int64, repoName string, cs db.CommitStatus, actor *db.User) error {
	if s.dispatcher == nil {
		return nil
	}

	changeIDStr := ""
	if cs.ChangeID.Valid {
		changeIDStr = cs.ChangeID.String
	}
	shaStr := ""
	if cs.CommitSha.Valid {
		shaStr = cs.CommitSha.String
	}

	sender := webhooks.UserPayload{}
	if actor != nil {
		sender = webhooks.UserPayload{
			ID:    actor.ID,
			Login: actor.Username,
		}
	}

	payload := webhooks.CommitStatusEventPayload{
		CommitStatus: webhooks.CommitStatusPayload{
			ID:          cs.ID,
			SHA:         shaStr,
			ChangeID:    changeIDStr,
			Context:     cs.Context,
			Status:      cs.Status,
			Description: cs.Description,
			TargetURL:   cs.TargetUrl,
		},
		Repository: webhooks.RepositoryPayload{
			ID:   repositoryID,
			Name: repoName,
		},
		Sender: sender,
	}
	if err := s.dispatcher.DispatchEvent(ctx, repositoryID, webhooks.EventTypeStatus, payload); err != nil {
		return pkgerrors.Internal("failed to enqueue commit status webhook delivery").WithCause(err)
	}
	return nil
}

func (s *CommitStatusService) ListCommitStatuses(
	ctx context.Context,
	repositoryID int64,
	ref string,
	page, perPage int,
) ([]db.CommitStatus, int64, error) {
	refText := pgtype.Text{String: ref, Valid: true}

	total, err := s.queries.CountCommitStatusesByRef(ctx, db.CountCommitStatusesByRefParams{
		RepositoryID: repositoryID,
		Ref:          refText,
	})
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to count commit statuses").WithCause(err)
	}

	pageOffset := (page - 1) * perPage
	statuses, err := s.queries.ListCommitStatusesByRef(ctx, db.ListCommitStatusesByRefParams{
		RepositoryID: repositoryID,
		Ref:          refText,
		PageSize:     int32(perPage),
		PageOffset:   ClampInt32(pageOffset),
	})
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to list commit statuses").WithCause(err)
	}
	if statuses == nil {
		return []db.CommitStatus{}, total, nil
	}
	return statuses, total, nil
}

// UpdateCommitStatusForWorkflowRun updates the latest commit status linked to a workflow run.
func (s *CommitStatusService) UpdateCommitStatusForWorkflowRun(
	ctx context.Context,
	workflowRunID int64,
	status string,
	description string,
	targetURL string,
) (db.CommitStatus, error) {
	if workflowRunID <= 0 {
		return db.CommitStatus{}, pkgerrors.BadRequest("workflow run id must be positive")
	}
	status = strings.ToLower(strings.TrimSpace(status))
	if _, ok := validCommitStatuses[status]; !ok {
		return db.CommitStatus{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{
			Resource: "CommitStatus",
			Field:    "status",
			Code:     "invalid",
		})
	}
	if err := validateCommitStatusDescription(description); err != nil {
		return db.CommitStatus{}, err
	}
	if err := validateCommitStatusTargetURL(targetURL); err != nil {
		return db.CommitStatus{}, err
	}

	updated, err := s.queries.UpdateLatestCommitStatusByWorkflowRunID(ctx, db.UpdateLatestCommitStatusByWorkflowRunIDParams{
		WorkflowRunID: pgtype.Int8{Int64: workflowRunID, Valid: true},
		Status:        status,
		Description:   description,
		TargetUrl:     targetURL,
	})
	if err != nil {
		if err == pgx.ErrNoRows {
			return db.CommitStatus{}, pkgerrors.NotFound("commit status not found")
		}
		return db.CommitStatus{}, pkgerrors.Internal("failed to update commit status").WithCause(err)
	}

	_ = s.dispatchCommitStatusEvent(ctx, updated.RepositoryID, s.resolveRepoName(ctx, updated.RepositoryID, ""), updated, nil)
	return updated, nil
}

func (s *CommitStatusService) resolveRepoName(ctx context.Context, repositoryID int64, fallback string) string {
	if strings.TrimSpace(fallback) != "" || s.queries == nil {
		return fallback
	}
	repo, err := s.queries.GetRepoByID(ctx, repositoryID)
	if err != nil {
		return fallback
	}
	return repo.Name
}
