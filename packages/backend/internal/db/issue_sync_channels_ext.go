package db

import "context"

// IssueSyncChannel is one admitted external conversation (Slack channel or
// Telegram chat) that routes into a repository's issues for one owner.
type IssueSyncChannel struct {
	Provider       string `json:"provider"`
	ConnectionID   string `json:"connection_id"`
	ScopeID        string `json:"scope_id"`
	ConversationID string `json:"conversation_id"`
	ThreadID       string `json:"thread_id"`
	ExternalUserID string `json:"external_user_id"`
}

// ListIssueSyncChannels returns the owner's admitted channels for a repository.
// The table is owner-scoped, so another owner's admissions never show.
func (q *Queries) ListIssueSyncChannels(ctx context.Context, ownerID, repoID int64) ([]IssueSyncChannel, error) {
	rows, err := q.db.Query(ctx, `SELECT provider,connection_id,scope_id,conversation_id,thread_id,external_user_id FROM issue_sync_channels WHERE owner_id=$1 AND repository_id=$2 ORDER BY provider,connection_id,scope_id,conversation_id,thread_id`, ownerID, repoID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []IssueSyncChannel{}
	for rows.Next() {
		var c IssueSyncChannel
		if err := rows.Scan(&c.Provider, &c.ConnectionID, &c.ScopeID, &c.ConversationID, &c.ThreadID, &c.ExternalUserID); err != nil {
			return nil, err
		}
		result = append(result, c)
	}
	return result, rows.Err()
}
