package identity

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type ownerQueries struct {
	owner db.User
	err   error
	calls int
}

func (q *ownerQueries) GetSelfHostOwner(context.Context) (db.User, error) {
	q.calls++
	return q.owner, q.err
}

func TestMemberBoundaryCachesOwnerAndRejectsForeignPrincipal(t *testing.T) {
	q := &ownerQueries{owner: db.User{ID: 7}}
	boundary := NewMemberBoundary(q)
	require.Nil(t, boundary.AuthorizeMember(context.Background(), 7))
	require.Nil(t, boundary.AuthorizeMember(context.Background(), 7))
	assert.Equal(t, 1, q.calls)

	err := boundary.AuthorizeMember(context.Background(), 8)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "installation owner")
}

func TestMemberBoundaryDoesNotCacheUninitializedState(t *testing.T) {
	q := &ownerQueries{err: pgx.ErrNoRows}
	boundary := NewMemberBoundary(q)
	require.NotNil(t, boundary.AuthorizeMember(context.Background(), 7))

	q.err = nil
	q.owner = db.User{ID: 7}
	require.Nil(t, boundary.AuthorizeMember(context.Background(), 7))
	assert.Equal(t, 2, q.calls)
}

type rosterQueries struct {
	ownerQueries
	permissions map[int64]string
}

func (q *rosterQueries) InstallationMemberPermission(_ context.Context, userID int64) (string, error) {
	if permission, ok := q.permissions[userID]; ok {
		return permission, nil
	}
	return "", pgx.ErrNoRows
}

// A roster member passes the boundary only on a route the HTTP boundary
// marked as a member route; a person off the roster never does.
func TestMemberBoundaryAdmitsRosterMembersOnMemberRoutes(t *testing.T) {
	q := &rosterQueries{ownerQueries: ownerQueries{owner: db.User{ID: 7}}, permissions: map[int64]string{8: "write", 9: "admin", 10: "read"}}
	boundary := NewMemberBoundary(q)
	member := WithMemberRoute(context.Background())
	for _, id := range []int64{8, 9} {
		require.Nil(t, boundary.AuthorizeMember(member, id), "member %d on a member route", id)
		err := boundary.AuthorizeMember(context.Background(), id)
		require.NotNil(t, err, "member %d on an owner route", id)
		assert.Contains(t, err.Error(), "installation owner")
		require.NotNil(t, boundary.AuthorizeMember(WithSetupScope(context.Background()), id), "setup scope is not a member route")
	}
	for _, id := range []int64{10, 11} {
		err := boundary.AuthorizeMember(member, id)
		require.NotNil(t, err, "%d is not a member", id)
		assert.Contains(t, err.Error(), "installation owner")
	}
}
