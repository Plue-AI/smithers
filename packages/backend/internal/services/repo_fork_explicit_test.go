package services

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// GetRepoView is the read a client uses to decide whether to offer editing or
// forking. Both answers come from the same call so no client has to infer one.
func TestRepoService_GetRepoView_ReportsWriteAccessAndUpstream(t *testing.T) {
	t.Parallel()

	upstream := db.Repository{ID: 90, Name: "source", LowerName: "source", IsPublic: true,
		UserID: pgtype.Int8{Int64: 99, Valid: true}}
	fork := db.Repository{ID: 91, Name: "source", LowerName: "source", IsPublic: true, IsFork: true,
		UserID: pgtype.Int8{Int64: 7, Valid: true},
		ForkID: pgtype.Int8{Int64: upstream.ID, Valid: true}}

	t.Run("a reader sees no write access and no upstream", func(t *testing.T) {
		t.Parallel()
		q := &mockRepoQuerier{getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return upstream, nil
		}}

		view, err := NewRepoService(q, &mockRepoHostClient{}, "s1").
			GetRepoView(context.Background(), &db.User{ID: 7, Username: "forker"}, "alice", "source")

		require.NoError(t, err)
		assert.False(t, view.CanWrite)
		assert.Empty(t, view.ForkOf)
		assert.Equal(t, upstream.ID, view.Repository.ID)
	})

	t.Run("the fork's owner sees write access and the upstream", func(t *testing.T) {
		t.Parallel()
		q := &forkOwnerNamingQuerier{mockRepoQuerier: &mockRepoQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return fork, nil
			},
			getRepoByIDFn: func(_ context.Context, id int64) (db.Repository, error) {
				assert.Equal(t, upstream.ID, id)
				return upstream, nil
			},
		}, users: map[int64]db.User{99: {ID: 99, Username: "alice", LowerUsername: "alice"}}}

		view, err := NewRepoService(q, &mockRepoHostClient{}, "s1").
			GetRepoView(context.Background(), &db.User{ID: 7, Username: "forker"}, "forker", "source")

		require.NoError(t, err)
		assert.True(t, view.CanWrite)
		assert.Equal(t, "alice/source", view.ForkOf)
	})

	t.Run("a signed-out viewer of a public repository can never write", func(t *testing.T) {
		t.Parallel()
		q := &mockRepoQuerier{getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return upstream, nil
		}}

		view, err := NewRepoService(q, &mockRepoHostClient{}, "s1").
			GetRepoView(context.Background(), nil, "alice", "source")

		require.NoError(t, err)
		assert.False(t, view.CanWrite)
	})
}

// forkOwnerNamingQuerier adds the owner-name lookups production's db.Queries
// has, so a test can prove fork_of renders "owner/name" rather than the empty
// string the lightweight mock falls back to.
type forkOwnerNamingQuerier struct {
	*mockRepoQuerier
	users map[int64]db.User
}

func (q *forkOwnerNamingQuerier) GetUserByID(_ context.Context, id int64) (db.User, error) {
	user, ok := q.users[id]
	if !ok {
		return db.User{}, pgx.ErrNoRows
	}
	return user, nil
}

func (q *forkOwnerNamingQuerier) GetOrgByID(_ context.Context, _ int64) (db.Organization, error) {
	return db.Organization{}, pgx.ErrNoRows
}
