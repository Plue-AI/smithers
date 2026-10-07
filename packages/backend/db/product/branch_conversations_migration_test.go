package product

import (
	"context"
	"slices"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/require"
)

func TestBranchConversationsMigrationPreservesPrivateTurns(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	migrations, err := registeredMigrations()
	require.NoError(t, err)
	cut := slices.IndexFunc(migrations, func(m migration) bool {
		return strings.Contains(m.sql, "ADD COLUMN conversation_id")
	})
	require.Positive(t, cut)
	require.NoError(t, applyOnce(ctx, pool, migrations[:cut]))

	// The old journal permits different members to run private turns with the
	// same conversation name. Their leases, replay proofs and history must
	// survive the shared-conversation cutover without becoming shared turns.
	_, err = pool.Exec(ctx, `INSERT INTO chat_turns
		(id, repository_id, user_id, run_id, leg_id, request_payload, request_hash,
		 access_hash, state, terminal, producer_generation, producer_token_hash,
		 producer_lease_expires_at)
		VALUES
		('alice', 9001, 1, 'run', 'leg', '{"conversationId":"main","messages":[]}', 'request-a', 'access-a', 'running', false, 3, 'producer-a', now()+interval '1 minute'),
		('bob', 9001, 2, 'run', 'leg', '{"conversationId":"main","messages":[]}', 'request-b', 'access-b', 'running', false, 2, 'producer-b', now()+interval '1 minute'),
		('accepted', 9001, 3, 'run', 'leg', '{"conversationId":"main"}', 'request-c', 'access-c', 'accepted', false, 0, NULL, NULL),
		('archive', 9001, 4, 'run', 'leg', '{"conversationId":"main"}', 'request-d', 'access-d', 'completed', true, 1, NULL, NULL);
		INSERT INTO chat_turn_batches
		(turn_id, batch_number, from_position, previous_hash, frames, hash, canonical_bytes)
		VALUES ('archive', 1, 1, 'previous', '[{"type":"done","reason":"stop"}]', 'batch', 33);`)
	require.NoError(t, err)
	var turnsBefore, batchesBefore string
	require.NoError(t, pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(t) ORDER BY id)::text FROM chat_turns t`).Scan(&turnsBefore))
	require.NoError(t, pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(b) ORDER BY turn_id, batch_number)::text FROM chat_turn_batches b`).Scan(&batchesBefore))

	// Compare the cutover itself before later additive migrations change the row shape.
	require.NoError(t, applyOnce(ctx, pool, migrations[:cut+1]))
	require.NoError(t, applyOnce(ctx, pool, migrations[:cut+1]))
	var turnsAfter, batchesAfter string
	var promoted int
	require.NoError(t, pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(t)-'conversation_id' ORDER BY id)::text FROM chat_turns t`).Scan(&turnsAfter))
	require.NoError(t, pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(b) ORDER BY turn_id, batch_number)::text FROM chat_turn_batches b`).Scan(&batchesAfter))
	require.JSONEq(t, turnsBefore, turnsAfter)
	require.JSONEq(t, batchesBefore, batchesAfter)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM chat_turns WHERE conversation_id IS NOT NULL`).Scan(&promoted))
	require.Zero(t, promoted, "legacy private turns must not enter shared conversation history or queues")

	require.NoError(t, Apply(ctx, pool))
	require.NoError(t, Apply(ctx, pool))

	// Later entry and summary migrations must preserve private journal bytes too.
	require.NoError(t, pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(t)-ARRAY['conversation_id','entry_seq','summary','summary_rev','summary_pending_since'] ORDER BY id)::text FROM chat_turns t`).Scan(&turnsAfter))
	require.NoError(t, pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(b) ORDER BY turn_id, batch_number)::text FROM chat_turn_batches b`).Scan(&batchesAfter))
	require.JSONEq(t, turnsBefore, turnsAfter)
	require.JSONEq(t, batchesBefore, batchesAfter)
	var initialized int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM chat_turns WHERE conversation_id IS NOT NULL OR entry_seq<>0 OR summary IS NOT NULL OR summary_rev<>0 OR summary_pending_since IS NOT NULL`).Scan(&initialized))
	require.Zero(t, initialized, "legacy private turns must not gain shared cursors or model summaries")

	// New shared turns still enforce one producer per repository/conversation,
	// without an old private producer blocking admission or queue progress.
	_, err = pool.Exec(ctx, `INSERT INTO chat_turns
		(id, repository_id, user_id, run_id, leg_id, request_hash, access_hash, state, conversation_id)
		VALUES ('shared-first', 9001, 1, 'shared-first', 'leg', 'request', 'access', 'running', 'main'),
		('shared-next', 9001, 2, 'shared-next', 'leg', 'request', 'access', 'queued', 'main'),
		('other-repo', 9002, 2, 'other-repo', 'leg', 'request', 'access', 'running', 'main'),
		('other-branch', 9001, 2, 'other-branch', 'leg', 'request', 'access', 'running', 'feature');`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE chat_turns SET state='running' WHERE id='shared-next'`)
	var pgErr *pgconn.PgError
	require.ErrorAs(t, err, &pgErr)
	require.Equal(t, "23505", pgErr.Code)
	require.Equal(t, "chat_turns_conversation_running_idx", pgErr.ConstraintName)
	_, err = pool.Exec(ctx, `UPDATE chat_turns SET state='completed', terminal=true WHERE id='shared-first';
		UPDATE chat_turns SET state='running' WHERE id='shared-next';`)
	require.NoError(t, err)
}
