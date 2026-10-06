package chat

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// ReadMemberViewState serves the same private projection to authorized live
// subscriptions. The caller supplies the authenticated member, never an actor
// from a frame; membership is rechecked on each snapshot.
func (s *Store) ReadMemberViewState(ctx context.Context, userID int64, conversation string) (json.RawMessage, error) {
	return s.memberViewState(ctx, userID, conversation, nil)
}

// readMemberView takes one database snapshot of the member's view and private
// queue. No browser Draft, confirmation, other author's prompt or started turn
// enters this projection. Empty queues retain the existing view-state shape.
func (s *Store) readMemberView(ctx context.Context, userID int64, conversation string) (json.RawMessage, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	var result json.RawMessage
	var repositoryID int64
	err = tx.QueryRow(ctx, `SELECT c.repository_id, coalesce(c.view_state->$2,'{}'::jsonb) || jsonb_build_object('toasts_hidden',c.toasts_hidden)
 FROM collaborators c JOIN users u ON u.id=c.user_id
 JOIN install_settings i ON i.key='github.repository' AND (i.value->>'repository_id')::bigint=c.repository_id
 WHERE c.user_id=$1 AND c.suspended_at IS NULL AND NOT u.prohibit_login`, userID, conversation).Scan(&repositoryID, &result)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrForbidden
	}
	if err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `SELECT `+turnColumns+` FROM chat_turns WHERE repository_id=$1 AND user_id=$2 AND conversation_id=$3 AND state='queued' AND NOT terminal ORDER BY created_at,id`, repositoryID, userID, conversation)
	if err != nil {
		return nil, err
	}
	type queuedPrompt struct {
		ID     string `json:"id"`
		RunID  string `json:"runId"`
		LegID  string `json:"legId"`
		Prompt string `json:"prompt"`
		Cursor Cursor `json:"cursor"`
	}
	queue := []queuedPrompt{}
	for rows.Next() {
		turn, scanErr := scanTurn(rows)
		if scanErr != nil {
			rows.Close()
			return nil, scanErr
		}
		_, cursor, checkErr := checkHead(turn)
		if checkErr != nil {
			rows.Close()
			return nil, checkErr
		}
		_, prompt, metadataErr := conversationMetadata(turn)
		if metadataErr != nil {
			rows.Close()
			return nil, metadataErr
		}
		queue = append(queue, queuedPrompt{ID: turn.ID, RunID: turn.RunID, LegID: turn.LegID, Prompt: prompt, Cursor: cursor})
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return nil, err
	}
	var view map[string]json.RawMessage
	if err = json.Unmarshal(result, &view); err != nil {
		return nil, ErrCorrupt
	}
	// Saved browser input never supplies a queue. Only committed rows do.
	delete(view, "queue")
	if len(queue) > 0 {
		view["queue"], err = json.Marshal(queue)
		if err != nil {
			return nil, err
		}
	}
	result, err = json.Marshal(view)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return result, nil
}

// View state belongs to the authenticated member, never to a shared entry.
// Resolve the single installed repository and recheck suspension on each write.
func (s *Store) memberViewState(ctx context.Context, userID int64, conversation string, value json.RawMessage) (json.RawMessage, error) {
	if !validIdentity(conversation) || userID <= 0 {
		return nil, ErrInvalidRequest
	}
	if value == nil {
		return s.readMemberView(ctx, userID, conversation)
	}
	var row pgx.Row
	{
		object, canonical, err := parseCanonical(value)
		if err != nil {
			return nil, err
		}
		state, ok := object.(map[string]any)
		if !ok {
			return nil, ErrInvalidRequest
		}
		if _, supplied := state["queue"]; supplied {
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
	{
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
	branch, err := h.branch(w, r, scope)
	if err != nil {
		return
	}
	var value json.RawMessage
	if r.Method == http.MethodPut {
		if !decodeBounded(w, r, &value) {
			return
		}
	}
	result, err := h.Store.memberViewState(r.Context(), scope.UserID, branch, value)
	if err != nil {
		publicError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
