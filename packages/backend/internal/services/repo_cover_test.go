package services

import (
	"context"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

func TestRepo_Cov_ForkRepoPrivateBillingAndHostRollback(t *testing.T) {
	t.Parallel()

	actor := &db.User{ID: 5, Username: "forker", LowerUsername: "forker"}
	source := testRepo(func(r *db.Repository) {
		r.ID = 90
		r.Name = "source"
		r.LowerName = "source"
		r.Description = "source description"
		r.IsPublic = false
		r.DefaultBookmark = "trunk"
		r.UserID = pgtype.Int8{Int64: 99, Valid: true}
		r.OrgID = pgtype.Int8{}
	})

	t.Run("private source bills actor and copies repo", func(t *testing.T) {
		billing := &stubBillingPolicy{}
		q := &mockRepoQuerier{
			getRepoByOwnerAndLowerNameFn: func(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				// The fork path looks the source up, then looks for an existing
				// fork of it in the actor's namespace before creating one.
				if arg.Owner == "forker" {
					assert.Equal(t, "forked", arg.LowerName)
					return db.Repository{}, pgx.ErrNoRows
				}
				assert.Equal(t, "alice", arg.Owner)
				assert.Equal(t, "source", arg.LowerName)
				return source, nil
			},
			getCollaboratorPermissionForRepo: func(_ context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
				assert.Equal(t, actor.ID, arg.UserID.Int64)
				return "read", nil
			},
			createForkRepoFn: func(_ context.Context, arg db.CreateForkRepoParams) (db.Repository, error) {
				assert.Equal(t, pgtype.Int8{Int64: actor.ID, Valid: true}, arg.UserID)
				assert.Equal(t, "forked", arg.Name)
				assert.Equal(t, "forked", arg.LowerName)
				assert.Equal(t, "custom desc", arg.Description)
				assert.False(t, arg.IsPublic)
				assert.Equal(t, "trunk", arg.DefaultBookmark)
				assert.Equal(t, pgtype.Int8{Int64: source.ID, Valid: true}, arg.ForkID)
				return db.Repository{ID: 91, Name: arg.Name, LowerName: arg.LowerName, UserID: arg.UserID, ForkID: arg.ForkID, IsFork: true}, nil
			},
		}
		rh := &mockRepoHostClient{
			forkRepoFn: func(_ context.Context, srcOwner, srcRepo, dstOwner, dstRepo string) error {
				assert.Equal(t, "alice", srcOwner)
				assert.Equal(t, "source", srcRepo)
				assert.Equal(t, "forker", dstOwner)
				assert.Equal(t, "forked", dstRepo)
				return nil
			},
		}
		svc := NewRepoService(q, rh, "s1", WithRepoBillingPolicy(billing))

		forked, err := svc.ForkRepo(context.Background(), actor, "alice", "source", "forked", "custom desc")
		require.NoError(t, err)
		assert.Equal(t, int64(91), forked.Repository.ID)
		assert.True(t, forked.Created)
		assert.Equal(t, 1, billing.privateRepoCalls)
		assert.Equal(t, BillingOwnerTypeUser, billing.lastOwnerType)
		assert.Equal(t, actor.ID, billing.lastOwnerID)
		assert.Equal(t, 1, rh.forkRepoCalls)
		assert.False(t, q.deleteCalled)
	})

	t.Run("repo host failure deletes fork row", func(t *testing.T) {
		q := &mockRepoQuerier{
			getRepoByOwnerAndLowerNameFn: func(_ context.Context, _ db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return source, nil
			},
			getCollaboratorPermissionForRepo: func(_ context.Context, _ db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
				return "read", nil
			},
			createForkRepoFn: func(_ context.Context, arg db.CreateForkRepoParams) (db.Repository, error) {
				return db.Repository{ID: 92, Name: arg.Name, UserID: arg.UserID}, nil
			},
		}
		rh := &mockRepoHostClient{
			forkRepoFn: func(_ context.Context, _, _, _, _ string) error {
				return fmt.Errorf("repo host down")
			},
		}
		svc := NewRepoService(q, rh, "s1")

		_, err := svc.ForkRepo(context.Background(), actor, "alice", "source", "", "")
		assert.Equal(t, 500, apiStatus(t, err))
		assert.Equal(t, 1, rh.deleteRepoCalls)
		assert.True(t, q.deleteCalled)
	})
}

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

func TestRepo_Cov_TransferOrgMoveFailureRestoresGrants(t *testing.T) {
	t.Parallel()

	actor := &db.User{ID: 11, Username: "owner"}
	repository := testRepo(func(r *db.Repository) {
		r.ID = 200
		r.UserID = pgtype.Int8{Int64: actor.ID, Valid: true}
		r.OrgID = pgtype.Int8{}
		r.Name = "demo"
		r.LowerName = "demo"
	})
	var restoredCollaborators int
	var restoredTeams int
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			if arg.Owner == "owner" && arg.LowerName == "demo" {
				return repository, nil
			}
			return db.Repository{}, pgx.ErrNoRows
		},
		getUserByLowerUsernameFn: func(_ context.Context, lowerUsername string) (db.User, error) {
			assert.Equal(t, "acme", lowerUsername)
			return db.User{}, pgx.ErrNoRows
		},
		getOrgByLowerNameFn: func(_ context.Context, lowerName string) (db.Organization, error) {
			assert.Equal(t, "acme", lowerName)
			return db.Organization{ID: 33, Name: "acme", LowerName: "acme"}, nil
		},
		getOrgMemberFn: func(_ context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error) {
			assert.Equal(t, int64(33), arg.OrganizationID)
			assert.Equal(t, actor.ID, arg.UserID)
			return db.OrgMember{OrganizationID: 33, UserID: actor.ID, Role: "owner"}, nil
		},
		listCollaboratorsByRepoFn: func(_ context.Context, repositoryID int64) ([]db.Collaborator, error) {
			assert.Equal(t, repository.ID, repositoryID)
			return []db.Collaborator{{RepositoryID: repositoryID, UserID: pgtype.Int8{Int64: 20, Valid: true}, Permission: "write"}}, nil
		},
		listTeamReposByRepoFn: func(_ context.Context, repositoryID int64) ([]db.TeamRepo, error) {
			assert.Equal(t, repository.ID, repositoryID)
			return []db.TeamRepo{{RepositoryID: repositoryID, TeamID: 40}}, nil
		},
		transferRepoToOrgFn: func(_ context.Context, arg db.TransferRepoToOrgParams) (db.Repository, error) {
			assert.Equal(t, pgtype.Int8{Int64: 33, Valid: true}, arg.NewOrgID)
			return db.Repository{ID: repository.ID, OrgID: arg.NewOrgID, Name: repository.Name, LowerName: repository.LowerName}, nil
		},
		transferRepoToUserFn: func(_ context.Context, arg db.TransferRepoToUserParams) (db.Repository, error) {
			assert.Equal(t, repository.UserID, arg.NewUserID)
			return repository, nil
		},
		addCollaboratorFn: func(_ context.Context, arg db.AddCollaboratorParams) (db.Collaborator, error) {
			restoredCollaborators++
			assert.Equal(t, repository.ID, arg.RepositoryID)
			assert.Equal(t, "write", arg.Permission)
			return db.Collaborator{RepositoryID: arg.RepositoryID, UserID: arg.UserID, Permission: arg.Permission}, nil
		},
		addTeamRepoFn: func(_ context.Context, arg db.AddTeamRepoParams) (db.TeamRepo, error) {
			restoredTeams++
			assert.Equal(t, repository.ID, arg.RepositoryID)
			assert.Equal(t, int64(40), arg.TeamID)
			return db.TeamRepo{RepositoryID: arg.RepositoryID, TeamID: arg.TeamID}, nil
		},
	}
	rh := &mockRepoHostClient{
		moveRepoFn: func(_ context.Context, srcOwner, srcRepo, dstOwner, dstRepo string) error {
			assert.Equal(t, "owner", srcOwner)
			assert.Equal(t, "demo", srcRepo)
			assert.Equal(t, "acme", dstOwner)
			assert.Equal(t, "demo", dstRepo)
			return fmt.Errorf("move failed")
		},
	}

	_, err := NewRepoService(q, rh, "s1").TransferRepo(context.Background(), actor, "owner", "demo", "acme")
	assert.Equal(t, 500, apiStatus(t, err))
	assert.True(t, q.transferToOrgCalled)
	assert.True(t, q.transferToUserCalled)
	assert.Equal(t, 1, rh.moveRepoCalls)
	assert.Equal(t, 1, restoredCollaborators)
	assert.Equal(t, 1, restoredTeams)
}
