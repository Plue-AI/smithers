package services

import (
	"context"
	stderrors "errors"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

type repoZQuerier struct {
	*mockRepoQuerier
	archiveRepoFn   func(context.Context, int64) (db.Repository, error)
	unarchiveRepoFn func(context.Context, int64) (db.Repository, error)
}

func (q *repoZQuerier) ArchiveRepo(ctx context.Context, id int64) (db.Repository, error) {
	if q.archiveRepoFn != nil {
		return q.archiveRepoFn(ctx, id)
	}
	return q.mockRepoQuerier.ArchiveRepo(ctx, id)
}

func (q *repoZQuerier) UnarchiveRepo(ctx context.Context, id int64) (db.Repository, error) {
	if q.unarchiveRepoFn != nil {
		return q.unarchiveRepoFn(ctx, id)
	}
	return q.mockRepoQuerier.UnarchiveRepo(ctx, id)
}

func repoZPublicRepo() db.Repository {
	return testRepo(func(r *db.Repository) {
		r.IsPublic = true
		r.UserID = pgtype.Int8{Int64: 1, Valid: true}
		r.OrgID = pgtype.Int8{}
	})
}

func repoZOwnerRepo(actorID int64) db.Repository {
	return testRepo(func(r *db.Repository) {
		r.IsPublic = true
		r.UserID = pgtype.Int8{Int64: actorID, Valid: true}
		r.OrgID = pgtype.Int8{}
	})
}

func repoZServiceForRepo(repository db.Repository) *RepoService {
	return NewRepoService(&mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repository, nil
		},
	}, &mockRepoHostClient{}, "s1")
}

func TestRepo_Z_CreateBillingAndErrors(t *testing.T) {
	ctx := context.Background()
	user := testUser()

	t.Run("private user repo authorizes billing", func(t *testing.T) {
		billing := &stubBillingPolicy{}
		q := &mockRepoQuerier{
			createRepoFn: func(_ context.Context, arg db.CreateRepoParams) (db.Repository, error) {
				assert.Equal(t, "private", arg.Name)
				assert.Equal(t, "dev", arg.DefaultBookmark)
				assert.False(t, arg.IsPublic)
				return db.Repository{ID: 10, UserID: arg.UserID, Name: arg.Name, LowerName: arg.LowerName, IsPublic: arg.IsPublic, DefaultBookmark: arg.DefaultBookmark}, nil
			},
		}
		repo, err := NewRepoService(q, &mockRepoHostClient{}, "s1", WithRepoBillingPolicy(billing)).
			CreateRepo(ctx, user, " private ", "", false, "dev", false)
		require.NoError(t, err)
		assert.Equal(t, "private", repo.Name)
		assert.Equal(t, 1, billing.privateRepoCalls)
		assert.Equal(t, BillingOwnerTypeUser, billing.lastOwnerType)
		assert.Equal(t, user.ID, billing.lastOwnerID)
	})

	t.Run("private user repo returns billing error", func(t *testing.T) {
		billing := &stubBillingPolicy{authorizePrivateRepoFn: func(context.Context, string, int64) error {
			return pkgerrors.Forbidden("blocked")
		}}
		_, err := NewRepoService(&mockRepoQuerier{}, &mockRepoHostClient{}, "s1", WithRepoBillingPolicy(billing)).
			CreateRepo(ctx, user, "private", "", false, "", false)
		assert.Equal(t, http.StatusForbidden, apiStatus(t, err))
	})

	t.Run("create repo generic db error", func(t *testing.T) {
		q := &mockRepoQuerier{createRepoFn: func(context.Context, db.CreateRepoParams) (db.Repository, error) {
			return db.Repository{}, stderrors.New("insert failed")
		}}
		_, err := NewRepoService(q, &mockRepoHostClient{}, "s1").CreateRepo(ctx, user, "repo", "", true, "", false)
		assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
	})

	orgQ := func() *mockRepoQuerier {
		return &mockRepoQuerier{
			getOrgByLowerNameFn: func(context.Context, string) (db.Organization, error) {
				return db.Organization{ID: 44, Name: "acme", LowerName: "acme"}, nil
			},
			getOrgMemberFn: func(context.Context, db.GetOrgMemberParams) (db.OrgMember, error) {
				return db.OrgMember{OrganizationID: 44, UserID: user.ID, Role: "owner"}, nil
			},
		}
	}

	t.Run("private org repo authorizes billing", func(t *testing.T) {
		billing := &stubBillingPolicy{}
		_, err := NewRepoService(orgQ(), &mockRepoHostClient{}, "s1", WithRepoBillingPolicy(billing)).
			CreateOrgRepo(ctx, user, "acme", "repo", "", false, "", false)
		require.NoError(t, err)
		assert.Equal(t, 1, billing.privateRepoCalls)
		assert.Equal(t, BillingOwnerTypeOrg, billing.lastOwnerType)
		assert.Equal(t, int64(44), billing.lastOwnerID)
	})

	t.Run("private org repo returns billing error", func(t *testing.T) {
		billing := &stubBillingPolicy{authorizePrivateRepoFn: func(context.Context, string, int64) error {
			return pkgerrors.Forbidden("blocked")
		}}
		_, err := NewRepoService(orgQ(), &mockRepoHostClient{}, "s1", WithRepoBillingPolicy(billing)).
			CreateOrgRepo(ctx, user, "acme", "repo", "", false, "", false)
		assert.Equal(t, http.StatusForbidden, apiStatus(t, err))
	})
}

func TestRepo_Z_ForkBranches(t *testing.T) {
	ctx := context.Background()
	actor := &db.User{ID: 7, Username: "forker"}
	source := repoZPublicRepo()
	source.ID = 90
	source.Name = "source"
	source.LowerName = "source"
	source.DefaultBookmark = "trunk"

	_, err := NewRepoService(&mockRepoQuerier{}, &mockRepoHostClient{}, "s1").ForkRepo(ctx, nil, "alice", "source", "", "")
	assert.Equal(t, http.StatusUnauthorized, apiStatus(t, err))

	_, err = NewRepoService(&mockRepoQuerier{}, &mockRepoHostClient{}, "s1").ForkRepo(ctx, actor, "", "source", "", "")
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))

	q := &mockRepoQuerier{getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		return source, nil
	}}
	_, err = NewRepoService(q, &mockRepoHostClient{}, "s1").ForkRepo(ctx, actor, "alice", "source", "bad name!", "")
	assert.Equal(t, http.StatusUnprocessableEntity, apiStatus(t, err))

	for _, tc := range []struct {
		name string
		err  error
		code int
	}{
		{name: "unique", err: &pgconn.PgError{Code: "23505"}, code: http.StatusConflict},
		{name: "generic", err: stderrors.New("insert failed"), code: http.StatusInternalServerError},
	} {
		t.Run("create fork "+tc.name, func(t *testing.T) {
			q := &mockRepoQuerier{
				getRepoByOwnerAndLowerNameFn: func(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
					if arg.LowerName == source.LowerName {
						return source, nil
					}
					return db.Repository{}, pgx.ErrNoRows
				},
				createForkRepoFn: func(context.Context, db.CreateForkRepoParams) (db.Repository, error) {
					return db.Repository{}, tc.err
				},
			}
			_, err := NewRepoService(q, &mockRepoHostClient{}, "s1").ForkRepo(ctx, actor, "alice", "source", "fork", "")
			assert.Equal(t, tc.code, apiStatus(t, err))
		})
	}

	// num_forks maintenance moved into the database
	// (trg_repositories_fork_count_*); the fork path performs no counter write.
}

func TestRepo_Z_ContentRefsAndHelpers(t *testing.T) {
	ctx := context.Background()
	repository := repoZPublicRepo()
	repository.DefaultBookmark = "main"

	calls := 0
	rh := &mockRepoHostClient{listBookmarksFn: func(context.Context, string, string, string, int) ([]repohost.Bookmark, string, error) {
		calls++
		return []repohost.Bookmark{{Name: fmt.Sprintf("b-%d", calls), TargetChangeID: "change"}}, fmt.Sprintf("cursor-%d", calls), nil
	}}
	require.NoError(t, NewRepoService(&mockRepoQuerier{}, rh, "s1").walkBookmarks(ctx, "alice", "demo", func([]repohost.Bookmark) bool { return true }))
	assert.Equal(t, bookmarkMaxPages, calls)

	_, err := NewRepoService(&mockRepoQuerier{}, &mockRepoHostClient{}, "s1").ListRepoContents(ctx, nil, "", "demo", "", "")
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))

	q := &mockRepoQuerier{getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		return repository, nil
	}}
	rh = &mockRepoHostClient{listBookmarksFn: func(context.Context, string, string, string, int) ([]repohost.Bookmark, string, error) {
		return nil, "", stderrors.New("bookmarks failed")
	}}
	_, err = NewRepoService(q, rh, "s1").ListRepoContents(ctx, nil, "alice", "demo", "", "")
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	rh = &mockRepoHostClient{
		listBookmarksFn: func(context.Context, string, string, string, int) ([]repohost.Bookmark, string, error) {
			return nil, "", nil
		},
		listFilesAtChangeFn: func(context.Context, string, string, string, string) ([]repohost.ChangeFile, error) {
			return nil, stderrors.New("host failed")
		},
	}
	_, err = NewRepoService(q, rh, "s1").ListRepoContents(ctx, nil, "alice", "demo", "change", "")
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	rh.listFilesAtChangeFn = func(context.Context, string, string, string, string) ([]repohost.ChangeFile, error) {
		return []repohost.ChangeFile{{Path: "src"}, {Path: "src/main.go"}}, nil
	}
	entries, err := NewRepoService(q, rh, "s1").ListRepoContents(ctx, nil, "alice", "demo", "change", "src")
	require.NoError(t, err)
	require.Len(t, entries, 1)
	assert.Equal(t, "main.go", entries[0].Name)

	_, err = NewRepoService(&mockRepoQuerier{}, &mockRepoHostClient{}, "s1").GetRepoContents(ctx, nil, "", "demo", "", "README.md")
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))
	_, err = NewRepoService(q, &mockRepoHostClient{}, "s1").GetRepoContents(ctx, nil, "alice", "demo", "", "")
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))

	rh = &mockRepoHostClient{listBookmarksFn: func(context.Context, string, string, string, int) ([]repohost.Bookmark, string, error) {
		return nil, "", stderrors.New("bookmarks failed")
	}}
	_, err = NewRepoService(q, rh, "s1").GetRepoContents(ctx, nil, "alice", "demo", "", "README.md")
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	rh = &mockRepoHostClient{
		listBookmarksFn: func(context.Context, string, string, string, int) ([]repohost.Bookmark, string, error) {
			return nil, "", nil
		},
		getFileAtChangeFn: func(context.Context, string, string, string, string) (repohost.FileContent, error) {
			return repohost.FileContent{}, stderrors.New("host failed")
		},
	}
	_, err = NewRepoService(q, rh, "s1").GetRepoContents(ctx, nil, "alice", "demo", "change", "README.md")
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	_, err = NewRepoService(&mockRepoQuerier{}, &mockRepoHostClient{}, "s1").ListGitRefs(ctx, nil, "", "demo")
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))
	rh.listBookmarksFn = func(context.Context, string, string, string, int) ([]repohost.Bookmark, string, error) {
		return nil, "", stderrors.New("bookmarks failed")
	}
	_, err = NewRepoService(q, rh, "s1").ListGitRefs(ctx, nil, "alice", "demo")
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	permission, owner, err := repoPermissionForUser(ctx, repoZServiceForRepo(repository).queries, repository, repository.UserID.Int64)
	require.NoError(t, err)
	assert.True(t, owner)
	assert.Empty(t, permission)

	assert.True(t, isRepoUniqueViolation(&pgconn.PgError{Code: "23505"}))
	assert.False(t, isRepoUniqueViolation(&pgconn.PgError{Code: "40001"}))
	assert.Empty(t, normalizeStringList(nil))
}

func TestRepo_Z_UpdateArchiveDeleteAndDispatch(t *testing.T) {
	ctx := context.Background()
	actor := testUser()

	nonOwner := repoZPublicRepo()
	nonOwner.UserID = pgtype.Int8{Int64: 99, Valid: true}
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return nonOwner, nil
		},
		getCollaboratorPermissionForRepo: func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			return "", stderrors.New("perm failed")
		},
	}
	_, err := NewRepoService(q, &mockRepoHostClient{}, "s1").UpdateRepo(ctx, actor, "alice", "demo", UpdateRepoRequest{Description: stringPtr("new")})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
	err = NewRepoService(q, &mockRepoHostClient{}, "s1").DeleteRepo(ctx, actor, "alice", "demo")
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	ownerRepo := repoZOwnerRepo(actor.ID)
	q = &mockRepoQuerier{getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		return ownerRepo, nil
	}, updateRepoFn: func(_ context.Context, arg db.UpdateRepoParams) (db.Repository, error) {
		updated := ownerRepo
		updated.LandingQueueMode = arg.LandingQueueMode
		updated.LandingQueueRequiredChecks = arg.LandingQueueRequiredChecks
		return updated, nil
	}}
	mode := " "
	emptyChecks := []string{}
	updated, err := NewRepoService(q, &mockRepoHostClient{}, "s1").UpdateRepo(ctx, actor, "alice", "demo", UpdateRepoRequest{
		LandingQueueMode:           &mode,
		LandingQueueRequiredChecks: &emptyChecks,
	})
	require.NoError(t, err)
	assert.Equal(t, "serialized", updated.LandingQueueMode)
	assert.Empty(t, updated.LandingQueueRequiredChecks)

	mode = "sideways"
	_, err = NewRepoService(q, &mockRepoHostClient{}, "s1").UpdateRepo(ctx, actor, "alice", "demo", UpdateRepoRequest{LandingQueueMode: &mode})
	assert.Equal(t, http.StatusUnprocessableEntity, apiStatus(t, err))

	archiveErrQ := &repoZQuerier{
		mockRepoQuerier: &mockRepoQuerier{getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return ownerRepo, nil
		}},
		archiveRepoFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{}, stderrors.New("archive failed")
		},
		unarchiveRepoFn: func(context.Context, int64) (db.Repository, error) {
			return db.Repository{}, stderrors.New("unarchive failed")
		},
	}
	_, err = NewRepoService(archiveErrQ, &mockRepoHostClient{}, "s1").ArchiveRepo(ctx, actor, "alice", "demo")
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	archivedSuccess, err := repoZServiceForRepo(ownerRepo).ArchiveRepo(ctx, actor, "alice", "demo")
	require.NoError(t, err)
	assert.True(t, archivedSuccess.IsArchived)

	archived := ownerRepo
	archived.IsArchived = true
	archiveErrQ.mockRepoQuerier.getRepoByOwnerAndLowerNameFn = func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		return archived, nil
	}
	_, err = NewRepoService(archiveErrQ, &mockRepoHostClient{}, "s1").UnarchiveRepo(ctx, actor, "alice", "demo")
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	_, err = NewRepoService(&mockRepoQuerier{}, &mockRepoHostClient{}, "s1").ArchiveRepo(ctx, nil, "alice", "demo")
	assert.Equal(t, http.StatusUnauthorized, apiStatus(t, err))
	_, err = NewRepoService(&mockRepoQuerier{}, &mockRepoHostClient{}, "s1").ArchiveRepo(ctx, actor, "", "demo")
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))
	_, err = NewRepoService(&mockRepoQuerier{}, &mockRepoHostClient{}, "s1").UnarchiveRepo(ctx, nil, "alice", "demo")
	assert.Equal(t, http.StatusUnauthorized, apiStatus(t, err))
	_, err = NewRepoService(&mockRepoQuerier{}, &mockRepoHostClient{}, "s1").UnarchiveRepo(ctx, actor, "", "demo")
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))

	q = &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return nonOwner, nil
		},
		getCollaboratorPermissionForRepo: func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			return "", stderrors.New("perm failed")
		},
	}
	_, err = NewRepoService(q, &mockRepoHostClient{}, "s1").ArchiveRepo(ctx, actor, "alice", "demo")
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
	_, err = NewRepoService(q, &mockRepoHostClient{}, "s1").UnarchiveRepo(ctx, actor, "alice", "demo")
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	q.getCollaboratorPermissionForRepo = func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
		return "read", nil
	}
	_, err = NewRepoService(q, &mockRepoHostClient{}, "s1").ArchiveRepo(ctx, actor, "alice", "demo")
	assert.Equal(t, http.StatusForbidden, apiStatus(t, err))
	_, err = NewRepoService(q, &mockRepoHostClient{}, "s1").UnarchiveRepo(ctx, actor, "alice", "demo")
	assert.Equal(t, http.StatusForbidden, apiStatus(t, err))

	notArchived, err := repoZServiceForRepo(ownerRepo).UnarchiveRepo(ctx, actor, "alice", "demo")
	require.NoError(t, err)
	assert.False(t, notArchived.IsArchived)

	dispatcher := &mockRepoDispatcher{dispatchFn: func(context.Context, int64, webhooks.EventType, any) error {
		return stderrors.New("queue failed")
	}}
	err = NewRepoService(&mockRepoQuerier{}, &mockRepoHostClient{}, "s1", WithRepoWebhookDispatcher(dispatcher)).
		dispatchRepositoryEvent(ctx, ownerRepo, nil, webhooks.EventTypeCreate, "created")
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
}

func TestRepo_Z_TransferUserBranches(t *testing.T) {
	ctx := context.Background()
	actor := testUser()
	repository := repoZOwnerRepo(actor.ID)
	repository.ID = 200
	repository.Name = "demo"
	repository.LowerName = "demo"

	baseQ := func() *mockRepoQuerier {
		q := &mockRepoQuerier{
			getRepoByOwnerAndLowerNameFn: func(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				if arg.Owner == "owner" && arg.LowerName == "demo" {
					return repository, nil
				}
				return db.Repository{}, pgx.ErrNoRows
			},
			listCollaboratorsByRepoFn: func(context.Context, int64) ([]db.Collaborator, error) {
				return []db.Collaborator{{RepositoryID: repository.ID, UserID: pgtype.Int8{Int64: 88, Valid: true}, Permission: "write"}}, nil
			},
			listTeamReposByRepoFn: func(context.Context, int64) ([]db.TeamRepo, error) {
				return []db.TeamRepo{{RepositoryID: repository.ID, TeamID: 99}}, nil
			},
			getUserByLowerUsernameFn: func(context.Context, string) (db.User, error) {
				return db.User{ID: 22, Username: "bob", LowerUsername: "bob"}, nil
			},
			transferRepoToUserFn: func(context.Context, db.TransferRepoToUserParams) (db.Repository, error) {
				return db.Repository{ID: repository.ID, UserID: pgtype.Int8{Int64: 22, Valid: true}, Name: repository.Name, LowerName: repository.LowerName}, nil
			},
		}
		return q
	}

	_, err := NewRepoService(&mockRepoQuerier{}, &mockRepoHostClient{}, "s1").TransferRepo(ctx, nil, "owner", "demo", "bob")
	assert.Equal(t, http.StatusUnauthorized, apiStatus(t, err))
	_, err = NewRepoService(&mockRepoQuerier{}, &mockRepoHostClient{}, "s1").TransferRepo(ctx, actor, "owner", "demo", " ")
	assert.Equal(t, http.StatusUnprocessableEntity, apiStatus(t, err))
	_, err = NewRepoService(&mockRepoQuerier{}, &mockRepoHostClient{}, "s1").TransferRepo(ctx, actor, "", "demo", "bob")
	assert.Equal(t, http.StatusBadRequest, apiStatus(t, err))
	_, err = NewRepoService(baseQ(), &mockRepoHostClient{}, "s1").TransferRepo(ctx, actor, "owner", "demo", " OWNER ")
	assert.Equal(t, http.StatusUnprocessableEntity, apiStatus(t, err))

	permissionErrRepo := repository
	permissionErrRepo.UserID = pgtype.Int8{Int64: 500, Valid: true}
	q := baseQ()
	q.getRepoByOwnerAndLowerNameFn = func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		return permissionErrRepo, nil
	}
	q.getCollaboratorPermissionForRepo = func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
		return "", stderrors.New("perm failed")
	}
	_, err = NewRepoService(q, &mockRepoHostClient{}, "s1").TransferRepo(ctx, actor, "owner", "demo", "bob")
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	q = baseQ()
	q.listCollaboratorsByRepoFn = func(context.Context, int64) ([]db.Collaborator, error) { return nil, stderrors.New("list collabs") }
	_, err = transferToUserCompensating(ctx, NewRepoService(q, &mockRepoHostClient{}, "s1"), repository, 22)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	q = baseQ()
	q.listTeamReposByRepoFn = func(context.Context, int64) ([]db.TeamRepo, error) { return nil, stderrors.New("list teams") }
	_, err = transferToUserCompensating(ctx, NewRepoService(q, &mockRepoHostClient{}, "s1"), repository, 22)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	q = baseQ()
	q.getRepoByOwnerAndLowerNameFn = func(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		if arg.Owner == "owner" {
			return repository, nil
		}
		if arg.Owner == "bob" {
			return repository, nil
		}
		return db.Repository{}, pgx.ErrNoRows
	}
	_, err = NewRepoService(q, &mockRepoHostClient{}, "s1").TransferRepo(ctx, actor, "owner", "demo", "bob")
	assert.Equal(t, http.StatusConflict, apiStatus(t, err))

	privateRepo := repository
	privateRepo.IsPublic = false
	q = baseQ()
	q.getRepoByOwnerAndLowerNameFn = func(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		if arg.Owner == "owner" {
			return privateRepo, nil
		}
		return db.Repository{}, pgx.ErrNoRows
	}
	billing := &stubBillingPolicy{authorizePrivateRepoFn: func(context.Context, string, int64) error {
		t.Fatal("recipient billing is checked when the transfer is accepted")
		return nil
	}}
	privateService := NewRepoService(q, &mockRepoHostClient{}, "s1", WithRepoBillingPolicy(billing))
	privateService.ownershipTx = &fakeOwnershipTxManager{tx: &fakeOwnershipTx{
		q: q, getByIDFn: func(context.Context, int64) (db.Repository, error) { return privateRepo, nil },
	}}
	pending, err := privateService.TransferRepo(ctx, actor, "owner", "demo", "bob")
	require.NoError(t, err)
	require.NotNil(t, pending.PendingTransfer)
	assert.Equal(t, actor.ID, pending.UserID.Int64)

	q = baseQ()
	q.deleteCollaboratorsByRepoFn = func(context.Context, int64) error { return stderrors.New("delete collabs") }
	_, err = transferToUserCompensating(ctx, NewRepoService(q, &mockRepoHostClient{}, "s1"), repository, 22)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	q = baseQ()
	q.deleteTeamReposByRepoFn = func(context.Context, int64) error { return stderrors.New("delete teams") }
	_, err = transferToUserCompensating(ctx, NewRepoService(q, &mockRepoHostClient{}, "s1"), repository, 22)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))

	for _, tc := range []struct {
		name string
		err  error
		code int
	}{
		{name: "unique", err: &pgconn.PgError{Code: "23505"}, code: http.StatusConflict},
		{name: "generic", err: stderrors.New("transfer failed"), code: http.StatusInternalServerError},
	} {
		t.Run("transfer user "+tc.name, func(t *testing.T) {
			q := baseQ()
			q.transferRepoToUserFn = func(context.Context, db.TransferRepoToUserParams) (db.Repository, error) {
				return db.Repository{}, tc.err
			}
			q.addCollaboratorFn = func(context.Context, db.AddCollaboratorParams) (db.Collaborator, error) {
				return db.Collaborator{}, stderrors.New("restore collaborator failed")
			}
			q.addTeamRepoFn = func(context.Context, db.AddTeamRepoParams) (db.TeamRepo, error) {
				return db.TeamRepo{}, stderrors.New("restore team failed")
			}
			_, err := transferToUserCompensating(ctx, NewRepoService(q, &mockRepoHostClient{}, "s1"), repository, 22)
			assert.Equal(t, tc.code, apiStatus(t, err))
		})
	}

	q = baseQ()
	revertCalls := 0
	q.transferRepoToUserFn = func(context.Context, db.TransferRepoToUserParams) (db.Repository, error) {
		revertCalls++
		if revertCalls == 2 {
			return db.Repository{}, stderrors.New("revert failed")
		}
		return db.Repository{ID: repository.ID, UserID: pgtype.Int8{Int64: 22, Valid: true}, Name: repository.Name, LowerName: repository.LowerName}, nil
	}
	rh := &mockRepoHostClient{moveRepoFn: func(context.Context, string, string, string, string) error {
		return stderrors.New("move failed")
	}}
	_, err = transferToUserCompensating(ctx, NewRepoService(q, rh, "s1"), repository, 22)
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
	assert.Equal(t, 2, revertCalls)
}

func TestRepo_Z_TransferOrgBranches(t *testing.T) {
	ctx := context.Background()
	actor := testUser()
	repository := repoZOwnerRepo(actor.ID)
	repository.ID = 300
	repository.Name = "demo"
	repository.LowerName = "demo"

	baseQ := func() *mockRepoQuerier {
		return &mockRepoQuerier{
			getRepoByOwnerAndLowerNameFn: func(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				if arg.Owner == "owner" && arg.LowerName == "demo" {
					return repository, nil
				}
				return db.Repository{}, pgx.ErrNoRows
			},
			listCollaboratorsByRepoFn: func(context.Context, int64) ([]db.Collaborator, error) {
				return []db.Collaborator{{RepositoryID: repository.ID, UserID: pgtype.Int8{Int64: 88, Valid: true}, Permission: "write"}}, nil
			},
			listTeamReposByRepoFn: func(context.Context, int64) ([]db.TeamRepo, error) {
				return []db.TeamRepo{{RepositoryID: repository.ID, TeamID: 99}}, nil
			},
			getUserByLowerUsernameFn: func(context.Context, string) (db.User, error) {
				return db.User{}, pgx.ErrNoRows
			},
			getOrgByLowerNameFn: func(context.Context, string) (db.Organization, error) {
				return db.Organization{ID: 44, Name: "acme", LowerName: "acme"}, nil
			},
			getOrgMemberFn: func(context.Context, db.GetOrgMemberParams) (db.OrgMember, error) {
				return db.OrgMember{OrganizationID: 44, UserID: actor.ID, Role: "owner"}, nil
			},
			transferRepoToOrgFn: func(context.Context, db.TransferRepoToOrgParams) (db.Repository, error) {
				return db.Repository{ID: repository.ID, OrgID: pgtype.Int8{Int64: 44, Valid: true}, Name: repository.Name, LowerName: repository.LowerName}, nil
			},
		}
	}

	for _, tc := range []struct {
		name      string
		configure func(*mockRepoQuerier)
		code      int
	}{
		{name: "org not found", configure: func(q *mockRepoQuerier) {
			q.getOrgByLowerNameFn = func(context.Context, string) (db.Organization, error) { return db.Organization{}, pgx.ErrNoRows }
		}, code: http.StatusNotFound},
		{name: "org lookup error", configure: func(q *mockRepoQuerier) {
			q.getOrgByLowerNameFn = func(context.Context, string) (db.Organization, error) {
				return db.Organization{}, stderrors.New("org failed")
			}
		}, code: http.StatusInternalServerError},
		{name: "membership missing", configure: func(q *mockRepoQuerier) {
			q.getOrgMemberFn = func(context.Context, db.GetOrgMemberParams) (db.OrgMember, error) {
				return db.OrgMember{}, pgx.ErrNoRows
			}
		}, code: http.StatusForbidden},
		{name: "membership error", configure: func(q *mockRepoQuerier) {
			q.getOrgMemberFn = func(context.Context, db.GetOrgMemberParams) (db.OrgMember, error) {
				return db.OrgMember{}, stderrors.New("member failed")
			}
		}, code: http.StatusInternalServerError},
		{name: "membership not owner", configure: func(q *mockRepoQuerier) {
			q.getOrgMemberFn = func(context.Context, db.GetOrgMemberParams) (db.OrgMember, error) {
				return db.OrgMember{OrganizationID: 44, UserID: actor.ID, Role: "member"}, nil
			}
		}, code: http.StatusForbidden},
		{name: "duplicate org repo", configure: func(q *mockRepoQuerier) {
			q.getRepoByOwnerAndLowerNameFn = func(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				if arg.Owner == "owner" {
					return repository, nil
				}
				if arg.Owner == "acme" {
					return repository, nil
				}
				return db.Repository{}, pgx.ErrNoRows
			}
		}, code: http.StatusConflict},
		{name: "delete collaborators", configure: func(q *mockRepoQuerier) {
			q.deleteCollaboratorsByRepoFn = func(context.Context, int64) error { return stderrors.New("delete collabs") }
		}, code: http.StatusInternalServerError},
		{name: "delete team repos", configure: func(q *mockRepoQuerier) {
			q.deleteTeamReposByRepoFn = func(context.Context, int64) error { return stderrors.New("delete teams") }
		}, code: http.StatusInternalServerError},
		{name: "transfer unique", configure: func(q *mockRepoQuerier) {
			q.transferRepoToOrgFn = func(context.Context, db.TransferRepoToOrgParams) (db.Repository, error) {
				return db.Repository{}, &pgconn.PgError{Code: "23505"}
			}
		}, code: http.StatusConflict},
		{name: "transfer generic", configure: func(q *mockRepoQuerier) {
			q.transferRepoToOrgFn = func(context.Context, db.TransferRepoToOrgParams) (db.Repository, error) {
				return db.Repository{}, stderrors.New("transfer failed")
			}
		}, code: http.StatusInternalServerError},
	} {
		t.Run(tc.name, func(t *testing.T) {
			q := baseQ()
			tc.configure(q)
			_, err := NewRepoService(q, &mockRepoHostClient{}, "s1").TransferRepo(ctx, actor, "owner", "demo", "acme")
			assert.Equal(t, tc.code, apiStatus(t, err))
		})
	}

	privateRepo := repository
	privateRepo.IsPublic = false
	q := baseQ()
	q.getRepoByOwnerAndLowerNameFn = func(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		if arg.Owner == "owner" {
			return privateRepo, nil
		}
		return db.Repository{}, pgx.ErrNoRows
	}
	billing := &stubBillingPolicy{authorizePrivateRepoFn: func(context.Context, string, int64) error {
		return pkgerrors.Forbidden("blocked")
	}}
	_, err := NewRepoService(q, &mockRepoHostClient{}, "s1", WithRepoBillingPolicy(billing)).TransferRepo(ctx, actor, "owner", "demo", "acme")
	assert.Equal(t, http.StatusForbidden, apiStatus(t, err))

	q = baseQ()
	revertCalls := 0
	q.transferRepoToUserFn = func(context.Context, db.TransferRepoToUserParams) (db.Repository, error) {
		revertCalls++
		return db.Repository{}, stderrors.New("revert failed")
	}
	rh := &mockRepoHostClient{moveRepoFn: func(context.Context, string, string, string, string) error {
		return stderrors.New("move failed")
	}}
	_, err = NewRepoService(q, rh, "s1").TransferRepo(ctx, actor, "owner", "demo", "acme")
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
	assert.Equal(t, 1, revertCalls)
}

func TestRepo_Z_NormalizeTopicsEmpty(t *testing.T) {
	topics, err := normalizeTopics(nil)
	require.NoError(t, err)
	assert.Empty(t, topics)

	topics, err = normalizeTopics([]string{" Go ", "go", "ci"})
	require.NoError(t, err)
	assert.Equal(t, []string{"go", "ci"}, topics)

	_, err = normalizeTopics([]string{strings.Repeat("a", 36)})
	assert.Equal(t, http.StatusUnprocessableEntity, apiStatus(t, err))
}
