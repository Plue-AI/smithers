package errors

import "errors"

// UnknownCursorReason is the details.reason of a resume cursor the stream did
// not issue: ahead of its head, or naming a record that no longer exists.
const UnknownCursorReason = "cursor_unknown"

// UnknownCursor refuses a stream resume cursor the server cannot honour. A
// stream must never resume past events it cannot prove the client saw, so the
// client discards its position (details.resync) and reloads the stream's
// current state instead of reconnecting with the same cursor.
func UnknownCursor(message string) *APIError {
	refusal := Conflict(message)
	refusal.Details = map[string]any{"reason": UnknownCursorReason, "resync": true}
	return refusal
}

// IsUnknownCursor reports whether err is an UnknownCursor refusal.
func IsUnknownCursor(err error) bool {
	var refusal *APIError
	if !errors.As(err, &refusal) || refusal.Code != CodeConflict {
		return false
	}
	details, ok := refusal.Details.(map[string]any)
	return ok && details["reason"] == UnknownCursorReason
}
