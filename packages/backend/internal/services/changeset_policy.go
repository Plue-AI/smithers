package services

import (
	"context"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func (s *ChangesetService) requireRepoAccess(ctx context.Context, repo db.Repository, userID int64, write bool) error {
	var allowed bool
	var err error
	if write {
		allowed, err = canWriteRepo(ctx, s.queries, repo, userID)
	} else {
		allowed, err = canReadRepo(ctx, s.queries, repo, userID)
	}
	if err != nil {
		return err
	}
	if !allowed {
		return pkgerrors.Forbidden("insufficient member repository permissions")
	}
	return nil
}

func (s *ChangesetService) requireMembersAccess(ctx context.Context, userID int64, members []db.ChangesetMember, write bool) error {
	for _, member := range members {
		repo, err := s.queries.GetRepoByID(ctx, member.RepositoryID)
		if err != nil {
			return pkgerrors.Internal("failed to load member repository").WithCause(err)
		}
		if err := s.requireRepoAccess(ctx, repo, userID, write); err != nil {
			return err
		}
	}
	return nil
}

func (s *ChangesetService) checkLandingPolicy(ctx context.Context, repo db.Repository, owner, changeID, commitID, target string) error {
	if isMythicalBookmark(target) {
		return errMythicalBookmarkOwned
	}
	rules, err := s.queries.ListAllProtectedBookmarksByRepo(ctx, repo.ID)
	if err != nil {
		return pkgerrors.Internal("failed to load protected bookmarks").WithCause(err)
	}
	protected := len(repo.LandingQueueRequiredChecks) > 0
	for _, rule := range rules {
		match, err := bookmarkMatchesPattern(rule.Pattern, target)
		if err != nil {
			return pkgerrors.Internal("invalid protected bookmark pattern").WithCause(err)
		}
		protected = protected || match
	}
	if !protected {
		return nil
	}
	current, err := s.repoHost.GetChange(ctx, owner, repo.Name, changeID)
	if err != nil {
		return pkgerrors.Conflict("cannot verify the reviewed member revision")
	}
	if current.CommitID != commitID {
		return pkgerrors.Conflict("changeset pin differs from the reviewed landing request revision")
	}
	if s.landingPolicy == nil {
		return pkgerrors.Conflict("protected target requires the landing policy evaluator")
	}
	lr, err := s.queries.GetLatestLandingRequestForChange(ctx, db.GetLatestLandingRequestForChangeParams{RepositoryID: repo.ID, ChangeID: changeID})
	if err != nil {
		return pkgerrors.Conflict("protected changeset member requires an open landing request")
	}
	if lr.State != "open" || lr.TargetBookmark != target {
		return pkgerrors.Conflict("member landing request must be open and target the same bookmark")
	}
	row, err := s.queries.GetLandingRequestWithChangeIDsByNumber(ctx, db.GetLandingRequestWithChangeIDsByNumberParams{RepositoryID: repo.ID, Number: lr.Number})
	if err != nil {
		return pkgerrors.Internal("failed to load member landing request").WithCause(err)
	}
	if len(row.ChangeIds) != 1 || row.ChangeIds[0] != changeID {
		return pkgerrors.Conflict("changeset member must have its own landing request")
	}
	blocks, err := s.landingPolicy.landingBlockers(ctx, repo, owner, repo.Name, row)
	if err != nil {
		return err
	}
	current, err = s.repoHost.GetChange(ctx, owner, repo.Name, changeID)
	if err != nil || current.CommitID != commitID {
		return pkgerrors.Conflict("member revision changed during policy evaluation")
	}
	if len(blocks) > 0 {
		return pkgerrors.Conflict("changeset member has unmet reviews, ownership approvals, or required checks")
	}
	return nil
}
