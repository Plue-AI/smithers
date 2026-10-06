package jobs

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

const maxReplayPage = 1000

func (store *Store) Head(ctx context.Context, scope Scope) (int64, error) {
	if err := scope.validate(); err != nil {
		return 0, err
	}
	var head int64
	err := store.pool.QueryRow(ctx, `SELECT head FROM product_job_streams
		WHERE tenant_id=$1 AND principal_id=$2`, scope.TenantID, scope.PrincipalID).Scan(&head)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	return head, err
}

// Replay returns one bounded, ordered page after cursor. Cursor zero starts at
// the beginning while retained. Call Snapshot after CursorExpiredError.
func (store *Store) Replay(ctx context.Context, scope Scope, cursor int64, limit int) (ReplayPage, error) {
	if err := scope.validate(); err != nil {
		return ReplayPage{}, err
	}
	if cursor < 0 {
		return ReplayPage{}, errors.New("jobs: cursor cannot be negative")
	}
	if limit <= 0 || limit > maxReplayPage {
		limit = maxReplayPage
	}
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly, IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return ReplayPage{}, err
	}
	defer rollback(tx)
	var head, floor int64
	err = tx.QueryRow(ctx, `SELECT head, retention_floor FROM product_job_streams
		WHERE tenant_id=$1 AND principal_id=$2`, scope.TenantID, scope.PrincipalID).Scan(&head, &floor)
	if errors.Is(err, pgx.ErrNoRows) {
		if cursor > 0 {
			return ReplayPage{}, ErrCursorAhead
		}
		if err := tx.Commit(ctx); err != nil {
			return ReplayPage{}, err
		}
		return ReplayPage{Cursor: 0, Head: 0}, nil
	}
	if err != nil {
		return ReplayPage{}, err
	}
	if cursor < floor-1 {
		return ReplayPage{}, &CursorExpiredError{Cursor: cursor, Floor: floor, Head: head}
	}
	if cursor > head {
		return ReplayPage{}, ErrCursorAhead
	}
	rows, err := tx.Query(ctx, `
		SELECT tenant_id, principal_id, sequence, event_id, operation_id,
		       event_type, state, data, recorded_at
		FROM product_job_events
		WHERE tenant_id=$1 AND principal_id=$2 AND sequence>$3 AND sequence<=$4
		ORDER BY sequence
		LIMIT $5`, scope.TenantID, scope.PrincipalID, cursor, head, limit)
	if err != nil {
		return ReplayPage{}, err
	}
	defer rows.Close()
	page := ReplayPage{Cursor: cursor, Head: head}
	for rows.Next() {
		var event Event
		if err := rows.Scan(&event.Scope.TenantID, &event.Scope.PrincipalID, &event.Sequence,
			&event.EventID, &event.OperationID, &event.Type, &event.State, &event.Data,
			&event.RecordedAt); err != nil {
			return ReplayPage{}, err
		}
		page.Events = append(page.Events, event)
		page.Cursor = event.Sequence
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return ReplayPage{}, err
	}
	rows.Close()
	if len(page.Events) == 0 {
		page.Cursor = head
	}
	page.More = page.Cursor < head
	if err := tx.Commit(ctx); err != nil {
		return ReplayPage{}, err
	}
	return page, nil
}

// Snapshot provides the current scoped operation projection and the cursor at
// which it was read. It is the resync path after event retention expires.
func (store *Store) Snapshot(ctx context.Context, scope Scope, limit int) (Snapshot, error) {
	if err := scope.validate(); err != nil {
		return Snapshot{}, err
	}
	if limit <= 0 || limit > maxReplayPage {
		limit = maxReplayPage
	}
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly, IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return Snapshot{}, err
	}
	defer rollback(tx)
	var head int64
	err = tx.QueryRow(ctx, `SELECT head FROM product_job_streams
		WHERE tenant_id=$1 AND principal_id=$2`, scope.TenantID, scope.PrincipalID).Scan(&head)
	if errors.Is(err, pgx.ErrNoRows) {
		head, err = 0, nil
	}
	if err != nil {
		return Snapshot{}, err
	}
	rows, err := tx.Query(ctx, `
		SELECT request.id, request.tenant_id, request.principal_id, request.operation,
		       request.request_id, request.payload_fingerprint, request.payload,
		       request.authorization_context, request.state, request.request_receipt,
		       dispatch.external_receipt, request.terminal_receipt,
		       dispatch.effect_policy, dispatch.effect_key, dispatch.attempt,
		       dispatch.external_attempt,
		       dispatch.generation, dispatch.reconcile_required,
		       request.cancellation_requested, request.cancellation_requested_at,
		       request.created_at, request.updated_at,
		       count(*) OVER ()
		FROM product_job_requests request
		JOIN product_job_dispatches dispatch ON dispatch.operation_id=request.id
		WHERE request.tenant_id=$1 AND request.principal_id=$2
		ORDER BY request.created_at, request.id LIMIT $3`, scope.TenantID, scope.PrincipalID, limit)
	if err != nil {
		return Snapshot{}, err
	}
	defer rows.Close()
	snapshot := Snapshot{Scope: scope, Cursor: head}
	var total int64
	for rows.Next() {
		var operation Operation
		var fingerprint []byte
		var external []byte
		var terminal []byte
		var cancelledAt *time.Time
		if err := rows.Scan(&operation.ID, &operation.Scope.TenantID, &operation.Scope.PrincipalID,
			&operation.Operation, &operation.RequestID, &fingerprint, &operation.Payload,
			&operation.AuthorizationContext, &operation.State, &operation.RequestReceipt,
			&external, &terminal, &operation.EffectPolicy, &operation.EffectKey,
			&operation.Attempt, &operation.ExternalAttempt, &operation.Generation, &operation.NeedsReconciliation,
			&operation.CancellationRequested, &cancelledAt,
			&operation.CreatedAt, &operation.UpdatedAt, &total); err != nil {
			return Snapshot{}, err
		}
		copy(operation.PayloadFingerprint[:], fingerprint)
		operation.ExternalReceipt = external
		operation.TerminalReceipt = terminal
		operation.CancellationRequestedAt = cancelledAt
		snapshot.Operations = append(snapshot.Operations, operation)
	}
	if err := rows.Err(); err != nil {
		return Snapshot{}, err
	}
	snapshot.Truncated = total > int64(len(snapshot.Operations))
	if err := tx.Commit(ctx); err != nil {
		return Snapshot{}, err
	}
	return snapshot, nil
}

// ExpireEventsThrough advances the explicit retention floor. A client behind
// that floor receives CursorExpiredError instead of a silently gapped replay.
func (store *Store) ExpireEventsThrough(ctx context.Context, scope Scope, sequence int64) error {
	if err := scope.validate(); err != nil {
		return err
	}
	if sequence < 0 {
		return errors.New("jobs: expiry sequence cannot be negative")
	}
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer rollback(tx)
	// Match repository-before-item source allocation locks.
	var repositoryHead int64
	err = tx.QueryRow(ctx, `SELECT head FROM product_job_streams WHERE tenant_id=$1 AND principal_id='repository:todos' FOR UPDATE`, scope.TenantID).Scan(&repositoryHead)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	var head int64
	err = tx.QueryRow(ctx, `SELECT head FROM product_job_streams
		WHERE tenant_id=$1 AND principal_id=$2 FOR UPDATE`, scope.TenantID, scope.PrincipalID).Scan(&head)
	if errors.Is(err, pgx.ErrNoRows) {
		return tx.Commit(ctx)
	}
	if err != nil {
		return err
	}
	if sequence > head {
		sequence = head
	}
	var repositoryFloor int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(repository_sequence),0) FROM product_job_events WHERE tenant_id=$1 AND principal_id=$2 AND sequence<=$3`, scope.TenantID, scope.PrincipalID, sequence).Scan(&repositoryFloor); err != nil {
		return err
	}
	if repositoryFloor > 0 {
		if _, err := tx.Exec(ctx, `UPDATE product_job_streams SET retention_floor=GREATEST(retention_floor,$2+1) WHERE tenant_id=$1 AND principal_id='repository:todos'`, scope.TenantID, repositoryFloor); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM product_job_events
		WHERE tenant_id=$1 AND principal_id=$2 AND sequence<=$3`,
		scope.TenantID, scope.PrincipalID, sequence); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE product_job_streams
		SET retention_floor=GREATEST(retention_floor,$3+1)
		WHERE tenant_id=$1 AND principal_id=$2`, scope.TenantID, scope.PrincipalID, sequence); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

type AuthorizeFunc func(context.Context, Scope) error

type Subscription struct {
	store        *Store
	scope        Scope
	cursor       int64
	pollInterval time.Duration
	authorize    AuthorizeFunc
	buffer       []Event
	closed       context.Context
	close        context.CancelFunc
}

// Subscribe polls the durable journal without holding a database connection
// between pages. Idle subscriptions therefore cannot exhaust admission or
// replay capacity. New events are observed within pollInterval (five seconds
// by default), plus query time; the cursor closes the connect/replay race.
func (store *Store) Subscribe(ctx context.Context, scope Scope, cursor int64, pollInterval time.Duration, authorize AuthorizeFunc) (*Subscription, error) {
	if err := scope.validate(); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if cursor < 0 {
		return nil, errors.New("jobs: cursor cannot be negative")
	}
	if pollInterval <= 0 {
		pollInterval = 5 * time.Second
	}
	closed, closeSubscription := context.WithCancel(context.Background())
	return &Subscription{store: store, scope: scope, cursor: cursor, pollInterval: pollInterval, authorize: authorize, closed: closed, close: closeSubscription}, nil
}

func (subscription *Subscription) Cursor() int64 { return subscription.cursor }

// Next is not safe for concurrent callers. Close may interrupt a pending Next.
func (subscription *Subscription) Next(ctx context.Context) (Event, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(subscription.closed, cancel)
	defer stop()
	for {
		if subscription.closed.Err() != nil {
			return Event{}, errors.New("jobs: subscription is closed")
		}
		if err := ctx.Err(); err != nil {
			return Event{}, err
		}
		if subscription.authorize != nil {
			if err := subscription.authorize(ctx, subscription.scope); err != nil {
				return Event{}, err
			}
		}
		if len(subscription.buffer) > 0 {
			event := subscription.buffer[0]
			subscription.buffer = subscription.buffer[1:]
			subscription.cursor = event.Sequence
			return event, nil
		}
		page, err := subscription.store.Replay(ctx, subscription.scope, subscription.cursor, maxReplayPage)
		if err != nil {
			return Event{}, err
		}
		if len(page.Events) > 0 {
			subscription.buffer = page.Events
			continue
		}
		subscription.cursor = page.Cursor
		timer := time.NewTimer(subscription.pollInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
		case <-timer.C:
		}
	}
}

func (subscription *Subscription) Close(_ context.Context) error {
	subscription.close()
	return nil
}
