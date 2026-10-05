-- name: SaveFlowRelayPlan :exec
INSERT INTO flow_relay_plans (tenant_id, principal_id, workspace_id, plan_id, flow_id)
VALUES (sqlc.arg(tenant_id), sqlc.arg(principal_id), sqlc.arg(workspace_id), sqlc.arg(plan_id), sqlc.arg(flow_id))
ON CONFLICT (tenant_id, principal_id, workspace_id, plan_id) DO UPDATE
SET flow_id = EXCLUDED.flow_id, created_at = NOW();

-- name: GetFlowRelayPlan :one
SELECT flow_id FROM flow_relay_plans
WHERE tenant_id = sqlc.arg(tenant_id) AND principal_id = sqlc.arg(principal_id)
  AND workspace_id = sqlc.arg(workspace_id) AND plan_id = sqlc.arg(plan_id)
  AND created_at > NOW() - INTERVAL '1 day';

-- name: PruneFlowRelayPlans :execrows
DELETE FROM flow_relay_plans WHERE created_at <= NOW() - INTERVAL '1 day';
