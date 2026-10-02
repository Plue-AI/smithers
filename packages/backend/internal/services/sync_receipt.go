package services

// IssueSyncReceipt is the retained durable delivery receipt used by wiki sync.
// Installed receipt rows and generic document synchronization keep this shape.
type IssueSyncReceipt struct {
	Resolution    string `json:"resolution,omitempty"`
	ExpectedToken string `json:"expected_token,omitempty"`
	Provider      string `json:"provider,omitempty"`
	State         string `json:"state"`
	Token         string `json:"token"`
	MessageID     string `json:"message_id"`
	Error         string `json:"error"`
}
