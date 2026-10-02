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

const (
	// maxVariablesPerRepo and maxVariablesPerOrg are best-effort read-then-write
	// caps enforced in the service layer (see the matching comment in
	// secret.go for the TOCTOU tradeoff).
	maxVariablesPerRepo   = 100
	maxVariablesPerOrg    = 100
	maxVariableValueBytes = 48 * 1024
)

type VariableQuerier interface {
	GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	GetOrgByLowerName(ctx context.Context, lowerName string) (db.Organization, error)
	GetVisibleOrgForViewer(ctx context.Context, arg db.GetVisibleOrgForViewerParams) (db.GetVisibleOrgForViewerRow, error)
	GetOrgMember(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error)
	IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)

	CreateOrUpdateVariable(ctx context.Context, arg db.CreateOrUpdateVariableParams) (db.RepositoryVariable, error)
	GetVariableByName(ctx context.Context, arg db.GetVariableByNameParams) (db.RepositoryVariable, error)
	ListVariables(ctx context.Context, repositoryID int64) ([]db.RepositoryVariable, error)
	DeleteVariable(ctx context.Context, arg db.DeleteVariableParams) error
	CreateOrUpdateOrgVariable(ctx context.Context, arg db.CreateOrUpdateOrgVariableParams) (db.OrganizationVariable, error)
	GetOrgVariableByName(ctx context.Context, arg db.GetOrgVariableByNameParams) (db.OrganizationVariable, error)
	ListOrgVariables(ctx context.Context, organizationID int64) ([]db.OrganizationVariable, error)
	DeleteOrgVariable(ctx context.Context, arg db.DeleteOrgVariableParams) error
}

type VariableService struct {
	queries        VariableQuerier
	ownershipGuard RepoOwnershipGuard
	// subscriptionTokens mirrors feature_flags.subscription_connections.
	subscriptionTokens bool
}

type VariableServiceOption func(*VariableService)

// WithVariableSubscriptionTokens lets a self-hosted deployment store a Claude
// or ChatGPT subscription token in a variable. Off by default (hosted).
func WithVariableSubscriptionTokens(allowed bool) VariableServiceOption {
	return func(s *VariableService) { s.subscriptionTokens = allowed }
}

// WithVariableOwnershipGuard serializes repository variable writes with ownership changes.
func WithVariableOwnershipGuard(g RepoOwnershipGuard) VariableServiceOption {
	return func(s *VariableService) { s.ownershipGuard = g }
}

func NewVariableService(q VariableQuerier, opts ...VariableServiceOption) *VariableService {
	s := &VariableService{queries: q}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// VariableResponse is the service-layer response for a variable.
type VariableResponse struct {
	Name      string `json:"name"`
	Value     string `json:"value"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

func toVariableResponse(v db.RepositoryVariable) VariableResponse {
	return VariableResponse{
		Name:      v.Name,
		Value:     v.Value,
		CreatedAt: v.CreatedAt.Format("2006-01-02T15:04:05Z"),
		UpdatedAt: v.UpdatedAt.Format("2006-01-02T15:04:05Z"),
	}
}

func orgVariableToResponse(v db.OrganizationVariable) VariableResponse {
	return VariableResponse{
		Name:      v.Name,
		Value:     v.Value,
		CreatedAt: v.CreatedAt.Format("2006-01-02T15:04:05Z"),
		UpdatedAt: v.UpdatedAt.Format("2006-01-02T15:04:05Z"),
	}
}

func (s *VariableService) SetVariable(ctx context.Context, actor *db.User, owner, repo, name, value string) (VariableResponse, error) {
	if actor == nil {
		return VariableResponse{}, pkgerrors.Unauthorized("authentication required")
	}

	trimmedName := strings.TrimSpace(name)
	if trimmedName == "" {
		return VariableResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Variable", Field: "name", Code: "missing_field"})
	}
	if len(trimmedName) > 255 {
		return VariableResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Variable", Field: "name", Code: "invalid"})
	}
	if !IsInjectedSecretName(trimmedName) {
		return VariableResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Variable", Field: "name", Code: "invalid"})
	}
	if len(value) > maxVariableValueBytes {
		return VariableResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Variable", Field: "value", Code: "too_long"})
	}
	if err := refuseSubscriptionToken(s.subscriptionTokens, trimmedName, value); err != nil {
		return VariableResponse{}, err
	}

	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return VariableResponse{}, err
	}
	if err := s.requireWriteAccess(ctx, repository, actor); err != nil {
		return VariableResponse{}, err
	}

	if err := s.enforceVariableQuota(ctx, repository.ID, trimmedName); err != nil {
		return VariableResponse{}, err
	}

	var created db.RepositoryVariable
	err = guardedRepoWrite(ctx, s.ownershipGuard, repository, func() error {
		if err := s.requireWriteAccess(ctx, repository, actor); err != nil {
			return err
		}
		var err error
		created, err = s.queries.CreateOrUpdateVariable(ctx, db.CreateOrUpdateVariableParams{
			RepositoryID: repository.ID,
			Name:         trimmedName,
			Value:        value,
		})
		if err != nil {
			return pkgerrors.Internal("failed to set variable").WithCause(err)
		}
		return nil
	})
	if err != nil {
		return VariableResponse{}, err
	}

	return toVariableResponse(created), nil
}

func (s *VariableService) GetVariable(ctx context.Context, actor *db.User, owner, repo, name string) (VariableResponse, error) {
	trimmedName := strings.TrimSpace(name)
	if trimmedName == "" {
		return VariableResponse{}, pkgerrors.BadRequest("variable name is required")
	}

	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return VariableResponse{}, err
	}
	if err := s.requireReadAccess(ctx, repository, actor); err != nil {
		return VariableResponse{}, err
	}

	variable, err := s.queries.GetVariableByName(ctx, db.GetVariableByNameParams{
		RepositoryID: repository.ID,
		Name:         trimmedName,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return VariableResponse{}, pkgerrors.NotFound("variable not found")
		}
		return VariableResponse{}, pkgerrors.Internal("failed to get variable").WithCause(err)
	}

	return toVariableResponse(variable), nil
}

func (s *VariableService) ListVariables(ctx context.Context, actor *db.User, owner, repo string) ([]VariableResponse, error) {
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return nil, err
	}
	if err := s.requireReadAccess(ctx, repository, actor); err != nil {
		return nil, err
	}

	variables, err := s.queries.ListVariables(ctx, repository.ID)
	if err != nil {
		return nil, pkgerrors.Internal("failed to list variables").WithCause(err)
	}

	result := make([]VariableResponse, len(variables))
	for i, v := range variables {
		result[i] = toVariableResponse(v)
	}
	return result, nil
}

func (s *VariableService) DeleteVariable(ctx context.Context, actor *db.User, owner, repo, name string) error {
	if actor == nil {
		return pkgerrors.Unauthorized("authentication required")
	}

	trimmedName := strings.TrimSpace(name)
	if trimmedName == "" {
		return pkgerrors.BadRequest("variable name is required")
	}

	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return err
	}
	if err := s.requireWriteAccess(ctx, repository, actor); err != nil {
		return err
	}

	return guardedRepoWrite(ctx, s.ownershipGuard, repository, func() error {
		if err := s.requireWriteAccess(ctx, repository, actor); err != nil {
			return err
		}
		if err := s.queries.DeleteVariable(ctx, db.DeleteVariableParams{
			RepositoryID: repository.ID,
			Name:         trimmedName,
		}); err != nil {
			return pkgerrors.Internal("failed to delete variable").WithCause(err)
		}
		return nil
	})
}

func (s *VariableService) SetOrgVariable(ctx context.Context, actor *db.User, orgName, name, value string) (VariableResponse, error) {
	org, err := s.requireOrgOwner(ctx, actor, orgName)
	if err != nil {
		return VariableResponse{}, err
	}
	trimmedName := strings.TrimSpace(name)
	if trimmedName == "" {
		return VariableResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Variable", Field: "name", Code: "missing_field"})
	}
	if len(trimmedName) > 255 {
		return VariableResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Variable", Field: "name", Code: "invalid"})
	}
	if !IsInjectedSecretName(trimmedName) {
		return VariableResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Variable", Field: "name", Code: "invalid"})
	}
	if len(value) > maxVariableValueBytes {
		return VariableResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Variable", Field: "value", Code: "too_long"})
	}
	if err := refuseSubscriptionToken(s.subscriptionTokens, trimmedName, value); err != nil {
		return VariableResponse{}, err
	}
	if err := s.enforceOrgVariableQuota(ctx, org.ID, trimmedName); err != nil {
		return VariableResponse{}, err
	}
	created, err := s.queries.CreateOrUpdateOrgVariable(ctx, db.CreateOrUpdateOrgVariableParams{
		OrganizationID: org.ID,
		Name:           trimmedName,
		Value:          value,
	})
	if err != nil {
		return VariableResponse{}, pkgerrors.Internal("failed to set organization variable").WithCause(err)
	}
	return orgVariableToResponse(created), nil
}

func (s *VariableService) ListOrgVariables(ctx context.Context, actor *db.User, orgName string) ([]VariableResponse, error) {
	org, err := s.requireOrgOwner(ctx, actor, orgName)
	if err != nil {
		return nil, err
	}
	variables, err := s.queries.ListOrgVariables(ctx, org.ID)
	if err != nil {
		return nil, pkgerrors.Internal("failed to list organization variables").WithCause(err)
	}
	result := make([]VariableResponse, len(variables))
	for i, v := range variables {
		result[i] = orgVariableToResponse(v)
	}
	return result, nil
}

func (s *VariableService) DeleteOrgVariable(ctx context.Context, actor *db.User, orgName, name string) error {
	org, err := s.requireOrgOwner(ctx, actor, orgName)
	if err != nil {
		return err
	}
	trimmedName := strings.TrimSpace(name)
	if trimmedName == "" {
		return pkgerrors.BadRequest("variable name is required")
	}
	if err := s.queries.DeleteOrgVariable(ctx, db.DeleteOrgVariableParams{
		OrganizationID: org.ID,
		Name:           trimmedName,
	}); err != nil {
		return pkgerrors.Internal("failed to delete organization variable").WithCause(err)
	}
	return nil
}

// enforceVariableQuota rejects a write that would create a new variable
// beyond maxVariablesPerRepo. Updates to an already-existing name are always
// allowed. This is a best-effort read-then-write cap (TOCTOU races can
// slightly overshoot); hard transactional enforcement is deferred to a COUNT
// query.
func (s *VariableService) enforceVariableQuota(ctx context.Context, repositoryID int64, name string) error {
	rows, err := s.queries.ListVariables(ctx, repositoryID)
	if err != nil {
		return pkgerrors.Internal("failed to set variable").WithCause(err)
	}
	for _, row := range rows {
		if row.Name == name {
			return nil
		}
	}
	if len(rows) >= maxVariablesPerRepo {
		return pkgerrors.QuotaExceeded("repository variable limit reached (100)")
	}
	return nil
}

// enforceOrgVariableQuota is the organization-scoped counterpart of
// enforceVariableQuota.
func (s *VariableService) enforceOrgVariableQuota(ctx context.Context, organizationID int64, name string) error {
	rows, err := s.queries.ListOrgVariables(ctx, organizationID)
	if err != nil {
		return pkgerrors.Internal("failed to set organization variable").WithCause(err)
	}
	for _, row := range rows {
		if row.Name == name {
			return nil
		}
	}
	if len(rows) >= maxVariablesPerOrg {
		return pkgerrors.QuotaExceeded("organization variable limit reached (100)")
	}
	return nil
}

// --- permission helpers ---

func (s *VariableService) resolveRepoByOwnerAndName(ctx context.Context, owner, repo string) (db.Repository, error) {
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
		slog.Error("load repository failed", "owner", lowerOwner, "repo", lowerRepo, "error", err)
		return db.Repository{}, pkgerrors.Internal("failed to load repository").WithCause(err)
	}
	return repository, nil
}

// requireOrgOwner resolves orgName for actor and admits site administrators
// and organization owners. Visibility is decided first, so a private
// organization answers everyone else like a missing one.
func (s *VariableService) requireOrgOwner(ctx context.Context, actor *db.User, orgName string) (db.Organization, error) {
	if actor == nil {
		return db.Organization{}, pkgerrors.Unauthorized("authentication required")
	}
	if actor.IsAdmin {
		return lookupOrgByName(ctx, s.queries, orgName)
	}
	org, membership, err := resolveOrgForViewer(ctx, s.queries, actor, orgName)
	if err != nil {
		return db.Organization{}, err
	}
	if !membership.hasRole("owner") {
		return db.Organization{}, pkgerrors.Forbidden("permission denied")
	}
	return org, nil
}

func (s *VariableService) requireReadAccess(ctx context.Context, repository db.Repository, viewer *db.User) error {
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

func (s *VariableService) requireWriteAccess(ctx context.Context, repository db.Repository, actor *db.User) error {
	if actor == nil {
		return pkgerrors.Unauthorized("authentication required")
	}
	canWrite, err := s.canWriteRepo(ctx, repository, actor.ID)
	if err != nil {
		return err
	}
	if !canWrite {
		return pkgerrors.Forbidden("permission denied")
	}
	return nil
}

func (s *VariableService) canReadRepo(ctx context.Context, repository db.Repository, userID int64) (bool, error) {
	return canReadRepo(ctx, s.queries, repository, userID)
}

func (s *VariableService) canWriteRepo(ctx context.Context, repository db.Repository, userID int64) (bool, error) {
	return canWriteRepo(ctx, s.queries, repository, userID)
}
