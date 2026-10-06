package product

import (
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/require"
)

func TestMachineEventsMigration(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := t.Context()
	migrations, err := registeredMigrations()
	require.NoError(t, err)
	cut := slices.IndexFunc(migrations, func(m migration) bool {
		return strings.Contains(m.sql, "CREATE TABLE machine_event_receipts")
	})
	require.Positive(t, cut)
	require.NoError(t, applyOnce(ctx, pool, migrations[:cut]))
	repo := reviewRepo(t, pool)
	var branch, other string
	for i, dest := range []*string{&branch, &other} {
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspaces(repository_id,user_id,name,target_bookmark,kind,status)
            SELECT $1,id,$2,$2,'container','running' FROM users WHERE username='smithers-machines' RETURNING workspaces.id`, repo, fmt.Sprintf("machine-%d", i)).Scan(dest))
	}
	const event = "10000000-0000-4000-8000-000000000001"
	_, err = pool.Exec(ctx, `INSERT INTO product_job_streams(tenant_id,principal_id,head) VALUES ('machine','member',1);
        INSERT INTO product_job_requests(id,tenant_id,principal_id,operation,request_id,payload_fingerprint,payload,authorization_context,state,request_receipt)
        VALUES ('20000000-0000-4000-8000-000000000001','machine','member','burst','request',decode(repeat('00',32),'hex'),'{}','{}','accepted','{}');
        INSERT INTO product_job_events(tenant_id,principal_id,sequence,event_id,operation_id,event_type,state,data)
        VALUES ('machine','member',1,'10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','burst','completed','{"preserved":true}');`)
	require.NoError(t, err)
	require.NoError(t, Apply(ctx, pool))
	require.NoError(t, Apply(ctx, pool))
	var data string
	require.NoError(t, pool.QueryRow(ctx, `SELECT data::text FROM product_job_events WHERE event_id=$1`, event).Scan(&data))
	require.JSONEq(t, `{"preserved":true}`, data)

	// A failed ingest must leave neither file versions nor an acknowledgment.
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `INSERT INTO machine_event_receipts(workspace_id,event_id,outcome) VALUES($1,$2,'committed')`, branch, event)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `INSERT INTO burst_files(event_id,path,change) VALUES($1,'rollback.txt','added')`, event)
	require.NoError(t, err)
	require.NoError(t, tx.Rollback(ctx))
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM burst_files)+(SELECT count(*) FROM machine_event_receipts)`).Scan(&count))
	require.Zero(t, count)

	// Concurrent deliveries claim one durable receipt. Replay cannot replace
	// the first outcome, and a different branch has an independent key.
	results := make(chan error, 12)
	for range 12 {
		go func() {
			_, err := pool.Exec(ctx, `INSERT INTO machine_event_receipts(workspace_id,event_id,outcome) VALUES($1,$2,'committed') ON CONFLICT (workspace_id,event_id) DO NOTHING`, branch, event)
			results <- err
		}()
	}
	for range 12 {
		require.NoError(t, <-results)
	}
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM machine_event_receipts WHERE workspace_id=$1 AND event_id=$2`, branch, event).Scan(&count))
	require.Equal(t, 1, count)
	_, err = pool.Exec(ctx, `INSERT INTO machine_event_receipts(workspace_id,event_id,outcome) VALUES($1,$2,'stale_base')`, other, event)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO machine_event_receipts(workspace_id,event_id,outcome) VALUES($1,$2,'stale_base')`, branch, event)
	var pgErr *pgconn.PgError
	require.ErrorAs(t, err, &pgErr)
	require.Equal(t, "23505", pgErr.Code)
	var outcome string
	var stamped bool
	require.NoError(t, pool.QueryRow(ctx, `SELECT outcome, at IS NOT NULL FROM machine_event_receipts WHERE workspace_id=$1 AND event_id=$2`, branch, event).Scan(&outcome, &stamped))
	require.Equal(t, "committed", outcome)
	require.True(t, stamped)

	for _, change := range []string{"added", "modified", "deleted", "renamed"} {
		_, err = pool.Exec(ctx, `INSERT INTO burst_files(event_id,path,change,before_blob,after_blob,post_digest,renamed_to) VALUES($1,$2,$2,$3,$4,$5,$6)`, event, change,
			map[string]any{"modified": "before", "deleted": "before", "renamed": "before"}[change],
			map[string]any{"added": "after", "modified": "after", "renamed": "after"}[change],
			map[string]any{"added": "digest", "modified": "digest", "renamed": "digest"}[change],
			map[string]any{"renamed": "destination"}[change])
		require.NoError(t, err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO burst_files(event_id,path,change) VALUES($1,'added','added')`, event)
	require.ErrorAs(t, err, &pgErr)
	require.Equal(t, "23505", pgErr.Code)
	_, err = pool.Exec(ctx, `INSERT INTO burst_files(event_id,path,change) VALUES(gen_random_uuid(),'orphan','added')`)
	require.ErrorAs(t, err, &pgErr)
	require.Equal(t, "23503", pgErr.Code)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM burst_files WHERE event_id=$1`, event).Scan(&count))
	require.Equal(t, 4, count)
	var before, after, digest, to string
	require.NoError(t, pool.QueryRow(ctx, `SELECT before_blob,after_blob,post_digest,renamed_to FROM burst_files WHERE event_id=$1 AND path='renamed'`, event).Scan(&before, &after, &digest, &to))
	require.Equal(t, []string{"before", "after", "digest", "destination"}, []string{before, after, digest, to})

	for _, invalid := range []struct {
		query string
		args  []any
		code  string
	}{
		{`INSERT INTO burst_files(event_id,path,change) VALUES($1,'','added')`, []any{event}, "23514"},
		{`INSERT INTO burst_files(event_id,path,change) VALUES($1,'bad','unknown')`, []any{event}, "23514"},
		{`INSERT INTO machine_event_receipts(workspace_id,event_id,outcome) VALUES($1,gen_random_uuid(),'')`, []any{branch}, "23514"},
		{`INSERT INTO machine_event_receipts(workspace_id,event_id,outcome) VALUES(gen_random_uuid(),gen_random_uuid(),'committed')`, nil, "23503"},
	} {
		_, err = pool.Exec(ctx, invalid.query, invalid.args...)
		require.ErrorAs(t, err, &pgErr)
		require.Equal(t, invalid.code, pgErr.Code)
	}
	var absent bool
	require.NoError(t, pool.QueryRow(ctx, `SELECT after_blob IS NULL AND post_digest IS NULL AND renamed_to IS NULL FROM burst_files WHERE event_id=$1 AND path='deleted'`, event).Scan(&absent))
	require.True(t, absent)

	// Activity retention may remove versions, but cannot re-admit a replay.
	_, err = pool.Exec(ctx, `DELETE FROM product_job_events WHERE event_id=$1`, event)
	require.NoError(t, err)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM burst_files`).Scan(&count))
	require.Zero(t, count)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM machine_event_receipts`).Scan(&count))
	require.Equal(t, 2, count)
	_, err = pool.Exec(ctx, `DELETE FROM workspaces WHERE id=$1 OR id=$2`, branch, other)
	require.NoError(t, err)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM machine_event_receipts`).Scan(&count))
	require.Zero(t, count)
}
