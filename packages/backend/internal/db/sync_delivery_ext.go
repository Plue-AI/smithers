package db

import "context"

// ClaimSyncDelivery is shared by chat and document adapters. Admission and
// ownership are checked by the caller, in the same transaction as this CAS.
func (q *Queries) ClaimSyncDelivery(ctx context.Context, id int64, token string) (string, error) {
	var state string
	err := q.db.QueryRow(ctx, `UPDATE issue_sync_deliveries d SET state='dispatching',claim_token=$2,updated_at=now()
 WHERE d.id=$1 AND d.state='pending' AND NOT EXISTS (
 SELECT 1 FROM issue_sync_deliveries earlier WHERE
 (earlier.issue_id=d.issue_id OR earlier.document_scope=d.document_scope)
 AND earlier.id<d.id AND earlier.state NOT IN ('sent','unsupported')) RETURNING state`, id, token).Scan(&state)
	return state, err
}

// SettleSyncDelivery fences every provider receipt, including a replay after
// the side effect committed but its receipt was lost.
func (q *Queries) SettleSyncDelivery(ctx context.Context, id int64, token, state, messageID, failure string) (bool, error) {
	tag, err := q.db.Exec(ctx, `UPDATE issue_sync_deliveries SET state=$3,message_id=$4,error=$5,updated_at=now()
 WHERE id=$1 AND claim_token=$2 AND state IN ('dispatching','outcome_unknown')`, id, token, state, messageID, failure)
	return tag.RowsAffected() == 1, err
}
