package product

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"
)

func TestBuildCacheQuotaMigrationBackfillAndAccounting(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	specs, err := registeredMigrations()
	require.NoError(t, err)
	for _, m := range specs {
		if m.version >= 74 {
			break
		}
		_, err = pool.Exec(ctx, m.sql, pgx.QueryExecModeSimpleProtocol)
		require.NoError(t, err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO users(id,username,lower_username) VALUES(1,'cache-owner','cache-owner');
 INSERT INTO repositories(id,name,lower_name,user_id) VALUES(1,'cache-upgrade','cache-upgrade',1);
 INSERT INTO build_cache_entries(repository_id,key_digest,body,result_canonical) VALUES(1,'key',repeat('x',1200),repeat('y',1500));
 INSERT INTO build_cache_artifacts(repository_id,digest,size_bytes,gcs_key) VALUES(1,repeat('a',64),1500,'build-cache/1/a');`, pgx.QueryExecModeSimpleProtocol)
	require.NoError(t, err)
	for _, m := range specs {
		if m.version < 74 {
			continue
		}
		_, err = pool.Exec(ctx, m.sql, pgx.QueryExecModeSimpleProtocol)
		require.NoError(t, err)
	}
	usage := func(want int64) {
		t.Helper()
		var got int64
		require.NoError(t, pool.QueryRow(ctx, "SELECT size_bytes FROM build_cache_repository_usage WHERE repository_id=1").Scan(&got))
		require.Equal(t, want, got)
	}
	usage(4200)
	_, err = pool.Exec(ctx, "UPDATE build_cache_artifacts SET size_bytes=2000 WHERE repository_id=1")
	require.NoError(t, err)
	usage(4700)
	_, err = pool.Exec(ctx, "DELETE FROM build_cache_entries WHERE repository_id=1")
	require.NoError(t, err)
	usage(2000)
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, "INSERT INTO build_cache_entries(repository_id,key_digest,body,result_canonical) VALUES(1,'rollback','{}','{}')")
	require.NoError(t, err)
	require.NoError(t, tx.Rollback(ctx))
	usage(2000)
	_, err = pool.Exec(ctx, `BEGIN;
 INSERT INTO repository_storage_operations(repository_id,operation_type,token,storage_route_key,source_owner,source_repo,source_user_id)
 VALUES(1,'delete',repeat('1',64),'fixture','cache-owner','cache-upgrade',1);
 SELECT set_config('smithers.repository_storage_operation_token',repeat('1',64),true);
 DELETE FROM repositories WHERE id=1; COMMIT;`, pgx.QueryExecModeSimpleProtocol)
	require.NoError(t, err, "repository cascade deletion must not recreate or underflow its usage row")
	var count int
	require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM build_cache_repository_usage").Scan(&count))
	require.Zero(t, count)
}
