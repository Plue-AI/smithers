package db

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5/pgxpool"
	"strconv"
	"sync"
	"time"
)

// WikiDocumentLocation fences a live topic by immutable page id and repository.
func (q *Queries) WikiDocumentLocation(ctx context.Context, repository, page int64) (slug, visibility string, err error) {
	err = q.db.QueryRow(ctx, `SELECT slug, visibility FROM wiki_pages WHERE repository_id=$1 AND id=$2 AND attachment IS NULL`, repository, page).Scan(&slug, &visibility)
	return
}

// LeaseWikiDocument holds an advisory lock on a dedicated pool connection,
// so a second backend cannot admit an independent owner of this page.
func (q *Queries) LeaseWikiDocument(ctx context.Context, page int64) (func(), error) {
	pool, ok := q.db.(interface {
		Acquire(context.Context) (*pgxpool.Conn, error)
	})
	if !ok {
		return nil, errors.New("wiki ownership needs a connection pool")
	}
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	var locked bool
	err = conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtextextended('wiki:' || $1::text,3587))`, strconv.FormatInt(page, 10)).Scan(&locked)
	if err != nil || !locked {
		conn.Release()
		return nil, errors.New("wiki page already hosted")
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_, err := conn.Exec(cleanup, `SELECT pg_advisory_unlock(hashtextextended('wiki:' || $1::text,3587))`, strconv.FormatInt(page, 10))
			if err != nil {
				conn.Conn().Close(cleanup)
			}
			conn.Release()
		})
	}, nil
}
