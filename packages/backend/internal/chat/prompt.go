package chat

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// admit is the common journal admission boundary for renderer transports.
func (h *Handler) admit(r *http.Request, scope Scope, runID string, journal JournalRequest, request json.RawMessage) (AdmitResult, error) {
	release := h.credentials.admit(turnKey{userID: scope.UserID, runID: runID, legID: journal.LegID}, middleware.CredentialOf(middleware.AuthInfoFromContext(r.Context())))
	accepted, err := h.Store.Admit(r.Context(), AdmitInput{Scope: scope, RunID: runID, Journal: journal, Request: request})
	if err != nil || accepted.Status != "accepted" {
		release()
	}
	return accepted, err
}

// Prompt persists and acknowledges a prompt without waiting for launch or
// execution. Authority and journal identities never come from browser input.
func (h *Handler) Prompt(w http.ResponseWriter, r *http.Request) {
	auth := middleware.AuthInfoFromContext(r.Context())
	if auth == nil || auth.IsAgent() {
		queueError(w, ErrForbidden)
		return
	}
	scope, ok := h.publicScope(w, r)
	if !ok {
		return
	}
	if h.Dispatcher == nil || scope.RepositoryID <= 0 {
		queueProblem(w, http.StatusServiceUnavailable, "conversation_unavailable")
		return
	}
	var input struct {
		Prompt         string `json:"prompt"`
		IdempotencyKey string `json:"idempotencyKey"`
	}
	if !decodeBoundedWithProblem(w, r, &input, queueProblem) {
		return
	}
	branch := chi.URLParam(r, "b")
	credential := middleware.CredentialOf(auth)
	if !validIdentity(branch) || !validIdentity(input.IdempotencyKey) || strings.TrimSpace(input.Prompt) == "" || len(input.Prompt) > maxPayloadBytes/2 || credential == (middleware.Credential{}) {
		queueError(w, ErrInvalidRequest)
		return
	}
	// Credential-scoped dedupe: another member or credential using the same
	// key creates its own turn. The existing journal serializes concurrent POSTs.
	identity, _ := json.Marshal([]any{"branch-prompt-v1", scope.RepositoryID, scope.UserID, credential, branch, input.IdempotencyKey})
	hash := sha256.Sum256(identity)
	key := hex.EncodeToString(hash[:])
	accessHash := sha256.Sum256(append([]byte("branch-prompt-access-v1:"), identity...))
	accessToken := hex.EncodeToString(accessHash[:])
	runID, legID := "prompt-"+key, "prompt-leg-"+key
	request, err := json.Marshal(map[string]any{
		"runId": runID, "conversationId": branch, "purpose": "conversation", "sharedConversation": true,
		"instructions": "Answer the repository question as Smithers for the prompt author.",
		"messages":     []map[string]string{{"role": "user", "content": input.Prompt}},
	})
	if err != nil {
		queueError(w, err)
		return
	}
	accepted, err := h.admit(r, scope, runID, JournalRequest{Version: 1, LegID: legID, Token: accessToken}, request)
	if err != nil {
		if errors.Is(err, ErrConflict) {
			pkgerrors.WriteError(w, pkgerrors.Conflict("Prompt key already used"))
			return
		}
		queueError(w, err)
		return
	}
	h.Dispatcher.Enqueue(Candidate{Scope: scope, TurnID: accepted.TurnID})
	writeJSON(w, http.StatusAccepted, map[string]any{"status": accepted.Status, "turnId": accepted.TurnID, "runId": runID, "legId": legID, "cursor": accepted.Cursor, "terminal": accepted.Terminal})
}
