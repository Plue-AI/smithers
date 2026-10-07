package services

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// recordTodoFact binds the existing card builder to the same transaction as
// its source fact. Replay must never substitute today's card for yesterday's
// transition. This adds no projection table, writer or transport cursor.
func (s *MythicalService) recordTodoFact(ctx context.Context, tx pgx.Tx, item db.MythicalItem, operation, kind, state string, raw json.RawMessage) (jobs.Event, error) {
	// Serialize the aggregate read before assigning the repository source position.
	if _, err := tx.Exec(ctx, `INSERT INTO product_job_streams(tenant_id,principal_id,head) VALUES($1,'repository:todos',0) ON CONFLICT DO NOTHING`, todoOperationScope(item).TenantID); err != nil {
		return jobs.Event{}, err
	}
	var sourceHead int64
	if err := tx.QueryRow(ctx, `SELECT head FROM product_job_streams WHERE tenant_id=$1 AND principal_id='repository:todos' FOR UPDATE`, todoOperationScope(item).TenantID).Scan(&sourceHead); err != nil {
		return jobs.Event{}, err
	}
	view := *s
	view.store = tx
	card, err := view.todoCard(ctx, item, nil)
	if err != nil {
		return jobs.Event{}, err
	}
	if card["state"] != state {
		return jobs.Event{}, fmt.Errorf("TODO source state differs from its card")
	}
	var fact map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fact); err != nil {
		return jobs.Event{}, err
	}
	projected, err := json.Marshal(card)
	if err != nil {
		return jobs.Event{}, err
	}
	fact["card"] = projected
	cards, err := view.Todos(ctx, item.RepositoryID)
	if err != nil {
		return jobs.Event{}, err
	}
	normalized, err := json.Marshal(cards)
	if err != nil {
		return jobs.Event{}, err
	}
	if err := json.Unmarshal(normalized, &cards); err != nil {
		return jobs.Event{}, err
	}
	home := HomeModel("", cards, nil)
	// Main health, capacity and member controls keep their existing providers.
	projection, err := json.Marshal(map[string]any{"items": home["items"], "counts": home["counts"]})
	if err != nil {
		return jobs.Event{}, err
	}
	fact["home"] = projection
	data, err := json.Marshal(fact)
	if err != nil {
		return jobs.Event{}, err
	}
	event, err := jobs.RecordProjectedFactInTx(ctx, tx, todoOperationScope(item), operation, kind, state, raw, data)
	if err != nil {
		return jobs.Event{}, err
	}
	if err := s.recordFlowFact(ctx, tx, item.RepositoryID); err != nil {
		return jobs.Event{}, err
	}
	return event, nil
}
