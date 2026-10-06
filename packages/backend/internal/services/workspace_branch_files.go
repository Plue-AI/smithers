package services

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// Branch files reuse the workspace facets and their credential, confinement and
// snapshot checks. The install resolves the repository, never a request body.
func (s *WorkspaceService) branchFileWorkspace(ctx context.Context, branch string, repositoryID, userID int64) (db.Workspace, error) {
	if _, err := uuid.Parse(branch); err == nil {
		return s.loadWorkspaceWithAccess(ctx, branch, repositoryID, userID, WorkspaceAccessRead)
	}
	lookup, ok := s.q.(interface {
		GetBranchWorkspace(context.Context, db.GetBranchWorkspaceParams) (db.Workspace, error)
	})
	if !ok {
		return db.Workspace{}, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "branch store unavailable")
	}
	row, err := lookup.GetBranchWorkspace(ctx, db.GetBranchWorkspaceParams{RepositoryID: repositoryID, TargetBookmark: branch})
	if errors.Is(err, pgx.ErrNoRows) {
		return row, pkgerrors.NotFound("branch not found")
	}
	return row, err
}

func (s *WorkspaceService) ListBranchFiles(ctx context.Context, branch string, repositoryID, userID int64, filePath string) ([]WorkspaceFileEntry, error) {
	row, err := s.branchFileWorkspace(ctx, branch, repositoryID, userID)
	if err != nil {
		return nil, err
	}
	return s.ListWorkspaceFiles(ctx, row.ID, repositoryID, userID, filePath)
}

// A read does not depend on guest-entry, admission or session-identity gates.
// Membership and the authoritative branch binding still hold in one transaction.
func (s *WorkspaceService) authorizeBranchFileRead(ctx context.Context, row db.Workspace, userID int64) error {
	if err := s.requireBranchMachineProviders(); err != nil {
		return err
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	p := s.branchMachineProviders
	if err := p.Membership(ctx, tx, row.RepositoryID, userID); err != nil {
		return err
	}
	if err := p.Authorize(ctx, tx, "branch.read", row.RepositoryID, row.TargetBookmark, userID); err != nil {
		return err
	}
	return p.LaneBinding(ctx, tx, row.RepositoryID, row.TargetBookmark, row.ID)
}

// PresenceBranch resolves a branch under the same membership, lane and branch
// authorizer as file reads. Presence metadata never opens a guest file or wakes it.
func (s *WorkspaceService) PresenceBranch(ctx context.Context, branch string, repositoryID, userID int64) (db.Workspace, error) {
	row, err := s.branchFileWorkspace(ctx, branch, repositoryID, userID)
	if err != nil {
		return row, err
	}
	return row, s.authorizeBranchFileRead(ctx, row, userID)
}
