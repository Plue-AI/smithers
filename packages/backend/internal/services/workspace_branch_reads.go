package services

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// BranchMachineResponse is a projection of the existing workspace, with no
// parallel branch or machine state store.
type BranchMachineResponse struct {
	Name    string            `json:"name"`
	State   string            `json:"state"`
	Machine WorkspaceResponse `json:"machine"`
}

func branchMachineState(row db.Workspace) string {
	switch row.Status {
	case "running":
		return "awake"
	case "suspended", "stopped":
		return "asleep"
	case "pending", "starting":
		if row.VmID != "" {
			return "waking"
		}
		return "provisioning"
	case "failed":
		return "failed"
	default:
		return "closed"
	}
}

func (s *WorkspaceService) ListBranches(ctx context.Context, repositoryID, userID int64, page, perPage int) ([]BranchMachineResponse, int64, error) {
	if err := s.requireBranchMachineProviders(); err != nil {
		return nil, 0, err
	}
	// List-all authority is a separate catalog decision; a branch-scoped run
	// never gains it by joining its own branch.
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	if err := s.branchMachineProviders.Membership(ctx, tx, repositoryID, userID); err != nil {
		return nil, 0, err
	}
	if err := s.branchMachineProviders.Authorize(ctx, tx, "branches.read", repositoryID, "", userID); err != nil {
		return nil, 0, err
	}
	rows, total, err := s.ListWorkspaces(ctx, repositoryID, userID, page, perPage)
	if err != nil {
		return nil, 0, err
	}
	result := make([]BranchMachineResponse, 0, len(rows))
	for _, row := range rows {
		full, err := s.q.GetWorkspace(ctx, row.ID)
		if err != nil {
			return nil, 0, err
		}
		result = append(result, BranchMachineResponse{Name: full.TargetBookmark, State: branchMachineState(full), Machine: row})
	}
	return result, total, nil
}

func (s *WorkspaceService) GetBranch(ctx context.Context, branch string, repositoryID, userID int64) (BranchMachineResponse, error) {
	if err := s.preflightBranchMachine(ctx, repositoryID, userID, branch, ""); err != nil {
		return BranchMachineResponse{}, err
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return BranchMachineResponse{}, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	row, err := db.New(tx).GetBranchWorkspace(ctx, db.GetBranchWorkspaceParams{RepositoryID: repositoryID, TargetBookmark: branch})
	if errors.Is(err, pgx.ErrNoRows) {
		return BranchMachineResponse{}, pkgerrors.NotFound("branch not found")
	}
	if err != nil {
		return BranchMachineResponse{}, err
	}
	projected, err := s.GetWorkspace(ctx, row.ID, repositoryID, userID)
	if err != nil {
		return BranchMachineResponse{}, err
	}
	return BranchMachineResponse{Name: row.TargetBookmark, State: branchMachineState(row), Machine: projected}, nil
}
