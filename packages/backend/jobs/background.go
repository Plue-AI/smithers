package jobs

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
)

// ControlFailedInTx keeps the operation identity and admission immutable. A
// retry opens a new external attempt; dismissal retains the failure receipt.
// Callers must authorize the product binding before invoking this operation.
func (store *Store) ControlFailedInTx(ctx context.Context, tx pgx.Tx, scope Scope, id, action, key string, checkpoint json.RawMessage) error {
	if tx == nil {
		return errors.New("jobs: transaction required")
	}
	if err := scope.validate(); err != nil {
		return err
	}
	if action != "retry" && action != "dismiss" {
		return ErrUncertainResolution
	}
	var locked string
	err := tx.QueryRow(ctx, `SELECT d.operation_id FROM product_job_dispatches d JOIN product_job_requests r ON r.id=d.operation_id WHERE r.id=$1 AND r.tenant_id=$2 AND r.principal_id=$3 FOR UPDATE OF d`, id, scope.TenantID, scope.PrincipalID).Scan(&locked)
	if err != nil {
		return err
	}
	op, err := queryOperation(ctx, tx, scope, id, true)
	if err != nil {
		return err
	}
	if action == "retry" {
		if key == "" {
			return ErrUncertainResolution
		}
		var replay bool
		if err := tx.QueryRow(ctx, `SELECT COALESCE(request_receipt->'homeRetryKeys' ? $2,false) FROM product_job_requests WHERE id=$1`, id, key).Scan(&replay); err != nil {
			return err
		}
		if replay {
			return nil
		}
		if op.State != StateFailed || op.EffectPolicy == EffectUnsafe {
			return ErrUncertainResolution
		}
		if len(checkpoint) > 0 {
			if _, err := canonicalJSON(checkpoint, true); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `UPDATE product_job_requests SET state='accepted',terminal_receipt=NULL,cancellation_requested=false,cancellation_requested_at=NULL,request_receipt=jsonb_set(request_receipt,'{homeRetryKeys}',COALESCE(request_receipt->'homeRetryKeys','{}'::jsonb) || jsonb_build_object($2::text,true)),updated_at=clock_timestamp() WHERE id=$1`, id, key); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE product_job_dispatches SET status='ready',claim_token=NULL,worker_id=NULL,claimed_at=NULL,lease_expires_at=NULL,external_started_at=NULL,external_attempt=external_attempt+1,external_receipt=$2,reconcile_required=false,next_attempt_at=clock_timestamp(),last_error='',updated_at=clock_timestamp() WHERE operation_id=$1`, id, checkpoint); err != nil {
			return err
		}
		data, _ := json.Marshal(map[string]string{"key": key})
		_, err = appendEvent(ctx, tx, scope, id, "operation.retry_authorized", StateAccepted, data)
		return err
	}
	if op.State != StateFailed && op.State != StateUncertain {
		return ErrUncertainResolution
	}
	var receipt map[string]any
	if json.Unmarshal(op.TerminalReceipt, &receipt) != nil {
		return ErrUncertainResolution
	}
	if receipt["homeDismissed"] == true {
		return nil
	}
	if _, err := tx.Exec(ctx, `UPDATE product_job_requests SET terminal_receipt=terminal_receipt || '{"homeDismissed":true}'::jsonb,updated_at=clock_timestamp() WHERE id=$1`, id); err != nil {
		return err
	}
	_, err = appendEvent(ctx, tx, scope, id, "operation.dismissed", op.State, json.RawMessage(`{"homeDismissed":true}`))
	return err
}
