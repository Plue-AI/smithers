package services

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// recordTodoTransitionFact snapshots the card in the transition transaction.
// A crash cannot leave a committed transition without its replayable fact.
func (s *MythicalService) recordTodoTransitionFact(ctx context.Context, tx pgx.Tx, item db.MythicalItem, operation, kind, state string, raw json.RawMessage) (jobs.Event, error) {
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
	fact["card"], err = json.Marshal(card)
	if err != nil {
		return jobs.Event{}, err
	}
	data, err := json.Marshal(fact)
	if err != nil {
		return jobs.Event{}, err
	}
	return jobs.RecordFactInTx(ctx, tx, todoOperationScope(item), operation, kind, state, data)
}
