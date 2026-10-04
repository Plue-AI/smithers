package routes

import (
	"encoding/json"
	"net/http"
)

// OpenTerminal is the S2 POST /api/terminals door. Keep it unmounted until
// isolation (T-INS-02), person admission (T-MCH-06), member identities
// (T-MCH-11), authenticated machined transport (T-COL-03), owner sessions
// (T-TRM-07), branch.join (T-ACC-03), revocation (T-ACC-02), and session-bound
// sign-in (T-TRM-02 S1) are wired and proven together. The S1 runtime/SSH
// service cannot satisfy these contracts and must never be used as fallback.
// No projection is published before T-COL-02 supplies the Branch topic.
func (h *WorkspaceTerminalHandler) OpenTerminal(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusServiceUnavailable)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"code": "terminal_unavailable", "class": "infra", "message": "Terminal is unavailable",
	})
}
