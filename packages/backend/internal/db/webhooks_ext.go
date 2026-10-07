package db

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// EnsureWebhookAtURL gives a repository one active hook at url when it has
// none there, and returns the hook at url either way. The check and insert run
// under a per-repository advisory lock, so API replicas reconciling at once
// create one hook, not one each.
func (q *Queries) EnsureWebhookAtURL(ctx context.Context, arg CreateWebhookParams) (Webhook, bool, error) {
	tx, err := q.BeginTx(ctx)
	if err != nil {
		return Webhook{}, false, fmt.Errorf("ensure webhook: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('webhook-at-url:' || $1::bigint::text, 0))`, arg.RepositoryID); err != nil {
		return Webhook{}, false, err
	}
	var hook Webhook
	err = tx.QueryRow(ctx, `
SELECT id, repository_id, url, secret, events, is_active, last_delivery_at, created_at, updated_at
FROM webhooks
WHERE repository_id = $1 AND url = $2
ORDER BY id
LIMIT 1
`, arg.RepositoryID, arg.Url).Scan(
		&hook.ID, &hook.RepositoryID, &hook.Url, &hook.Secret, &hook.Events,
		&hook.IsActive, &hook.LastDeliveryAt, &hook.CreatedAt, &hook.UpdatedAt,
	)
	if err == nil {
		return hook, false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Webhook{}, false, err
	}
	hook, err = q.WithTx(tx).CreateWebhook(ctx, arg)
	if err != nil {
		return Webhook{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Webhook{}, false, err
	}
	return hook, true, nil
}

// A test ping is sent once by its admitting request, never by the delivery
// worker. Infinity keeps a crash or an ambiguous remote result from turning
// into an automatic retry. The durable receipt exists before any HTTP send.
func (q *Queries) CreateWebhookTestDelivery(ctx context.Context, webhookID int64, payload []byte) (WebhookDelivery, error) {
	var row WebhookDelivery
	err := q.db.QueryRow(ctx, `INSERT INTO webhook_deliveries
 (webhook_id,event_type,payload,status,response_body,next_retry_at,attempts)
 VALUES ($1,'ping',$2,'pending','{"outcome":"outcomeUnknown"}','infinity',1)
 RETURNING id,webhook_id,event_type,payload,status,response_status,response_body,attempts,delivered_at,next_retry_at,created_at,updated_at`, webhookID, payload).Scan(
		&row.ID, &row.WebhookID, &row.EventType, &row.Payload, &row.Status, &row.ResponseStatus, &row.ResponseBody, &row.Attempts, &row.DeliveredAt, &row.NextRetryAt, &row.CreatedAt, &row.UpdatedAt)
	return row, err
}
