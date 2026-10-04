package product

import (
	"context"
	"fmt"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

// Exercises the registered forward migration against historical engine rows,
// not a second TODO schema or a fake admission service.
func TestMythicalActiveIssueMigrationPreservesHistory(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	registered, err := registeredMigrations()
	require.NoError(t, err)
	var forward migration
	for _, m := range registered {
		if m.version == 107 {
			forward = m
			break
		}
		_, err = pool.Exec(ctx, m.sql, pgx.QueryExecModeSimpleProtocol)
		require.NoError(t, err, "migration %d", m.version)
	}
	require.NotEmpty(t, forward.sql)
	_, err = pool.Exec(ctx, `
 INSERT INTO users(id,username,lower_username) VALUES(1,'Ben','ben');
 INSERT INTO repositories(id,user_id,name,lower_name) VALUES(1,1,'repo','repo');
 INSERT INTO mythical_items(repository_id,issue_number,state,workspace_id,pr_number,pr_head,issue_digest,issue_body,checks)
 VALUES(1,7,'running','retained-workspace',42,'retained-head','frozen-digest','frozen-body','{"todo":true}'),
 (1,8,'skipped','',NULL, '', '', '', '{}');`, pgx.QueryExecModeSimpleProtocol)
	// Keep the skipped row literal without inventing a TODO link or backfill.
	require.NoError(t, err)
	q := db.New(pool)
	original, err := q.GetMythicalItemByIssue(ctx, 1, 7)
	require.NoError(t, err)
	skipped, err := q.GetMythicalItemByIssue(ctx, 1, 8)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO mythical_lanes(workspace_id,repository_id,item_id,name) VALUES('retained-workspace',1,$1,'implement')`, original.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, forward.sql, pgx.QueryExecModeSimpleProtocol)
	require.NoError(t, err)
	after, err := q.GetMythicalItem(ctx, original.ID)
	require.NoError(t, err)
	require.Equal(t, original, after)
	after, err = q.GetMythicalItem(ctx, skipped.ID)
	require.NoError(t, err)
	require.Equal(t, skipped, after)
	var lane pgtype.UUID
	require.NoError(t, pool.QueryRow(ctx, `SELECT item_id FROM mythical_lanes WHERE workspace_id='retained-workspace'`).Scan(&lane))
	require.Equal(t, original.ID, lane)
	for _, terminal := range []string{"cancelled", "landed", "rejected", "declined"} {
		t.Run(terminal, func(t *testing.T) {
			_, err := pool.Exec(ctx, `INSERT INTO mythical_items(repository_id,issue_number,state) VALUES(1,7,'queued')`)
			var conflict *pgconn.PgError
			require.ErrorAs(t, err, &conflict)
			require.Equal(t, "23505", conflict.Code)
			active, err := q.GetActiveMythicalItemByIssue(ctx, 1, 7)
			require.NoError(t, err)
			_, err = pool.Exec(ctx, `UPDATE mythical_items SET state=$2 WHERE id=$1`, active.ID, terminal)
			require.NoError(t, err)
			_, err = q.GetActiveMythicalItemByIssue(ctx, 1, 7)
			require.ErrorIs(t, err, pgx.ErrNoRows)
			history, err := q.GetMythicalItemByIssue(ctx, 1, 7)
			require.NoError(t, err)
			require.Equal(t, active.ID, history.ID)
			next, inserted, err := q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: 1, IssueNumber: pgtype.Int8{Int64: 7, Valid: true}, State: "queued", IssueBody: fmt.Sprintf("new after %s", terminal)})
			require.NoError(t, err)
			require.True(t, inserted)
			require.NotEqual(t, active.ID, next.ID)
			duplicate, inserted, err := q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: 1, IssueNumber: pgtype.Int8{Int64: 7, Valid: true}, State: "queued", IssueBody: "must not replace"})
			require.NoError(t, err)
			require.False(t, inserted)
			require.Equal(t, next, duplicate)
			shown, err := q.GetMythicalItemByIssue(ctx, 1, 7)
			require.NoError(t, err)
			require.Equal(t, next.ID, shown.ID)
		})
	}
	after, err = q.GetMythicalItem(ctx, original.ID)
	require.NoError(t, err)
	require.Equal(t, original.WorkspaceID, after.WorkspaceID)
	require.Equal(t, original.PRNumber, after.PRNumber)
	require.Equal(t, original.PRHead, after.PRHead)
	require.Equal(t, original.IssueBody, after.IssueBody)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE repository_id=1 AND issue_number=7`).Scan(&count))
	require.Equal(t, 5, count)
	// Restoring a dropped row while its issue has a new claim must refuse,
	// preserving both identities rather than stealing the new claim.
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='queued' WHERE id=$1`, original.ID)
	var conflict *pgconn.PgError
	require.ErrorAs(t, err, &conflict)
	require.Equal(t, "23505", conflict.Code)
	_, err = pool.Exec(ctx, `INSERT INTO mythical_items(repository_id,issue_number,state) VALUES(1,8,'queued')`)
	require.ErrorAs(t, err, &conflict) // A skipped historical row is not a dropped TODO.
	require.Equal(t, "23505", conflict.Code)
	// Repository scope and nullable issue links are independent claims.
	_, err = pool.Exec(ctx, `INSERT INTO repositories(id,user_id,name,lower_name) VALUES(2,1,'other','other');
 INSERT INTO mythical_items(repository_id,issue_number,state) VALUES(2,7,'queued'),(1,NULL,'queued'),(1,NULL,'queued');`, pgx.QueryExecModeSimpleProtocol)
	require.NoError(t, err)
	// Exercise the real insert/conflict lookup boundary with independent clients.
	start := make(chan struct{})
	type result struct {
		item     db.MythicalItem
		inserted bool
		err      error
	}
	results := make(chan result, 8)
	var workers sync.WaitGroup
	for range 8 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			item, inserted, err := db.New(pool).InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: 1, IssueNumber: pgtype.Int8{Int64: 9, Valid: true}, State: "queued", IssueBody: "race snapshot"})
			results <- result{item, inserted, err}
		}()
	}
	close(start)
	workers.Wait()
	close(results)
	var winner pgtype.UUID
	insertedCount := 0
	for result := range results {
		require.NoError(t, result.err)
		if !winner.Valid {
			winner = result.item.ID
		}
		require.Equal(t, winner, result.item.ID)
		require.Equal(t, "race snapshot", result.item.IssueBody)
		if result.inserted {
			insertedCount++
		}
	}
	require.Equal(t, 1, insertedCount)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE repository_id=1 AND issue_number=9`).Scan(&count))
	require.Equal(t, 1, count)
}
