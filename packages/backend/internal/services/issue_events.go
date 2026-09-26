package services

import (
	"context"
	"encoding/json"
	stdErrors "errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// IssueEventResponse is the API representation of an issue event.
type IssueEventResponse struct {
	ID         int64           `json:"id"`
	IssueID    int64           `json:"issue_id"`
	ActorID    any             `json:"actor_id"`
	ActorLogin string          `json:"actor_login,omitempty"`
	EventType  string          `json:"event_type"`
	Payload    json.RawMessage `json:"payload"`
	CreatedAt  time.Time       `json:"created_at"`
}

// IssueEventQuerier is the DB interface needed by IssueEventService.
type IssueEventQuerier interface {
	GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)

	GetIssueByNumber(ctx context.Context, arg db.GetIssueByNumberParams) (db.Issue, error)

	ListIssueEventsByIssue(ctx context.Context, arg db.ListIssueEventsByIssueParams) ([]db.IssueEvent, error)

	GetUserByID(ctx context.Context, id int64) (db.User, error)
}

// IssueEventService handles reading issue event timelines.
type IssueEventService struct {
	queries IssueEventQuerier
}

func NewIssueEventService(q IssueEventQuerier) *IssueEventService {
	return &IssueEventService{queries: q}
}

// ListIssueEvents returns the ordered timeline of events for an issue.
func (s *IssueEventService) ListIssueEvents(ctx context.Context, viewer *db.User, owner, repo string, number int64, page, perPage int) ([]IssueEventResponse, error) {
	repository, err := s.resolveRepo(ctx, owner, repo)
	if err != nil {
		return nil, err
	}
	if err := s.requireRead(ctx, repository, viewer); err != nil {
		return nil, err
	}

	issue, err := s.getIssueByNumber(ctx, repository.ID, number)
	if err != nil {
		return nil, err
	}

	if err := requireIssueVisibility(issue, viewer); err != nil {
		return nil, err
	}
	if page < 1 {
		page = 1
	}
	if perPage < 1 {
		perPage = 30
	}
	offset := ClampInt32((page - 1) * perPage)

	rows, err := s.queries.ListIssueEventsByIssue(ctx, db.ListIssueEventsByIssueParams{
		IssueID:    issue.ID,
		PageOffset: offset,
		PageSize:   int32(perPage),
	})
	if err != nil {
		return nil, pkgerrors.Internal("failed to list issue events").WithCause(err)
	}

	logins := s.resolveActorLogins(ctx, rows)

	items := make([]IssueEventResponse, 0, len(rows))
	for _, r := range rows {
		item := mapIssueEvent(r)
		if r.ActorID.Valid {
			item.ActorLogin = logins[r.ActorID.Int64]
		}
		items = append(items, item)
	}
	return items, nil
}

// resolveActorLogins resolves each unique actor id on the page to its username
// exactly once. A missing/deleted user or a null actor_id leaves the login
// empty so the client keeps its numeric fallback.
func (s *IssueEventService) resolveActorLogins(ctx context.Context, rows []db.IssueEvent) map[int64]string {
	logins := make(map[int64]string)
	for _, r := range rows {
		if !r.ActorID.Valid {
			continue
		}
		id := r.ActorID.Int64
		if _, seen := logins[id]; seen {
			continue
		}
		user, err := s.queries.GetUserByID(ctx, id)
		if err != nil {
			logins[id] = ""
			continue
		}
		logins[id] = user.Username
	}
	return logins
}

// ---- helpers ----

func (s *IssueEventService) resolveRepo(ctx context.Context, owner, repo string) (db.Repository, error) {
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

func (s *IssueEventService) requireRead(ctx context.Context, repository db.Repository, viewer *db.User) error {
	if repository.IsPublic {
		return nil
	}
	if viewer == nil {
		return pkgerrors.Forbidden("permission denied")
	}
	permission, isOwner, err := s.eventRepoPermission(ctx, repository, viewer.ID)
	if err != nil {
		return err
	}
	if isOwner || permission == "read" || permission == "write" || permission == "admin" {
		return nil
	}
	return pkgerrors.Forbidden("permission denied")
}

func (s *IssueEventService) eventRepoPermission(ctx context.Context, repository db.Repository, userID int64) (string, bool, error) {
	return repoPermissionForUser(ctx, s.queries, repository, userID)
}

func (s *IssueEventService) getIssueByNumber(ctx context.Context, repositoryID, number int64) (db.Issue, error) {
	if number <= 0 {
		return db.Issue{}, pkgerrors.BadRequest("invalid issue number")
	}
	issue, err := s.queries.GetIssueByNumber(ctx, db.GetIssueByNumberParams{
		RepositoryID: repositoryID,
		Number:       number,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.Issue{}, pkgerrors.NotFound("issue not found")
		}
		return db.Issue{}, pkgerrors.Internal("failed to load issue").WithCause(err)
	}
	return issue, nil
}

func mapIssueEvent(e db.IssueEvent) IssueEventResponse {
	var actorID any
	if e.ActorID != (pgtype.Int8{}) && e.ActorID.Valid {
		actorID = e.ActorID.Int64
	}
	return IssueEventResponse{
		ID:        e.ID,
		IssueID:   e.IssueID,
		ActorID:   actorID,
		EventType: e.EventType,
		Payload:   e.Payload,
		CreatedAt: e.CreatedAt,
	}
}
