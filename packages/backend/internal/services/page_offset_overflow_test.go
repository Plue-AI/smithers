package services

import (
	"context"
	"math"
	"strconv"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type offsetShareListingStore struct {
	*fakeShareListingStore
	publicOffset int64
	ownerOffset  int64
}

func (s *offsetShareListingStore) ListLiveShareListings(_ context.Context, arg db.ListLiveShareListingsParams) ([]db.ShareListing, error) {
	s.publicOffset = arg.ResultOffset
	return nil, nil
}

func (s *offsetShareListingStore) ListShareListingsForOwner(_ context.Context, arg db.ListShareListingsForOwnerParams) ([]db.ShareListing, error) {
	s.ownerOffset = arg.ResultOffset
	return nil, nil
}

type offsetChangesetQueries struct {
	*fakeChangesetQueries
	offset int32
	called bool
}

func (q *offsetChangesetQueries) ListChangesetsByOrg(_ context.Context, arg db.ListChangesetsByOrgParams) ([]db.Changeset, error) {
	q.offset, q.called = arg.PageOffset, true
	return nil, nil
}

func TestShareListingServicePageOffsetBoundary(t *testing.T) {
	if strconv.IntSize < 64 {
		t.Skip("int64 page range requires a 64-bit host")
	}
	store := &offsetShareListingStore{fakeShareListingStore: newFakeShareListingStore()}
	svc := NewShareListingService(store)
	maxPage64 := int64(math.MaxInt64/4 + 1)
	maxPage := int(maxPage64)
	for _, mine := range []bool{false, true} {
		query := ShareListingQuery{Page: maxPage, PerPage: 4}
		var err error
		if mine {
			_, err = svc.ListForOwner(t.Context(), 1, query)
			require.Equal(t, int64((maxPage-1)*4), store.ownerOffset)
		} else {
			_, err = svc.List(t.Context(), query)
			require.Equal(t, int64((maxPage-1)*4), store.publicOffset)
		}
		require.NoError(t, err)
		query.Page++
		if mine {
			_, err = svc.ListForOwner(t.Context(), 1, query)
		} else {
			_, err = svc.List(t.Context(), query)
		}
		requireShareListingAPIStatus(t, err, 400)
	}
}

func TestShareListingPageHasMoreAtOffsetBoundary(t *testing.T) {
	if strconv.IntSize < 64 {
		t.Skip("int64 page range requires a 64-bit host")
	}
	maxPage64 := int64(math.MaxInt64/4 + 1)
	require.False(t, (ShareListingPage{Page: int(maxPage64), PerPage: 4, Total: math.MaxInt64}).HasMore())
	require.True(t, (ShareListingPage{Page: 2, PerPage: 4, Total: 9}).HasMore())
	require.False(t, (ShareListingPage{Page: 2, PerPage: 4, Total: 8}).HasMore())
}

func TestChangesetServicePageOffsetBoundary(t *testing.T) {
	queries := &offsetChangesetQueries{fakeChangesetQueries: newFakeChangesetQueries()}
	svc := NewChangesetService(queries, nil, nil, nil)
	maxPage := int(math.MaxInt32/4 + 1)
	_, err := svc.ListChangesets(t.Context(), &db.User{ID: 1}, "acme", maxPage, 4)
	require.NoError(t, err)
	require.True(t, queries.called)
	require.Equal(t, int32((maxPage-1)*4), queries.offset)
	queries.called = false
	_, err = svc.ListChangesets(t.Context(), &db.User{ID: 1}, "acme", maxPage+1, 4)
	requireShareListingAPIStatus(t, err, 400)
	require.False(t, queries.called)
}
