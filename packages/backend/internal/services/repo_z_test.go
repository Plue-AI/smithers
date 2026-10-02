package services

import (
	"context"
	stderrors "errors"
	"fmt"
	"net/http"
	"strings"
	"testing"

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
