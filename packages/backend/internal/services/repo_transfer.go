package services

import (
	"context"
	stdErrors "errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// TransferRepo requests a transfer to a user, or immediately transfers to an organization.
//
// Only the direct repo owner (or org owner for org-owned repos) may initiate a
// transfer. Collaborator admins are explicitly denied. User requests leave
// ownership, grants, billing, and storage unchanged until the recipient accepts.
// Acceptance and production organization transfers serialize ownership, check
// destination limits, and journal the storage move with the ownership commit.
func (s *RepoService) TransferRepo(ctx context.Context, actor *db.User, owner, repo, newOwner string) (RepoTransferResult, error) {
	if actor == nil {
		return RepoTransferResult{}, errors.Unauthorized("authentication required")
	}

	newOwner = strings.TrimSpace(newOwner)
	if newOwner == "" {
		return RepoTransferResult{}, errors.ValidationFailed(errors.FieldError{
			Resource: "Repository",
			Field:    "new_owner",
			Code:     "missing_field",
		})
	}

	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return RepoTransferResult{}, err
	}
	canonicalOwner, err := s.canonicalRepositoryOwner(ctx, repository, owner)
	if err != nil {
		return RepoTransferResult{}, err
	}

	// Only the repo owner (not merely an admin collaborator) may transfer.
	allowed, err := s.canOwnRepo(ctx, repository, actor.ID)
	if err != nil {
		return RepoTransferResult{}, err
	}
	if !allowed {
		return RepoTransferResult{}, errors.Forbidden("permission denied")
	}

	// Don't allow transfer to the same owner.
	lowerNewOwner := strings.ToLower(newOwner)
	lowerCurrentOwner := strings.ToLower(canonicalOwner)
	if lowerNewOwner == lowerCurrentOwner {
		return RepoTransferResult{}, errors.ValidationFailed(errors.FieldError{
			Resource: "Repository",
			Field:    "new_owner",
			Code:     "invalid",
		})
	}

	// Resolve the new owner as a user first, then as an organization.
	var target repoTransferTarget

	targetUser, err := s.queries.GetUserByLowerUsername(ctx, lowerNewOwner)
	if err == nil {
		// Check if the target user already has a repo with the same name.
		_, dupErr := s.queries.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{
			Owner:     lowerNewOwner,
			LowerName: repository.LowerName,
		})
		if dupErr == nil {
			return RepoTransferResult{}, errors.Conflict(fmt.Sprintf("user '%s' already has a repository named '%s'", newOwner, repository.Name))
		}
		if !stdErrors.Is(dupErr, pgx.ErrNoRows) {
			return RepoTransferResult{}, errors.Internal("failed to check destination repository")
		}

		return s.createRepoTransferRequest(ctx, actor, repository, canonicalOwner, targetUser.ID)
	} else {
		if !stdErrors.Is(err, pgx.ErrNoRows) {
			return RepoTransferResult{}, errors.Internal("failed to resolve new owner")
		}
		// Try as an organization.
		targetOrg, orgErr := s.queries.GetOrgByLowerName(ctx, lowerNewOwner)
		if orgErr != nil {
			if stdErrors.Is(orgErr, pgx.ErrNoRows) {
				return RepoTransferResult{}, errors.NotFound(fmt.Sprintf("user or organization '%s' not found", newOwner))
			}
			return RepoTransferResult{}, errors.Internal("failed to resolve new owner").WithCause(orgErr)
		}

		// Verify the actor is an owner of the target organization.
		member, memErr := s.queries.GetOrgMember(ctx, db.GetOrgMemberParams{
			OrganizationID: targetOrg.ID,
			UserID:         actor.ID,
		})
		if memErr != nil {
			if stdErrors.Is(memErr, pgx.ErrNoRows) {
				return RepoTransferResult{}, errors.Forbidden("must be an owner of the target organization")
			}
			return RepoTransferResult{}, errors.Internal("failed to check organization membership").WithCause(memErr)
		}
		if strings.ToLower(strings.TrimSpace(member.Role)) != "owner" {
			return RepoTransferResult{}, errors.Forbidden("must be an owner of the target organization")
		}

		// Check if the target org already has a repo with the same name.
		_, dupErr := s.queries.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{
			Owner:     lowerNewOwner,
			LowerName: repository.LowerName,
		})
		if dupErr == nil {
			return RepoTransferResult{}, errors.Conflict(fmt.Sprintf("organization '%s' already has a repository named '%s'", newOwner, repository.Name))
		}
		if !stdErrors.Is(dupErr, pgx.ErrNoRows) {
			return RepoTransferResult{}, errors.Internal("failed to check destination repository")
		}

		// The recipient org must have private-repo entitlement to receive a private
		// repo; a transfer otherwise bypasses the target org's private-repo quota.
		if !repository.IsPublic && s.billing != nil {
			if err := s.billing.AuthorizePrivateRepo(ctx, BillingOwnerTypeOrg, targetOrg.ID); err != nil {
				return RepoTransferResult{}, err
			}
		}

		target = repoTransferTarget{
			ownerName:   targetOrg.Name,
			orgID:       pgtype.Int8{Int64: targetOrg.ID, Valid: true},
			conflictMsg: fmt.Sprintf("organization '%s' already has a repository named '%s'", newOwner, repository.Name),
		}
	}

	var updated db.Repository
	if s.ownershipTx != nil {
		updated, err = s.transferRepoSerialized(ctx, repository, canonicalOwner, repository.Name, target)
	} else {
		updated, err = s.transferRepoCompensating(ctx, repository, canonicalOwner, repository.Name, target)
	}
	return RepoTransferResult{Repository: updated, Owner: target.ownerName}, err
}

// repoTransferTarget captures the resolved destination of a repository
// transfer. Exactly one of userID/orgID is set; ownerName is the exact-case
// storage path segment of the new owner.
type repoTransferTarget struct {
	requestID   int64
	ownerName   string
	userID      pgtype.Int8
	orgID       pgtype.Int8
	conflictMsg string
}

func (target repoTransferTarget) billingOwner() (string, int64, bool) {
	if target.userID.Valid && !target.orgID.Valid && target.userID.Int64 > 0 {
		return BillingOwnerTypeUser, target.userID.Int64, true
	}
	if target.orgID.Valid && !target.userID.Valid && target.orgID.Int64 > 0 {
		return BillingOwnerTypeOrg, target.orgID.Int64, true
	}
	return "", 0, false
}

// applyTransfer performs the grant deletion and ownership update against q,
// mapping duplicate-name races to a Conflict error.
func (target repoTransferTarget) applyTransfer(ctx context.Context, q interface {
	DeleteCollaboratorsByRepo(ctx context.Context, repositoryID int64) error
	DeleteTeamReposByRepo(ctx context.Context, repositoryID int64) error
	TransferRepoToUser(ctx context.Context, arg db.TransferRepoToUserParams) (db.Repository, error)
	TransferRepoToOrg(ctx context.Context, arg db.TransferRepoToOrgParams) (db.Repository, error)
}, repositoryID int64) (db.Repository, error) {
	if err := q.DeleteCollaboratorsByRepo(ctx, repositoryID); err != nil {
		slog.Error("failed to delete collaborators during transfer", "repo_id", repositoryID, "error", err)
		return db.Repository{}, errors.Internal("failed to transfer repository").WithCause(err)
	}
	if err := q.DeleteTeamReposByRepo(ctx, repositoryID); err != nil {
		slog.Error("failed to delete team repos during transfer", "repo_id", repositoryID, "error", err)
		return db.Repository{}, errors.Internal("failed to transfer repository").WithCause(err)
	}

	var updated db.Repository
	var err error
	if target.userID.Valid {
		updated, err = q.TransferRepoToUser(ctx, db.TransferRepoToUserParams{
			NewUserID: target.userID,
			ID:        repositoryID,
		})
	} else {
		updated, err = q.TransferRepoToOrg(ctx, db.TransferRepoToOrgParams{
			NewOrgID: target.orgID,
			ID:       repositoryID,
		})
	}
	if err != nil {
		if isRepoUniqueViolation(err) {
			return db.Repository{}, errors.Conflict(target.conflictMsg)
		}
		slog.Error("failed to transfer repository", "repo_id", repositoryID, "new_owner", target.ownerName, "error", err)
		return db.Repository{}, errors.Internal("failed to transfer repository").WithCause(err)
	}
	return updated, nil
}

// transferRepoSerialized performs the transfer inside a per-repository
// advisory-locked transaction: concurrent transfers serialize, ownership is
// re-validated under the lock, and a storage-move failure rolls the grant
// deletion and ownership update back atomically.
func (s *RepoService) transferRepoSerialized(ctx context.Context, repository db.Repository, owner, repo string, target repoTransferTarget) (db.Repository, error) {
	stagedRepoHost, ok := s.repoHost.(repoHostStagedMoveClient)
	if !ok {
		slog.Error("repo-host client does not support staged repository moves", "repo_id", repository.ID)
		return db.Repository{}, errors.Internal("failed to transfer repository")
	}
	var prepared *repohost.StagedMove
	retainIntent := false
	moveAttempted := false
	if s.storageOperations != nil {
		preparedRepoHost, preparedOK := s.repoHost.(repoHostPreparedMoveClient)
		if !preparedOK {
			slog.Error("repo-host client cannot prepare durable repository move", "repo_id", repository.ID)
			return db.Repository{}, errors.Internal("failed to transfer repository")
		}
		staged, prepareErr := preparedRepoHost.PrepareStagedMove(ctx, owner, repository.Name, target.ownerName, repository.Name)
		if prepareErr != nil {
			slog.Error("failed to prepare repository move", "repo_id", repository.ID, "error", prepareErr)
			return db.Repository{}, errors.Internal("failed to transfer repository").WithCause(prepareErr)
		}
		createErr := s.storageOperations.Create(ctx, newMoveStorageOperation(repository, owner, target, staged))
		if createErr != nil {
			switch {
			case stdErrors.Is(createErr, errRepositoryStorageOperationExists):
				return db.Repository{}, errors.Conflict("repository storage operation is already in progress")
			case stdErrors.Is(createErr, errRepositoryStorageSourceChanged):
				return db.Repository{}, errors.Conflict("repository ownership changed concurrently")
			case stdErrors.Is(createErr, errRepositoryStorageTargetChanged):
				return db.Repository{}, errors.Conflict("repository transfer destination changed concurrently")
			default:
				slog.Error("failed to persist repository move intent", "repo_id", repository.ID, "error", createErr)
				return db.Repository{}, errors.Internal("failed to transfer repository").WithCause(createErr)
			}
		}
		prepared = &staged
		defer func() {
			if !retainIntent {
				if moveAttempted {
					s.settleRepoMoveIntent(ctx, repository, *prepared, stagedRepoHost, false)
				} else {
					// PrepareStagedMove only resolves placement and creates a token.
					// Nothing reached the storage host, so a failed/expired decision
					// must not depend on that host to release its database intent.
					cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), repoProvisionDBCleanupTimeout)
					defer cancel()
					if err := s.storageOperations.Complete(cleanup, repository.ID, prepared.Token); err != nil {
						slog.Error("failed to remove unexecuted repository move intent", "repo_id", repository.ID, "error", err)
					}
				}
			}
		}()
	}
	tx, err := s.ownershipTx.BeginOwnershipTx(ctx, repository.ID)
	if err != nil {
		slog.Error("failed to begin repository ownership transaction", "repo_id", repository.ID, "error", err)
		return db.Repository{}, errors.Internal("failed to transfer repository").WithCause(err)
	}
	committed := false
	rollbackParent := ctx
	defer func() {
		if !committed {
			rollbackCtx, cancel := context.WithTimeout(context.WithoutCancel(rollbackParent), repoProvisionDBCleanupTimeout)
			defer cancel()
			_ = tx.Rollback(rollbackCtx)
		}
	}()

	// Re-read under the advisory lock: the snapshot the caller authorized
	// against may have been invalidated by a concurrent transfer or delete.
	fresh, err := tx.GetRepoByIDForUpdate(ctx, repository.ID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.Repository{}, errors.NotFound("repository not found")
		}
		return db.Repository{}, errors.Internal("failed to transfer repository").WithCause(err)
	}
	if !repoOwnershipUnchanged(fresh, repository) {
		return db.Repository{}, errors.Conflict("repository ownership changed concurrently")
	}
	if target.requestID != 0 {
		if err := s.consumeRepoTransferRequest(ctx, tx, fresh, target); err != nil {
			if stdErrors.Is(err, errRepoTransferExpired) {
				if commitErr := tx.Commit(ctx); commitErr != nil {
					return db.Repository{}, errors.Internal("failed to expire repository transfers").WithCause(commitErr)
				}
				committed = true
			}
			return db.Repository{}, err
		}
		// Non-production policies may lack the transaction admission extension.
		if !fresh.IsPublic && s.billing != nil {
			if err := s.billing.AuthorizePrivateRepo(ctx, BillingOwnerTypeUser, target.userID.Int64); err != nil {
				return db.Repository{}, err
			}
		}
	}
	if prepared != nil {
		active, verifyErr := s.storageOperations.Verify(ctx, repository.ID, prepared.Token)
		if verifyErr != nil {
			slog.Error("failed to verify repository move intent", "repo_id", repository.ID, "error", verifyErr)
			return db.Repository{}, errors.Internal("failed to transfer repository").WithCause(verifyErr)
		}
		if !active {
			return db.Repository{}, errors.Conflict("repository storage operation changed concurrently")
		}
		if authorizeErr := tx.AuthorizeStorageOperation(ctx, prepared.Token); authorizeErr != nil {
			slog.Error("failed to authorize repository move transaction", "repo_id", repository.ID, "error", authorizeErr)
			return db.Repository{}, errors.Internal("failed to transfer repository").WithCause(authorizeErr)
		}
	}

	workCtx, cancelWork, err := beginRepoHostMutationConsistency(ctx, repoHostMutationConsistencyTimeout)
	if err != nil {
		return db.Repository{}, errors.Internal("failed to transfer repository").WithCause(err)
	}
	defer cancelWork()
	rollbackParent = workCtx

	var updated db.Repository
	var committedMove *repohost.StagedMove
	settleCommittedMove := func() {
		if committedMove == nil {
			return
		}
		s.settleRepoMoveIntent(workCtx, repository, *committedMove, stagedRepoHost, true)
		committedMove = nil
	}
	applyAndCommit := func(commitCtx context.Context) error {
		var commitErr error
		updated, commitErr = s.applyAndCommitRepoTransfer(commitCtx, repository, owner, repo, target, tx, stagedRepoHost, prepared, &committed, &retainIntent, &committedMove, &moveAttempted)
		return commitErr
	}
	if transaction, txOK := tx.(repoOwnershipDBTransaction); txOK {
		if authorizer, billingOK := s.billing.(RepositoryTransferTransactionAuthorizer); billingOK {
			targetOwnerType, targetOwnerID, valid := target.billingOwner()
			if !valid {
				return db.Repository{}, errors.Internal("failed to resolve repository transfer billing owner")
			}
			called := false
			err := authorizer.AuthorizeRepositoryTransferCommittedInTransaction(
				workCtx,
				transaction.OwnershipDBTX(),
				repository.ID,
				targetOwnerType,
				targetOwnerID,
				!fresh.IsPublic,
				func(commitCtx context.Context) error {
					if called {
						return errors.Internal("repository transfer commit called more than once")
					}
					called = true
					return applyAndCommit(commitCtx)
				},
			)
			// Repo-host finalization can take minutes. Run it only after the
			// admission callback has returned and released any target-owner
			// quota lock. This also settles an ownership COMMIT that succeeded
			// before the authorizer itself returned an error.
			settleCommittedMove()
			if err != nil {
				return db.Repository{}, err
			}
			if !called {
				return db.Repository{}, errors.Internal("repository transfer was not committed")
			}
			return updated, nil
		}
	}
	if authorizer, ok := s.billing.(RepositoryTransferCommitAuthorizer); ok {
		targetOwnerType, targetOwnerID, valid := target.billingOwner()
		if !valid {
			return db.Repository{}, errors.Internal("failed to resolve repository transfer billing owner")
		}
		called := false
		err := authorizer.AuthorizeRepositoryTransferCommitted(
			workCtx,
			repository.ID,
			targetOwnerType,
			targetOwnerID,
			!fresh.IsPublic,
			func(commitCtx context.Context) error {
				if called {
					return errors.Internal("repository transfer commit called more than once")
				}
				called = true
				return applyAndCommit(commitCtx)
			},
		)
		settleCommittedMove()
		if err != nil {
			return db.Repository{}, err
		}
		if !called {
			return db.Repository{}, errors.Internal("repository transfer was not committed")
		}
		return updated, nil
	}
	err = applyAndCommit(workCtx)
	settleCommittedMove()
	if err != nil {
		return db.Repository{}, err
	}
	return updated, nil
}

func (s *RepoService) applyAndCommitRepoTransfer(
	ctx context.Context,
	repository db.Repository,
	owner string,
	repo string,
	target repoTransferTarget,
	tx repoOwnershipTx,
	stagedRepoHost repoHostStagedMoveClient,
	prepared *repohost.StagedMove,
	committed *bool,
	retainIntent *bool,
	committedMove **repohost.StagedMove,
	moveAttempted *bool,
) (db.Repository, error) {
	removedCollaborators := s.collaboratorsOf(ctx, repository.ID)
	ownershipHolders := s.ownershipAccessHoldersOf(ctx, repository)
	updated, err := target.applyTransfer(ctx, tx, repository.ID)
	if err != nil {
		return db.Repository{}, err
	}
	transferred := updated
	defer func() {
		if committed != nil && *committed {
			s.publishCollaboratorsRemoved(ctx, repository.ID, removedCollaborators, 0, "repository transferred")
			s.publishAccessLost(ctx, transferred, ownershipHolders, "repository transferred")
		}
	}()

	// Journal and move storage while the DB lock is held. The client owns the
	// token before sending the request, so even a successful move whose response
	// is lost can be rolled back before this transaction rolls back.
	var staged repohost.StagedMove
	*moveAttempted = true
	if prepared != nil {
		staged = *prepared
		err = s.repoHost.(repoHostPreparedMoveClient).ExecuteStagedMove(ctx, staged)
	} else {
		staged, err = stagedRepoHost.StageMoveRepo(ctx, owner, repo, target.ownerName, repo)
	}
	if err != nil {
		slog.Error("failed to move repository storage during transfer", "repo_id", repository.ID, "new_owner", target.ownerName, "error", err)
		compensationCtx, cancelCompensation := repoHostCompensationContext(ctx)
		rollbackErr := rollbackStagedRepoMove(compensationCtx, staged, stagedRepoHost)
		cancelCompensation()
		if rollbackErr != nil {
			slog.Error("failed to roll back ambiguous repository storage move",
				"repo_id", repository.ID, "owner", owner, "new_owner", target.ownerName, "error", rollbackErr)
		}
		return db.Repository{}, errors.Internal("failed to move repository storage").WithCause(err)
	}

	if err := tx.Commit(ctx); err != nil {
		slog.Error("failed to commit repository transfer", "repo_id", repository.ID, "error", err)
		// COMMIT transport errors are ambiguous. Abort any still-live tx, then
		// reacquire the repository advisory lock before reading the stable id.
		// Only a current target/source owner is conclusive; any other state leaves
		// the journal untouched for explicit reconciliation.
		rollbackCtx, cancelRollback := context.WithTimeout(context.WithoutCancel(ctx), repoProvisionDBCleanupTimeout)
		_ = tx.Rollback(rollbackCtx)
		cancelRollback()
		reconcileCtx, cancelReconcile := repoHostCompensationContext(ctx)
		commitState, reconcileErr := s.repoTransferCommitStateLocked(reconcileCtx, repository, target)
		cancelReconcile()
		if reconcileErr == nil && commitState == repoTransferCommitApplied {
			*committed = true
			*retainIntent = true
			*committedMove = &staged
			return updated, nil
		}
		if reconcileErr != nil {
			slog.Error("failed to reconcile ambiguous repository transfer commit",
				"repo_id", repository.ID, "owner", owner, "new_owner", target.ownerName, "error", reconcileErr)
		}
		if commitState == repoTransferCommitUnknown {
			// Missing rows, third-party owners, and read failures do not prove
			// whether COMMIT applied. Leave both the journal and storage at the
			// staged destination so an operator/reconciler can make the decision
			// from durable state; guessing either completion would risk split-brain.
			*retainIntent = true
			return db.Repository{}, errors.Internal("failed to transfer repository")
		}
		compensationCtx, cancelCompensation := repoHostCompensationContext(ctx)
		moveBackErr := rollbackStagedRepoMove(compensationCtx, staged, stagedRepoHost)
		cancelCompensation()
		if moveBackErr != nil {
			slog.Error("failed to move repository storage back after commit failure",
				"repo_id", repository.ID, "owner", owner, "new_owner", target.ownerName, "error", moveBackErr)
		}
		return db.Repository{}, errors.Internal("failed to transfer repository").WithCause(err)
	}
	*committed = true
	*retainIntent = true
	*committedMove = &staged
	return updated, nil
}

type repoTransferCommitOutcome uint8

const (
	repoTransferCommitUnknown repoTransferCommitOutcome = iota
	repoTransferCommitNotApplied
	repoTransferCommitApplied
)

// repoTransferCommitStateLocked waits for the original transaction's
// repository advisory lock before classifying an ambiguous COMMIT. A pooled
// read without this lock can observe the source row while the server-side
// COMMIT is still finishing and incorrectly roll storage back moments before
// the ownership change becomes visible.
func (s *RepoService) repoTransferCommitStateLocked(ctx context.Context, repository db.Repository, target repoTransferTarget) (repoTransferCommitOutcome, error) {
	tx, err := s.ownershipTx.BeginOwnershipTx(ctx, repository.ID)
	if err != nil {
		return repoTransferCommitUnknown, err
	}
	defer func() {
		rollbackCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), repoProvisionDBCleanupTimeout)
		defer cancel()
		_ = tx.Rollback(rollbackCtx)
	}()

	visible, err := tx.GetRepoByIDForUpdate(ctx, repository.ID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return repoTransferCommitUnknown, nil
		}
		return repoTransferCommitUnknown, err
	}
	if visible.ID != repository.ID {
		return repoTransferCommitUnknown, nil
	}
	if visible.UserID == target.userID && visible.OrgID == target.orgID {
		return repoTransferCommitApplied, nil
	}
	if visible.UserID == repository.UserID && visible.OrgID == repository.OrgID {
		return repoTransferCommitNotApplied, nil
	}
	return repoTransferCommitUnknown, nil
}

func rollbackStagedRepoMove(ctx context.Context, staged repohost.StagedMove, repoHost repoHostStagedMoveClient) error {
	err := repoHost.RollbackStagedMove(ctx, staged)
	if err != nil {
		err = repoHost.RollbackStagedMove(ctx, staged)
	}
	return err
}

func (s *RepoService) finalizeRepoMove(ctx context.Context, repository db.Repository, staged repohost.StagedMove, repoHost repoHostStagedMoveClient) error {
	finalizeCtx, cancelFinalize := repoHostCompensationContext(ctx)
	defer cancelFinalize()
	err := repoHost.FinalizeStagedMove(finalizeCtx, staged)
	if err != nil {
		err = repoHost.FinalizeStagedMove(finalizeCtx, staged)
	}
	if err != nil {
		slog.Error("failed to finalize staged repository move",
			"repo_id", repository.ID, "repo_name", repository.Name, "error", err)
	}
	return err
}

func (s *RepoService) settleRepoMoveIntent(
	ctx context.Context,
	repository db.Repository,
	staged repohost.StagedMove,
	repoHost repoHostStagedMoveClient,
	finalize bool,
) {
	var actionErr error
	if finalize {
		actionErr = s.finalizeRepoMove(ctx, repository, staged, repoHost)
	} else {
		rollbackCtx, cancelRollback := repoHostCompensationContext(ctx)
		actionErr = rollbackStagedRepoMove(rollbackCtx, staged, repoHost)
		cancelRollback()
		if actionErr != nil {
			slog.Error("failed to roll back staged repository move",
				"repo_id", repository.ID, "repo_name", repository.Name, "error", actionErr)
		}
	}
	if actionErr != nil || s.storageOperations == nil {
		return
	}
	completeCtx, cancelComplete := context.WithTimeout(context.WithoutCancel(ctx), repoProvisionDBCleanupTimeout)
	defer cancelComplete()
	if err := s.storageOperations.Complete(completeCtx, repository.ID, staged.Token); err != nil {
		slog.Error("failed to complete repository move intent",
			"repo_id", repository.ID, "repo_name", repository.Name, "error", err)
	}
}

// transferRepoCompensating is the fallback transfer path used when no
// transaction manager is configured (e.g. unit tests without a pool). It
// mutates directly and compensates on storage-move failure: ownership is
// reverted to the original owner kind, and grants are restored only when the
// revert actually succeeded (otherwise the old grants would attach to the new
// owner's repository).
func (s *RepoService) transferRepoCompensating(ctx context.Context, repository db.Repository, owner, repo string, target repoTransferTarget) (db.Repository, error) {
	// Snapshot grants before we delete them so we can restore on failure.
	collaborators, err := s.queries.ListCollaboratorsByRepo(ctx, repository.ID)
	if err != nil {
		slog.Error("failed to snapshot collaborators before transfer", "repo_id", repository.ID, "error", err)
		return db.Repository{}, errors.Internal("failed to transfer repository").WithCause(err)
	}
	teamRepos, err := s.queries.ListTeamReposByRepo(ctx, repository.ID)
	if err != nil {
		slog.Error("failed to snapshot team repos before transfer", "repo_id", repository.ID, "error", err)
		return db.Repository{}, errors.Internal("failed to transfer repository").WithCause(err)
	}

	// restoreGrants re-inserts collaborator/team grants that were deleted.
	// Errors are logged but not returned — best-effort so we don't hide the root failure.
	restoreGrants := func(restoreCtx context.Context) {
		for _, c := range collaborators {
			if _, rerr := s.queries.AddCollaborator(restoreCtx, db.AddCollaboratorParams{
				RepositoryID: repository.ID,
				UserID:       c.UserID,
				Permission:   c.Permission,
			}); rerr != nil {
				slog.Error("failed to restore collaborator after transfer rollback",
					"repo_id", repository.ID, "user_id", c.UserID, "error", rerr)
			}
		}
		for _, tr := range teamRepos {
			if _, rerr := s.queries.AddTeamRepo(restoreCtx, db.AddTeamRepoParams{
				TeamID:       tr.TeamID,
				RepositoryID: repository.ID,
			}); rerr != nil {
				slog.Error("failed to restore team repo after transfer rollback",
					"repo_id", repository.ID, "team_id", tr.TeamID, "error", rerr)
			}
		}
	}

	workCtx, cancelWork, err := beginRepoHostMutationConsistency(ctx, repoHostMutationConsistencyTimeout)
	if err != nil {
		return db.Repository{}, errors.Internal("failed to transfer repository").WithCause(err)
	}
	defer cancelWork()

	removedCollaborators := s.collaboratorsOf(workCtx, repository.ID)
	ownershipHolders := s.ownershipAccessHoldersOf(workCtx, repository)
	updated, err := target.applyTransfer(workCtx, s.queries, repository.ID)
	if err != nil {
		compensationCtx, cancelCompensation := repoHostCompensationContext(workCtx)
		restoreGrants(compensationCtx)
		cancelCompensation()
		return db.Repository{}, err
	}
	s.publishCollaboratorsRemoved(workCtx, repository.ID, removedCollaborators, 0, "repository transferred")
	s.publishAccessLost(workCtx, updated, ownershipHolders, "repository transferred")

	// Move storage on repo-host; revert DB on failure.
	if err := s.repoHost.MoveRepo(workCtx, owner, repo, target.ownerName, repo); err != nil {
		slog.Error("failed to move repository storage during transfer", "repo_id", repository.ID, "new_owner", target.ownerName, "error", err)
		compensationCtx, cancelCompensation := repoHostCompensationContext(workCtx)
		defer cancelCompensation()
		// Compensate: revert DB ownership back to the original owner kind — an
		// org-owned repo must revert via TransferRepoToOrg (its user_id is NULL).
		var revertErr error
		if repository.OrgID.Valid {
			_, revertErr = s.queries.TransferRepoToOrg(compensationCtx, db.TransferRepoToOrgParams{
				NewOrgID: repository.OrgID,
				ID:       repository.ID,
			})
		} else {
			_, revertErr = s.queries.TransferRepoToUser(compensationCtx, db.TransferRepoToUserParams{
				NewUserID: repository.UserID,
				ID:        repository.ID,
			})
		}
		if revertErr != nil {
			// Ownership is still with the target: restoring the old grants now
			// would attach the previous owner's collaborators/teams to the new
			// owner's repository (a cross-tenant access leak), so skip it.
			slog.Error("failed to revert DB ownership after storage move failure", "repo_id", repository.ID, "error", revertErr)
			return db.Repository{}, errors.Internal("failed to move repository storage").WithCause(revertErr)
		}
		restoreGrants(compensationCtx)
		return db.Repository{}, errors.Internal("failed to move repository storage").WithCause(err)
	}

	return updated, nil
}
