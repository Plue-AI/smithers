package chat

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// SharedTurn is a public projection, not a journal capability. Private request
// context, writer tokens, approvals and the member's queue never enter it.
type SharedContextPreflight struct {
	Context    []json.RawMessage `json:"context"`
	Candidates []json.RawMessage `json:"candidates"`
	Model      string            `json:"model"`
	DurationMs float64           `json:"durationMs"`
}

type SharedTurn struct {
	ID          string                  `json:"id"`
	Author      int64                   `json:"author"`
	AuthorLogin string                  `json:"authorLogin"`
	RunID       string                  `json:"runId"`
	Prompt      string                  `json:"prompt"`
	State       State                   `json:"state"`
	Frames      []json.RawMessage       `json:"frames"`
	Context     *[]json.RawMessage      `json:"context,omitempty"`
	Preflight   *SharedContextPreflight `json:"preflight,omitempty"`
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
	installedID, err := db.New(tx).InstallRepositoryID(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, ErrForbidden
	}
	if err != nil {
		return result, err
	}
	if installedID != scope.RepositoryID {
		return result, ErrForbidden
	}
	var active bool
	err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM collaborators c JOIN users u ON u.id=c.user_id WHERE c.repository_id=$1 AND c.user_id=$2 AND c.suspended_at IS NULL AND NOT u.prohibit_login)`, scope.RepositoryID, scope.UserID).Scan(&active)
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
		if err := tx.QueryRow(ctx, `SELECT username FROM users WHERE id=$1`, turn.UserID).Scan(&entry.AuthorLogin); err != nil {
			return result, err
		}
		cursor := initialCursor(acceptance)
		var preflight sharedPreflight
		for {
			page, e := s.replayVerified(ctx, tx, turn, cursor, maxReplayBatches)
			if e != nil {
				return result, e
			}
			for _, batch := range page.Batches {
				for _, frame := range batch.Frames {
					if err := preflight.apply(frame); err != nil {
						return result, err
					}
					entry.Context = preflight.context
					entry.Preflight = preflight.result
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

// sharedContext projects only the completed selection. Candidate contents,
// model inputs and arbitrary producer fields are never shared with the answer.
// Historical frames without a phase are completed selections too.
func sharedContext(raw json.RawMessage) []json.RawMessage {
	var frame struct {
		Type   string `json:"type"`
		Phase  string `json:"phase"`
		Result struct {
			Context []map[string]json.RawMessage `json:"context"`
		} `json:"result"`
	}
	if json.Unmarshal(raw, &frame) != nil || frame.Type != "context.preflight" || (frame.Phase != "" && frame.Phase != "completed") {
		return nil
	}
	result := make([]json.RawMessage, 0, len(frame.Result.Context))
	for _, item := range frame.Result.Context {
		selected := make(map[string]json.RawMessage)
		for _, key := range []string{"kind", "label", "ref", "revision", "reason"} {
			if value, ok := item[key]; ok {
				selected[key] = value
			}
		}
		encoded, err := json.Marshal(selected)
		if err != nil {
			return nil
		}
		result = append(result, encoded)
	}
	return result
}

// sharedPreflight assembles numbered selections across replay pages. A partial
// phase is never a shared context list; a new page zero fences interrupted work.
type sharedPreflight struct {
	result       *SharedContextPreflight
	candidates   []json.RawMessage
	context      *[]json.RawMessage
	pending      []json.RawMessage
	phase, model string
	duration     float64
	next, total  int
}

func (p *sharedPreflight) apply(raw json.RawMessage) error {
	var frame struct {
		Type, Phase string
		Page        *struct{ Index, Total float64 }
		Result      struct {
			Model      string
			DurationMs float64
			Candidates []map[string]json.RawMessage
		}
	}
	if json.Unmarshal(raw, &frame) != nil {
		return ErrInvalidFrame
	}
	if frame.Type != "context.preflight" {
		return nil
	}
	if frame.Page == nil {
		*p = sharedPreflight{}
		if selected := sharedContext(raw); selected != nil {
			p.context = &selected
			p.result = &SharedContextPreflight{Context: selected, Candidates: sharedCandidateItems(frame.Result.Candidates), Model: frame.Result.Model, DurationMs: frame.Result.DurationMs}
		}
		return nil
	}
	page := frame.Page
	if page.Index < 0 || page.Total <= page.Index || page.Index != math.Trunc(page.Index) || page.Total != math.Trunc(page.Total) || page.Total > 9007199254740991 || !oneOf(frame.Phase, "started", "completed") {
		return ErrInvalidFrame
	}
	if page.Index == 0 {
		*p = sharedPreflight{phase: frame.Phase, model: frame.Result.Model, duration: frame.Result.DurationMs, total: int(page.Total), pending: []json.RawMessage{}, candidates: []json.RawMessage{}}
	} else if float64(p.next) != page.Index || float64(p.total) != page.Total || p.phase != frame.Phase || p.model != frame.Result.Model || p.duration != frame.Result.DurationMs {
		return ErrInvalidFrame
	}
	if frame.Phase == "completed" {
		p.pending = append(p.pending, sharedContext(raw)...)
	}
	p.candidates = append(p.candidates, sharedCandidateItems(frame.Result.Candidates)...)
	p.next++
	if p.next == p.total && frame.Phase == "completed" {
		selected := p.pending
		p.context = &selected
		p.result = &SharedContextPreflight{Context: selected, Candidates: p.candidates, Model: p.model, DurationMs: p.duration}
	}
	return nil
}

// Inspect shares only pinned source identities; repository bytes and extra
// fields in a provider frame never cross this audience projection.
func sharedCandidateItems(items []map[string]json.RawMessage) []json.RawMessage {
	result := make([]json.RawMessage, 0, len(items))
	for _, item := range items {
		selected := map[string]json.RawMessage{}
		for _, key := range []string{"kind", "label", "ref", "revision"} {
			if value, ok := item[key]; ok {
				selected[key] = value
			}
		}
		encoded, _ := json.Marshal(selected)
		result = append(result, encoded)
	}
	return result
}
