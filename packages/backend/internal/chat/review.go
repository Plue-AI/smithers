package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"

	"github.com/google/uuid"
)

// DeliverReview appends a completed, inert result to the shared conversation.
// operation is the durable review job ID. A lost reply can replay delivery,
// but cannot replace that job's findings or enqueue another model turn.
func (s *Store) DeliverReview(ctx context.Context, scope Scope, branch, operation, prURL string, number int64, change json.RawMessage) error {
	if s == nil || scope.RepositoryID <= 0 || scope.UserID <= 0 || !validIdentity(branch) || !validIdentity(operation) || number <= 0 {
		return ErrInvalidRequest
	}
	link, err := url.Parse(prURL)
	if err != nil || link.Scheme != "https" || link.Host == "" || link.User != nil || !strings.HasSuffix(link.Path, fmt.Sprintf("/pull/%d", number)) {
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
	card := map[string]any{"id": "review-" + operation, "kind": "change", "title": "Review", "payload": payload}
	request, err := json.Marshal(map[string]any{"purpose": "conversation", "conversationId": branch, "sharedConversation": true, "reviewResult": card, "reviewURL": link.String(), "messages": []any{map[string]any{"role": "user", "content": fmt.Sprintf("/review #%d", number)}}})
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
	pr, _ := json.Marshal(map[string]any{"runId": id, "type": "delta", "kind": "text", "text": fmt.Sprintf("[#%d](<%s>)", number, link.String())})
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	if err := s.appendCompletedTx(ctx, tx, scope, branch, id, "review", request, []json.RawMessage{frame, pr, done}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
