package services

import (
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Only the runtime queue may attest the effective payload and consumption.
// An edited activity entry must not change feedback replayed by Retry before
// the runtime's atomic replace-if-pending receipt commits.
func (s *MythicalService) projectTodoSteerReceipt(ctx context.Context, update flowdispatch.ProjectionUpdate) error {
	var projection struct {
		ItemID  string `json:"itemId"`
		Input   string `json:"input"`
		Version int64  `json:"inputVersion"`
		RunID   string `json:"runId"`
		Attempt int32  `json:"attempt"`
	}
	receipt := update.Checkpoint.MutationReceipt
	if receipt == nil || receipt.InputBody == nil || json.Unmarshal(update.Checkpoint.Projection, &projection) != nil || projection.Version < 1 {
		return nil
	}
	id, err := uuid.Parse(projection.ItemID)
	if err != nil {
		return err
	}
	return pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		q := db.New(tx)
		item, err := q.GetMythicalItem(ctx, pgtype.UUID{Bytes: id, Valid: true})
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `SELECT 1 FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, item.RepositoryID); err != nil {
			return err
		}
		item, err = q.GetMythicalItem(ctx, item.ID)
		if err != nil {
			return err
		}
		if item.Attempt != projection.Attempt || item.RequestRunID != projection.RunID || update.Checkpoint.RunID != projection.RunID {
			return nil
		}
		checks := mythicalChecksOf(item)
		for i, input := range checks.Steers {
			if input.ID == projection.Input && input.InputVersion == projection.Version {
				checks.Steers[i].Text = *receipt.InputBody
				checks.Steers[i].InputConsumed = receipt.InputConsumed
				item.Checks = checks.encode()
				_, err = q.SaveMythicalItem(ctx, item)
				return err
			}
		}
		return nil
	})
}
