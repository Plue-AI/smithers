package product

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"
)

func TestDocumentSyncMigrationPreservesChat(t *testing.T) {
	ctx := context.Background()
	pool := newProductTestPool(t)
	migrations, err := registeredMigrations()
	require.NoError(t, err)
	for _, m := range migrations {
		if m.version >= 58 {
			break
		}
		_, err = pool.Exec(ctx, m.sql, pgx.QueryExecModeSimpleProtocol)
		require.NoError(t, err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO users(id,username,lower_username) VALUES(1,'sync-owner','sync-owner');
 INSERT INTO repositories(id,name,lower_name,user_id) VALUES(1,'sync-upgrade','sync-upgrade',1);
 INSERT INTO issues(id,repository_id,number,title,author_id,kind) VALUES(1,1,1,'chat',1,'chat');
 INSERT INTO issue_sync_threads(issue_id,owner_id,provider,connection_id,scope_id,conversation_id) VALUES(1,1,'slack','conn','T001','C001');
 INSERT INTO issue_comments(issue_id,user_id,body) VALUES(1,1,'hello');
 UPDATE issue_sync_deliveries SET state='dispatching',claim_token='retained';`, pgx.QueryExecModeSimpleProtocol)
	require.NoError(t, err)
	for _, m := range migrations {
		if m.version < 58 {
			continue
		}
		_, err = pool.Exec(ctx, m.sql, pgx.QueryExecModeSimpleProtocol)
		require.NoError(t, err)
	}
	var state, token string
	require.NoError(t, pool.QueryRow(ctx, `SELECT state,claim_token FROM issue_sync_deliveries WHERE issue_id=1`).Scan(&state, &token))
	require.Equal(t, "dispatching", state)
	require.Equal(t, "retained", token)
	_, err = pool.Exec(ctx, `INSERT INTO issue_sync_deliveries(document_scope,document_payload,document_owner_id,document_repository_id) VALUES('scope','{}',1,1)`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO issue_sync_deliveries(document_scope,document_payload,document_owner_id,document_repository_id,issue_id) VALUES('invalid','{}',1,1,1)`)
	require.Error(t, err)
	_, err = pool.Exec(ctx, `BEGIN;
 INSERT INTO repository_storage_operations(repository_id,operation_type,token,storage_route_key,source_owner,source_repo,source_user_id)
 VALUES(1,'delete',repeat('1',64),'fixture','sync-owner','sync-upgrade',1);
 SELECT set_config('smithers.repository_storage_operation_token',repeat('1',64),true);
 DELETE FROM repositories WHERE id=1; COMMIT;`, pgx.QueryExecModeSimpleProtocol)
	require.NoError(t, err)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM issue_sync_deliveries`).Scan(&count))
	require.Zero(t, count)
}
