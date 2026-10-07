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
	scope := FlowLiveScope(repository)
	// Serialize the projection before assigning its cursor, including TODO
	// candidate changes that race with activation of main.
	if _, err := tx.Exec(ctx, `INSERT INTO product_job_streams(tenant_id,principal_id,head) VALUES($1,$2,0) ON CONFLICT DO NOTHING`, scope.TenantID, scope.PrincipalID); err != nil {
		return err
	}
	var head int64
	if err := tx.QueryRow(ctx, `SELECT head FROM product_job_streams WHERE tenant_id=$1 AND principal_id=$2 FOR UPDATE`, scope.TenantID, scope.PrincipalID).Scan(&head); err != nil {
		return err
	}
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
	var unchanged bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM product_job_events WHERE tenant_id=$1 AND principal_id=$2 AND sequence=$3 AND data=$4::jsonb)`, scope.TenantID, scope.PrincipalID, head, projection).Scan(&unchanged); err != nil {
		return err
	}
	if unchanged {
		return nil
	}
	_, err = jobs.RecordFactInTx(ctx, tx, FlowLiveScope(repository), uuid.NewString(), "flows.changed", "completed", projection)
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

// recordTodoFlowFact publishes proposed versions in the candidate's transaction.
// Keep the TODO source contract unchanged until its own provider adds projections.
func (s *MythicalService) recordTodoFlowFact(ctx context.Context, tx pgx.Tx, item db.MythicalItem, operation, kind, state string, raw json.RawMessage) (jobs.Event, error) {
	event, err := jobs.RecordFactInTx(ctx, tx, todoOperationScope(item), operation, kind, state, raw)
	if err != nil {
		return jobs.Event{}, err
	}
	if err := s.recordFlowFact(ctx, tx, item.RepositoryID); err != nil {
		return jobs.Event{}, err
	}
	return event, nil
}
