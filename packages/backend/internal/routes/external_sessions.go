package routes

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/externalsessions"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// ExternalSessionsHandler serves GET /api/external/sessions (mvp.md M-38):
// a Codex or Claude Code session run on this machine, as raw JSONL from a
// byte offset. The app decodes the lines, so this host and the Bun test host
// serve the same contract and one decoder reads it. The sessions are the
// files of the account the install runs as, so only the install owner's
// browser session reads them, and the owner is the person they show.
type ExternalSessionsHandler struct {
	Queries  *db.Queries
	Sessions *externalsessions.Finder
}

// externalSessionRead is one read: complete lines of the session from
// offset; next is the offset after them.
type externalSessionRead struct {
	Agent     externalsessions.Agent `json:"agent"`
	SessionID string                 `json:"session_id"`
	Owner     externalSessionOwner   `json:"owner"`
	Offset    int64                  `json:"offset"`
	Next      int64                  `json:"next"`
	Text      string                 `json:"text"`
	EOF       bool                   `json:"eof"`
}

type externalSessionOwner struct {
	Login string `json:"login"`
	Name  string `json:"name"`
}

func externalSessionRefusal(w http.ResponseWriter, status int, class, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"class": class, "code": code, "message": message})
}

// Read answers ?agent=codex|claude-code&session=<id or prefix>&offset=<n>.
func (h *ExternalSessionsHandler) Read(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.Queries == nil || h.Sessions == nil {
		externalSessionRefusal(w, http.StatusServiceUnavailable, "infra", "external_unavailable", "Agent sessions are unavailable")
		return
	}
	if _, err := services.Authorize(r.Context(), h.Queries, "external.read"); err != nil {
		todoRouteError(w, err)
		return
	}
	query := r.URL.Query()
	agent, ok := externalsessions.ParseAgent(query.Get("agent"))
	if !ok {
		externalSessionRefusal(w, http.StatusBadRequest, "user", "invalid_request", "agent must be codex or claude-code.")
		return
	}
	offset := int64(0)
	if raw := query.Get("offset"); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed < 0 || strconv.FormatInt(parsed, 10) != raw {
			externalSessionRefusal(w, http.StatusBadRequest, "user", "invalid_request", "offset must be a byte offset the previous read answered as next.")
			return
		}
		offset = parsed
	}
	session, err := h.Sessions.Find(agent, query.Get("session"))
	if err != nil {
		externalSessionError(w, err)
		return
	}
	chunk, err := externalsessions.Read(session.Path, offset)
	if err != nil {
		externalSessionError(w, err)
		return
	}
	user := middleware.AuthInfoFromContext(r.Context()).User
	name := user.DisplayName
	if name == "" {
		name = user.Username
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(externalSessionRead{
		Agent: agent, SessionID: session.ID, Owner: externalSessionOwner{Login: user.Username, Name: name},
		Offset: chunk.Offset, Next: chunk.Next, Text: string(chunk.Text), EOF: chunk.EOF,
	})
}

func externalSessionError(w http.ResponseWriter, err error) {
	var refused *externalsessions.Refusal
	if errors.As(err, &refused) {
		externalSessionRefusal(w, refused.Status, "user", refused.Code, refused.Message)
		return
	}
	externalSessionRefusal(w, http.StatusServiceUnavailable, "infra", "external_unavailable", "Agent sessions are unavailable")
}
