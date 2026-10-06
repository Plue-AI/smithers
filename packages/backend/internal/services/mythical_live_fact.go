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
	data, err := json.Marshal(fact)
	if err != nil {
		return jobs.Event{}, err
	}
	return jobs.RecordProjectedFactInTx(ctx, tx, todoOperationScope(item), operation, kind, state, raw, data)
}
