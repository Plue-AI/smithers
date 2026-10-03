package services

import (
	"context"
	"errors"
	"strconv"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// Item returns one item, named by its id, its TODO (T12) or its issue's
// number, as the snapshot shows it. The snapshot lists a bounded number of items, settled
// ones last; a watcher reads one item here however many the stack holds.
func (s *MythicalService) Item(ctx context.Context, repositoryID int64, ref string) (MythicalItemView, error) {
	q := s.queries()
	var item db.MythicalItem
	var err error
	if id, parseErr := uuid.Parse(ref); parseErr == nil {
		item, err = q.GetMythicalItem(ctx, pgtype.UUID{Bytes: id, Valid: true})
		if err == nil && item.RepositoryID != repositoryID {
			err = pgx.ErrNoRows
		}
	} else if number, parseErr := strconv.ParseInt(ref, 10, 64); parseErr == nil && number > 0 {
		item, err = q.GetMythicalItemByIssue(ctx, repositoryID, number)
	} else if number, ok := todoRef(ref); ok {
		item, err = q.GetMythicalItemByTodo(ctx, repositoryID, number)
	} else {
		return MythicalItemView{}, pkgerrors.BadRequest("item must be an item id, a TODO (T12) or an issue number")
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return MythicalItemView{}, pkgerrors.NotFound("item not found")
	}
	if err != nil {
		return MythicalItemView{}, err
	}
	costs, err := q.MythicalItemCosts(ctx, repositoryID, []pgtype.UUID{item.ID})
	if err != nil {
		return MythicalItemView{}, err
	}
	view, err := s.itemView(ctx, item)
	if err != nil {
		return MythicalItemView{}, err
	}
	view.CostNanos = costs[item.ID.Bytes]
	return view, nil
}
