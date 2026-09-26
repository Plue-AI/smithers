package services

import (
	"context"
	stdErrors "errors"
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const maxLinearIdentifierLen = 64

// LinearIssueReference is the public issue-DTO representation of a Linear
// mapping. URL is derived from the canonical identifier so it remains useful
// for mappings created by both manual links and the sync engine.
type LinearIssueReference struct {
	Identifier string `json:"identifier"`
	URL        string `json:"url"`
}

type LinearIssueLinkInput struct {
	Identifier string `json:"identifier"`
}

type LinearIssueLookupClient interface {
	FetchIssue(ctx context.Context, accessToken, identifier string) (LinearIssue, error)
}

type LinearIssueIntegrationAccess interface {
	RefreshTokenIfNeeded(ctx context.Context, integration db.LinearIntegration) (db.LinearIntegration, error)
	GetDecryptedAccessToken(ctx context.Context, integration db.LinearIntegration) (string, error)
}

type LinearIssueLinkQuerier interface {
	GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)
	GetIssueByNumber(ctx context.Context, arg db.GetIssueByNumberParams) (db.Issue, error)
	ListLinearIntegrationsByRepo(ctx context.Context, smithersRepoID int64) ([]db.LinearIntegration, error)
	GetLinearIssueMapBySmithersIssueID(ctx context.Context, jjhubIssueID int64) (db.LinearIssueMap, error)
	CreateLinearIssueMap(ctx context.Context, arg db.CreateLinearIssueMapParams) (db.LinearIssueMap, error)
	DeleteLinearIssueMapByID(ctx context.Context, id int64) (int64, error)
}

// LinearIssueLinkService owns validation and persistence for manual issue
// links. Route handlers only decode HTTP input and delegate here.
type LinearIssueLinkService struct {
	queries           LinearIssueLinkQuerier
	integrationAccess LinearIssueIntegrationAccess
	linearClient      LinearIssueLookupClient
}

func NewLinearIssueLinkService(q LinearIssueLinkQuerier, integrationAccess LinearIssueIntegrationAccess, linearClient LinearIssueLookupClient) *LinearIssueLinkService {
	return &LinearIssueLinkService{
		queries:           q,
		integrationAccess: integrationAccess,
		linearClient:      linearClient,
	}
}

func (s *LinearIssueLinkService) LinkIssue(ctx context.Context, actor *db.User, owner, repo string, number int64, input LinearIssueLinkInput) (LinearIssueReference, error) {
	if actor == nil {
		return LinearIssueReference{}, pkgerrors.Unauthorized("authentication required")
	}

	identifier := strings.TrimSpace(input.Identifier)
	if identifier == "" {
		return LinearIssueReference{}, linearIdentifierValidationError("missing_field")
	}
	if utf8.RuneCountInString(identifier) > maxLinearIdentifierLen {
		return LinearIssueReference{}, linearIdentifierValidationError("too_long")
	}

	repository, issue, err := s.resolveWritableIssue(ctx, actor, owner, repo, number)
	if err != nil {
		return LinearIssueReference{}, err
	}

	if _, err := s.queries.GetLinearIssueMapBySmithersIssueID(ctx, issue.ID); err == nil {
		return LinearIssueReference{}, linearIdentifierValidationError("already_exists")
	} else if !stdErrors.Is(err, pgx.ErrNoRows) {
		return LinearIssueReference{}, pkgerrors.Internal("failed to load Linear issue link")
	}

	integrations, err := s.queries.ListLinearIntegrationsByRepo(ctx, repository.ID)
	if err != nil {
		return LinearIssueReference{}, pkgerrors.Internal("failed to load Linear integration").WithCause(err)
	}
	integration, ok := matchingLinearIntegration(integrations, identifier)
	if !ok {
		if len(integrations) == 0 {
			return LinearIssueReference{}, pkgerrors.BadRequest("repository has no active Linear integration")
		}
		return LinearIssueReference{}, linearIdentifierValidationError("invalid")
	}

	if s.integrationAccess == nil || s.linearClient == nil {
		return LinearIssueReference{}, pkgerrors.Internal("Linear issue linking is unavailable")
	}
	integration, err = s.integrationAccess.RefreshTokenIfNeeded(ctx, integration)
	if err != nil {
		return LinearIssueReference{}, pkgerrors.Internal("failed to refresh Linear integration token: " + err.Error())
	}
	accessToken, err := s.integrationAccess.GetDecryptedAccessToken(ctx, integration)
	if err != nil {
		return LinearIssueReference{}, err
	}

	linearIssue, err := s.linearClient.FetchIssue(ctx, accessToken, identifier)
	if err != nil {
		return LinearIssueReference{}, pkgerrors.UnprocessableEntity("failed to validate Linear identifier: " + err.Error())
	}
	if strings.TrimSpace(linearIssue.ID) == "" ||
		!strings.EqualFold(strings.TrimSpace(linearIssue.Identifier), identifier) ||
		linearIssue.Team.ID != integration.LinearTeamID {
		return LinearIssueReference{}, linearIdentifierValidationError("invalid")
	}

	created, err := s.queries.CreateLinearIssueMap(ctx, db.CreateLinearIssueMapParams{
		IntegrationID:    integration.ID,
		JjhubIssueID:     issue.ID,
		JjhubIssueNumber: issue.Number,
		LinearIssueID:    linearIssue.ID,
		LinearIdentifier: linearIssue.Identifier,
	})
	if err != nil {
		if isUniqueViolation(err) {
			return LinearIssueReference{}, linearIdentifierValidationError("already_exists")
		}
		return LinearIssueReference{}, pkgerrors.Internal("failed to create Linear issue link").WithCause(err)
	}

	return linearIssueReference(created.LinearIdentifier), nil
}

func (s *LinearIssueLinkService) UnlinkIssue(ctx context.Context, actor *db.User, owner, repo string, number int64) error {
	if actor == nil {
		return pkgerrors.Unauthorized("authentication required")
	}

	_, issue, err := s.resolveWritableIssue(ctx, actor, owner, repo, number)
	if err != nil {
		return err
	}

	issueMap, err := s.queries.GetLinearIssueMapBySmithersIssueID(ctx, issue.ID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("Linear issue link not found")
		}
		return pkgerrors.Internal("failed to load Linear issue link").WithCause(err)
	}
	deleted, err := s.queries.DeleteLinearIssueMapByID(ctx, issueMap.ID)
	if err != nil {
		return pkgerrors.Internal("failed to delete Linear issue link").WithCause(err)
	}
	if deleted == 0 {
		return pkgerrors.NotFound("Linear issue link not found")
	}
	return nil
}

func (s *LinearIssueLinkService) resolveWritableIssue(ctx context.Context, actor *db.User, owner, repo string, number int64) (db.Repository, db.Issue, error) {
	lowerOwner := strings.ToLower(strings.TrimSpace(owner))
	lowerRepo := strings.ToLower(strings.TrimSpace(repo))
	if lowerOwner == "" {
		return db.Repository{}, db.Issue{}, pkgerrors.BadRequest("owner is required")
	}
	if lowerRepo == "" {
		return db.Repository{}, db.Issue{}, pkgerrors.BadRequest("repository name is required")
	}

	repository, err := s.queries.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{Owner: lowerOwner, LowerName: lowerRepo})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.Repository{}, db.Issue{}, pkgerrors.NotFound("repository not found")
		}
		return db.Repository{}, db.Issue{}, pkgerrors.Internal("failed to load repository").WithCause(err)
	}
	permission, isOwner, err := repoPermissionForUser(ctx, s.queries, repository, actor.ID)
	if err != nil {
		return db.Repository{}, db.Issue{}, err
	}
	if !isOwner && permission != "write" && permission != "admin" {
		return db.Repository{}, db.Issue{}, pkgerrors.Forbidden("permission denied")
	}
	if number <= 0 {
		return db.Repository{}, db.Issue{}, pkgerrors.BadRequest("invalid issue number")
	}
	issue, err := s.queries.GetIssueByNumber(ctx, db.GetIssueByNumberParams{RepositoryID: repository.ID, Number: number})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.Repository{}, db.Issue{}, pkgerrors.NotFound("issue not found")
		}
		return db.Repository{}, db.Issue{}, pkgerrors.Internal("failed to load issue").WithCause(err)
	}
	if issue.Kind == "chat" {
		return db.Repository{}, db.Issue{}, pkgerrors.NotFound("issue not found")
	}
	return repository, issue, nil
}

func matchingLinearIntegration(integrations []db.LinearIntegration, identifier string) (db.LinearIntegration, bool) {
	for _, integration := range integrations {
		teamKey := strings.TrimSpace(integration.LinearTeamKey)
		if teamKey != "" && strings.HasPrefix(strings.ToUpper(identifier), strings.ToUpper(teamKey)+"-") {
			return integration, true
		}
	}
	// A repository normally has one active Linear integration. Let Linear's
	// authoritative team ID validation handle a stale or missing cached team
	// key in that common case.
	if len(integrations) == 1 {
		return integrations[0], true
	}
	return db.LinearIntegration{}, false
}

func linearIdentifierValidationError(code string) error {
	return pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "LinearIssueLink", Field: "identifier", Code: code})
}

func linearIssueReference(identifier string) LinearIssueReference {
	identifier = strings.TrimSpace(identifier)
	return LinearIssueReference{
		Identifier: identifier,
		URL:        "https://linear.app/issue/" + url.PathEscape(identifier),
	}
}
