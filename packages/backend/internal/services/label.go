package services

import (
	"context"
	stdErrors "errors"
	"log/slog"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type CreateLabelInput struct {
	Name        string `json:"name"`
	Color       string `json:"color"`
	Description string `json:"description"`
}

type UpdateLabelInput struct {
	Name        *string `json:"name,omitempty"`
	Color       *string `json:"color,omitempty"`
	Description *string `json:"description,omitempty"`
}

type LabelQuerier interface {
	GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)
	GetUserByID(ctx context.Context, id int64) (db.User, error)
	ListIssueAssignees(ctx context.Context, issueID int64) ([]db.ListIssueAssigneesRow, error)

	CreateLabel(ctx context.Context, arg db.CreateLabelParams) (db.Label, error)
	ListLabelsByRepo(ctx context.Context, arg db.ListLabelsByRepoParams) ([]db.Label, error)
	CountLabelsByRepo(ctx context.Context, repositoryID int64) (int64, error)
	GetLabelByID(ctx context.Context, arg db.GetLabelByIDParams) (db.Label, error)
	GetLabelByName(ctx context.Context, arg db.GetLabelByNameParams) (db.Label, error)
	ListLabelsByNames(ctx context.Context, arg db.ListLabelsByNamesParams) ([]db.Label, error)
	UpdateLabel(ctx context.Context, arg db.UpdateLabelParams) (db.Label, error)
	DeleteLabel(ctx context.Context, arg db.DeleteLabelParams) error

	GetIssueByNumber(ctx context.Context, arg db.GetIssueByNumberParams) (db.Issue, error)
	AddIssueLabel(ctx context.Context, arg db.AddIssueLabelParams) (db.IssueLabel, error)
	AddIssueLabels(ctx context.Context, arg db.AddIssueLabelsParams) error
	ListLabelsForIssue(ctx context.Context, arg db.ListLabelsForIssueParams) ([]db.Label, error)
	CountLabelsForIssue(ctx context.Context, issueID int64) (int64, error)
	RemoveIssueLabelByName(ctx context.Context, arg db.RemoveIssueLabelByNameParams) (int64, error)
}

type LabelService struct {
	queries        LabelQuerier
	workflowRunSvc WorkflowRunService
}

type LabelServiceOption func(*LabelService)

func WithLabelWorkflowRunService(workflowRunSvc WorkflowRunService) LabelServiceOption {
	return func(s *LabelService) {
		s.workflowRunSvc = workflowRunSvc
	}
}

func NewLabelService(q LabelQuerier, opts ...LabelServiceOption) *LabelService {
	s := &LabelService{queries: q}
	for _, opt := range opts {
		if opt != nil {
			opt(s)
		}
	}
	return s
}

func (s *LabelService) CreateLabel(ctx context.Context, actor *db.User, owner, repo string, req CreateLabelInput) (db.Label, error) {
	if actor == nil {
		return db.Label{}, pkgerrors.Unauthorized("authentication required")
	}

	name, err := validateLabelName(req.Name)
	if err != nil {
		return db.Label{}, err
	}
	color, err := normalizeLabelColor(req.Color)
	if err != nil {
		return db.Label{}, err
	}

	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return db.Label{}, err
	}
	if err := s.requireWriteAccess(ctx, repository, actor); err != nil {
		return db.Label{}, err
	}

	if verr := validateSafeText("Label", "description", req.Description); verr != nil {
		return db.Label{}, verr
	}

	created, err := s.queries.CreateLabel(ctx, db.CreateLabelParams{
		RepositoryID: repository.ID,
		Name:         name,
		Color:        color,
		Description:  req.Description,
	})
	if err != nil {
		if isUniqueViolation(err) {
			return db.Label{}, pkgerrors.Conflict("label already exists")
		}
		return db.Label{}, pkgerrors.Internal("failed to create label").WithCause(err)
	}
	return created, nil
}

func (s *LabelService) ListLabels(ctx context.Context, viewer *db.User, owner, repo string, page, perPage int) ([]db.Label, int64, error) {
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return nil, 0, err
	}
	if err := s.requireReadAccess(ctx, repository, viewer); err != nil {
		return nil, 0, err
	}

	pageSize, pageOffset, _, _ := normalizePage(page, perPage)
	total, err := s.queries.CountLabelsByRepo(ctx, repository.ID)
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to count labels").WithCause(err)
	}

	labels, err := s.queries.ListLabelsByRepo(ctx, db.ListLabelsByRepoParams{
		RepositoryID: repository.ID,
		PageOffset:   pageOffset,
		PageSize:     pageSize,
	})
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to list labels").WithCause(err)
	}
	return labels, total, nil
}

func (s *LabelService) GetLabel(ctx context.Context, viewer *db.User, owner, repo string, id int64) (db.Label, error) {
	if id <= 0 {
		return db.Label{}, pkgerrors.BadRequest("invalid label id")
	}

	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return db.Label{}, err
	}
	if err := s.requireReadAccess(ctx, repository, viewer); err != nil {
		return db.Label{}, err
	}

	label, err := s.queries.GetLabelByID(ctx, db.GetLabelByIDParams{RepositoryID: repository.ID, ID: id})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.Label{}, pkgerrors.NotFound("label not found")
		}
		return db.Label{}, pkgerrors.Internal("failed to get label").WithCause(err)
	}
	return label, nil
}

func (s *LabelService) UpdateLabel(ctx context.Context, actor *db.User, owner, repo string, id int64, req UpdateLabelInput) (db.Label, error) {
	if actor == nil {
		return db.Label{}, pkgerrors.Unauthorized("authentication required")
	}

	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return db.Label{}, err
	}
	if err := s.requireWriteAccess(ctx, repository, actor); err != nil {
		return db.Label{}, err
	}

	existing, err := s.queries.GetLabelByID(ctx, db.GetLabelByIDParams{RepositoryID: repository.ID, ID: id})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.Label{}, pkgerrors.NotFound("label not found")
		}
		return db.Label{}, pkgerrors.Internal("failed to load label").WithCause(err)
	}

	name := existing.Name
	if req.Name != nil {
		name, err = validateLabelName(*req.Name)
		if err != nil {
			return db.Label{}, err
		}
	}

	color := existing.Color
	if req.Color != nil {
		color, err = normalizeLabelColor(*req.Color)
		if err != nil {
			return db.Label{}, err
		}
	}

	description := existing.Description
	if req.Description != nil {
		description = *req.Description
		if verr := validateSafeText("Label", "description", description); verr != nil {
			return db.Label{}, verr
		}
	}

	updated, err := s.queries.UpdateLabel(ctx, db.UpdateLabelParams{
		RepositoryID: repository.ID,
		ID:           id,
		Name:         name,
		Color:        color,
		Description:  description,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.Label{}, pkgerrors.NotFound("label not found")
		}
		if isUniqueViolation(err) {
			return db.Label{}, pkgerrors.Conflict("label already exists")
		}
		return db.Label{}, pkgerrors.Internal("failed to update label").WithCause(err)
	}
	return updated, nil
}

func (s *LabelService) DeleteLabel(ctx context.Context, actor *db.User, owner, repo string, id int64) error {
	if actor == nil {
		return pkgerrors.Unauthorized("authentication required")
	}

	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return err
	}
	if err := s.requireWriteAccess(ctx, repository, actor); err != nil {
		return err
	}

	_, err = s.queries.GetLabelByID(ctx, db.GetLabelByIDParams{RepositoryID: repository.ID, ID: id})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("label not found")
		}
		return pkgerrors.Internal("failed to load label").WithCause(err)
	}

	if err := s.queries.DeleteLabel(ctx, db.DeleteLabelParams{RepositoryID: repository.ID, ID: id}); err != nil {
		return pkgerrors.Internal("failed to delete label").WithCause(err)
	}
	return nil
}

func (s *LabelService) AddLabelsToIssue(ctx context.Context, actor *db.User, owner, repo string, number int64, names []string) ([]db.Label, error) {
	if actor == nil {
		return nil, pkgerrors.Unauthorized("authentication required")
	}
	if number <= 0 {
		return nil, pkgerrors.BadRequest("invalid issue number")
	}
	labelNames, err := normalizeLabelNames(names)
	if err != nil {
		return nil, err
	}

	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return nil, err
	}
	if err := s.requireWriteAccess(ctx, repository, actor); err != nil {
		return nil, err
	}

	issue, err := s.queries.GetIssueByNumber(ctx, db.GetIssueByNumberParams{RepositoryID: repository.ID, Number: number})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return nil, pkgerrors.NotFound("issue not found")
		}
		return nil, pkgerrors.Internal("failed to load issue").WithCause(err)
	}

	if err := requireIssueVisibility(issue, actor); err != nil {
		return nil, err
	}
	labelsByName, err := s.queries.ListLabelsByNames(ctx, db.ListLabelsByNamesParams{
		RepositoryID: repository.ID,
		Names:        labelNames,
	})
	if err != nil {
		return nil, pkgerrors.Internal("failed to load label").WithCause(err)
	}
	if len(labelsByName) != len(labelNames) {
		return nil, pkgerrors.NotFound("label not found")
	}

	labelIDs := make([]int64, 0, len(labelsByName))
	for _, label := range labelsByName {
		labelIDs = append(labelIDs, label.ID)
	}
	if err := s.queries.AddIssueLabels(ctx, db.AddIssueLabelsParams{
		IssueID:  issue.ID,
		LabelIds: labelIDs,
		AddedBy:  nativeLabelSender(ctx, actor.ID),
	}); err != nil {
		if isUniqueViolation(err) {
			return nil, pkgerrors.Conflict("label already attached to issue")
		}
		return nil, pkgerrors.Internal("failed to attach label").WithCause(err)
	}

	labels, err := s.listAllLabelsForIssue(ctx, issue.ID)
	if err != nil {
		return nil, err
	}
	s.dispatchIssueWorkflowEvent(ctx, owner, repository, actor, "labeled", issue, labels)
	return labels, nil
}

func (s *LabelService) ListIssueLabels(ctx context.Context, viewer *db.User, owner, repo string, number int64, page, perPage int) ([]db.Label, int64, error) {
	if number <= 0 {
		return nil, 0, pkgerrors.BadRequest("invalid issue number")
	}

	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return nil, 0, err
	}
	if err := s.requireReadAccess(ctx, repository, viewer); err != nil {
		return nil, 0, err
	}

	issue, err := s.queries.GetIssueByNumber(ctx, db.GetIssueByNumberParams{RepositoryID: repository.ID, Number: number})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return nil, 0, pkgerrors.NotFound("issue not found")
		}
		return nil, 0, pkgerrors.Internal("failed to load issue").WithCause(err)
	}

	if err := requireIssueVisibility(issue, viewer); err != nil {
		return nil, 0, err
	}
	pageSize, pageOffset, _, _ := normalizePage(page, perPage)
	total, err := s.queries.CountLabelsForIssue(ctx, issue.ID)
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to count issue labels").WithCause(err)
	}

	labels, err := s.queries.ListLabelsForIssue(ctx, db.ListLabelsForIssueParams{
		IssueID:    issue.ID,
		PageOffset: pageOffset,
		PageSize:   pageSize,
	})
	if err != nil {
		return nil, 0, pkgerrors.Internal("failed to list issue labels").WithCause(err)
	}
	return labels, total, nil
}

func (s *LabelService) RemoveIssueLabelByName(ctx context.Context, actor *db.User, owner, repo string, number int64, labelName string) error {
	if actor == nil {
		return pkgerrors.Unauthorized("authentication required")
	}
	if number <= 0 {
		return pkgerrors.BadRequest("invalid issue number")
	}
	trimmedLabelName := strings.TrimSpace(labelName)
	if trimmedLabelName == "" {
		return pkgerrors.BadRequest("label name is required")
	}

	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return err
	}
	if err := s.requireWriteAccess(ctx, repository, actor); err != nil {
		return err
	}

	issue, err := s.queries.GetIssueByNumber(ctx, db.GetIssueByNumberParams{RepositoryID: repository.ID, Number: number})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("issue not found")
		}
		return pkgerrors.Internal("failed to load issue").WithCause(err)
	}

	if err := requireIssueVisibility(issue, actor); err != nil {
		return err
	}
	removed, err := s.queries.RemoveIssueLabelByName(ctx, db.RemoveIssueLabelByNameParams{
		RepositoryID: repository.ID,
		IssueNumber:  number,
		LabelName:    trimmedLabelName,
	})
	if err != nil {
		return pkgerrors.Internal("failed to remove issue label").WithCause(err)
	}
	if removed == 0 {
		return pkgerrors.NotFound("label not found on issue")
	}
	labels, err := s.listAllLabelsForIssue(ctx, issue.ID)
	if err != nil {
		return err
	}
	s.dispatchIssueWorkflowEvent(ctx, owner, repository, actor, "unlabeled", issue, labels)
	return nil
}

func (s *LabelService) dispatchIssueWorkflowEvent(ctx context.Context, owner string, repository db.Repository, actor *db.User, action string, issue db.Issue, labels []db.Label) {
	if issue.Kind == "chat" {
		return
	}
	if s.workflowRunSvc == nil {
		return
	}

	var author *db.User
	if issue.AuthorID > 0 {
		loadedAuthor, err := s.queries.GetUserByID(ctx, issue.AuthorID)
		if err != nil {
			slog.Error("load issue author for workflow dispatch failed", "repo_id", repository.ID, "issue_id", issue.ID, "error", err)
		} else {
			author = &loadedAuthor
		}
	}

	assignees, err := s.queries.ListIssueAssignees(ctx, issue.ID)
	if err != nil {
		slog.Error("load issue assignees for workflow dispatch failed", "repo_id", repository.ID, "issue_id", issue.ID, "error", err)
		assignees = nil
	}

	issuePayload := issuePayloadFromRecord(issue, author, assignees, labels)
	input := newWorkflowEventDispatchInput(repository, actor, "issues", action, issueWorkflowInputs(owner, repository, issuePayload, issueSenderPayload(actor), action))
	if _, err := s.workflowRunSvc.DispatchForEvent(ctx, input); err != nil {
		slog.Error("workflow dispatch for issues failed", "repo_id", repository.ID, "issue_id", issue.ID, "action", action, "error", err)
	}
}

func (s *LabelService) resolveRepoByOwnerAndName(ctx context.Context, owner, repo string) (db.Repository, error) {
	lowerOwner := strings.ToLower(strings.TrimSpace(owner))
	lowerRepo := strings.ToLower(strings.TrimSpace(repo))
	if lowerOwner == "" {
		return db.Repository{}, pkgerrors.BadRequest("owner is required")
	}
	if lowerRepo == "" {
		return db.Repository{}, pkgerrors.BadRequest("repository name is required")
	}

	repository, err := s.queries.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{
		Owner:     lowerOwner,
		LowerName: lowerRepo,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.Repository{}, pkgerrors.NotFound("repository not found")
		}
		return db.Repository{}, pkgerrors.Internal("failed to load repository").WithCause(err)
	}
	return repository, nil
}

func (s *LabelService) requireReadAccess(ctx context.Context, repository db.Repository, viewer *db.User) error {
	if repository.IsPublic {
		return nil
	}
	if viewer == nil {
		return pkgerrors.Forbidden("permission denied")
	}
	allowed, err := s.canReadRepo(ctx, repository, viewer.ID)
	if err != nil {
		return err
	}
	if !allowed {
		return pkgerrors.Forbidden("permission denied")
	}
	return nil
}

func (s *LabelService) requireWriteAccess(ctx context.Context, repository db.Repository, actor *db.User) error {
	if actor == nil {
		return pkgerrors.Unauthorized("authentication required")
	}
	allowed, err := s.canWriteRepo(ctx, repository, actor.ID)
	if err != nil {
		return err
	}
	if !allowed {
		return pkgerrors.Forbidden("permission denied")
	}
	return nil
}

func (s *LabelService) canReadRepo(ctx context.Context, repository db.Repository, userID int64) (bool, error) {
	return canReadRepo(ctx, s.queries, repository, userID)
}

func (s *LabelService) canWriteRepo(ctx context.Context, repository db.Repository, userID int64) (bool, error) {
	return canWriteRepo(ctx, s.queries, repository, userID)
}

func validateLabelName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" {
		return "", pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Label", Field: "name", Code: "missing_field"})
	}
	if len(name) > 255 {
		return "", pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Label", Field: "name", Code: "invalid"})
	}
	if verr := validateSafeText("Label", "name", name); verr != nil {
		return "", verr
	}
	return name, nil
}

func normalizeLabelColor(raw string) (string, error) {
	color := strings.ToLower(strings.TrimSpace(raw))
	if color == "" {
		return "", pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Label", Field: "color", Code: "missing_field"})
	}
	color = strings.TrimPrefix(color, "#")
	if len(color) != 6 {
		return "", pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Label", Field: "color", Code: "invalid"})
	}
	for _, ch := range color {
		if (ch < '0' || ch > '9') && (ch < 'a' || ch > 'f') {
			return "", pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Label", Field: "color", Code: "invalid"})
		}
	}
	return "#" + color, nil
}

func normalizeLabelNames(names []string) ([]string, error) {
	if len(names) == 0 {
		return nil, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Issue", Field: "labels", Code: "missing_field"})
	}

	seen := make(map[string]struct{}, len(names))
	result := make([]string, 0, len(names))
	for _, raw := range names {
		name := strings.TrimSpace(raw)
		if name == "" {
			return nil, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Issue", Field: "labels", Code: "invalid"})
		}
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		result = append(result, name)
	}
	return result, nil
}

func (s *LabelService) listAllLabelsForIssue(ctx context.Context, issueID int64) ([]db.Label, error) {
	total, err := s.queries.CountLabelsForIssue(ctx, issueID)
	if err != nil {
		return nil, pkgerrors.Internal("failed to count issue labels").WithCause(err)
	}
	if total == 0 {
		return []db.Label{}, nil
	}

	labels := make([]db.Label, 0, total)
	offset := int32(0)
	for int64(len(labels)) < total {
		pageSize := int32(maxPerPage)
		if remaining := total - int64(len(labels)); remaining < int64(pageSize) {
			pageSize = int32(remaining)
		}

		page, err := s.queries.ListLabelsForIssue(ctx, db.ListLabelsForIssueParams{
			IssueID:    issueID,
			PageOffset: offset,
			PageSize:   pageSize,
		})
		if err != nil {
			return nil, pkgerrors.Internal("failed to load issue labels").WithCause(err)
		}
		if len(page) == 0 {
			break
		}

		labels = append(labels, page...)
		offset += int32(len(page))
	}
	return labels, nil
}
