package services

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Public TODO names select the same retained coding workspace both cards use.
// A review lane's internal bookmark is never the person's branch selector.
func branchWorkspaceByName(ctx context.Context, tx pgx.Tx, q *db.Queries, repository int64, name string) (db.Workspace, error) {
	row, err := q.GetBranchWorkspace(ctx, db.GetBranchWorkspaceParams{RepositoryID: repository, TargetBookmark: name})
	if !errors.Is(err, pgx.ErrNoRows) {
		return row, err
	}
	number, err := branchTodoNumber(ctx, tx, repository, name)
	if err != nil {
		return db.Workspace{}, err
	}
	item, err := q.GetMythicalItemByNumber(ctx, repository, number)
	if err != nil {
		return db.Workspace{}, err
	}
	return q.GetMythicalTodoBranchWorkspace(ctx, item)
}
