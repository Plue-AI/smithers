package product

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"
)

func TestIssueChatSyncUpgradeFromMain(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	all, err := registeredMigrations()
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `CREATE TABLE smithers_product_migrations(version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`)
	require.NoError(t, err)
	for _, m := range all {
		if m.version > 38 {
			break
		}
		_, err = pool.Exec(ctx, m.sql, pgx.QueryExecModeSimpleProtocol)
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `INSERT INTO smithers_product_migrations(version,checksum) VALUES($1,$2)`, m.version, m.checksum)
		require.NoError(t, err)
	}
	_, err = pool.Exec(ctx, `
 INSERT INTO users(id,username,lower_username) VALUES(1,'owner','owner');
 INSERT INTO repositories(id,user_id,name,lower_name) VALUES(1,1,'repo','repo');
 INSERT INTO issues(id,repository_id,number,author_id,title) VALUES(1,1,1,1,'existing issue');
 INSERT INTO issue_comments(id,issue_id,user_id,body) VALUES(1,1,1,'existing comment');
 `, pgx.QueryExecModeSimpleProtocol)
	require.NoError(t, err)
	var before string
	require.NoError(t, pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(f) ORDER BY sequence)::text FROM issue_state_facts f`).Scan(&before))
	pending, err := Status(ctx, pool)
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(pending), 2)
	require.Equal(t, []int{39, 40}, pending[:2], "later migrations may follow")
	require.NoError(t, Apply(ctx, pool))
	require.NoError(t, Apply(ctx, pool)) // Restart reuses the same migration ledger.
	var after, kind, body, persona, key string
	require.NoError(t, pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(f)-'audience_user_id' ORDER BY sequence)::text FROM issue_state_facts f`).Scan(&after))
	require.Equal(t, before, after)
	require.NoError(t, pool.QueryRow(ctx, `SELECT i.kind,c.body,c.persona::text,c.idempotency_key FROM issues i JOIN issue_comments c ON c.issue_id=i.id WHERE i.id=1`).Scan(&kind, &body, &persona, &key))
	require.Equal(t, "issue", kind)
	require.Equal(t, "existing comment", body)
	require.Equal(t, "{}", persona)
	require.Empty(t, key)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM issue_state_facts WHERE entity_type='issue_comment'`).Scan(&count))
	require.Zero(t, count) // No invented historical comment facts.

	// Both connectors are available directly, with no Slack schema or default.
	for index, provider := range []string{"slack", "telegram"} {
		id := index + 2
		_, err = pool.Exec(ctx, `INSERT INTO issues(id,repository_id,number,author_id,title,kind) VALUES($1,1,$1,1,'chat','chat')`, id)
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `INSERT INTO issue_sync_threads(issue_id,owner_id,provider,connection_id,scope_id,conversation_id,thread_id) VALUES($1,1,$2,'connection','scope','conversation','thread')`, id, provider)
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `INSERT INTO issue_sync_channels(owner_id,repository_id,provider,connection_id,scope_id,conversation_id,thread_id,external_user_id) VALUES(1,1,$1,'connection','scope','conversation','thread','user')`, provider)
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `INSERT INTO issue_comments(id,issue_id,user_id,body,idempotency_key,persona) VALUES($1,$1,1,'hello','request','{"username":"Builder"}')`, id)
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `UPDATE issue_sync_deliveries SET state='outcome_unknown',claim_token='claim',message_id='message' WHERE issue_id=$1`, id)
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `INSERT INTO issue_external_messages(issue_id,comment_id,message_id) VALUES($1,$1,'message')`, id)
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `INSERT INTO issue_sync_receipts(owner_id,delivery_key,issue_id) VALUES(1,$1,$2)`, provider+":event", id)
		require.NoError(t, err)
	}
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM issue_state_facts WHERE entity_type='issue_comment' AND audience_user_id=1`).Scan(&count))
	require.Equal(t, 2, count)
	require.NoError(t, Apply(ctx, pool))
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM issue_sync_deliveries WHERE state='outcome_unknown' AND claim_token='claim' AND message_id='message' AND reconcile_key<>''`).Scan(&count))
	require.Equal(t, 2, count)
	_, err = pool.Exec(ctx, `UPDATE issue_comments SET body='edited' WHERE id=1`)
	require.NoError(t, err)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM issue_state_facts WHERE entity_type='issue_comment' AND audience_user_id IS NULL`).Scan(&count))
	require.Equal(t, 1, count)
}
