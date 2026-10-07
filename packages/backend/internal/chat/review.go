package chat

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
)

// DeliverReview appends a completed, inert result to the shared conversation.
// operation is the durable review job ID. A lost reply can replay delivery,
// but cannot replace that job's findings or enqueue another model turn.
func (s *Store) DeliverReview(ctx context.Context, scope Scope, branch, operation string, number int64, change json.RawMessage) error {
	if s == nil || scope.RepositoryID <= 0 || scope.UserID <= 0 || !validIdentity(branch) || !validIdentity(operation) || number <= 0 {
		return ErrInvalidRequest
	}
	// This inert journal has no caller-held private replay capability.
	scope.Owner = fmt.Sprintf("review-result:%d", scope.UserID)
	var payload map[string]json.RawMessage
	if json.Unmarshal(change, &payload) != nil || payload == nil {
		return ErrInvalidRequest
	}
	payload["facet"] = json.RawMessage(`"findings"`)
	id := uuid.NewSHA1(uuid.NameSpaceOID, []byte(fmt.Sprintf("review:%d:%d:%s", scope.RepositoryID, scope.UserID, operation))).String()
	card := map[string]any{"id": id, "kind": "change", "title": "Review", "payload": payload}
	request, err := json.Marshal(map[string]any{"purpose": "conversation", "conversationId": branch, "sharedConversation": true, "reviewResult": card, "messages": []any{map[string]any{"role": "user", "content": fmt.Sprintf("/review #%d", number)}}})
	if err != nil {
		return err
	}
	if len(request) > maxPayloadBytes {
		return ErrLimit
	}
	frame, err := json.Marshal(map[string]any{"runId": id, "type": "card", "card": card})
	if err != nil {
		return err
	}
	done, _ := json.Marshal(map[string]any{"runId": id, "type": "done", "reason": "stop"})
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	if err := s.appendCompletedTx(ctx, tx, scope, branch, id, "review", request, []json.RawMessage{frame, done}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
