package services

import (
	"context"
	stdErrors "errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// ChangeRevertResponse identifies the reviewable object produced by a revert.
// Ordinary changes have a landing_request_id; cross-repository changes return
// the newly composed changeset_id instead.
type ChangeRevertResponse struct {
	ChangeID             string `json:"change_id"`
	LandingRequestID     int64  `json:"landing_request_id,omitempty"`
	LandingRequestNumber int64  `json:"landing_request_number,omitempty"`
	ChangesetID          int64  `json:"changeset_id,omitempty"`
}

type ChangeRevertQuerier interface {
	GetLandedChangesetForChange(ctx context.Context, arg db.GetLandedChangesetForChangeParams) (db.Changeset, error)
	GetMergedLandingRequestForChange(ctx context.Context, arg db.GetMergedLandingRequestForChangeParams) (db.GetMergedLandingRequestForChangeRow, error)
	GetLandingRequestByNumber(ctx context.Context, arg db.GetLandingRequestByNumberParams) (db.LandingRequest, error)
	ListChangesetMembers(ctx context.Context, changesetID int64) ([]db.ChangesetMember, error)
	GetRepoByID(ctx context.Context, id int64) (db.Repository, error)
	GetOrgByID(ctx context.Context, id int64) (db.Organization, error)
}

type ChangeBackoutRepoHost interface {
	GetChange(ctx context.Context, owner, repo, changeID string) (repohost.Change, error)
	BackoutChange(ctx context.Context, owner, repo, changeID string, req repohost.BackoutChangeRequest) (repohost.Change, error)
}

type ChangeRevertLandingCreator interface {
	CreateLandingRequest(ctx context.Context, actor *db.User, owner, repo string, req CreateLandingRequestInput) (LandingRequestResponse, error)
}

type ChangeRevertChangesetCreator interface {
	AuthorizeChangesetRevert(ctx context.Context, actor *db.User, orgName string, repositories []db.Repository) error
	CreateChangeset(ctx context.Context, actor *db.User, orgName string, input CreateChangesetInput) (ChangesetResponse, error)
}

type GeneratedChangeRecorder interface {
	RecordGeneratedChange(ctx context.Context, repositoryID int64, change repohost.Change, source string) error
}

// ChangeRevertService turns an already-landed revision back into a reviewable
// change. A member of a landed cross-repository changeset is never reverted in
// isolation: every member is backed out and pinned in one new changeset.
type ChangeRevertService struct {
	queries        ChangeRevertQuerier
	repoHost       ChangeBackoutRepoHost
	landings       ChangeRevertLandingCreator
	changesets     ChangeRevertChangesetCreator
	changeRecorder GeneratedChangeRecorder
}

func NewChangeRevertService(
	queries ChangeRevertQuerier,
	repoHost ChangeBackoutRepoHost,
	landings ChangeRevertLandingCreator,
	changesets ChangeRevertChangesetCreator,
	changeRecorder GeneratedChangeRecorder,
) *ChangeRevertService {
	return &ChangeRevertService{
		queries: queries, repoHost: repoHost, landings: landings,
		changesets: changesets, changeRecorder: changeRecorder,
	}
}

func (s *ChangeRevertService) RevertChange(
	ctx context.Context,
	actor *db.User,
	repositoryID int64,
	owner, repo, changeID string,
) (ChangeRevertResponse, error) {
	if actor == nil {
		return ChangeRevertResponse{}, pkgerrors.Unauthorized("authentication required")
	}
	if s == nil || s.queries == nil || s.repoHost == nil || s.changeRecorder == nil {
		return ChangeRevertResponse{}, pkgerrors.Internal("change revert service not configured")
	}
	changeID = strings.TrimSpace(changeID)
	if changeID == "" {
		return ChangeRevertResponse{}, pkgerrors.BadRequest("change_id is required")
	}
	if _, err := s.repoHost.GetChange(ctx, owner, repo, changeID); err != nil {
		return ChangeRevertResponse{}, mapChangeRepoHostError(err, "failed to get change")
	}

	landedChangeset, err := s.queries.GetLandedChangesetForChange(ctx, db.GetLandedChangesetForChangeParams{
		RepositoryID: repositoryID,
		ChangeID:     changeID,
	})
	if err == nil {
		return s.revertChangeset(ctx, actor, landedChangeset)
	}
	if !stdErrors.Is(err, pgx.ErrNoRows) {
		return ChangeRevertResponse{}, pkgerrors.Internal("failed to load landed changeset")
	}

	if s.landings == nil {
		return ChangeRevertResponse{}, pkgerrors.Internal("change revert landing service not configured")
	}
	landing, err := s.queries.GetMergedLandingRequestForChange(ctx, db.GetMergedLandingRequestForChangeParams{
		RepositoryID: repositoryID,
		ChangeID:     changeID,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return ChangeRevertResponse{}, pkgerrors.Conflict("change is not landed")
		}
		return ChangeRevertResponse{}, pkgerrors.Internal("failed to load landed change").WithCause(err)
	}
	if strings.TrimSpace(landing.LandedRevision) == "" {
		return ChangeRevertResponse{}, pkgerrors.Internal("landed change revision is unavailable")
	}

	reverting, err := s.repoHost.BackoutChange(ctx, owner, repo, changeID, repohost.BackoutChangeRequest{
		Revision:       landing.LandedRevision,
		TargetBookmark: landing.TargetBookmark,
	})
	if err != nil {
		return ChangeRevertResponse{}, mapChangeRepoHostError(err, "failed to revert change")
	}
	if err := s.changeRecorder.RecordGeneratedChange(ctx, repositoryID, reverting, "revert"); err != nil {
		return ChangeRevertResponse{}, err
	}

	created, err := s.landings.CreateLandingRequest(ctx, actor, owner, repo, CreateLandingRequestInput{
		Title:          revertTitle(changeID),
		Body:           fmt.Sprintf("Reverts change %s.", changeID),
		TargetBookmark: landing.TargetBookmark,
		ChangeIDs:      []string{reverting.ChangeID},
	})
	if err != nil {
		return ChangeRevertResponse{}, err
	}
	createdRow, err := s.queries.GetLandingRequestByNumber(ctx, db.GetLandingRequestByNumberParams{
		RepositoryID: repositoryID,
		Number:       created.Number,
	})
	if err != nil {
		return ChangeRevertResponse{}, pkgerrors.Internal("failed to load reverting landing request").WithCause(err)
	}
	return ChangeRevertResponse{
		ChangeID:             reverting.ChangeID,
		LandingRequestID:     createdRow.ID,
		LandingRequestNumber: createdRow.Number,
	}, nil
}

func (s *ChangeRevertService) revertChangeset(ctx context.Context, actor *db.User, original db.Changeset) (ChangeRevertResponse, error) {
	if s.changesets == nil {
		return ChangeRevertResponse{}, pkgerrors.Internal("change revert changeset service not configured")
	}
	org, err := s.queries.GetOrgByID(ctx, original.OrganizationID)
	if err != nil {
		return ChangeRevertResponse{}, pkgerrors.Internal("failed to load changeset organization").WithCause(err)
	}
	members, err := s.queries.ListChangesetMembers(ctx, original.ID)
	if err != nil {
		return ChangeRevertResponse{}, pkgerrors.Internal("failed to load changeset members").WithCause(err)
	}
	if len(members) == 0 {
		return ChangeRevertResponse{}, pkgerrors.Conflict("landed changeset has no members")
	}

	// Resolve and authorize the complete set before any repo-host or recorder
	// write. CreateChangeset's eventual authorization is too late for backouts.
	repositories := make([]db.Repository, 0, len(members))
	for _, member := range members {
		repository, err := s.queries.GetRepoByID(ctx, member.RepositoryID)
		if err != nil {
			return ChangeRevertResponse{}, pkgerrors.Internal("failed to load changeset member repository").WithCause(err)
		}
		repositories = append(repositories, repository)
	}
	if err := s.changesets.AuthorizeChangesetRevert(ctx, actor, org.Name, repositories); err != nil {
		return ChangeRevertResponse{}, err
	}
	inputs := make([]ChangesetMemberInput, 0, len(members))
	for i, member := range members {
		repository := repositories[i]
		reverting, err := s.repoHost.BackoutChange(ctx, org.Name, repository.Name, member.ChangeID, repohost.BackoutChangeRequest{
			// CommitID is the exact revision pinned into the changeset. The
			// landed bookmark head may instead be a merge commit whose change
			// ID is unrelated to this member.
			Revision:       member.CommitID,
			TargetBookmark: member.TargetBookmark,
		})
		if err != nil {
			return ChangeRevertResponse{}, mapChangeRepoHostError(err, "failed to revert changeset member")
		}
		if reverting.HasConflict {
			return ChangeRevertResponse{}, pkgerrors.Conflict(fmt.Sprintf("reverting change %s in %s has conflicts", member.ChangeID, repository.Name))
		}
		if err := s.changeRecorder.RecordGeneratedChange(ctx, repository.ID, reverting, "revert"); err != nil {
			return ChangeRevertResponse{}, err
		}
		inputs = append(inputs, ChangesetMemberInput{
			Repo:           repository.Name,
			ChangeID:       reverting.ChangeID,
			TargetBookmark: member.TargetBookmark,
		})
	}

	created, err := s.changesets.CreateChangeset(ctx, actor, org.Name, CreateChangesetInput{
		Description:    revertTitle(original.ChangeID),
		TargetBookmark: original.TargetBookmark,
		Members:        inputs,
	})
	if err != nil {
		return ChangeRevertResponse{}, err
	}
	return ChangeRevertResponse{ChangeID: created.ChangeID, ChangesetID: created.ID}, nil
}

func revertTitle(changeID string) string {
	changeID = strings.TrimSpace(changeID)
	if len(changeID) > 8 {
		changeID = changeID[:8]
	}
	return "Revert " + changeID
}
