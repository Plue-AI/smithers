package product

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"
)

func TestWikiSpacesMigrationPreservesRevisions(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	specs, err := registeredMigrations()
	require.NoError(t, err)
	for _, m := range specs {
		if m.version >= 42 {
			break
		}
		_, err = pool.Exec(ctx, m.sql, pgx.QueryExecModeSimpleProtocol)
		require.NoError(t, err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO users(id,username,lower_username) VALUES(1,'wiki-owner','wiki-owner');
 INSERT INTO repositories(id,name,lower_name,user_id) VALUES(1,'wiki-upgrade','wiki-upgrade',1);
 INSERT INTO wiki_pages(repository_id,slug,title,body,author_id) VALUES(1,'home','Home','first',1);
 UPDATE wiki_pages SET body='second' WHERE slug='home';`, pgx.QueryExecModeSimpleProtocol)
	require.NoError(t, err)
	for _, m := range specs {
		if m.version < 42 {
			continue
		}
		_, err = pool.Exec(ctx, m.sql, pgx.QueryExecModeSimpleProtocol)
		require.NoError(t, err)
	}
	var revision, count, head int64
	var visibility, path, digest string
	err = pool.QueryRow(ctx, `SELECT revision,visibility,path,content_digest FROM wiki_pages WHERE slug='home'`).Scan(&revision, &visibility, &path, &digest)
	require.NoError(t, err)
	require.Equal(t, int64(2), revision)
	require.Equal(t, "public", visibility)
	require.Equal(t, "home.md", path)
	require.Len(t, digest, 64)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM wiki_page_revisions`).Scan(&count))
	require.Equal(t, int64(2), count)
	require.NoError(t, pool.QueryRow(ctx, `SELECT head FROM wiki_spaces WHERE repository_id=1 AND visibility='public'`).Scan(&head))
	require.Equal(t, int64(2), head)
	_, err = pool.Exec(ctx, `UPDATE wiki_pages SET body='third' WHERE slug='home'`)
	require.NoError(t, err)
	var sequence int64
	var body string
	require.NoError(t, pool.QueryRow(ctx, `SELECT sequence,body FROM wiki_page_revisions ORDER BY sequence DESC LIMIT 1`).Scan(&sequence, &body))
	require.Equal(t, int64(3), sequence)
	require.Equal(t, "third", body)
}
