package services

import (
	"context"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/workspace"
)

func CodingMachineSpec(ctx context.Context, q *db.Queries, id string, repository int64, revision string) (workspace.WorkspaceSpec, error) {
	row, err := q.GetRepoOwnerSlugAndNameByID(ctx, repository)
	if err != nil {
		return workspace.WorkspaceSpec{}, err
	}
	if row.OwnerSlug == "" || row.RepoName == "" {
		return workspace.WorkspaceSpec{}, fmt.Errorf("coding machine repository unavailable")
	}
	return workspace.CodingMachineSpec(id, row.OwnerSlug+"/"+row.RepoName, revision), nil
}
