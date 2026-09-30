package product

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"
)

func TestWikiRevisionSourceMigrationKeepsHistoryAndRecordsOnce(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	specs, err := registeredMigrations()
	require.NoError(t, err)
	for _, m := range specs {
		if m.version >= 101 {
			break
		}
		_, err = pool.Exec(ctx, m.sql, pgx.QueryExecModeSimpleProtocol)
		require.NoError(t, err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO users(id,username,lower_username) VALUES(1,'wiki-owner','wiki-owner');
 INSERT INTO repositories(id,name,lower_name,user_id) VALUES(1,'wiki-upgrade','wiki-upgrade',1);
 INSERT INTO wiki_pages(repository_id,slug,title,body,author_id) VALUES(1,'home','Home','# Home',1);`, pgx.QueryExecModeSimpleProtocol)
	require.NoError(t, err)
	for _, m := range specs {
		if m.version < 101 {
			continue
		}
		_, err = pool.Exec(ctx, m.sql, pgx.QueryExecModeSimpleProtocol)
		require.NoError(t, err)
	}
	var source, body string
	require.NoError(t, pool.QueryRow(ctx, "SELECT source_commit,body FROM wiki_page_revisions WHERE slug='home'").Scan(&source, &body))
	require.Empty(t, source)
	require.Equal(t, "# Home", body)
	_, err = pool.Exec(ctx, "UPDATE wiki_page_revisions SET source_commit='HEAD' WHERE slug='home'")
	require.ErrorContains(t, err, "check constraint")
	commit := strings.Repeat("0123456789abcdef", 4)
	_, err = pool.Exec(ctx, "UPDATE wiki_page_revisions SET source_commit=$1 WHERE slug='home'", commit)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, "UPDATE wiki_page_revisions SET source_commit='' WHERE slug='home'")
	require.ErrorContains(t, err, "wiki revisions are immutable")
	_, err = pool.Exec(ctx, "UPDATE wiki_page_revisions SET title='Other' WHERE slug='home'")
	require.ErrorContains(t, err, "wiki revisions are immutable")
	// Projection receipts still advance after an annotated revision.
	_, err = pool.Exec(ctx, "UPDATE wiki_page_revisions SET history_commit_id='projected' WHERE slug='home'")
	require.NoError(t, err)
	require.NoError(t, pool.QueryRow(ctx, "SELECT source_commit FROM wiki_page_revisions WHERE slug='home'").Scan(&source))
	require.Equal(t, commit, source)
}
