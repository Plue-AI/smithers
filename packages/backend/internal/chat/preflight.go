package chat

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// Validate only the transport envelope here. The packaged recall/model host
// owns selection and the RPC schema; Go never ranks or reads candidate files.
func validPreflight(value any) bool {
	result, ok := value.(map[string]any)
	if !ok {
		return false
	}
	model, ok := result["model"].(string)
	if !ok || model == "" {
		return false
	}
	duration, ok := result["durationMs"].(json.Number)
	if !ok {
		return false
	}
	ms, err := duration.Float64()
	if err != nil || ms < 0 || math.IsInf(ms, 0) || math.IsNaN(ms) {
		return false
	}
	for _, field := range []string{"context", "candidates"} {
		items, ok := result[field].([]any)
		if !ok {
			return false
		}
		for _, value := range items {
			item, ok := value.(map[string]any)
			if !ok {
				return false
			}
			kind, ok := item["kind"].(string)
			if !ok || !oneOf(kind, "file", "page", "todo", "run", "issue") {
				return false
			}
			if _, ok := item["label"].(string); !ok {
				return false
			}
			if _, ok := item["ref"].(string); !ok {
				return false
			}
			if revision, exists := item["revision"]; exists {
				if _, ok := revision.(string); !ok {
					return false
				}
			}
			if field == "context" {
				reason, ok := item["reason"].(string)
				if !ok || reason == "" {
					return false
				}
			}
		}
	}
	return true
}

// ContextRepository supplies host-read candidate data and settings. Selection
// stays in the existing TypeScript recall step. An absent provider refuses;
// the callback never substitutes a browser transcript or an empty repository.
// Arguments are the admitted credential, user ID, repository ID and branch.
// The result has state, candidates and tokenBudget from the RPC preflight
// input; the packaged host validates that schema before any model call.
type ContextRepository func(context.Context, middleware.Credential, int64, int64, string) (json.RawMessage, error)

const ContextPath = "/internal/chat/context"

// Context resolves the prompt and audience from the admitted turn, never from
// callback arguments. The same producer and admitting-credential fences used
// for source reads cover shared history and repository candidates.
func (h *Handler) Context(w http.ResponseWriter, r *http.Request) {
	if h.Store == nil {
		writeProblem(w, http.StatusServiceUnavailable, "storage_failed")
		return
	}
	var request struct {
		TurnID     string `json:"turnId"`
		Generation int64  `json:"generation"`
	}
	if !decodeBounded(w, r, &request) {
		return
	}
	turn, ok := h.liveProducer(w, r, request.TurnID, request.Generation)
	if !ok {
		return
	}
	credential, ok := h.admittingCredential(w, turn)
	if !ok {
		return
	}
	credentialActive := func() bool {
		info, err := middleware.ReloadCredential(r.Context(), db.New(h.Store.pool), credential, time.Now().UTC())
		if err != nil || !info.ReadsRepositoriesAsPerson() || info.User.ID != turn.UserID {
			writeProblem(w, http.StatusForbidden, "forbidden")
			return false
		}
		return true
	}
	if !credentialActive() {
		return
	}
	if h.ContextRepository == nil || h.ResolveBranch == nil {
		writeProblem(w, http.StatusServiceUnavailable, "context_unavailable")
		return
	}
	var branch, author string
	var payload json.RawMessage
	err := h.Store.pool.QueryRow(r.Context(), `SELECT t.conversation_id,t.request_payload,u.username FROM chat_turns t JOIN users u ON u.id=t.user_id WHERE t.id=$1 AND t.request_payload->>'sharedConversation'='true'`, request.TurnID).Scan(&branch, &payload, &author)
	if err != nil {
		writeProblem(w, http.StatusForbidden, "forbidden")
		return
	}
	resolved, err := h.ResolveBranch(r.Context(), turn.Scope, branch)
	if err != nil || resolved != branch {
		writeProblem(w, http.StatusForbidden, "forbidden")
		return
	}
	var admitted struct {
		Messages []struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"messages"`
	}
	if json.Unmarshal(payload, &admitted) != nil || len(admitted.Messages) != 1 || admitted.Messages[0].Role != "user" || strings.TrimSpace(admitted.Messages[0].Content) == "" {
		writeProblem(w, http.StatusConflict, "context_unavailable")
		return
	}
	shared, err := h.Store.SharedEntries(r.Context(), turn.Scope, branch)
	if err != nil {
		publicError(w, err)
		return
	}
	recent := []map[string]string{}
	found := false
	for _, entry := range shared.Entries {
		if entry.ID == request.TurnID {
			found = true
			break
		}
		var text strings.Builder
		text.WriteString(entry.Prompt)
		first := true
		for _, raw := range entry.Frames {
			var frame struct {
				Type string `json:"type"`
				Kind string `json:"kind"`
				Text string `json:"text"`
			}
			if json.Unmarshal(raw, &frame) == nil && frame.Type == "delta" && frame.Kind == "text" {
				if first {
					text.WriteString("\n")
					first = false
				}
				text.WriteString(frame.Text)
			}
		}
		recent = append(recent, map[string]string{"title": entry.Prompt, "text": text.String()})
	}
	if !found {
		writeProblem(w, http.StatusConflict, "context_unavailable")
		return
	}
	// Selection uses every shared title. Only the last three entry texts may
	// enter the answer; older full transcripts need not cross the host boundary.
	for i := 0; i < len(recent)-3; i++ {
		recent[i]["text"] = ""
	}
	repository, err := h.ContextRepository(r.Context(), credential, turn.UserID, turn.RepositoryID, branch)
	if err != nil {
		writeProblem(w, http.StatusServiceUnavailable, "context_unavailable")
		return
	}
	var data map[string]json.RawMessage
	if len(repository) > maxPayloadBytes || json.Unmarshal(repository, &data) != nil || len(data) != 3 || data["state"] == nil || data["candidates"] == nil || data["tokenBudget"] == nil {
		writeProblem(w, http.StatusServiceUnavailable, "context_unavailable")
		return
	}
	response, err := json.Marshal(map[string]any{"prompt": admitted.Messages[0].Content, "author": author, "branch": branch, "state": data["state"], "recent": recent, "candidates": data["candidates"], "tokenBudget": data["tokenBudget"], "wikiOnly": false})
	if err != nil || len(response)+1 > maxPayloadBytes {
		writeProblem(w, http.StatusServiceUnavailable, "context_unavailable")
		return
	}
	// Revalidate after slow source reads so a revoked/cancelled producer cannot
	// receive the captured conversation or repository bytes.
	if _, ok = h.liveProducer(w, r, request.TurnID, request.Generation); !ok {
		return
	}
	if !credentialActive() {
		return
	}
	resolved, err = h.ResolveBranch(r.Context(), turn.Scope, branch)
	if err != nil || resolved != branch {
		writeProblem(w, http.StatusForbidden, "forbidden")
		return
	}
	writeJSON(w, http.StatusOK, json.RawMessage(response))
}
