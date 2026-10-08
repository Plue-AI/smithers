package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// SubjectEntry is a committed TODO card fact, never a viewer's action.
type SubjectEntry struct {
	Number int64  `json:"n"`
	Title  string `json:"title"`
	State  string `json:"state"`
	Tone   string `json:"tone"`
}

// SubjectTone consumes the single TODO state projection; it is not another
// state machine. Attention outranks live work, including stack attention.
func SubjectTone(state string, attention bool) string {
	if attention || state == "needs_you" {
		return "attention"
	}
	switch state {
	case "starting", "working":
		return "live"
	case "failed":
		return "failed"
	case "merged", "dropped":
		return "done"
	default:
		return "quiet"
	}
}

// PublishSubjectTx publishes one card per TODO and updates its derived facts
// in the source transaction, preserving the original verified journal. Discarded random capabilities and terminal state ensure that
// an event can neither be claimed by the model dispatcher nor used as a tool.
func PublishSubjectTx(ctx context.Context, tx pgx.Tx, scope Scope, branch, event string, subject SubjectEntry, card json.RawMessage) error {
	if scope.RepositoryID <= 0 || scope.UserID <= 0 || !validIdentity(branch) || event == "" || subject.Number <= 0 {
		return ErrInvalidRequest
	}
	id := uuid.NewSHA1(uuid.NameSpaceOID, []byte(fmt.Sprintf("subject:%d:%d:%s", scope.RepositoryID, subject.Number, branch))).String()
	subjectBytes, err := json.Marshal(struct {
		SubjectEntry
		Card json.RawMessage `json:"card"`
	}{subject, card})
	if err != nil {
		return err
	}
	result, err := tx.Exec(ctx, `UPDATE chat_turns SET entry_subject=$2,updated_at=clock_timestamp() WHERE id=$1`, id, subjectBytes)
	if err != nil {
		return err
	}
	if result.RowsAffected() > 0 {
		return notifyTx(ctx, tx, id)
	}
	request, err := json.Marshal(map[string]any{"purpose": "conversation", "conversationId": branch, "sharedConversation": true, "subject": subject, "messages": []any{}})
	if err != nil {
		return err
	}
	_, canonical, err := parseCanonical(request)
	if err != nil {
		return err
	}
	frame, err := json.Marshal(map[string]any{"runId": id, "type": "card", "card": json.RawMessage(card)})
	if err != nil {
		return err
	}
	if err := appendCompletedEntryTx(ctx, tx, scope, branch, id, "subject", canonical, []json.RawMessage{frame}, time.Now().UTC()); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE chat_turns SET entry_subject=$2 WHERE id=$1`, id, subjectBytes)
	return err
}

// Both imported and subject entries use the ordinary journal format and cursor.
func appendCompletedEntryTx(ctx context.Context, tx pgx.Tx, scope Scope, branch, id, leg string, canonical string, frames []json.RawMessage, now time.Time) error {
	ownerHash, accessHash, err := authHashes(scope, uuid.NewString())
	if err != nil {
		return err
	}
	writerHash, err := digest("writer", uuid.NewString())
	if err != nil {
		return err
	}
	requestHash := digestCanonical("request", canonical)
	acceptance, err := makeAcceptance(id, leg, ownerHash, accessHash, requestHash, writerHash, now.UnixMilli())
	if err != nil {
		return err
	}
	done, _ := json.Marshal(map[string]any{"runId": id, "type": "done", "reason": "stop"})
	frames = append(frames, done)
	if _, err = validateFrames(frames, id); err != nil {
		return err
	}
	batch, n, err := makeBatch(initialCursor(acceptance), frames)
	if err != nil {
		return err
	}
	if n > maxBatchBytes {
		return ErrLimit
	}
	head := cursorAfter(batch)
	hash, err := headHash(acceptance, head, int64(n), true)
	if err != nil {
		return err
	}
	a, _ := json.Marshal(acceptance)
	f, _ := json.Marshal(frames)
	_, err = tx.Exec(ctx, `INSERT INTO chat_turns(id,repository_id,user_id,run_id,leg_id,request_payload,request_hash,owner_hash,access_hash,writer_hash,acceptance,acceptance_hash,accepted_at_ms,head_batch,head_position,cursor_hash,head_hash,output_bytes,terminal,state,producer_generation,created_at,updated_at,conversation_id) VALUES($1,$2,$3,$1,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,$13,$14,$15,$16,true,'completed',1,$17,$17,$18)`, id, scope.RepositoryID, scope.UserID, leg, json.RawMessage(canonical), requestHash, ownerHash, accessHash, writerHash, a, acceptance.Hash, now.UnixMilli(), head.Position, head.Hash, hash, n, now, branch)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO chat_turn_batches(turn_id,batch_number,from_position,previous_hash,frames,hash,canonical_bytes) VALUES($1,1,1,$2,$3,$4,$5)`, id, batch.PreviousHash, f, batch.Hash, n)
	if err != nil {
		return err
	}
	return notifyTx(ctx, tx, id)
}
