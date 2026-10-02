package services

import (
	"context"

	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

func TestRepo_Cov_StarArchiveAndHelperBranches(t *testing.T) {
	t.Parallel()

	svc := NewRepoService(&mockRepoQuerier{}, &mockRepoHostClient{}, "")
	assert.Equal(t, DefaultStorageSetID, svc.activeStorageSetID)
	assert.Equal(t, "main", normalizeDefaultBookmark(" "))
	assert.Equal(t, "trunk", normalizeDefaultBookmark(" trunk "))
	assert.Equal(t, []string{"ci", "test"}, normalizeStringList([]string{" ci ", "", "test", "ci"}))
	assert.True(t, isRepoHostStatus(&repohost.StatusError{StatusCode: 404}, 404))
	assert.False(t, isRepoHostStatus(&repohost.StatusError{StatusCode: 500, Message: "status 404"}, 404))
	assert.False(t, isRepoHostStatus(nil, 404))

	actor := &db.User{ID: 7, Username: "alice"}
	repository := testRepo(func(r *db.Repository) {
		r.ID = 101
		r.IsPublic = true
		r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
	})

	archived := repository
	archived.IsArchived = true
	got, err := NewRepoService(&mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(_ context.Context, _ db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return archived, nil
		},
	}, &mockRepoHostClient{}, "s1").ArchiveRepo(context.Background(), actor, "alice", "demo")
	require.NoError(t, err)
	assert.True(t, got.IsArchived)

	unarchived, err := NewRepoService(&mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(_ context.Context, _ db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return archived, nil
		},
	}, &mockRepoHostClient{}, "s1").UnarchiveRepo(context.Background(), actor, "alice", "demo")
	require.NoError(t, err)
	assert.False(t, unarchived.IsArchived)
}
