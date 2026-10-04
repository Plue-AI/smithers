package product

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"
)

func TestIssueSyncDeliveryNotifiesAfterCommit(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	migrations, err := registeredMigrations()
	require.NoError(t, err)
	for _, m := range migrations {
		_, err = pool.Exec(ctx, m.sql, pgx.QueryExecModeSimpleProtocol)
		require.NoError(t, err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO users(id,username,lower_username) VALUES(1001,'notify-owner','notify-owner');
 INSERT INTO repositories(id,name,lower_name,user_id) VALUES(1,'notify-repo','notify-repo',1001);
 INSERT INTO issues(id,repository_id,number,title,author_id,kind) VALUES(1,1,1,'chat',1001,'chat');
 INSERT INTO issue_sync_threads(issue_id,owner_id,provider,connection_id,scope_id,conversation_id) VALUES(1,1001,'slack','conn','T001','C001');
 INSERT INTO issue_events(id,issue_id,actor_id,event_type,payload) VALUES(1,1,1001,'comment.reaction','{}');`, pgx.QueryExecModeSimpleProtocol)
	require.NoError(t, err)
	listener, err := pool.Acquire(ctx)
	require.NoError(t, err)
	defer listener.Release()
	_, err = listener.Exec(ctx, `LISTEN issue_state_facts_1`)
	require.NoError(t, err)
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer tx.Rollback(ctx)
	_, err = tx.Exec(ctx, `INSERT INTO issue_sync_deliveries(issue_id,event_id) VALUES(1,1)`)
	require.NoError(t, err)
	short, cancel := context.WithTimeout(ctx, 30*time.Millisecond)
	_, err = listener.Conn().WaitForNotification(short)
	cancel()
	require.ErrorIs(t, err, context.DeadlineExceeded, "uncommitted work must not wake the durable delivery listener")
	require.NoError(t, tx.Commit(ctx))
	wait := func() {
		ctx, cancel := context.WithTimeout(ctx, time.Second)
		defer cancel()
		notification, err := listener.Conn().WaitForNotification(ctx)
		require.NoError(t, err)
		require.Equal(t, "sync:1001", notification.Payload)
	}
	wait()
	_, err = pool.Exec(ctx, `UPDATE issue_sync_deliveries SET state='failed'; UPDATE issue_sync_deliveries SET state='pending';`, pgx.QueryExecModeSimpleProtocol)
	require.NoError(t, err)
	wait()
}
