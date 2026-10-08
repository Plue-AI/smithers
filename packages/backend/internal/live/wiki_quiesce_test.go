package live

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/livedocument"
	"github.com/stretchr/testify/require"
)

func TestWikiQuiescePersistenceFailureAndRecovery(t *testing.T) {
	path := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	if path == "" {
		t.Skip("native ABI required")
	}
	library, err := livedocument.Load(path)
	require.NoError(t, err)
	defer library.Close()
	host := NewWikiHost(t.Context(), library)
	defer host.Close()
	host.Open = func(context.Context, int64, int64, int64, bool) (db.GetWikiDocumentRow, error) {
		return db.GetWikiDocumentRow{}, nil
	}
	doc, err := library.Open(livedocument.Wiki, nil)
	require.NoError(t, err)
	_, err = doc.SetAuthor(1, "owner")
	require.NoError(t, err)
	pending := time.Now()
	page := &wikiDocument{host: host, doc: doc, oldest: pending, peers: map[*wikiStream]bool{}}
	host.pages[1] = page
	failure := errors.New("postgres save failed")
	host.Commit = func(context.Context, int64, db.GetWikiDocumentRow, []byte, []byte, string) (db.GetWikiDocumentRow, error) {
		return db.GetWikiDocumentRow{}, failure
	}
	require.ErrorIs(t, host.Drain(t.Context()), failure)
	require.True(t, host.paused.Load())
	require.Equal(t, pending, page.oldest)
	stream := &wikiStream{page: page}
	// A valid awareness envelope is refused before touching the native document.
	require.EqualError(t, stream.Send(t.Context(), []byte{4, 0}), "wiki persistence paused")
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	require.ErrorIs(t, host.Resume(ctx), context.Canceled)
	require.True(t, host.paused.Load())
	calls := 0
	host.Commit = func(_ context.Context, _ int64, row db.GetWikiDocumentRow, state, vector []byte, _ string) (db.GetWikiDocumentRow, error) {
		calls++
		row.CrdtState, row.CrdtVector = state, vector
		return row, nil
	}
	require.NoError(t, host.Drain(t.Context()))
	require.True(t, page.oldest.IsZero())
	require.Equal(t, 1, calls)
	require.NoError(t, host.Drain(t.Context()))
	require.Equal(t, 1, calls, "a repeated drain must not duplicate a committed save")
	require.NoError(t, host.Resume(t.Context()))
	require.False(t, host.paused.Load())
}

func TestWikiQuiesceUnavailable(t *testing.T) {
	var host *WikiHost
	require.EqualError(t, host.Check(t.Context()), "wiki persistence unavailable")
	require.EqualError(t, host.Drain(t.Context()), "wiki persistence unavailable")
	require.EqualError(t, host.Resume(t.Context()), "wiki persistence unavailable")
}
