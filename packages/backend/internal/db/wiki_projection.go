package db

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// RebuildWikiProjection is a maintenance operation, not a second write API.
// Revisions are retained; the current page/search/CRDT projection is replaced
// from their latest snapshots under a table fence. It neither appends events
// nor changes the per-wiki cursor. Failure rolls the entire rebuild back.
func (q *Queries) RebuildWikiProjection(ctx context.Context, repoID int64, visibility string) error {
	if repoID <= 0 || (visibility != "public" && visibility != "private") {
		return fmt.Errorf("invalid wiki projection scope")
	}
	beginner, ok := q.db.(interface {
		Begin(context.Context) (pgx.Tx, error)
	})
	if !ok {
		return fmt.Errorf("wiki projection rebuild requires a transaction-capable database")
	}
	tx, err := beginner.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	// A repair is rare and explicit. This lock also fences writes that would
	// otherwise hold a page lock while waiting for the wiki sequence row.
	if _, err = tx.Exec(ctx, `LOCK TABLE wiki_pages IN SHARE ROW EXCLUSIVE MODE`); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `SELECT set_config('smithers.wiki_replay','on',true)`); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM wiki_pages WHERE repository_id=$1 AND visibility=$2`, repoID, visibility); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
 WITH latest AS (
  SELECT DISTINCT ON(page_id) * FROM wiki_page_revisions
  WHERE repository_id=$1 AND visibility=$2 ORDER BY page_id,revision DESC
 ), first_created AS (
  SELECT page_id,min(created_at) AS created_at FROM wiki_page_revisions
  WHERE repository_id=$1 AND visibility=$2 GROUP BY page_id
 )
 INSERT INTO wiki_pages(id,repository_id,slug,title,body,author_id,created_at,updated_at,revision,
  crdt_state,crdt_vector,last_update_id,last_update,visibility,path,content_digest,attachment)
 SELECT r.page_id,r.repository_id,r.slug,r.title,r.body,r.author_id,c.created_at,r.created_at,r.revision,
  r.crdt_state,r.crdt_vector,r.update_id,r.update_bytes,r.visibility,r.path,r.content_digest,r.attachment
 FROM latest r JOIN first_created c USING(page_id) WHERE NOT r.deleted`, repoID, visibility)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}
