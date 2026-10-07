package chat

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// notifyTx wakes the author's live queue after a journal change commits.
func notifyTx(ctx context.Context, tx pgx.Tx, turnID string) error {
	_, err := tx.Exec(ctx, `SELECT pg_notify('view_' || repository_id::text || '_' || user_id::text,'{"type":"queue"}') FROM chat_turns WHERE id=$1`, turnID)
	return err
}
