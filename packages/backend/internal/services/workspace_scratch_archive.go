package services

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// ArchiveScratchBranch is a member decision, not runtime destruction. It
// persists the retention origin even while a terminal pins the disk. Repeated
// requests preserve the first committed time and never shorten retention.
func (s *WorkspaceService) ArchiveScratchBranch(ctx context.Context, id string, repositoryID, userID int64) (BranchMachineResponse, error) {
	if err := s.requireBranchMachineProviders(); err != nil {
		return BranchMachineResponse{}, err
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return BranchMachineResponse{}, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	if err := guardInstallMemberCredential(ctx, tx, repositoryID, userID, false); err != nil {
		return BranchMachineResponse{}, err
	}
	q := db.New(tx)
	subject, initial, lookup := InstallScratchArchiveSubject(ctx, q, repositoryID, id)
	authorization, err := Authorize(ctx, q, "branch.archive", subject)
	if err != nil {
		return BranchMachineResponse{}, err
	}
	if lookup != nil {
		return BranchMachineResponse{}, lookup
	}
	if authorization.UserID != userID {
		return BranchMachineResponse{}, confirmationPermission()
	}
	ctx = WithInstallAuthorization(ctx, "branch.archive", authorization, subject)
	if err := s.branchMachineProviders.Membership(ctx, tx, repositoryID, userID); err != nil {
		return BranchMachineResponse{}, err
	}
	if err := tx.Rollback(ctx); err != nil {
		return BranchMachineResponse{}, err
	}
	id = initial.ID
	unlock := s.lockRuntimeWorkspace(id)
	defer unlock()
	tx, err = s.transactions.Begin(ctx)
	if err != nil {
		return BranchMachineResponse{}, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	authorization, err = Authorize(ctx, db.New(tx), "branch.archive", subject)
	if err != nil {
		return BranchMachineResponse{}, err
	}
	if authorization.UserID != userID {
		return BranchMachineResponse{}, pkgerrors.Forbidden("not a member of this install")
	}
	if err := guardInstallMemberCredential(ctx, tx, repositoryID, userID, false); err != nil {
		return BranchMachineResponse{}, err
	}
	if err := s.branchMachineProviders.Membership(ctx, tx, repositoryID, userID); err != nil {
		return BranchMachineResponse{}, err
	}
	q = db.New(tx)
	var locked string
	err = tx.QueryRow(ctx, `SELECT id::text FROM workspaces WHERE id=$1 AND repository_id=$2 AND deleted_at IS NULL FOR UPDATE`, id, repositoryID).Scan(&locked)
	if errors.Is(err, pgx.ErrNoRows) {
		return BranchMachineResponse{}, pkgerrors.NotFound("branch not found")
	}
	if err != nil {
		return BranchMachineResponse{}, err
	}
	row, err := q.GetWorkspace(ctx, id)
	if err != nil {
		return BranchMachineResponse{}, err
	}
	if _, err := Authorize(ctx, q, "branch.archive", scratchArchiveSubject(row)); err != nil {
		return BranchMachineResponse{}, err
	}
	owner, err := q.GetBranchMachineOwner(ctx)
	if err != nil {
		return BranchMachineResponse{}, err
	}
	if row.UserID != owner || branchKind(row.TargetBookmark) != "scratch" {
		return BranchMachineResponse{}, pkgerrors.Conflict("only a scratch branch can be archived")
	}
	if !row.BranchArchivedAt.Valid {
		if _, err := tx.Exec(ctx, `UPDATE workspaces SET branch_archived_at=$2,updated_at=$2 WHERE id=$1`, id, time.Now().UTC()); err != nil {
			return BranchMachineResponse{}, err
		}
		row, err = q.GetWorkspace(ctx, id)
		if err != nil {
			return BranchMachineResponse{}, err
		}
	}
	projected, err := s.projectBranch(ctx, tx, q, row, s.toWorkspaceResponse(row))
	if err != nil {
		return BranchMachineResponse{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return BranchMachineResponse{}, err
	}
	return projected, nil
}

// InstallScratchArchiveSubject resolves either branch selector before the one
// command decision. Retention time is omitted so repeats remain idempotent.
func InstallScratchArchiveSubject(ctx context.Context, q *db.Queries, repository int64, selector string) (InstallSubject, db.Workspace, error) {
	var row db.Workspace
	var err error
	if _, parseErr := uuid.Parse(selector); parseErr == nil {
		row, err = q.GetWorkspaceByRepo(ctx, db.GetWorkspaceByRepoParams{ID: selector, RepositoryID: repository})
	} else {
		row, err = q.GetBranchWorkspace(ctx, db.GetBranchWorkspaceParams{RepositoryID: repository, TargetBookmark: selector})
	}
	if errors.Is(err, pgx.ErrNoRows) {
		err = pkgerrors.NotFound("branch not found")
	}
	if err != nil {
		return InstallSubject{RepositoryID: repository}, row, err
	}
	return scratchArchiveSubject(row), row, nil
}

func scratchArchiveSubject(row db.Workspace) InstallSubject {
	return InstallSubject{RepositoryID: row.RepositoryID, WorkspaceID: row.ID, Source: row.TargetBookmark, Resource: "archive"}
}
