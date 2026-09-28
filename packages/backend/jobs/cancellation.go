package jobs

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
)

// RequestCancellation durably records cancellation intent. Ready work is
// cancelled immediately. Claimed work remains fenced to its owner, whose
// heartbeat observes the request and acknowledges the terminal receipt.
func (store *Store) RequestCancellation(ctx context.Context, scope Scope, operationID string) (Operation, error) {
	return store.requestCancellation(ctx, scope, operationID, false)
}

// RequestCancellationForWorker records intent without settling ready work.
// The worker must complete its durable projection or cleanup before writing a
// cancellation receipt. Reconciliation remains required after failure or crash.
func (store *Store) RequestCancellationForWorker(ctx context.Context, scope Scope, operationID string) (Operation, error) {
	return store.requestCancellation(ctx, scope, operationID, true)
}

// RequestCancellationForWorkerInTx is RequestCancellationForWorker inside a
// product transaction, so the product's own cancel and the job's cancellation
// intent commit together or not at all. The caller commits.
func (store *Store) RequestCancellationForWorkerInTx(ctx context.Context, tx pgx.Tx, scope Scope, operationID string) (Operation, error) {
	if tx == nil {
		return Operation{}, errors.New("jobs: transaction is required")
	}
	if err := scope.validate(); err != nil {
		return Operation{}, err
	}
	if err := requestCancellationInTx(ctx, tx, scope, operationID, true); err != nil {
		return Operation{}, err
	}
	return queryOperation(ctx, tx, scope, operationID, false)
}

func (store *Store) requestCancellation(ctx context.Context, scope Scope, operationID string, requireWorker bool) (Operation, error) {
	if err := scope.validate(); err != nil {
		return Operation{}, err
	}
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Operation{}, err
	}
	defer rollback(tx)
	if err := requestCancellationInTx(ctx, tx, scope, operationID, requireWorker); err != nil {
		return Operation{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Operation{}, err
	}
	return store.Get(ctx, scope, operationID)
}

func requestCancellationInTx(ctx context.Context, tx pgx.Tx, scope Scope, operationID string, requireWorker bool) error {
	// Claims lock dispatch before mutating the request. Take the same order so a
	// cancellation racing a claim cannot deadlock as each waits on the other.
	var dispatchStatus string
	var externalStarted bool
	err := tx.QueryRow(ctx, `
		SELECT dispatch.status, dispatch.external_started_at IS NOT NULL
		FROM product_job_dispatches dispatch
		JOIN product_job_requests request ON request.id=dispatch.operation_id
		WHERE request.tenant_id=$1 AND request.principal_id=$2 AND request.id=$3
		FOR UPDATE OF dispatch`, scope.TenantID, scope.PrincipalID, operationID).Scan(&dispatchStatus, &externalStarted)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	operation, err := queryOperation(ctx, tx, scope, operationID, true)
	if err != nil {
		return err
	}
	if operation.State.Terminal() {
		return nil
	}
	if requireWorker {
		if _, err := tx.Exec(ctx, `UPDATE product_job_dispatches
			SET reconcile_required=true, updated_at=clock_timestamp()
			WHERE operation_id=$1`, operationID); err != nil {
			return err
		}
	}
	if operation.CancellationRequested {
		return nil
	}
	if _, err := tx.Exec(ctx, `UPDATE product_job_requests
		SET cancellation_requested=true, cancellation_requested_at=clock_timestamp(),
		    updated_at=clock_timestamp() WHERE id=$1`, operationID); err != nil {
		return err
	}
	data := json.RawMessage(`{"kind":"requested"}`)
	if dispatchStatus == "ready" && !externalStarted && !requireWorker {
		data = json.RawMessage(`{"kind":"cancelled-before-dispatch"}`)
		if _, err := tx.Exec(ctx, `UPDATE product_job_requests
			SET state='cancelled', terminal_receipt=$2, updated_at=clock_timestamp()
			WHERE id=$1`, operationID, data); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE product_job_dispatches
			SET status='done', updated_at=clock_timestamp() WHERE operation_id=$1`, operationID); err != nil {
			return err
		}
		if _, err := appendEvent(ctx, tx, scope, operationID, "operation.cancelled", StateCancelled, data); err != nil {
			return err
		}
	} else {
		// Required worker reconciliation must run promptly even when parked.
		if dispatchStatus == "ready" {
			if _, err := tx.Exec(ctx, `UPDATE product_job_dispatches
				SET next_attempt_at=clock_timestamp(), updated_at=clock_timestamp()
				WHERE operation_id=$1`, operationID); err != nil {
				return err
			}
		}
		if _, err := appendEvent(ctx, tx, scope, operationID, "operation.cancellation_requested", operation.State, data); err != nil {
			return err
		}
	}
	return nil
}
