package services

import (
	"context"
	"math"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type offsetChangesetQueries struct {
	*fakeChangesetQueries
	offset int32
	called bool
}

func (q *offsetChangesetQueries) ListChangesetsByOrg(_ context.Context, arg db.ListChangesetsByOrgParams) ([]db.Changeset, error) {
	q.offset, q.called = arg.PageOffset, true
	return nil, nil
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
	require.Equal(t, 400, httpStatus(err))
	require.False(t, queries.called)
}
