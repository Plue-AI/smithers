package jobs

import (
	"bytes"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed schema.sql
var schemaSQL string

// SchemaSQL returns the additive schema owned by this package. Product hosts
// apply it through their normal migration system; Store never self-migrates.
func SchemaSQL() string { return schemaSQL }

type Store struct {
	pool *pgxpool.Pool
}

func NewStore(pool *pgxpool.Pool) (*Store, error) {
	if pool == nil {
		return nil, errors.New("jobs: PostgreSQL pool is required")
	}
	return &Store{pool: pool}, nil
}

func validateAdmission(input Admission) (json.RawMessage, json.RawMessage, error) {
	if err := input.Scope.validate(); err != nil {
		return nil, nil, err
	}
	if input.Operation == "" || input.RequestID == "" {
		return nil, nil, errors.New("jobs: operation and request ID are required")
	}
	if !validatePolicy(input.EffectPolicy) {
		return nil, nil, errors.New("jobs: invalid external effect policy")
	}
	payload, err := canonicalJSON(input.Payload, false)
	if err != nil {
		return nil, nil, err
	}
	authorization, err := canonicalJSON(input.AuthorizationContext, true)
	if err != nil {
		return nil, nil, err
	}
	return payload, authorization, nil
}

// Admit atomically persists the request, its dispatch row, and its first
// ordered event. It performs no provider or runtime call. A successful return
// therefore means durable acceptance, not launch or completion.
func (store *Store) Admit(ctx context.Context, input Admission) (RequestReceipt, error) {
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return RequestReceipt{}, err
	}
	defer rollback(tx)

	receipt, err := store.AdmitInTx(ctx, tx, input)
	if err != nil {
		return RequestReceipt{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return RequestReceipt{}, err
	}
	return receipt, nil
}

// AdmitInTx adds admission to a caller-owned product transaction. The caller
// must use a transaction from the same PostgreSQL database as Store and owns
// commit or rollback. This is the integration seam for domain authorization
// and product admission that must become durable together.
func (store *Store) AdmitInTx(ctx context.Context, tx pgx.Tx, input Admission) (RequestReceipt, error) {
	if tx == nil {
		return RequestReceipt{}, errors.New("jobs: admission transaction is required")
	}
	payload, authorization, err := validateAdmission(input)
	if err != nil {
		return RequestReceipt{}, err
	}
	fingerprint := payloadFingerprint(payload)
	operationID := uuid.NewString()
	acceptedAt := time.Now().UTC()
	receipt := RequestReceipt{
		OperationID: operationID,
		RequestID:   input.RequestID,
		Kind:        "requested",
		State:       StateAccepted,
		AcceptedAt:  acceptedAt,
	}
	receiptJSON, err := json.Marshal(receipt)
	if err != nil {
		return RequestReceipt{}, err
	}
	effectKey := input.EffectKey
	if effectKey == "" {
		effectKey = "product-job:" + operationID
	}
	// An unscheduled job is available at the database's clock, the one every
	// claim compares against; the admitting process's clock may run ahead.
	var availableAt *time.Time
	if !input.AvailableAt.IsZero() {
		availableAt = &input.AvailableAt
	}

	var inserted bool
	err = tx.QueryRow(ctx, `
		INSERT INTO product_job_requests
			(id, tenant_id, principal_id, operation, request_id, payload_fingerprint,
			 payload, authorization_context, state, request_receipt)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'accepted',$9)
		ON CONFLICT (tenant_id, principal_id, operation, request_id) DO NOTHING
		RETURNING true`, operationID, input.Scope.TenantID, input.Scope.PrincipalID,
		input.Operation, input.RequestID, fingerprint[:], payload, authorization, receiptJSON).Scan(&inserted)
	if errors.Is(err, pgx.ErrNoRows) {
		var existingID string
		var existingFingerprint []byte
		var existingReceipt json.RawMessage
		var samePayload bool
		err = tx.QueryRow(ctx, `
			SELECT id, payload_fingerprint, request_receipt, payload=$5::jsonb
			FROM product_job_requests
			WHERE tenant_id=$1 AND principal_id=$2 AND operation=$3 AND request_id=$4`,
			input.Scope.TenantID, input.Scope.PrincipalID, input.Operation, input.RequestID,
			payload,
		).Scan(&existingID, &existingFingerprint, &existingReceipt, &samePayload)
		if err != nil {
			return RequestReceipt{}, err
		}
		// Exact number spellings may differ (1e3 and 1000), including from
		// fingerprints written before number-preserving canonicalization.
		if !bytes.Equal(existingFingerprint, fingerprint[:]) && !samePayload {
			return RequestReceipt{}, ErrPayloadConflict
		}
		if err := json.Unmarshal(existingReceipt, &receipt); err != nil {
			return RequestReceipt{}, fmt.Errorf("jobs: decode request receipt: %w", err)
		}
		receipt.OperationID = existingID
		receipt.Joined = true
		return receipt, nil
	}
	if err != nil {
		return RequestReceipt{}, err
	}
	if !inserted {
		return RequestReceipt{}, errors.New("jobs: admission insert returned no result")
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO product_job_dispatches
			(operation_id, effect_policy, effect_key, next_attempt_at)
		VALUES ($1,$2,$3,COALESCE($4::timestamptz, clock_timestamp()))`, operationID, input.EffectPolicy, effectKey, availableAt); err != nil {
		return RequestReceipt{}, err
	}
	if _, err := appendEvent(ctx, tx, input.Scope, operationID, "operation.accepted", StateAccepted, receiptJSON); err != nil {
		return RequestReceipt{}, err
	}
	return receipt, nil
}

func payloadFingerprint(payload json.RawMessage) [32]byte {
	return sha256.Sum256(payload)
}

func appendEvent(ctx context.Context, tx pgx.Tx, scope Scope, operationID, eventType string, state State, data json.RawMessage) (Event, error) {
	if len(data) == 0 {
		data = json.RawMessage(`{}`)
	}
	canonical, err := canonicalJSON(data, true)
	if err != nil {
		return Event{}, err
	}
	var sequence int64
	err = tx.QueryRow(ctx, `
		INSERT INTO product_job_streams (tenant_id, principal_id, head)
		VALUES ($1,$2,1)
		ON CONFLICT (tenant_id, principal_id)
		DO UPDATE SET head = product_job_streams.head + 1
		RETURNING head`, scope.TenantID, scope.PrincipalID).Scan(&sequence)
	if err != nil {
		return Event{}, err
	}
	event := Event{
		Scope: scope, Sequence: sequence, EventID: uuid.NewString(),
		OperationID: operationID, Type: eventType, State: state, Data: canonical,
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO product_job_events
			(tenant_id, principal_id, sequence, event_id, operation_id, event_type, state, data)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		RETURNING recorded_at`, scope.TenantID, scope.PrincipalID, sequence, event.EventID,
		operationID, eventType, state, canonical).Scan(&event.RecordedAt)
	if err != nil {
		return Event{}, err
	}
	// NOTIFY is delivered on commit. It is only a wake hint; subscribers always
	// repair from product_job_events using their committed cursor.
	if _, err := tx.Exec(ctx, `SELECT pg_notify('smithers_product_jobs', '')`); err != nil {
		return Event{}, err
	}
	return event, nil
}

func (store *Store) Get(ctx context.Context, scope Scope, operationID string) (Operation, error) {
	if err := scope.validate(); err != nil {
		return Operation{}, err
	}
	return queryOperation(ctx, store.pool, scope, operationID, false)
}

// GetByRequest reconnects a caller-visible idempotency key to its durable
// operation without crossing the tenant/principal/operation boundary.
func (store *Store) GetByRequest(ctx context.Context, scope Scope, operation, requestID string) (Operation, error) {
	return getByRequest(ctx, store.pool, scope, operation, requestID)
}

// GetByRequestInTx is GetByRequest inside the caller's transaction.
func (store *Store) GetByRequestInTx(ctx context.Context, tx pgx.Tx, scope Scope, operation, requestID string) (Operation, error) {
	if tx == nil {
		return Operation{}, errors.New("jobs: transaction is required")
	}
	return getByRequest(ctx, tx, scope, operation, requestID)
}

func getByRequest(ctx context.Context, q rowQuerier, scope Scope, operation, requestID string) (Operation, error) {
	if err := scope.validate(); err != nil {
		return Operation{}, err
	}
	if operation == "" || requestID == "" {
		return Operation{}, errors.New("jobs: operation and request ID are required")
	}
	var operationID string
	err := q.QueryRow(ctx, `SELECT id FROM product_job_requests
		WHERE tenant_id=$1 AND principal_id=$2 AND operation=$3 AND request_id=$4`,
		scope.TenantID, scope.PrincipalID, operation, requestID).Scan(&operationID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Operation{}, ErrNotFound
	}
	if err != nil {
		return Operation{}, err
	}
	return queryOperation(ctx, q, scope, operationID, false)
}

type rowQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func queryOperation(ctx context.Context, q rowQuerier, scope Scope, operationID string, forUpdate bool) (Operation, error) {
	query := `
		SELECT request.id, request.tenant_id, request.principal_id, request.operation,
		       request.request_id, request.payload_fingerprint, request.payload,
		       request.authorization_context, request.state, request.request_receipt,
		       dispatch.external_receipt, request.terminal_receipt,
		       dispatch.effect_policy, dispatch.effect_key, dispatch.attempt,
		       dispatch.external_attempt,
		       dispatch.generation, dispatch.reconcile_required,
		       request.cancellation_requested, request.cancellation_requested_at,
		       request.created_at, request.updated_at
		FROM product_job_requests request
		JOIN product_job_dispatches dispatch ON dispatch.operation_id=request.id
		WHERE request.tenant_id=$1 AND request.principal_id=$2 AND request.id=$3`
	if forUpdate {
		query += ` FOR UPDATE OF request`
	}
	var operation Operation
	var fingerprint []byte
	var external []byte
	var terminal []byte
	var cancelledAt *time.Time
	err := q.QueryRow(ctx, query, scope.TenantID, scope.PrincipalID, operationID).Scan(
		&operation.ID, &operation.Scope.TenantID, &operation.Scope.PrincipalID,
		&operation.Operation, &operation.RequestID, &fingerprint, &operation.Payload,
		&operation.AuthorizationContext, &operation.State, &operation.RequestReceipt,
		&external, &terminal, &operation.EffectPolicy, &operation.EffectKey,
		&operation.Attempt, &operation.ExternalAttempt, &operation.Generation, &operation.NeedsReconciliation,
		&operation.CancellationRequested, &cancelledAt,
		&operation.CreatedAt, &operation.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Operation{}, ErrNotFound
	}
	if err != nil {
		return Operation{}, err
	}
	copy(operation.PayloadFingerprint[:], fingerprint)
	operation.ExternalReceipt = external
	operation.TerminalReceipt = terminal
	operation.CancellationRequestedAt = cancelledAt
	return operation, nil
}

// HasActiveWithReceipt reports whether an unsettled operation of this kind in
// scope has an external receipt that contains fragment (JSON containment). A
// caller finds the work still pinned to an external owner this way.
func (store *Store) HasActiveWithReceipt(ctx context.Context, scope Scope, operation string, fragment json.RawMessage) (bool, error) {
	if err := scope.validate(); err != nil {
		return false, err
	}
	if operation == "" {
		return false, errors.New("jobs: operation is required")
	}
	canonical, err := canonicalJSON(fragment, true)
	if err != nil {
		return false, err
	}
	var active bool
	err = store.pool.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM product_job_requests request
		JOIN product_job_dispatches dispatch ON dispatch.operation_id=request.id
		WHERE request.tenant_id=$1 AND request.principal_id=$2 AND request.operation=$3
		  AND request.state IN ('accepted', 'dispatching', 'running', 'waiting')
		  AND dispatch.external_receipt @> $4::jsonb)`,
		scope.TenantID, scope.PrincipalID, operation, canonical).Scan(&active)
	return active, err
}

// ReplacePayload swaps a request's payload for replacement while the stored
// payload still equals expected, keeping its fingerprint in step, and reports
// whether it did. An operator key rotation reseals encrypted payload fields
// this way; the request's state and receipts are untouched.
func (store *Store) ReplacePayload(ctx context.Context, operationID string, expected, replacement json.RawMessage) (bool, error) {
	payload, err := canonicalJSON(replacement, false)
	if err != nil {
		return false, err
	}
	fingerprint := payloadFingerprint(payload)
	tag, err := store.pool.Exec(ctx, `
		UPDATE product_job_requests SET payload=$2, payload_fingerprint=$3
		WHERE id=$1 AND payload=$4::jsonb`, operationID, payload, fingerprint[:], expected)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// RecordFactInTx records a completed product fact without enqueueing an external
// effect. It shares the stream allocator with delivery; rollback publishes none.
func RecordFactInTx(ctx context.Context, tx pgx.Tx, scope Scope, operationID, eventType, state string, data json.RawMessage) (Event, error) {
	if err := scope.validate(); err != nil {
		return Event{}, err
	}
	canonical, err := canonicalJSON(data, true)
	if err != nil {
		return Event{}, err
	}
	fingerprint := payloadFingerprint(canonical)
	_, err = tx.Exec(ctx, `INSERT INTO product_job_requests
 (id,tenant_id,principal_id,operation,request_id,payload_fingerprint,payload,authorization_context,state,request_receipt,terminal_receipt)
 VALUES($1,$2,$3,$4,$7,$5,$6,'{}','completed',$6,$6)`, operationID, scope.TenantID, scope.PrincipalID, eventType, fingerprint[:], canonical, operationID)
	if err != nil {
		return Event{}, err
	}
	return appendEvent(ctx, tx, scope, operationID, eventType, State(state), canonical)
}
