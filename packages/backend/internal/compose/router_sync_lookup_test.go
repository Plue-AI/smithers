package compose

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/require"
)

// This unit fixture admits the unrelated API rate limit and controls only the
// repository lookup. Unexpected database work fails rather than succeeding
// through a nil query backend or an unrestricted mock.
type repoSyncLookupDB struct {
	t               *testing.T
	lookupErr       error
	lookupCalls     int
	provenanceCalls int
}

type repoSyncLookupRow func(...any) error

func (row repoSyncLookupRow) Scan(dest ...any) error { return row(dest...) }

func (store *repoSyncLookupDB) QueryRow(_ context.Context, query string, args ...any) pgx.Row {
	store.t.Helper()
	switch {
	case strings.HasPrefix(query, "-- name: ConsumeSearchRateLimitToken :one\n"):
		return repoSyncLookupRow(func(dest ...any) error {
			*dest[0].(*bool) = true
			*dest[1].(*float64) = 500
			*dest[2].(*time.Time) = time.Now()
			return nil
		})
	case strings.HasPrefix(query, "-- name: GetRepoByOwnerAndLowerName :one\n"):
		store.lookupCalls++
		require.Equal(store.t, []any{"alice", "demo"}, args)
		return repoSyncLookupRow(func(...any) error { return store.lookupErr })
	case strings.HasPrefix(query, "-- name: GetReadyImportedRepoForUserBySource :one\n"):
		store.provenanceCalls++
		require.Equal(store.t, []any{int64(42), "alice", "demo"}, args)
		return repoSyncLookupRow(func(...any) error { return pgx.ErrNoRows })
	default:
		store.t.Fatalf("unexpected row query: %s", query)
		return nil
	}
}

func (store *repoSyncLookupDB) Query(context.Context, string, ...any) (pgx.Rows, error) {
	store.t.Fatal("unexpected multi-row query")
	return nil, nil
}

func (store *repoSyncLookupDB) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	store.t.Fatal("unexpected database mutation")
	return pgconn.CommandTag{}, nil
}
