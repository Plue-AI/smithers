package product

import (
	"context"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestWikiTitleSourceMigrationPreservesLegacyTitleAndHistory(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	specs, err := registeredMigrations()
	require.NoError(t, err)
	for _, m := range specs {
		if m.version >= 94 {
			break
		}
		_, err = pool.Exec(ctx, m.sql, pgx.QueryExecModeSimpleProtocol)
		require.NoError(t, err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO users(id,username,lower_username) VALUES(1,'wiki-owner','wiki-owner');
 INSERT INTO repositories(id,name,lower_name,user_id) VALUES(1,'wiki-upgrade','wiki-upgrade',1);
 INSERT INTO wiki_pages(repository_id,slug,title,body,author_id) VALUES(1,'sync-legacy','Home.md','# Different heading',1);`, pgx.QueryExecModeSimpleProtocol)
	require.NoError(t, err)
	var before int64
	require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM wiki_page_revisions").Scan(&before))
	for _, m := range specs {
		if m.version < 94 {
			continue
		}
		_, err = pool.Exec(ctx, m.sql, pgx.QueryExecModeSimpleProtocol)
		require.NoError(t, err)
	}
	var title, source string
	var revision, after int64
	require.NoError(t, pool.QueryRow(ctx, "SELECT title,title_source,revision FROM wiki_pages WHERE slug='sync-legacy'").Scan(&title, &source, &revision))
	require.Equal(t, "Home.md", title)
	require.Equal(t, "unknown", source)
	require.Equal(t, int64(1), revision)
	require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM wiki_page_revisions").Scan(&after))
	require.Equal(t, before, after)
	_, err = pool.Exec(ctx, "UPDATE wiki_pages SET title_source='guessed' WHERE slug='sync-legacy'")
	require.ErrorContains(t, err, "check constraint")
}
