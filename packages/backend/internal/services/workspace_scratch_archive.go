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
	authorization, err := Authorize(ctx, db.New(tx), "branch.archive")
	if err != nil {
		return BranchMachineResponse{}, err
	}
	if authorization.UserID != userID {
		return BranchMachineResponse{}, pkgerrors.Forbidden("not a member of this install")
	}
	if err := s.branchMachineProviders.Membership(ctx, tx, repositoryID, userID); err != nil {
		return BranchMachineResponse{}, err
	}
	q := db.New(tx)
	var initial db.Workspace
	if _, parseErr := uuid.Parse(id); parseErr == nil {
		initial, err = q.GetWorkspaceByRepo(ctx, db.GetWorkspaceByRepoParams{ID: id, RepositoryID: repositoryID})
	} else {
		initial, err = q.GetBranchWorkspace(ctx, db.GetBranchWorkspaceParams{RepositoryID: repositoryID, TargetBookmark: id})
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return BranchMachineResponse{}, pkgerrors.NotFound("branch not found")
	}
	if err != nil {
		return BranchMachineResponse{}, err
	}
	id = initial.ID
	unlock := s.lockRuntimeWorkspace(id)
	defer unlock()
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
