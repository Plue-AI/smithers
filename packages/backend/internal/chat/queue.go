package chat

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// Cancellation seals the existing journal and fences the producer in the same
// transaction. Both the account stop and branch queue use this writer.
func (s *Store) cancelTurnTx(ctx context.Context, tx pgx.Tx, turn *turnRecord, now time.Time) error {
	if _, err := tx.Exec(ctx, `UPDATE chat_turns SET cancel_requested_at=COALESCE(cancel_requested_at,$2),updated_at=$2 WHERE id=$1`, turn.ID, now); err != nil {
		return err
	}
	turn.CancelRequestedAt = &now
	return s.appendTerminalTx(ctx, tx, turn, cancelledFrame(turn.RunID), StateCancelled, now)
}

// MutateQueuedTurn locks the same row Claim locks. Once Claim starts the turn,
// edits and removal refuse; no shared output or legacy private row is mutable.
func (s *Store) MutateQueuedTurn(ctx context.Context, scope Scope, branch, id, method, prompt string) (Cursor, error) {
	if scope.RepositoryID <= 0 || scope.UserID <= 0 || !validIdentity(branch) || !validIdentity(id) {
		return Cursor{}, ErrInvalidRequest
	}
	if method == http.MethodPatch && (strings.TrimSpace(prompt) == "" || len(prompt) > maxPayloadBytes/2) {
		return Cursor{}, ErrInvalidRequest
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Cursor{}, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	turn, err := scanTurn(tx.QueryRow(ctx, `SELECT `+turnColumns+` FROM chat_turns WHERE repository_id=$1 AND conversation_id=$2 AND id=$3 FOR UPDATE`, scope.RepositoryID, branch, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Cursor{}, ErrNotFound
	}
	if err != nil {
		return Cursor{}, err
	}
	if externalTurn(turn) {
		return Cursor{}, ErrForbidden
	}
	if turn.UserID != scope.UserID {
		return Cursor{}, ErrForbidden
	}
	inactive, err := inactiveAuthor(ctx, tx, turn.ID)
	if err != nil {
		return Cursor{}, err
	}
	if inactive {
		return Cursor{}, ErrForbidden
	}
	acceptance, cursor, err := checkHead(turn)
	if err != nil {
		return Cursor{}, err
	}
	if method != http.MethodPost && turn.State != StateQueued {
		return Cursor{}, ErrConflict
	}
	now := s.now().UTC()
	switch method {
	case http.MethodPost, http.MethodDelete:
		if !turn.Terminal {
			if err = s.cancelTurnTx(ctx, tx, &turn, now); err != nil {
				return Cursor{}, err
			}
			cursor, err = cursorOf(turn)
			if err != nil {
				return Cursor{}, err
			}
		}
	case http.MethodPatch:
		// A queued turn has no output. Re-seal its zero-batch acceptance and return
		// the new replay boundary rather than changing an already emitted batch.
		if cursor.Batch != 0 || turn.ProducerGeneration != 0 {
			return Cursor{}, ErrConflict
		}
		value, canonical, parseErr := parseCanonical(turn.Request)
		if parseErr != nil || digestCanonical("request", canonical) != turn.RequestHash {
			return Cursor{}, ErrCorrupt
		}
		request, ok := value.(map[string]any)
		if !ok {
			return Cursor{}, ErrCorrupt
		}
		messages, ok := request["messages"].([]any)
		if !ok {
			return Cursor{}, ErrCorrupt
		}
		changed := false
		for i := len(messages) - 1; i >= 0; i-- {
			message, ok := messages[i].(map[string]any)
			if ok && message["role"] == "user" {
				message["content"] = prompt
				changed = true
				break
			}
		}
		if !changed {
			return Cursor{}, ErrCorrupt
		}
		canonical, err = canonicalValue(request)
		if err != nil {
			return Cursor{}, err
		}
		requestHash := digestCanonical("request", canonical)
		acceptance, err = makeAcceptance(turn.RunID, turn.LegID, acceptance.OwnerHash, acceptance.AccessHash, requestHash, acceptance.WriterHash, *turn.AcceptedAtMS)
		if err != nil {
			return Cursor{}, err
		}
		cursor = initialCursor(acceptance)
		hash, err := headHash(acceptance, cursor, 0, false)
		if err != nil {
			return Cursor{}, err
		}
		raw, err := json.Marshal(acceptance)
		if err != nil {
			return Cursor{}, err
		}
		_, err = tx.Exec(ctx, `UPDATE chat_turns SET request_payload=$2,request_hash=$3,acceptance=$4,acceptance_hash=$5,cursor_hash=$5,head_hash=$6,updated_at=$7 WHERE id=$1`, turn.ID, json.RawMessage(canonical), requestHash, raw, acceptance.Hash, hash, now)
		if err != nil {
			return Cursor{}, err
		}
		if err = notifyTx(ctx, tx, turn.ID); err != nil {
			return Cursor{}, err
		}
	default:
		return Cursor{}, ErrInvalidRequest
	}
	if err = tx.Commit(ctx); err != nil {
		return Cursor{}, err
	}
	s.signals.notify(turn.ID)
	return cursor, nil
}

func queueProblem(w http.ResponseWriter, status int, code string) {
	class := "user"
	if status == http.StatusForbidden {
		class = "permission"
	}
	if status == http.StatusConflict {
		class = "conflict"
	}
	if status >= 500 {
		class = "infra"
	}
	writeJSON(w, status, map[string]string{"class": class, "code": code, "message": http.StatusText(status)})
}

func queueError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrForbidden):
		pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodePermission, "Only the author can change this prompt"))
	case errors.Is(err, ErrNotFound):
		pkgerrors.WriteError(w, pkgerrors.NotFound("Prompt unavailable"))
	case errors.Is(err, ErrInvalidRequest):
		queueProblem(w, 400, "request_invalid")
	case errors.Is(err, ErrConflict):
		pkgerrors.WriteError(w, pkgerrors.Conflict("The prompt has started"))
	case errors.Is(err, ErrCorrupt):
		pkgerrors.WriteError(w, pkgerrors.Internal("Prompt journal unavailable"))
	default:
		queueProblem(w, 503, "storage_failed")
	}
}

func (h *Handler) QueueTurn(w http.ResponseWriter, r *http.Request) {
	// Queue editing is a person's action; an agent cannot rewrite a person's
	// unstarted prompt, or use a body author to select somebody else's turn.
	if auth := middleware.AuthInfoFromContext(r.Context()); auth == nil || auth.IsAgent() {
		queueError(w, ErrForbidden)
		return
	}
	scope, ok := h.publicScope(w, r)
	if !ok {
		return
	}
	var input struct {
		Prompt string `json:"prompt"`
	}
	if r.Method == http.MethodPatch && !decodeBoundedWithProblem(w, r, &input, queueProblem) {
		return
	}
	branch, err := h.branch(w, r, scope)
	if err != nil {
		return
	}
	id := chi.URLParam(r, "id")
	cursor, err := h.Store.MutateQueuedTurn(r.Context(), scope, branch, id, r.Method, input.Prompt)
	if err != nil {
		queueError(w, err)
		return
	}
	if r.Method != http.MethodPatch && h.Dispatcher != nil {
		h.Dispatcher.CancelRunning(id)
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "cursor": cursor})
}
