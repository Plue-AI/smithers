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

// ReadMemberViewState serves the same private projection to authorized live
// subscriptions. The caller supplies the authenticated member, never an actor
// from a frame; membership is rechecked on each snapshot.
func (s *Store) ReadMemberViewState(ctx context.Context, userID int64, conversation string) (json.RawMessage, error) {
	return s.memberViewState(ctx, userID, conversation, nil)
}

// View state belongs to the authenticated member, never to a shared entry.
// Resolve the single installed repository and recheck suspension on each write.
func (s *Store) memberViewState(ctx context.Context, userID int64, conversation string, value json.RawMessage) (json.RawMessage, error) {
	if !validIdentity(conversation) || userID <= 0 {
		return nil, ErrInvalidRequest
	}
	var row pgx.Row
	if value == nil {
		row = s.pool.QueryRow(ctx, `SELECT coalesce(c.view_state->$2,'{}'::jsonb) || jsonb_build_object('toasts_hidden',c.toasts_hidden) FROM collaborators c
   JOIN install_settings i ON i.key='github.repository' AND (i.value->>'repository_id')::bigint=c.repository_id
   WHERE c.user_id=$1 AND c.suspended_at IS NULL`, userID, conversation)
	} else {
		object, canonical, err := parseCanonical(value)
		if err != nil {
			return nil, err
		}
		state, ok := object.(map[string]any)
		if !ok {
			return nil, ErrInvalidRequest
		}
		var hidden *bool
		if preference, present := state["toasts_hidden"]; present {
			flag, ok := preference.(bool)
			if !ok {
				return nil, ErrInvalidRequest
			}
			hidden = &flag
		}
		// Toast visibility is global for this member. Strip any per-branch
		// copy so changing branches cannot restore an older preference.
		row = s.pool.QueryRow(ctx, `UPDATE collaborators c SET view_state=jsonb_set(c.view_state,ARRAY[$2],$3::jsonb-'toasts_hidden',true),
   toasts_hidden=COALESCE($4,c.toasts_hidden)
   FROM install_settings i WHERE i.key='github.repository' AND (i.value->>'repository_id')::bigint=c.repository_id
   AND c.user_id=$1 AND c.suspended_at IS NULL RETURNING (c.view_state->$2) || jsonb_build_object('toasts_hidden',c.toasts_hidden),
   pg_notify('view_' || c.repository_id::text || '_' || c.user_id::text,'{"type":"view_state"}')`, userID, conversation, canonical, hidden)
	}
	var result json.RawMessage
	var err error
	if value == nil {
		err = row.Scan(&result)
	} else {
		// PostgreSQL emits the hint only when the update commits. It carries
		// no private state; authorized subscribers reread the saved projection.
		var hint any
		err = row.Scan(&result, &hint)
	}
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
