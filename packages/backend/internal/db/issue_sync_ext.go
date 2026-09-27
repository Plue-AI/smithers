package db

import (
	"context"
	"encoding/json"
)

type IssueSyncMapping struct {
	Provider       string `json:"provider"`
	DeliveryID     int64  `json:"delivery_id,omitempty"`
	State          string `json:"state,omitempty"`
	Error          string `json:"error,omitempty"`
	IssueID        int64  `json:"issue_id"`
	OwnerID        int64  `json:"-"`
	ConnectionID   string `json:"connection_id"`
	ScopeID        string `json:"scope_id"`
	ConversationID string `json:"conversation_id"`
	ThreadID       string `json:"thread_id"`
}

func (q *Queries) PutIssueSyncMapping(ctx context.Context, m IssueSyncMapping) error {
	_, err := q.db.Exec(ctx, `WITH mapped AS (
 INSERT INTO issue_sync_threads(issue_id,owner_id,connection_id,scope_id,conversation_id,thread_id,provider) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(issue_id) DO NOTHING RETURNING issue_id
), recorded AS (
 INSERT INTO issue_events(issue_id,actor_id,event_type,payload)
 SELECT c.issue_id,c.user_id,'comment.created',jsonb_build_object('comment',to_jsonb(c),'origin','mapping') FROM issue_comments c JOIN mapped m ON m.issue_id=c.issue_id ORDER BY c.id RETURNING id,issue_id
)
INSERT INTO issue_sync_deliveries(issue_id,event_id) SELECT issue_id,id FROM recorded`, m.IssueID, m.OwnerID, m.ConnectionID, m.ScopeID, m.ConversationID, m.ThreadID, m.Provider)
	return err
}
func (q *Queries) GetIssueSyncMapping(ctx context.Context, issueID int64) (m IssueSyncMapping, err error) {
	err = q.db.QueryRow(ctx, `SELECT issue_id,owner_id,connection_id,scope_id,conversation_id,thread_id,provider,
 COALESCE((SELECT state FROM issue_sync_deliveries WHERE issue_id=$1 AND state<>'sent' ORDER BY id LIMIT 1),'synced'),
 COALESCE((SELECT error FROM issue_sync_deliveries WHERE issue_id=$1 AND state<>'sent' ORDER BY id LIMIT 1),''),
 COALESCE((SELECT id FROM issue_sync_deliveries WHERE issue_id=$1 AND state<>'sent' ORDER BY id LIMIT 1),0)
 FROM issue_sync_threads WHERE issue_id=$1`, issueID).Scan(&m.IssueID, &m.OwnerID, &m.ConnectionID, &m.ScopeID, &m.ConversationID, &m.ThreadID, &m.Provider, &m.State, &m.Error, &m.DeliveryID)
	return
}

type IssueSyncDelivery struct {
	Key        string           `json:"key"`
	ID         int64            `json:"id"`
	IssueID    int64            `json:"issue_id"`
	CommentID  int64            `json:"comment_id"`
	State      string           `json:"state"`
	Event      string           `json:"event"`
	Payload    json.RawMessage  `json:"payload"`
	MessageID  string           `json:"message_id"`
	ClaimToken string           `json:"claim_token,omitempty"`
	Mapping    IssueSyncMapping `json:"mapping"`
}

// ListIssueSyncDeliveries returns the claim token of a dispatching row only once
// its 10-minute lease has lapsed, so another worker replays the claim's durable
// execution identity instead of racing a live one.
func (q *Queries) ListIssueSyncDeliveries(ctx context.Context, ownerID, repoID, afterID int64) ([]IssueSyncDelivery, error) {
	rows, err := q.db.Query(ctx, `SELECT d.id,d.reconcile_key,d.issue_id,d.state,CASE WHEN d.state='dispatching' AND d.updated_at<now()-interval '10 minutes' THEN d.claim_token ELSE '' END,e.event_type,e.payload,COALESCE(NULLIF(d.message_id,''),m.message_id,''),t.connection_id,t.scope_id,t.conversation_id,t.thread_id,t.provider FROM issue_sync_deliveries d JOIN issues i ON i.id=d.issue_id JOIN issue_events e ON e.id=d.event_id JOIN issue_sync_threads t ON t.issue_id=d.issue_id LEFT JOIN issue_external_messages m ON m.issue_id=d.issue_id AND m.comment_id=(e.payload->'comment'->>'id')::bigint WHERE t.owner_id=$1 AND i.repository_id=$2 AND d.state IN ('pending','dispatching','outcome_unknown') AND d.id>$3 ORDER BY d.id LIMIT 100`, ownerID, repoID, afterID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []IssueSyncDelivery{}
	for rows.Next() {
		var d IssueSyncDelivery
		if err = rows.Scan(&d.ID, &d.Key, &d.IssueID, &d.State, &d.ClaimToken, &d.Event, &d.Payload, &d.MessageID, &d.Mapping.ConnectionID, &d.Mapping.ScopeID, &d.Mapping.ConversationID, &d.Mapping.ThreadID, &d.Mapping.Provider); err != nil {
			return nil, err
		}
		d.Mapping.IssueID = d.IssueID
		d.Mapping.OwnerID = ownerID
		result = append(result, d)
	}
	return result, rows.Err()
}
