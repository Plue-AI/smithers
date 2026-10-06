package chat

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// View state belongs to the authenticated member, never to a shared entry.
// Resolve the single installed repository and recheck suspension on each write.
func (s *Store) memberViewState(ctx context.Context, userID int64, conversation string, value json.RawMessage) (json.RawMessage, error) {
	if !validIdentity(conversation) || userID <= 0 {
		return nil, ErrInvalidRequest
	}
	var row pgx.Row
	if value == nil {
		row = s.pool.QueryRow(ctx, `SELECT coalesce(c.view_state->$2,'{}'::jsonb) FROM collaborators c
   JOIN install_settings i ON i.key='github.repository' AND (i.value->>'repository_id')::bigint=c.repository_id
   WHERE c.user_id=$1 AND c.suspended_at IS NULL`, userID, conversation)
	} else {
		object, canonical, err := parseCanonical(value)
		if err != nil {
			return nil, err
		}
		if _, ok := object.(map[string]any); !ok {
			return nil, ErrInvalidRequest
		}
		row = s.pool.QueryRow(ctx, `UPDATE collaborators c SET view_state=jsonb_set(c.view_state,ARRAY[$2],$3::jsonb,true)
   FROM install_settings i WHERE i.key='github.repository' AND (i.value->>'repository_id')::bigint=c.repository_id
   AND c.user_id=$1 AND c.suspended_at IS NULL RETURNING c.view_state->$2`, userID, conversation, canonical)
	}
	var result json.RawMessage
	err := row.Scan(&result)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrForbidden
	}
	return result, err
}

func (h *Handler) ViewState(w http.ResponseWriter, r *http.Request) {
	// Agent turns may consume shared entries, never a person's private view.
	if auth := middleware.AuthInfoFromContext(r.Context()); auth == nil || auth.IsAgent() {
		writeProblem(w, http.StatusForbidden, "forbidden")
		return
	}
	scope, ok := h.publicScope(w, r)
	if !ok {
		return
	}
	var value json.RawMessage
	if r.Method == http.MethodPut {
		if !decodeBounded(w, r, &value) {
			return
		}
	}
	result, err := h.Store.memberViewState(r.Context(), scope.UserID, chi.URLParam(r, "b"), value)
	if err != nil {
		publicError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
