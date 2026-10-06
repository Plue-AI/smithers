package jobs

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
)

// RepositoryTodosScope is source ordering across the existing TODO streams.
func RepositoryTodosScope(tenant string) Scope {
	return Scope{TenantID: tenant, PrincipalID: "repository:todos"}
}

func (store *Store) ReplayRepositoryTodos(ctx context.Context, tenant string, cursor int64, limit int) (ReplayPage, error) {
	scope := RepositoryTodosScope(tenant)
	if err := scope.validate(); err != nil {
		return ReplayPage{}, err
	}
	if cursor < 0 {
		return ReplayPage{}, errors.New("jobs: cursor cannot be negative")
	}
	if limit <= 0 || limit > maxReplayPage {
		limit = maxReplayPage
	}
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly, IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return ReplayPage{}, err
	}
	defer rollback(tx)
	var head, floor int64
	err = tx.QueryRow(ctx, `SELECT head,retention_floor FROM product_job_streams WHERE tenant_id=$1 AND principal_id=$2`, scope.TenantID, scope.PrincipalID).Scan(&head, &floor)
	if errors.Is(err, pgx.ErrNoRows) {
		head, floor, err = 0, 1, nil
	}
	if err != nil {
		return ReplayPage{}, err
	}
	if cursor < floor-1 {
		return ReplayPage{}, &CursorExpiredError{Cursor: cursor, Floor: floor, Head: head}
	}
	if cursor > head {
		return ReplayPage{}, ErrCursorAhead
	}
	rows, err := tx.Query(ctx, `SELECT tenant_id,principal_id,sequence,repository_sequence,event_id,operation_id,event_type,state,data,recorded_at FROM product_job_events WHERE tenant_id=$1 AND repository_sequence>$2 AND repository_sequence<=$3 ORDER BY repository_sequence LIMIT $4`, tenant, cursor, head, limit)
	if err != nil {
		return ReplayPage{}, err
	}
	page := ReplayPage{Cursor: cursor, Head: head}
	for rows.Next() {
		var event Event
		if err := rows.Scan(&event.Scope.TenantID, &event.Scope.PrincipalID, &event.Sequence, &event.RepositorySequence, &event.EventID, &event.OperationID, &event.Type, &event.State, &event.Data, &event.RecordedAt); err != nil {
			rows.Close()
			return ReplayPage{}, err
		}
		page.Events = append(page.Events, event)
		page.Cursor = event.RepositorySequence
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return ReplayPage{}, err
	}
	if len(page.Events) == 0 {
		page.Cursor = head
	}
	page.More = page.Cursor < head
	if err := tx.Commit(ctx); err != nil {
		return ReplayPage{}, err
	}
	return page, nil
}
