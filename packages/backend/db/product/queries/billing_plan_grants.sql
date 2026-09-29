-- name: GetActiveBillingPlanGrant :one
SELECT * FROM billing_plan_grants
WHERE owner_type = sqlc.arg(owner_type) AND owner_id = sqlc.arg(owner_id)
 AND expires_at > sqlc.arg(as_of)::timestamptz
ORDER BY id DESC LIMIT 1;

-- name: GetBillingPlanGrantByKey :one
SELECT * FROM billing_plan_grants
WHERE owner_type = sqlc.arg(owner_type) AND owner_id = sqlc.arg(owner_id)
 AND source_key = sqlc.arg(source_key);

-- name: InsertBillingPlanGrant :execrows
INSERT INTO billing_plan_grants (owner_type, owner_id, source_key, plan_key, expires_at, actor, reason)
VALUES (sqlc.arg(owner_type), sqlc.arg(owner_id), sqlc.arg(source_key), sqlc.arg(plan_key),
 sqlc.arg(expires_at), sqlc.arg(actor), sqlc.arg(reason))
ON CONFLICT (owner_type, owner_id, source_key) DO NOTHING;
