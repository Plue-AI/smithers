package db

import (
	"encoding/json"
)

// IssueSyncMapping preserves stored provider provenance for historical delivery receipts.
type IssueSyncMapping struct {
	Provider        string `json:"provider"`
	DeliveryID      int64  `json:"delivery_id,omitempty"`
	State           string `json:"state,omitempty"`
	ResolutionToken string `json:"resolution_token,omitempty"`
	Error           string `json:"error,omitempty"`
	IssueID         int64  `json:"issue_id"`
	OwnerID         int64  `json:"-"`
	ConnectionID    string `json:"connection_id"`
	ScopeID         string `json:"scope_id"`
	ConversationID  string `json:"conversation_id"`
	ThreadID        string `json:"thread_id"`
}

// IssueSyncDelivery is also used by the retained wiki document outbox.
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
