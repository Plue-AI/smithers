package chat

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
)

// The installed repository is the authority for host-owned branch turns.
// Legacy journals outside that binding retain their account-only audience.
const inactiveInstallAuthor = `EXISTS(SELECT 1 FROM install_settings i
 WHERE i.key='github.repository' AND (i.value->>'repository_id')::bigint=t.repository_id)
 AND NOT EXISTS(SELECT 1 FROM collaborators c JOIN users u ON u.id=c.user_id
 WHERE c.repository_id=t.repository_id AND c.user_id=t.user_id
 AND c.suspended_at IS NULL AND NOT u.prohibit_login)`

func authorRevokedFrame(runID string) json.RawMessage {
	value, _ := json.Marshal(map[string]any{"runId": runID, "type": "done", "reason": "cancelled", "code": "author_revoked"})
	return value
}

// RevokeInactiveAuthors also covers queued turns and changes committed by
// another API process. The terminal append fences producer callbacks in the
// same transaction; dispatchers then cancel their local host contexts.
func (s *Store) RevokeInactiveAuthors(ctx context.Context) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	rows, err := tx.Query(ctx, `SELECT `+turnColumns+` FROM chat_turns t WHERE NOT t.terminal AND t.conversation_id IS NOT NULL AND `+inactiveInstallAuthor+` ORDER BY t.id LIMIT 100 FOR UPDATE OF t SKIP LOCKED`)
	if err != nil {
		return err
	}
	var turns []turnRecord
	for rows.Next() {
		turn, scanErr := scanTurn(rows)
		if scanErr != nil {
			rows.Close()
			return scanErr
		}
		turns = append(turns, turn)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}
	for index := range turns {
		turn := &turns[index]
		if err = s.appendTerminalTx(ctx, tx, turn, authorRevokedFrame(turn.RunID), StateCancelled, s.now().UTC()); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `UPDATE chat_turns SET producer_token_hash=NULL,cancel_requested_at=COALESCE(cancel_requested_at,$2) WHERE id=$1`, turn.ID, s.now().UTC()); err != nil {
			return err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	for _, turn := range turns {
		s.signals.notify(turn.ID)
	}
	return nil
}

// Hold the active membership through a claim or append commit. A concurrent
// removal/suspension cannot commit between this decision and the journal write.
func inactiveAuthor(ctx context.Context, tx pgx.Tx, turnID string) (bool, error) {
	var installed bool
	err := tx.QueryRow(ctx, `SELECT t.conversation_id IS NOT NULL AND EXISTS(SELECT 1 FROM install_settings i
 WHERE i.key='github.repository' AND (i.value->>'repository_id')::bigint=t.repository_id)
 FROM chat_turns t WHERE t.id=$1`, turnID).Scan(&installed)
	if err != nil || !installed {
		return false, err
	}
	var active int
	err = tx.QueryRow(ctx, `SELECT 1 FROM collaborators c JOIN users u ON u.id=c.user_id
 JOIN chat_turns t ON t.repository_id=c.repository_id AND t.user_id=c.user_id
 WHERE t.id=$1 AND c.suspended_at IS NULL AND NOT u.prohibit_login FOR SHARE OF c,u`, turnID).Scan(&active)
	if errors.Is(err, pgx.ErrNoRows) {
		return true, nil
	}
	return false, err
}
