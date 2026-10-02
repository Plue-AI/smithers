package services

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type failingImportCleanupHost struct {
	GitHubImportRepoHost
}

func (failingImportCleanupHost) DeleteRepo(context.Context, string, string) error {
	return errors.New("repo-host unavailable")
}

type recordingImportCleanupDB struct {
	GitHubImportRepoDB
	deleteCalls int
}

func (db *recordingImportCleanupDB) DeleteRepo(context.Context, int64) error {
	db.deleteCalls++
	return nil
}

func TestCreateRepo_RequiresAuthenticatedUser(t *testing.T) {
	t.Parallel()

	_, err := NewRepoService(&mockRepoQuerier{}, &mockRepoHostClient{}, "s1").CreateRepo(
		context.Background(), nil, "demo", "", true, "main", false,
	)
	assert.Equal(t, 401, apiStatus(t, err))
}

func TestGitHubImportCreatesProductRepositoryRow(t *testing.T) {
	t.Parallel()

	var createArg db.CreateRepoParams
	repoDB := &reconciliationImportRepoDB{
		getFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{}, pgx.ErrNoRows
		},
		createFn: func(_ context.Context, arg db.CreateRepoParams) (db.Repository, error) {
			createArg = arg
			return recoveredUserRepository(arg, 71), nil
		},
	}
	host := &reconciliationImportRepoHost{}
	svc := NewGitHubImportService(nil, repoDB, nil, host, nil, "https://smithers.test",
		WithGitHubImportStorageSet(" active-s9 "))

	repository, reused, err := svc.ensureLocalRepo(
		context.Background(), 7, "alice", "octocat", "demo", "main",
	)
	require.NoError(t, err)
	assert.False(t, reused)
	assert.Equal(t, int64(71), repository.ID)
	assert.Equal(t, "demo", createArg.Name)
}

func TestProvisioningCleanup_PreservesPlacementRowWhenStorageDeletionFails(t *testing.T) {
	t.Parallel()

	t.Run("ordinary repository", func(t *testing.T) {
		q := &mockRepoQuerier{}
		rh := &mockRepoHostClient{deleteRepoFn: func(context.Context, string, string) error {
			return errors.New("repo-host unavailable")
		}}

		NewRepoService(q, rh, "s1").rollbackProvisionedRepo(
			context.Background(), 41, "alice", "demo",
		)
		assert.False(t, q.deleteCalled)
	})

	t.Run("github import", func(t *testing.T) {
		repoDB := &recordingImportCleanupDB{}
		svc := &GitHubImportService{
			repoDB:   repoDB,
			repoHost: failingImportCleanupHost{},
		}

		svc.rollbackFreshImportRepo(context.Background(), 42, "alice", "demo")
		assert.Zero(t, repoDB.deleteCalls)
	})
}
