package services

import (
	"context"
	stderrors "errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// RepoTransferResult reports the current owner, including when a request is
// waiting for consent and the repository has not moved.
type RepoTransferResult struct {
	db.Repository
	Owner           string
	PendingTransfer *db.RepositoryTransferRequest
}

var errRepoTransferExpired = errors.Conflict("repository transfer has expired")

type repoTransferRequestReader interface {
	GetRepositoryTransferRequest(context.Context, int64) (db.RepositoryTransferRequest, error)
	ListRepositoryTransferRequests(context.Context, int64) ([]db.RepositoryTransferRequest, error)
}

type repoTransferRequestTx interface {
	GetRepositoryTransferRequest(context.Context, int64) (db.RepositoryTransferRequest, error)
	GetPendingRepositoryTransferRequest(context.Context, int64) (db.RepositoryTransferRequest, error)
	CreateRepositoryTransferRequest(context.Context, db.CreateRepositoryTransferRequestParams) (db.RepositoryTransferRequest, error)
	ExpireRepositoryTransferRequests(context.Context, int64) error
	ResolveRepositoryTransferRequest(context.Context, db.ResolveRepositoryTransferRequestParams) (db.RepositoryTransferRequest, error)
	IsOrgOwnerForRepoUser(context.Context, db.IsOrgOwnerForRepoUserParams) (bool, error)
}

func transferRequestQueries(tx repoOwnershipTx) (repoTransferRequestTx, error) {
	if transaction, ok := tx.(repoOwnershipDBTransaction); ok {
		return db.New(transaction.OwnershipDBTX()), nil
	}
	if q, ok := tx.(repoTransferRequestTx); ok {
		return q, nil
	}
	return nil, errors.Internal("repository transfers require transactional storage")
}

func rollbackTransferRequest(ctx context.Context, tx repoOwnershipTx) {
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), repoProvisionDBCleanupTimeout)
	defer cancel()
	_ = tx.Rollback(cleanup)
}

func transferSourceAuthorized(ctx context.Context, q repoTransferRequestTx, repo db.Repository, userID int64) error {
	if repo.UserID.Valid && repo.UserID.Int64 == userID {
		return nil
	}
	if repo.OrgID.Valid {
		allowed, err := q.IsOrgOwnerForRepoUser(ctx, db.IsOrgOwnerForRepoUserParams{RepositoryID: repo.ID, UserID: userID})
		if err != nil {
			return errors.Internal("failed to check repository owner").WithCause(err)
		}
		if allowed {
			return nil
		}
	}
	return errors.Forbidden("permission denied")
}

func (s *RepoService) createRepoTransferRequest(ctx context.Context, actor *db.User, repository db.Repository, owner string, recipientID int64) (RepoTransferResult, error) {
	if s.ownershipTx == nil {
		return RepoTransferResult{}, errors.Internal("repository transfers require transactional storage")
	}
	tx, err := s.ownershipTx.BeginOwnershipTx(ctx, repository.ID)
	if err != nil {
		return RepoTransferResult{}, errors.Internal("failed to request repository transfer").WithCause(err)
	}
	defer rollbackTransferRequest(ctx, tx)
	q, err := transferRequestQueries(tx)
	if err != nil {
		return RepoTransferResult{}, err
	}
	fresh, err := tx.GetRepoByIDForUpdate(ctx, repository.ID)
	if stderrors.Is(err, pgx.ErrNoRows) {
		return RepoTransferResult{}, errors.NotFound("repository not found")
	}
	if err != nil {
		return RepoTransferResult{}, errors.Internal("failed to read repository").WithCause(err)
	}
	if !repoOwnershipUnchanged(fresh, repository) || fresh.Name != repository.Name {
		return RepoTransferResult{}, errors.Conflict("repository ownership changed concurrently")
	}
	if err := transferSourceAuthorized(ctx, q, fresh, actor.ID); err != nil {
		return RepoTransferResult{}, err
	}
	if err := q.ExpireRepositoryTransferRequests(ctx, repository.ID); err != nil {
		return RepoTransferResult{}, errors.Internal("failed to expire repository transfers").WithCause(err)
	}
	request, err := q.GetPendingRepositoryTransferRequest(ctx, repository.ID)
	if err == nil {
		if request.RecipientID != recipientID || request.SenderID != actor.ID {
			return RepoTransferResult{}, errors.Conflict("repository transfer is already pending")
		}
	} else if stderrors.Is(err, pgx.ErrNoRows) {
		request, err = q.CreateRepositoryTransferRequest(ctx, db.CreateRepositoryTransferRequestParams{
			RepositoryID: fresh.ID, SenderID: actor.ID, RecipientID: recipientID,
			SourceUserID: fresh.UserID, SourceOrgID: fresh.OrgID, SourceOwner: owner, SourceName: fresh.Name,
		})
	}
	if err != nil {
		return RepoTransferResult{}, errors.Internal("failed to request repository transfer").WithCause(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return RepoTransferResult{}, errors.Internal("failed to request repository transfer").WithCause(err)
	}
	return RepoTransferResult{Repository: fresh, Owner: owner, PendingTransfer: &request}, nil
}

func (s *RepoService) ListRepoTransfers(ctx context.Context, actor *db.User) ([]db.RepositoryTransferRequest, error) {
	if actor == nil {
		return nil, errors.Unauthorized("authentication required")
	}
	q, ok := s.queries.(repoTransferRequestReader)
	if !ok {
		return nil, errors.Internal("repository transfer storage unavailable")
	}
	requests, err := q.ListRepositoryTransferRequests(ctx, actor.ID)
	if err != nil {
		return nil, errors.Internal("failed to list repository transfers").WithCause(err)
	}
	return requests, nil
}

func (s *RepoService) repoTransferRequestForActor(ctx context.Context, actor *db.User, id int64, sourceOwner bool) (db.RepositoryTransferRequest, error) {
	if actor == nil {
		return db.RepositoryTransferRequest{}, errors.Unauthorized("authentication required")
	}
	q, ok := s.queries.(repoTransferRequestReader)
	if !ok {
		return db.RepositoryTransferRequest{}, errors.Internal("repository transfer storage unavailable")
	}
	request, err := q.GetRepositoryTransferRequest(ctx, id)
	if stderrors.Is(err, pgx.ErrNoRows) {
		return request, errors.NotFound("repository transfer not found")
	}
	if err != nil {
		return request, errors.Internal("failed to read repository transfer").WithCause(err)
	}
	if sourceOwner {
		repository, err := s.queries.GetRepoByID(ctx, request.RepositoryID)
		if stderrors.Is(err, pgx.ErrNoRows) {
			return db.RepositoryTransferRequest{}, errors.NotFound("repository transfer not found")
		}
		if err != nil {
			return db.RepositoryTransferRequest{}, errors.Internal("failed to read repository").WithCause(err)
		}
		allowed, err := s.canOwnRepo(ctx, repository, actor.ID)
		if err != nil {
			return db.RepositoryTransferRequest{}, err
		}
		if !allowed {
			return db.RepositoryTransferRequest{}, errors.NotFound("repository transfer not found")
		}
	} else if actor.ID != request.RecipientID {
		return db.RepositoryTransferRequest{}, errors.NotFound("repository transfer not found")
	}
	return request, nil
}

func (s *RepoService) AcceptRepoTransfer(ctx context.Context, actor *db.User, id int64) (db.Repository, error) {
	request, err := s.repoTransferRequestForActor(ctx, actor, id, false)
	if err != nil {
		return db.Repository{}, err
	}
	if request.Status != "pending" {
		return db.Repository{}, errors.Conflict("repository transfer is no longer pending")
	}
	if s.ownershipTx == nil {
		return db.Repository{}, errors.Internal("repository transfers require transactional storage")
	}
	repository, err := s.queries.GetRepoByID(ctx, request.RepositoryID)
	if stderrors.Is(err, pgx.ErrNoRows) {
		return db.Repository{}, errors.NotFound("repository not found")
	}
	if err != nil {
		return db.Repository{}, errors.Internal("failed to read repository").WithCause(err)
	}
	owner, err := s.canonicalRepositoryOwner(ctx, repository, request.SourceOwner)
	if err != nil {
		return db.Repository{}, err
	}
	_, err = s.queries.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{
		Owner: strings.ToLower(actor.Username), LowerName: repository.LowerName,
	})
	conflict := fmt.Sprintf("user '%s' already has a repository named '%s'", actor.Username, repository.Name)
	if err == nil {
		return db.Repository{}, errors.Conflict(conflict)
	}
	if !stderrors.Is(err, pgx.ErrNoRows) {
		return db.Repository{}, errors.Internal("failed to check destination repository").WithCause(err)
	}
	return s.transferRepoSerialized(ctx, repository, owner, repository.Name, repoTransferTarget{
		requestID: id, ownerName: actor.Username, userID: pgtype.Int8{Int64: actor.ID, Valid: true}, conflictMsg: conflict,
	})
}

// loadLockedTransfer expires requests using database time while the repository
// lock fences competing accept/decline/cancel and repository mutations.
func loadLockedTransfer(ctx context.Context, q repoTransferRequestTx, repositoryID, id int64) (db.RepositoryTransferRequest, error) {
	if err := q.ExpireRepositoryTransferRequests(ctx, repositoryID); err != nil {
		return db.RepositoryTransferRequest{}, errors.Internal("failed to expire repository transfers").WithCause(err)
	}
	request, err := q.GetRepositoryTransferRequest(ctx, id)
	if stderrors.Is(err, pgx.ErrNoRows) {
		return request, errors.NotFound("repository transfer not found")
	}
	if err != nil {
		return request, errors.Internal("failed to read repository transfer").WithCause(err)
	}
	if request.Status == "expired" {
		return request, errRepoTransferExpired
	}
	if request.Status != "pending" {
		return request, errors.Conflict("repository transfer is no longer pending")
	}
	return request, nil
}

func (s *RepoService) consumeRepoTransferRequest(ctx context.Context, tx repoOwnershipTx, repository db.Repository, target repoTransferTarget) error {
	q, err := transferRequestQueries(tx)
	if err != nil {
		return err
	}
	request, err := loadLockedTransfer(ctx, q, repository.ID, target.requestID)
	if err != nil {
		return err
	}
	if request.RepositoryID != repository.ID || request.RecipientID != target.userID.Int64 ||
		request.SourceUserID != repository.UserID || request.SourceOrgID != repository.OrgID || request.SourceName != repository.Name {
		return errors.Conflict("repository transfer source changed")
	}
	if err := transferSourceAuthorized(ctx, q, repository, request.SenderID); err != nil {
		return err
	}
	_, err = q.ResolveRepositoryTransferRequest(ctx, db.ResolveRepositoryTransferRequestParams{ID: request.ID, Status: "accepted"})
	return resolveTransferRequestError(err)
}

func resolveTransferRequestError(err error) error {
	if stderrors.Is(err, pgx.ErrNoRows) {
		return errors.Conflict("repository transfer is no longer pending")
	}
	if err != nil {
		return errors.Internal("failed to resolve repository transfer").WithCause(err)
	}
	return nil
}

func (s *RepoService) DeclineRepoTransfer(ctx context.Context, actor *db.User, id int64) error {
	return s.resolveRepoTransferRequest(ctx, actor, id, "declined")
}

func (s *RepoService) CancelRepoTransfer(ctx context.Context, actor *db.User, id int64) error {
	return s.resolveRepoTransferRequest(ctx, actor, id, "cancelled")
}

func (s *RepoService) resolveRepoTransferRequest(ctx context.Context, actor *db.User, id int64, status string) error {
	request, err := s.repoTransferRequestForActor(ctx, actor, id, status == "cancelled")
	if err != nil {
		return err
	}
	if s.ownershipTx == nil {
		return errors.Internal("repository transfers require transactional storage")
	}
	tx, err := s.ownershipTx.BeginOwnershipTx(ctx, request.RepositoryID)
	if err != nil {
		return errors.Internal("failed to resolve repository transfer").WithCause(err)
	}
	defer rollbackTransferRequest(ctx, tx)
	repository, err := tx.GetRepoByIDForUpdate(ctx, request.RepositoryID)
	if stderrors.Is(err, pgx.ErrNoRows) {
		return errors.NotFound("repository not found")
	}
	if err != nil {
		return errors.Internal("failed to read repository").WithCause(err)
	}
	q, err := transferRequestQueries(tx)
	if err != nil {
		return err
	}
	if status == "cancelled" {
		if err := transferSourceAuthorized(ctx, q, repository, actor.ID); err != nil {
			return err
		}
	}
	if _, err = loadLockedTransfer(ctx, q, request.RepositoryID, id); err != nil {
		if stderrors.Is(err, errRepoTransferExpired) {
			if commitErr := tx.Commit(ctx); commitErr != nil {
				return errors.Internal("failed to expire repository transfers").WithCause(commitErr)
			}
		}
		return err
	}
	_, err = q.ResolveRepositoryTransferRequest(ctx, db.ResolveRepositoryTransferRequestParams{ID: id, Status: status})
	if err := resolveTransferRequestError(err); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return errors.Internal("failed to resolve repository transfer").WithCause(err)
	}
	return nil
}
