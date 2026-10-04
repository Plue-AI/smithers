package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type claimRecord struct {
	Status              string
	State               State
	Policy              EffectPolicy
	ExternalStartedAt   *time.Time
	ExternalAttempt     int
	CancelRequested     bool
	NeedsReconciliation bool
}

// Claim takes one ready external operation without blocking other workers.
// The monotonic generation and random token together fence every later write.
func (store *Store) Claim(ctx context.Context, workerID string, lease time.Duration) (Claim, error) {
	return store.ClaimForOperations(ctx, workerID, lease, nil)
}

// ClaimForOperations limits a worker to exact product-operation names. An
// empty list retains Claim's catch-all behavior. This lets one shared queue
// host typed handlers without allowing a Flow worker to consume unrelated
// product work.
func (store *Store) ClaimForOperations(ctx context.Context, workerID string, lease time.Duration, operations []string) (Claim, error) {
	if workerID == "" {
		return Claim{}, errors.New("jobs: worker ID is required")
	}
	if lease <= 0 {
		return Claim{}, errors.New("jobs: positive lease is required")
	}
	operations, err := normalizeOperationFilter(operations)
	if err != nil {
		return Claim{}, err
	}
	token := uuid.NewString()
	leaseMilliseconds := lease.Milliseconds()
	if leaseMilliseconds < 1 {
		leaseMilliseconds = 1
	}
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Claim{}, err
	}
	defer rollback(tx)

	var claim Claim
	err = tx.QueryRow(ctx, `
		WITH candidate AS (
			SELECT dispatch.operation_id
			FROM product_job_dispatches dispatch
			JOIN product_job_requests request ON request.id = dispatch.operation_id
			WHERE dispatch.status = 'ready'
			  AND dispatch.next_attempt_at <= clock_timestamp()
			  AND request.state IN ('accepted', 'running', 'waiting')
			  AND (cardinality($4::text[]) = 0 OR request.operation = ANY($4::text[]))
			ORDER BY dispatch.next_attempt_at, dispatch.operation_id
			FOR UPDATE OF dispatch SKIP LOCKED
			LIMIT 1
		), claimed AS (
			UPDATE product_job_dispatches dispatch
			SET status='claimed', claim_token=$1, worker_id=$2,
			    claimed_at=clock_timestamp(),
			    lease_expires_at=clock_timestamp() + ($3 * interval '1 millisecond'),
			    generation=dispatch.generation+1, attempt=dispatch.attempt+1,
			    updated_at=clock_timestamp()
			FROM candidate
			WHERE dispatch.operation_id=candidate.operation_id
			RETURNING dispatch.*
		)
		SELECT request.id, request.tenant_id, request.principal_id, request.operation,
		       request.request_id, request.payload, request.authorization_context,
		       claimed.effect_policy, claimed.effect_key, claimed.external_receipt,
		       claimed.attempt, claimed.external_attempt,
		       claimed.generation, claimed.claim_token, claimed.worker_id,
		       claimed.lease_expires_at, claimed.reconcile_required,
		       request.cancellation_requested
		FROM claimed JOIN product_job_requests request ON request.id=claimed.operation_id`,
		token, workerID, leaseMilliseconds, operations).Scan(
		&claim.OperationID, &claim.Scope.TenantID, &claim.Scope.PrincipalID,
		&claim.Operation, &claim.RequestID, &claim.Payload, &claim.AuthorizationContext,
		&claim.EffectPolicy, &claim.EffectKey, &claim.ExternalReceipt,
		&claim.Attempt, &claim.ExternalAttempt, &claim.Generation,
		&claim.Token, &claim.WorkerID, &claim.LeaseExpiresAt, &claim.NeedsReconciliation,
		&claim.CancellationRequested,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Claim{}, ErrNoWork
	}
	if err != nil {
		return Claim{}, err
	}
	if err := tx.QueryRow(ctx, `
		UPDATE product_job_requests
		SET state=CASE WHEN state='accepted' THEN 'dispatching' ELSE state END,
		    updated_at=clock_timestamp()
		WHERE id=$1 RETURNING state`, claim.OperationID).Scan(&claim.State); err != nil {
		return Claim{}, err
	}
	// A reconcile re-claim polls an operation that is already parked or
	// running elsewhere. Journal only claims that start new work, so a long
	// wait does not append one event per poll.
	if !claim.NeedsReconciliation {
		data, _ := json.Marshal(map[string]any{
			"attempt": claim.Attempt, "generation": claim.Generation,
			"externalAttempt": claim.ExternalAttempt,
		})
		if _, err := appendEvent(ctx, tx, claim.Scope, claim.OperationID, "operation.claimed", claim.State, data); err != nil {
			return Claim{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Claim{}, err
	}
	return claim, nil
}

func normalizeOperationFilter(operations []string) ([]string, error) {
	result := make([]string, 0, len(operations))
	seen := make(map[string]struct{}, len(operations))
	for _, operation := range operations {
		if operation == "" {
			return nil, errors.New("jobs: operation filter contains an empty name")
		}
		if _, exists := seen[operation]; exists {
			continue
		}
		seen[operation] = struct{}{}
		result = append(result, operation)
	}
	return result, nil
}

func lockClaim(ctx context.Context, tx pgx.Tx, claim Claim) (claimRecord, error) {
	var record claimRecord
	err := tx.QueryRow(ctx, `
		SELECT dispatch.status, request.state, dispatch.effect_policy, dispatch.external_started_at,
		       dispatch.external_attempt,
		       request.cancellation_requested, dispatch.reconcile_required
		FROM product_job_dispatches dispatch
		JOIN product_job_requests request ON request.id=dispatch.operation_id
		WHERE dispatch.operation_id=$1 AND dispatch.claim_token=$2
		  AND dispatch.generation=$3 AND dispatch.worker_id=$4
		  AND dispatch.status='claimed'
		  AND dispatch.lease_expires_at > clock_timestamp()
		FOR UPDATE OF dispatch, request`, claim.OperationID, claim.Token, claim.Generation, claim.WorkerID).Scan(
		&record.Status, &record.State, &record.Policy, &record.ExternalStartedAt, &record.ExternalAttempt, &record.CancelRequested, &record.NeedsReconciliation,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return claimRecord{}, ErrClaimLost
	}
	return record, err
}

// Heartbeat renews a live claim and returns durable cancellation intent.
func (store *Store) Heartbeat(ctx context.Context, claim Claim, lease time.Duration) (bool, error) {
	if lease <= 0 {
		return false, errors.New("jobs: positive lease is required")
	}
	leaseMilliseconds := lease.Milliseconds()
	if leaseMilliseconds < 1 {
		leaseMilliseconds = 1
	}
	var cancelRequested bool
	err := store.pool.QueryRow(ctx, `
		UPDATE product_job_dispatches dispatch
		SET lease_expires_at=clock_timestamp() + ($5 * interval '1 millisecond'),
		    updated_at=clock_timestamp()
		FROM product_job_requests request
		WHERE dispatch.operation_id=$1 AND dispatch.claim_token=$2
		  AND dispatch.generation=$3 AND dispatch.worker_id=$4
		  AND dispatch.status='claimed'
		  AND dispatch.lease_expires_at > clock_timestamp()
		  AND request.id=dispatch.operation_id
		RETURNING request.cancellation_requested`, claim.OperationID, claim.Token,
		claim.Generation, claim.WorkerID, leaseMilliseconds).Scan(&cancelRequested)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, ErrClaimLost
	}
	return cancelRequested, err
}

// MarkExternalStarted must be committed immediately before invoking the
// provider. Recovery uses this marker to avoid repeating ambiguous effects.
// BeginExternal commits the pre-call marker and returns the stable delivery
// attempt to send to the external authority. Recovery may replace the
// PostgreSQL claim, but it must reuse this value for an ambiguous launch.
func (store *Store) BeginExternal(ctx context.Context, claim Claim, observation json.RawMessage) (int, error) {
	canonical, err := canonicalJSON(observation, true)
	if err != nil {
		return 0, err
	}
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return 0, err
	}
	defer rollback(tx)
	record, err := lockClaim(ctx, tx, claim)
	if err != nil {
		return 0, err
	}
	if record.ExternalStartedAt != nil {
		if err := tx.Commit(ctx); err != nil {
			return 0, err
		}
		return record.ExternalAttempt, nil
	}
	if record.CancelRequested {
		return 0, ErrCancellationRequested
	}
	externalAttempt := record.ExternalAttempt
	if externalAttempt <= 0 {
		return 0, errors.New("jobs: external attempt must be positive")
	}
	if _, err := tx.Exec(ctx, `
		UPDATE product_job_dispatches
		SET external_started_at=clock_timestamp(),
		    external_attempt=$2, external_receipt=COALESCE(external_receipt, $3),
		    reconcile_required=false, updated_at=clock_timestamp()
		WHERE operation_id=$1`, claim.OperationID, externalAttempt, canonical); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE product_job_requests SET state='running', updated_at=clock_timestamp()
		WHERE id=$1`, claim.OperationID); err != nil {
		return 0, err
	}
	if _, err := appendEvent(ctx, tx, claim.Scope, claim.OperationID, "operation.started", StateRunning, canonical); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return externalAttempt, nil
}

// Checkpoint atomically advances the external receipt and ordered product
// journal. An identical receipt is a no-op, so reconnecting the same runtime
// cursor cannot duplicate a product checkpoint.
func (store *Store) Checkpoint(ctx context.Context, claim Claim, receipt json.RawMessage) (bool, error) {
	canonical, err := canonicalJSON(receipt, true)
	if err != nil {
		return false, err
	}
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return false, err
	}
	defer rollback(tx)
	record, err := lockClaim(ctx, tx, claim)
	if err != nil {
		return false, err
	}
	changed, err := updateExternalReceipt(ctx, tx, claim.OperationID, canonical)
	if err != nil {
		return false, err
	}
	if _, err := tx.Exec(ctx, `UPDATE product_job_requests
		SET state='waiting', updated_at=clock_timestamp() WHERE id=$1`, claim.OperationID); err != nil {
		return false, err
	}
	changed = changed || record.State != StateWaiting
	if changed {
		if _, err := appendEvent(ctx, tx, claim.Scope, claim.OperationID, "operation.waiting", StateWaiting, canonical); err != nil {
			return false, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return changed, nil
}

func updateExternalReceipt(ctx context.Context, tx pgx.Tx, operationID string, receipt json.RawMessage) (bool, error) {
	var changed bool
	err := tx.QueryRow(ctx, `UPDATE product_job_dispatches
		SET external_receipt=$2, updated_at=clock_timestamp()
		WHERE operation_id=$1 AND external_receipt IS DISTINCT FROM $2::jsonb
		RETURNING true`, operationID, receipt).Scan(&changed)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return changed, err
}

// Park persists a non-terminal external checkpoint and releases the fenced
// claim for later reconciliation. No process must stay alive merely because a
// canonical runtime is parked or still executing.
func (store *Store) Park(ctx context.Context, claim Claim, receipt json.RawMessage, retryAfter time.Duration) error {
	canonical, err := canonicalJSON(receipt, true)
	if err != nil {
		return err
	}
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer rollback(tx)
	record, err := lockClaim(ctx, tx, claim)
	if err != nil {
		return err
	}
	if record.ExternalStartedAt == nil {
		return errors.New("jobs: cannot park before an external effect starts")
	}
	if record.CancelRequested {
		retryAfter = 0
	}
	changed, err := updateExternalReceipt(ctx, tx, claim.OperationID, canonical)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE product_job_requests
		SET state='waiting', updated_at=clock_timestamp() WHERE id=$1`, claim.OperationID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE product_job_dispatches
		SET status='ready', claim_token=NULL, worker_id=NULL, claimed_at=NULL,
		    lease_expires_at=NULL, reconcile_required=true,
		    next_attempt_at=clock_timestamp() + ($2 * interval '1 millisecond'),
		    updated_at=clock_timestamp()
		WHERE operation_id=$1`, claim.OperationID, maxMilliseconds(retryAfter)); err != nil {
		return err
	}
	if changed || record.State != StateWaiting {
		if _, err := appendEvent(ctx, tx, claim.Scope, claim.OperationID, "operation.waiting", StateWaiting, canonical); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// Wake makes a ready, parked operation claimable now. A decision that another
// operation delivered (an approval, for example) uses it so the parked
// operation does not wait out its backoff. A claimed or settled operation is
// left alone.
func (store *Store) Wake(ctx context.Context, scope Scope, operationID string) error {
	if err := scope.validate(); err != nil {
		return err
	}
	_, err := store.pool.Exec(ctx, `UPDATE product_job_dispatches dispatch
		SET next_attempt_at=clock_timestamp(), updated_at=clock_timestamp()
		FROM product_job_requests request
		WHERE dispatch.operation_id=$3 AND request.id=dispatch.operation_id
		  AND request.tenant_id=$1 AND request.principal_id=$2
		  AND dispatch.status='ready' AND dispatch.next_attempt_at > clock_timestamp()`,
		scope.TenantID, scope.PrincipalID, operationID)
	return err
}

func (store *Store) Complete(ctx context.Context, claim Claim, receipt json.RawMessage) error {
	return store.settleClaim(ctx, claim, StateCompleted, "operation.completed", receipt, false)
}

func (store *Store) Fail(ctx context.Context, claim Claim, receipt json.RawMessage) error {
	return store.settleClaim(ctx, claim, StateFailed, "operation.failed", receipt, false)
}

func (store *Store) AcknowledgeCancellation(ctx context.Context, claim Claim, receipt json.RawMessage) error {
	return store.settleClaim(ctx, claim, StateCancelled, "operation.cancelled", receipt, true)
}

// RecordExternalCancellation settles a canonical external cancellation even
// when the product caller did not initiate it.
func (store *Store) RecordExternalCancellation(ctx context.Context, claim Claim, receipt json.RawMessage) error {
	return store.settleClaim(ctx, claim, StateCancelled, "operation.cancelled", receipt, false)
}

func (store *Store) settleClaim(ctx context.Context, claim Claim, state State, eventType string, receipt json.RawMessage, requireCancellation bool) error {
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer rollback(tx)
	if err := store.settleInTx(ctx, tx, claim, state, eventType, receipt, requireCancellation); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// SettleInTx fences completion and appends its event in a product-owned
// transaction so the setup projection cannot commit separately from its job.
func (store *Store) SettleInTx(ctx context.Context, tx pgx.Tx, claim Claim, receipt json.RawMessage, failed bool) error {
	state, event := StateCompleted, "operation.completed"
	if failed {
		state, event = StateFailed, "operation.failed"
	}
	return store.settleInTx(ctx, tx, claim, state, event, receipt, false)
}
func (store *Store) settleInTx(ctx context.Context, tx pgx.Tx, claim Claim, state State, eventType string, receipt json.RawMessage, requireCancellation bool) error {
	if tx == nil {
		return errors.New("jobs: settlement transaction required")
	}
	canonical, err := canonicalJSON(receipt, true)
	if err != nil {
		return err
	}
	record, err := lockClaim(ctx, tx, claim)
	if err != nil {
		return err
	}
	if requireCancellation && !record.CancelRequested {
		return ErrCancellationNotRequested
	}
	if _, err := tx.Exec(ctx, `
		UPDATE product_job_requests
		SET state=$2, terminal_receipt=$3, updated_at=clock_timestamp()
		WHERE id=$1`, claim.OperationID, state, canonical); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE product_job_dispatches
		SET status='done', claim_token=NULL, worker_id=NULL, claimed_at=NULL,
		    lease_expires_at=NULL, updated_at=clock_timestamp()
		WHERE operation_id=$1`, claim.OperationID); err != nil {
		return err
	}
	if _, err := appendEvent(ctx, tx, claim.Scope, claim.OperationID, eventType, state, canonical); err != nil {
		return err
	}
	return nil
}

// Abandon applies the persisted external-effect policy. It never blindly
// retries an unsafe effect once its pre-call marker was committed.
func (store *Store) Abandon(ctx context.Context, claim Claim, cause error, delay time.Duration) error {
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer rollback(tx)
	record, err := lockClaim(ctx, tx, claim)
	if err != nil {
		return err
	}
	message := "worker abandoned claim"
	if cause != nil {
		message = cause.Error()
	}
	if err := recoverClaim(ctx, tx, claim.Scope, claim.OperationID, record.Policy, record.ExternalStartedAt != nil, record.CancelRequested, record.NeedsReconciliation, message, delay); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func recoverClaim(ctx context.Context, tx pgx.Tx, scope Scope, operationID string, policy EffectPolicy, externalStarted, cancelRequested, reconciliationRequired bool, message string, delay time.Duration) error {
	if externalStarted && policy == EffectUnsafe {
		receipt, _ := json.Marshal(map[string]any{"kind": "uncertain", "reason": message})
		if _, err := tx.Exec(ctx, `UPDATE product_job_requests
			SET state='uncertain', terminal_receipt=$2, updated_at=clock_timestamp()
			WHERE id=$1`, operationID, receipt); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE product_job_dispatches
			SET status='stopped', claim_token=NULL, worker_id=NULL, claimed_at=NULL,
			    lease_expires_at=NULL, last_error=$2, updated_at=clock_timestamp()
			WHERE operation_id=$1`, operationID, message); err != nil {
			return err
		}
		_, err := appendEvent(ctx, tx, scope, operationID, "operation.uncertain", StateUncertain, receipt)
		return err
	}
	if cancelRequested && !externalStarted && !reconciliationRequired {
		receipt := json.RawMessage(`{"kind":"cancelled-before-external-effect"}`)
		if _, err := tx.Exec(ctx, `UPDATE product_job_requests
			SET state='cancelled', terminal_receipt=$2, updated_at=clock_timestamp()
			WHERE id=$1`, operationID, receipt); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE product_job_dispatches
			SET status='done', claim_token=NULL, worker_id=NULL, claimed_at=NULL,
			    lease_expires_at=NULL, last_error=$2, updated_at=clock_timestamp()
			WHERE operation_id=$1`, operationID, message); err != nil {
			return err
		}
		_, err := appendEvent(ctx, tx, scope, operationID, "operation.cancelled", StateCancelled, receipt)
		return err
	}
	reconcile := (externalStarted && (policy == EffectReconcile || cancelRequested)) || (cancelRequested && reconciliationRequired)
	nextState := StateAccepted
	if reconcile {
		nextState = StateWaiting
	}
	if _, err := tx.Exec(ctx, `UPDATE product_job_requests
		SET state=$2, updated_at=clock_timestamp() WHERE id=$1`, operationID, nextState); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE product_job_dispatches
		SET status='ready', claim_token=NULL, worker_id=NULL, claimed_at=NULL,
		    lease_expires_at=NULL, reconcile_required=$2,
		    next_attempt_at=clock_timestamp() + ($3 * interval '1 millisecond'),
		    last_error=$4, updated_at=clock_timestamp()
		WHERE operation_id=$1`, operationID, reconcile, maxMilliseconds(delay), message); err != nil {
		return err
	}
	eventType := "operation.retry_scheduled"
	if reconcile {
		eventType = "operation.reconciliation_required"
	}
	data, _ := json.Marshal(map[string]any{"reason": message, "reconcile": reconcile})
	_, err := appendEvent(ctx, tx, scope, operationID, eventType, nextState, data)
	return err
}

func maxMilliseconds(delay time.Duration) int64 {
	if delay <= 0 {
		return 0
	}
	if delay.Milliseconds() < 1 {
		return 1
	}
	return delay.Milliseconds()
}

// RecoverExpired reclaims up to limit expired leases. Multiple processes can
// run it concurrently; SKIP LOCKED partitions recovery work.
func (store *Store) RecoverExpired(ctx context.Context, limit int) (int, error) {
	return store.RecoverExpiredForOperations(ctx, nil, limit)
}

// RecoverExpiredForOperations reclaims only leases owned by the named product
// operation kinds. An empty list retains RecoverExpired's catch-all behavior.
func (store *Store) RecoverExpiredForOperations(ctx context.Context, operations []string, limit int) (int, error) {
	if limit <= 0 {
		return 0, nil
	}
	operations, err := normalizeOperationFilter(operations)
	if err != nil {
		return 0, err
	}
	recovered := 0
	for recovered < limit {
		didRecover, err := store.recoverOne(ctx, operations)
		if err != nil {
			return recovered, err
		}
		if !didRecover {
			break
		}
		recovered++
	}
	return recovered, nil
}

func (store *Store) recoverOne(ctx context.Context, operations []string) (bool, error) {
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return false, err
	}
	defer rollback(tx)
	var scope Scope
	var operationID string
	var policy EffectPolicy
	var externalStarted, cancelRequested, reconciliationRequired bool
	err = tx.QueryRow(ctx, `
		SELECT request.tenant_id, request.principal_id, dispatch.operation_id,
		       dispatch.effect_policy, dispatch.external_started_at IS NOT NULL,
		       request.cancellation_requested, dispatch.reconcile_required
		FROM product_job_dispatches dispatch
		JOIN product_job_requests request ON request.id=dispatch.operation_id
		WHERE dispatch.status='claimed' AND dispatch.lease_expires_at <= clock_timestamp()
		  AND (cardinality($1::text[]) = 0 OR request.operation = ANY($1::text[]))
		ORDER BY dispatch.lease_expires_at, dispatch.operation_id
		FOR UPDATE OF dispatch, request SKIP LOCKED
		LIMIT 1`, operations).Scan(&scope.TenantID, &scope.PrincipalID, &operationID, &policy, &externalStarted, &cancelRequested, &reconciliationRequired)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if err := recoverClaim(ctx, tx, scope, operationID, policy, externalStarted, cancelRequested, reconciliationRequired, "claim lease expired", 0); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return true, nil
}

type UncertainResolution string

const (
	ResolveRetry     UncertainResolution = "retry"
	ResolveCompleted UncertainResolution = "completed"
	ResolveFailed    UncertainResolution = "failed"
	ResolveCancelled UncertainResolution = "cancelled"
)

// ResolveUncertain is the explicit operator/reconciler decision required for
// an ambiguous unsafe effect.
func (store *Store) ResolveUncertain(ctx context.Context, scope Scope, operationID string, resolution UncertainResolution, receipt json.RawMessage) error {
	if err := scope.validate(); err != nil {
		return err
	}
	canonical, err := canonicalJSON(receipt, true)
	if err != nil {
		return err
	}
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer rollback(tx)
	// Cancellation and worker mutations acquire dispatch before request. Use
	// the same order so resolving an uncertain operation cannot deadlock with
	// a concurrent cancellation that is checking its terminal state.
	var lockedID string
	err = tx.QueryRow(ctx, `SELECT dispatch.operation_id
		FROM product_job_dispatches dispatch
		JOIN product_job_requests request ON request.id=dispatch.operation_id
		WHERE request.tenant_id=$1 AND request.principal_id=$2 AND request.id=$3
		FOR UPDATE OF dispatch`, scope.TenantID, scope.PrincipalID, operationID).Scan(&lockedID)
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
	if operation.State != StateUncertain {
		return ErrUncertainResolution
	}
	if resolution == ResolveRetry {
		if _, err := tx.Exec(ctx, `UPDATE product_job_requests
			SET state='accepted', terminal_receipt=NULL, updated_at=clock_timestamp()
			WHERE id=$1`, operationID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE product_job_dispatches
			SET status='ready', external_started_at=NULL, external_attempt=external_attempt+1, external_receipt=NULL,
			    reconcile_required=false, next_attempt_at=clock_timestamp(),
			    last_error='', updated_at=clock_timestamp()
			WHERE operation_id=$1`, operationID); err != nil {
			return err
		}
		if _, err := appendEvent(ctx, tx, scope, operationID, "operation.retry_authorized", StateAccepted, canonical); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	var state State
	var eventType string
	switch resolution {
	case ResolveCompleted:
		state, eventType = StateCompleted, "operation.completed"
	case ResolveFailed:
		state, eventType = StateFailed, "operation.failed"
	case ResolveCancelled:
		state, eventType = StateCancelled, "operation.cancelled"
	default:
		return fmt.Errorf("jobs: invalid uncertain resolution %q", resolution)
	}
	if _, err := tx.Exec(ctx, `UPDATE product_job_requests
		SET state=$2, terminal_receipt=$3, updated_at=clock_timestamp() WHERE id=$1`,
		operationID, state, canonical); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE product_job_dispatches
		SET status='done', updated_at=clock_timestamp() WHERE operation_id=$1`, operationID); err != nil {
		return err
	}
	if _, err := appendEvent(ctx, tx, scope, operationID, eventType, state, canonical); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
