package services

import (
	"context"
	"encoding/json"
	"strconv"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// FlowLiveScope uses the existing durable source allocator and retention.
func FlowLiveScope(repository int64) jobs.Scope {
	return jobs.Scope{TenantID: strconv.FormatInt(repository, 10), PrincipalID: "repository:flows"}
}

// The source row and its projection commit together. Replay reads the version
// people saw at that cursor, never a reconstruction from today's Active row.
func (s *MythicalService) recordFlowFact(ctx context.Context, tx pgx.Tx, repository int64) error {
	view := *s
	view.store = tx
	cards, err := RepositoryFlowCatalog(ctx, db.New(tx), repository, &view)
	if err != nil {
		return err
	}
	projection, err := json.Marshal(map[string]any{"card": cards})
	if err != nil {
		return err
	}
	_, err = jobs.RecordProjectedFactInTx(ctx, tx, FlowLiveScope(repository), uuid.NewString(), "flows.changed", "completed", json.RawMessage(`{}`), projection)
	return err
}

func (s *MythicalService) saveFlowLoadFact(ctx context.Context, next db.FlowLoad) (db.FlowLoad, error) {
	tx, err := s.store.Begin(ctx)
	if err != nil {
		return db.FlowLoad{}, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	saved, err := db.New(tx).SaveFlowLoad(ctx, next)
	if err != nil {
		return db.FlowLoad{}, err
	}
	if err := s.recordFlowFact(ctx, tx, next.RepositoryID); err != nil {
		return db.FlowLoad{}, err
	}
	return saved, tx.Commit(ctx)
}
