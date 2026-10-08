package flowhost

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// RetirementStopper stops the exact managed service identified by the durable
// binding, including after its product workspace/repository row has gone. It
// must confirm the process is stopped or absent; a missing product row alone
// is not proof. Implementations use the same WorkspaceRuntime adapter as launch.
type RetirementStopper interface {
	StopFlowHost(context.Context, Binding) error
}

// PrepareWorkspaceCapture stops settled hosts before the workspace writer
// fence checks for live children. It uses the same binding lock and pinned-run
// predicate as host upgrades; an active or unobservable run prevents capture.
func (store *Store) PrepareWorkspaceCapture(ctx context.Context, workspace string, stopper RetirementStopper, active ActiveRuns) error {
	if store == nil || store.pool == nil || stopper == nil || active == nil || workspace == "" {
		return errors.New("flow host capture requires binding, stopper and pinned-run authority")
	}
	rows, err := store.pool.Query(ctx, `SELECT id::text,catalog_key FROM flow_runtime_host_bindings WHERE workspace_id=$1 AND state<>'retired' ORDER BY id`, workspace)
	if err != nil {
		return err
	}
	type candidate struct{ id, catalog string }
	var pending []candidate
	for rows.Next() {
		var item candidate
		if err := rows.Scan(&item.id, &item.catalog); err != nil {
			rows.Close()
			return err
		}
		pending = append(pending, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, item := range pending {
		if err := store.prepareHostCapture(ctx, workspace, item.id, item.catalog, stopper, active); err != nil {
			return err
		}
	}
	return nil
}

func (store *Store) prepareHostCapture(ctx context.Context, workspace, id, catalog string, stopper RetirementStopper, active ActiveRuns) error {
	connection, err := store.pool.Acquire(ctx)
	if err != nil {
		return err
	}
	key := bindingLockKey(Authority{WorkspaceID: workspace}, Catalog{Key: catalog})
	if _, err := connection.Exec(ctx, `SELECT pg_advisory_lock(hashtextextended($1,0))`, key); err != nil {
		closeLockedConnection(connection)
		return err
	}
	held := &lease{store: store, connection: connection, lockKey: key}
	defer held.Close()
	binding, _, _, err := scanBinding(connection.QueryRow(ctx, bindingSelect+` WHERE id=$1 AND state<>'retired'`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	busy, err := active.ActiveFlowRuns(ctx, binding)
	if err != nil {
		return err
	}
	if busy {
		return errors.New("active flow run blocks final capture")
	}
	return stopper.StopFlowHost(ctx, binding)
}

// ReconcileRetired is a bounded reconciliation pass for the application's
// existing maintenance lifecycle. It starts no worker. Parent deletion leaves
// these records transactionally; retries retain their identity until the
// adapter confirms stop. It serializes with in-flight host launch/inspection.
func (store *Store) ReconcileRetired(ctx context.Context, stopper RetirementStopper, limit int) error {
	if store == nil || store.pool == nil || stopper == nil || limit <= 0 || limit > 1000 {
		return errors.New("flow host retirement requires store, stopper, and a bounded limit")
	}
	rows, err := store.pool.Query(ctx, `SELECT id::text, workspace_id::text, catalog_key
  FROM flow_runtime_host_bindings WHERE state='retired' ORDER BY updated_at, id LIMIT $1`, limit)
	if err != nil {
		return err
	}
	type candidate struct{ id, workspace, catalog string }
	var pending []candidate
	for rows.Next() {
		var item candidate
		if err := rows.Scan(&item.id, &item.workspace, &item.catalog); err != nil {
			rows.Close()
			return err
		}
		pending = append(pending, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	var failures []error
	for _, item := range pending {
		if ctx.Err() != nil {
			return errors.Join(append(failures, ctx.Err())...)
		}
		err := store.retireOne(ctx, stopper, item.id, item.workspace, item.catalog)
		if err != nil {
			failures = append(failures, fmt.Errorf("retire flow host %s: %w", item.id, err))
		}
	}
	return errors.Join(failures...)
}

func (store *Store) retireOne(ctx context.Context, stopper RetirementStopper, id, workspace, catalog string) error {
	connection, err := store.pool.Acquire(ctx)
	if err != nil {
		return err
	}
	key := bindingLockKey(Authority{WorkspaceID: workspace}, Catalog{Key: catalog})
	if _, err = connection.Exec(ctx, `SELECT pg_advisory_lock(hashtextextended($1,0))`, key); err != nil {
		closeLockedConnection(connection)
		return err
	}
	held := &lease{store: store, connection: connection, lockKey: key}
	defer held.Close()
	binding, _, _, err := scanBinding(connection.QueryRow(ctx, bindingSelect+` WHERE id=$1 AND state='retired'`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	// Advance the retry order before the external stop, including when that
	// call exhausts its context. Otherwise a full batch of unavailable hosts
	// can permanently starve newer retirement records. Keep their authority
	// until stop actually succeeds.
	if _, err = connection.Exec(ctx, `UPDATE flow_runtime_host_bindings
  SET updated_at=clock_timestamp() WHERE id=$1 AND state='retired'`, id); err != nil {
		return err
	}
	if err = stopper.StopFlowHost(ctx, binding); err != nil {
		return err
	}
	_, err = connection.Exec(ctx, `DELETE FROM flow_runtime_host_bindings WHERE id=$1 AND state='retired'`, id)
	return err
}
