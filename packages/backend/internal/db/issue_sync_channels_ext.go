package db

// IssueSyncChannel preserves the shape of historical provider admission records.
type IssueSyncChannel struct {
	Provider       string `json:"provider"`
	ConnectionID   string `json:"connection_id"`
	ScopeID        string `json:"scope_id"`
	ConversationID string `json:"conversation_id"`
	ThreadID       string `json:"thread_id"`
	ExternalUserID string `json:"external_user_id"`
}
