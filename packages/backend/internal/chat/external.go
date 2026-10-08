package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ExternalDraft is the inert output of the install-shipped T-AGT-01 adapter.
// Identities must be compared with the authenticated session binding by ingest,
// never inferred from transcript text. Imported entries are completed journals,
// so the existing dispatcher cannot claim them or run their reported tools.
type ExternalDraft struct {
	ID           string          `json:"id"`
	SourceID     string          `json:"source_id"`
	SourceOffset uint64          `json:"source_offset"`
	Origin       string          `json:"origin"`
	ReadOnly     bool            `json:"read_only"`
	Agent        string          `json:"agent"`
	Profile      string          `json:"source_format_version"`
	Session      string          `json:"session_id"`
	Participant  string          `json:"participant_id"`
	Owner        string          `json:"owner_id"`
	Author       string          `json:"author_id"`
	Kind         string          `json:"kind"`
	Body         json.RawMessage `json:"body"`
	CallID       string          `json:"call_id,omitempty"`
	Failed       bool            `json:"failed,omitempty"`
	Sequence     uint64          `json:"seq,omitempty"`
	At           int64           `json:"at,omitempty"`
	TurnID       string          `json:"turn_id,omitempty"`
}

func (d ExternalDraft) valid() bool {
	if d.ID == "" || d.SourceID == "" || d.Origin != "external" || !d.ReadOnly || d.Session == "" || d.Participant == "" || d.Owner == "" || !json.Valid(d.Body) {
		return false
	}
	// The release-valued aliases remain readable for already persisted rows.
	// New host drafts use the adapter's canonical minor-version profile.
	if !((d.Agent == "claude-code" && oneOf(d.Profile, "claude-code/2.1", "claude-code/2.1.0")) || (d.Agent == "codex" && oneOf(d.Profile, "codex-rollout/0.160", "codex/0.160.0"))) {
		return false
	}
	if !oneOf(d.Kind, "prompt", "assistant", "thinking", "attachment", "tool_request", "tool_result", "edit", "error") {
		return false
	}
	if d.Kind == "prompt" {
		return d.Author == d.Owner
	}
	return d.Author == d.Participant
}

func externalTurn(turn turnRecord) bool {
	var r struct {
		Origin string `json:"origin"`
	}
	return json.Unmarshal(turn.Request, &r) == nil && r.Origin == "external"
}

// ImportExternalTx uses the caller's receipt transaction. It never commits or
// publishes outside it: a failed receipt/entry append rolls back both. The
// adapter's stable ID deduplicates source-offset replay even with a new event ID.
// No new store/table or producer credential is created.
func (s *Store) ImportExternalTx(ctx context.Context, tx pgx.Tx, scope Scope, branch string, drafts []ExternalDraft) error {
	if s == nil || tx == nil || scope.RepositoryID <= 0 || scope.UserID <= 0 || !validIdentity(branch) {
		return ErrInvalidRequest
	}
	var member int
	if err := tx.QueryRow(ctx, `SELECT 1 FROM collaborators c JOIN users u ON u.id=c.user_id WHERE c.repository_id=$1 AND c.user_id=$2 AND c.suspended_at IS NULL AND NOT u.prohibit_login FOR SHARE OF c,u`, scope.RepositoryID, scope.UserID).Scan(&member); err != nil {
		if err == pgx.ErrNoRows {
			return ErrForbidden
		}
		return err
	}
	for _, d := range drafts {
		if !d.valid() || d.Owner != fmt.Sprint(scope.UserID) {
			return ErrInvalidRequest
		}
		encoded, err := json.Marshal(d)
		if err != nil {
			return err
		}
		if len(encoded) > maxPayloadBytes {
			return ErrLimit
		}
		id := uuid.NewSHA1(uuid.NameSpaceOID, []byte(fmt.Sprintf("external:%d:%s:%s", scope.RepositoryID, branch, d.ID))).String()
		prompt := ""
		if d.Kind == "prompt" {
			prompt, _ = externalText(d)
		}
		request, err := json.Marshal(map[string]any{"origin": "external", "external": d, "purpose": "conversation", "conversationId": branch, "sharedConversation": true, "messages": []any{map[string]any{"role": "user", "content": prompt}}})
		if err != nil {
			return err
		}
		_, canonical, err := parseCanonical(request)
		if err != nil {
			return err
		}
		requestHash := digestCanonical("request", canonical)
		var existing string
		err = tx.QueryRow(ctx, `SELECT request_hash FROM chat_turns WHERE id=$1`, id).Scan(&existing)
		if err == nil {
			if existing != requestHash {
				return ErrConflict
			}
			continue
		}
		if err != pgx.ErrNoRows {
			return err
		}
		frames := []json.RawMessage{}
		if d.Kind == "assistant" {
			text, _ := externalText(d)
			f, _ := json.Marshal(map[string]any{"runId": id, "type": "delta", "kind": "text", "text": text})
			frames = append(frames, f)
		}
		if err = appendCompletedEntryTx(ctx, tx, scope, branch, id, "external", canonical, frames, s.now().UTC()); err != nil {
			return err
		}
	}
	return nil
}
