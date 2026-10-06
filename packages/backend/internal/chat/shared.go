package chat

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
)

// SharedTurn is a public projection, not a journal capability. Private request
// context, writer tokens, approvals and the member's queue never enter it.
type SharedTurn struct {
	ID     string            `json:"id"`
	Author int64             `json:"author"`
	RunID  string            `json:"runId"`
	Prompt string            `json:"prompt"`
	State  State             `json:"state"`
	Frames []json.RawMessage `json:"frames"`
}
type SharedConversation struct {
	ID      string       `json:"id"`
	Entries []SharedTurn `json:"entries"`
}

// SharedEntries rereads active install membership and the committed journal in
// one snapshot. Branch access is resolved by the HTTP/live composition before
// this read. Legacy private rows are never promoted into the shared transcript.
func (s *Store) SharedEntries(ctx context.Context, scope Scope, branch string) (SharedConversation, error) {
	result := SharedConversation{ID: branch, Entries: []SharedTurn{}}
	if scope.RepositoryID <= 0 || scope.UserID <= 0 || !validIdentity(branch) {
		return result, ErrInvalidRequest
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return result, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	var active bool
	err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM collaborators c JOIN users u ON u.id=c.user_id JOIN install_settings i ON i.key='github.repository' AND (i.value->>'repository_id')::bigint=c.repository_id WHERE c.repository_id=$1 AND c.user_id=$2 AND c.suspended_at IS NULL AND NOT u.prohibit_login)`, scope.RepositoryID, scope.UserID).Scan(&active)
	if err != nil {
		return result, err
	}
	if !active {
		return result, ErrForbidden
	}
	rows, err := tx.Query(ctx, `SELECT `+turnColumns+` FROM chat_turns WHERE repository_id=$1 AND conversation_id=$2 AND producer_generation>0 AND state NOT IN ('queued','retired') AND request_payload->>'sharedConversation'='true' ORDER BY created_at,id`, scope.RepositoryID, branch)
	if err != nil {
		return result, err
	}
	turns := []turnRecord{}
	for rows.Next() {
		turn, e := scanTurn(rows)
		if e != nil {
			rows.Close()
			return result, e
		}
		turns = append(turns, turn)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return result, err
	}
	for _, turn := range turns {
		_, prompt, e := conversationMetadata(turn)
		if e != nil {
			return result, e
		}
		acceptance, _, e := checkHead(turn)
		if e != nil {
			return result, e
		}
		entry := SharedTurn{ID: turn.ID, Author: turn.UserID, RunID: turn.RunID, Prompt: prompt, State: turn.State, Frames: []json.RawMessage{}}
		cursor := initialCursor(acceptance)
		for {
			page, e := s.replayVerified(ctx, tx, turn, cursor, maxReplayBatches)
			if e != nil {
				return result, e
			}
			for _, batch := range page.Batches {
				for _, frame := range batch.Frames {
					if sharedFrame(frame) {
						entry.Frames = append(entry.Frames, frame)
					}
				}
			}
			if !page.More {
				break
			}
			cursor = page.Next
		}
		result.Entries = append(result.Entries, entry)
	}
	if err = tx.Commit(ctx); err != nil {
		return result, err
	}
	return result, nil
}

// Only visible answer output crosses the shared audience. Tool arguments,
// reasoning, preflight internals and private card kinds remain outside it.
func sharedFrame(raw json.RawMessage) bool {
	var frame struct {
		Type string `json:"type"`
		Kind string `json:"kind"`
		Card struct {
			Kind string `json:"kind"`
		} `json:"card"`
	}
	if json.Unmarshal(raw, &frame) != nil {
		return false
	}
	switch frame.Type {
	case "delta":
		return frame.Kind == "text"
	case "done", "error":
		return true
	case "card":
		switch frame.Card.Kind {
		case "todo", "file", "diff", "run-trace", "home", "flow", "wiki":
			return true
		}
	}
	return false
}

func (h *Handler) Conversation(w http.ResponseWriter, r *http.Request) {
	scope, ok := h.publicScope(w, r)
	if !ok {
		return
	}
	branch, err := h.branch(w, r, scope)
	if err != nil {
		return
	}
	result, err := h.Store.SharedEntries(r.Context(), scope, branch)
	if err != nil {
		if errors.Is(err, ErrForbidden) {
			queueError(w, err)
		} else {
			publicError(w, err)
		}
		return
	}
	writeJSON(w, http.StatusOK, result)
}
