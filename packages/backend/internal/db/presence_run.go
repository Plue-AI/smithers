package db

import (
	"context"
	"encoding/json"
)

// PresenceRunCheckpoint reuses the admitted launch's durable runtime receipt.
// Both host target and job scope must match: a run id grants no branch access.
func (q *Queries) PresenceRunCheckpoint(ctx context.Context, branch, run string) (json.RawMessage, string, error) {
	var raw json.RawMessage
	var state string
	err := q.db.QueryRow(ctx, `SELECT d.external_receipt,r.state FROM product_job_dispatches d
 JOIN product_job_requests r ON r.id=d.operation_id JOIN workspaces w ON w.id=$1::text::uuid
 WHERE r.operation='flow.runtime.launch' AND r.tenant_id='repository:'||w.repository_id::text
 AND d.external_receipt->>'runId'=$2 AND d.external_receipt->'target'->>'WorkspaceID'=$1::text
 AND d.external_receipt->'target'->>'TenantID'=r.tenant_id
 AND d.external_receipt->'target'->>'PrincipalID'=r.principal_id
 ORDER BY r.updated_at DESC LIMIT 1`, branch, run).Scan(&raw, &state)
	return raw, state, err
}
