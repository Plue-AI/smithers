package product

import (
	"context"
	"slices"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestMythicalTodoNumberMigration(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	migrations, err := registeredMigrations()
	require.NoError(t, err)
	// Everything before the TODO migration, whatever number it lands with.
	cut := slices.IndexFunc(migrations, func(m migration) bool { return strings.Contains(m.sql, "mythical_item_number") })
	require.Positive(t, cut)
	require.NoError(t, applyOnce(ctx, pool, migrations[:cut]))
	_, err = pool.Exec(ctx, `INSERT INTO users(id,username,lower_username) VALUES(9001,'owner','owner');
 INSERT INTO repositories(id,user_id,name,lower_name) VALUES(9001,9001,'repo','repo'),(9002,9001,'other','other');
 INSERT INTO mythical_items(id,repository_id,issue_number,issue_title,state,created_at,pr_head) VALUES
 ('00000000-0000-4000-8000-000000000002',9001,12,'Later','landed','2026-10-02','second-head'),
 ('00000000-0000-4000-8000-000000000001',9001,9,'First','proposed','2026-10-01','first-head'),
 ('00000000-0000-4000-8000-000000000003',9002,NULL,'Other','queued','2026-10-01','other-head');`)
	require.NoError(t, err)
	require.NoError(t, Apply(ctx, pool))
	q := db.New(pool)
	first, err := q.GetMythicalItemByNumber(ctx, 9001, 1)
	require.NoError(t, err)
	require.Equal(t, "first-head", first.PRHead)
	require.Equal(t, int64(9), first.IssueNumber.Int64)
	require.Equal(t, "First", first.Title.String)
	require.Equal(t, [16]byte{0, 0, 0, 0, 0, 0, 64, 0, 128, 0, 0, 0, 0, 0, 0, 1}, first.ID.Bytes)
	second, err := q.GetMythicalItemByNumber(ctx, 9001, 2)
	require.NoError(t, err)
	require.Equal(t, "second-head", second.PRHead)
	other, err := q.GetMythicalItemByNumber(ctx, 9002, 1)
	require.NoError(t, err)
	require.Equal(t, "other-head", other.PRHead)
	require.NoError(t, Apply(ctx, pool))
	again, err := q.GetMythicalItemByNumber(ctx, 9001, 1)
	require.NoError(t, err)
	require.Equal(t, first, again)
	next, inserted, err := q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: 9001, IssueNumber: pgtype.Int8{Int64: 11, Valid: true}, State: "queued"})
	require.NoError(t, err)
	require.True(t, inserted)
	require.EqualValues(t, 3, next.Number.Int64)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE repository_id IN(9001,9002)`).Scan(&count))
	require.Equal(t, 4, count)
}
