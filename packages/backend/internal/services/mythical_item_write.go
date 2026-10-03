package services

import (
	"context"
	"errors"
	"strconv"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// Every write of a mythical_items row goes through these four methods, and
// nothing else calls the item's writes (TestMythicalItemWritesGoThroughTheTodoProjection):
// the item and its TODO change in one transaction (spec §4.1.0, §10.1), so
// todos.state never drifts from the engine's work record.

// saveItem writes item (conditional on its version) and projects its TODO in
// one transaction. A concurrent writer of either answers pgx.ErrNoRows.
func (s *MythicalService) saveItem(ctx context.Context, item db.MythicalItem) (db.MythicalItem, error) {
	var saved db.MythicalItem
	err := pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		var err error
		saved, err = s.saveItemIn(ctx, tx, item)
		return err
	})
	return saved, err
}

// saveItemIn is saveItem inside the caller's transaction, for a write that
// commits with other rows (a launch's admission).
func (s *MythicalService) saveItemIn(ctx context.Context, tx pgx.Tx, item db.MythicalItem) (db.MythicalItem, error) {
	before, saved, err := s.saveItemRowIn(ctx, tx, item)
	if err != nil {
		return db.MythicalItem{}, err
	}
	return s.todos.projectItem(ctx, tx, &before, saved)
}

// saveItemRowIn saves engine facts before admission or activity publication.
// Its caller must projectItem before committing the same transaction.
func (s *MythicalService) saveItemRowIn(ctx context.Context, tx pgx.Tx, item db.MythicalItem) (db.MythicalItem, db.MythicalItem, error) {
	q := db.New(tx)
	before, err := q.GetMythicalItem(ctx, item.ID)
	if err != nil {
		return db.MythicalItem{}, db.MythicalItem{}, err
	}
	saved, err := q.SaveMythicalItem(ctx, item)
	return before, saved, err
}

// cancelRunIn records cancellation for every unsettled launch bound to the
// item, in the caller's transaction. A parked run can outlive its item phase
// or generation; neither is a reliable test for whether work remains.
// The dispatcher delivers cancellation to the canonical runtime afterward.
func (s *MythicalService) cancelRunIn(ctx context.Context, tx pgx.Tx, item db.MythicalItem) error {
	if s.launcher == nil {
		return nil
	}
	tenant := "repository:" + strconv.FormatInt(item.RepositoryID, 10)
	rows, err := tx.Query(ctx, `SELECT principal_id, request_id FROM product_job_requests
		WHERE tenant_id = $1 AND operation = $2
		AND state IN ('accepted', 'dispatching', 'running', 'waiting')
		AND payload->'projection'->>'kind' = $3
		AND payload->'projection'->>'itemId' = $4
		ORDER BY id`, tenant, flowdispatch.OperationLaunch, mythicalBindingKind, uuidString(item.ID))
	if err != nil {
		return err
	}
	type launch struct{ principal, request string }
	var pending []launch
	for rows.Next() {
		var l launch
		if err := rows.Scan(&l.principal, &l.request); err != nil {
			rows.Close()
			return err
		}
		pending = append(pending, l)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, l := range pending {
		_, err := s.launcher.CancelRequestInTx(ctx, tx, jobs.Scope{TenantID: tenant, PrincipalID: l.principal}, l.request)
		if err != nil && !errors.Is(err, jobs.ErrNotFound) {
			return err
		}
	}
	return nil
}

// insertIssueItem creates an issue's item and, once admitted, its TODO.
func (s *MythicalService) insertIssueItem(ctx context.Context, item db.MythicalItem) (db.MythicalItem, bool, error) {
	return s.insertItem(ctx, func(q *db.Queries) (db.MythicalItem, bool, error) { return q.InsertMythicalItem(ctx, item) })
}

// insertChatItem records a chat result's item and its TODO.
func (s *MythicalService) insertChatItem(ctx context.Context, item db.MythicalItem) (db.MythicalItem, bool, error) {
	return s.insertItem(ctx, func(q *db.Queries) (db.MythicalItem, bool, error) { return q.InsertMythicalChatItem(ctx, item) })
}

func (s *MythicalService) insertItem(ctx context.Context, insert func(*db.Queries) (db.MythicalItem, bool, error)) (db.MythicalItem, bool, error) {
	var created db.MythicalItem
	var inserted bool
	err := pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		var err error
		if created, inserted, err = insert(db.New(tx)); err != nil || !inserted {
			return err
		}
		created, err = s.todos.projectItem(ctx, tx, nil, created)
		return err
	})
	return created, inserted, err
}
