package chat

import (
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// appendCompletedTx stores inert host results using the ordinary journal hashes.
// The row is terminal at insertion, so the model dispatcher can never claim it.
func (s *Store) appendCompletedTx(ctx context.Context, tx pgx.Tx, scope Scope, branch, id, leg string, request json.RawMessage, frames []json.RawMessage) error {
	_, canonical, err := parseCanonical(request)
	if err != nil {
		return err
	}
	requestHash := digestCanonical("request", canonical)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, id); err != nil {
		return err
	}
	var existing string
	err = tx.QueryRow(ctx, `SELECT request_hash FROM chat_turns WHERE id=$1`, id).Scan(&existing)
	if err == nil {
		if existing != requestHash {
			return ErrConflict
		}
		return nil
	}
	if err != pgx.ErrNoRows {
		return err
	}
	// Random, discarded capabilities fence all private replay/producer doors.
	ownerHash, accessHash, err := authHashes(scope, uuid.NewString())
	if err != nil {
		return err
	}
	writerHash, err := digest("writer", uuid.NewString())
	if err != nil {
		return err
	}
	now := s.now().UTC()
	acceptance, err := makeAcceptance(id, leg, ownerHash, accessHash, requestHash, writerHash, now.UnixMilli())
	if err != nil {
		return err
	}
	batch, n, err := makeBatch(initialCursor(acceptance), frames)
	if err != nil {
		return err
	}
	head := cursorAfter(batch)
	hash, err := headHash(acceptance, head, int64(n), true)
	if err != nil {
		return err
	}
	a, _ := json.Marshal(acceptance)
	f, _ := json.Marshal(frames)
	_, err = tx.Exec(ctx, `INSERT INTO chat_turns(id,repository_id,user_id,run_id,leg_id,request_payload,request_hash,owner_hash,access_hash,writer_hash,acceptance,acceptance_hash,accepted_at_ms,head_batch,head_position,cursor_hash,head_hash,output_bytes,terminal,state,producer_generation,created_at,updated_at,conversation_id) VALUES($1,$2,$3,$1,$18,$4,$5,$6,$7,$8,$9,$10,$11,1,$12,$13,$14,$15,true,'completed',1,$16,$16,$17)`, id, scope.RepositoryID, scope.UserID, json.RawMessage(canonical), requestHash, ownerHash, accessHash, writerHash, a, acceptance.Hash, now.UnixMilli(), head.Position, head.Hash, hash, n, now, branch, leg)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO chat_turn_batches(turn_id,batch_number,from_position,previous_hash,frames,hash,canonical_bytes) VALUES($1,1,1,$2,$3,$4,$5)`, id, batch.PreviousHash, f, batch.Hash, n)
	if err != nil {
		return err
	}
	if err = notifyTx(ctx, tx, id); err != nil {
		return err
	}
	return nil
}
