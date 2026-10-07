package middleware

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
)

// StackAttentionCommand selects the typed action sharing the attention route.
// The leaf authorizer and provider still validate the role and stored kind.
func StackAttentionCommand(w http.ResponseWriter, r *http.Request) (string, error) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4096))
	r.Body = io.NopCloser(bytes.NewReader(raw))
	if err != nil {
		return "", err
	}
	var payload map[string]json.RawMessage
	if json.Unmarshal(raw, &payload) == nil {
		if _, ok := payload["revision"]; ok {
			return "order.ok", nil
		}
	}
	return "main.reset-to-github", nil
}
