package services

import (
	"context"
	stdErrors "errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

var errAmbiguousRepositoryCreate = stdErrors.New("connection lost after query")

func recoveredUserRepository(arg db.CreateRepoParams, id int64) db.Repository {
	return db.Repository{
		ID:              id,
		UserID:          arg.UserID,
		Name:            arg.Name,
		LowerName:       arg.LowerName,
		Description:     arg.Description,
		IsPublic:        arg.IsPublic,
		DefaultBookmark: arg.DefaultBookmark,
		CreatedAt:       time.Now().UTC().Add(time.Minute),
	}
}

func recoveredOrgRepository(arg db.CreateOrgRepoParams, id int64) db.Repository {
	return db.Repository{
		ID:              id,
		OrgID:           arg.OrgID,
		Name:            arg.Name,
		LowerName:       arg.LowerName,
		Description:     arg.Description,
		IsPublic:        arg.IsPublic,
		DefaultBookmark: arg.DefaultBookmark,
		CreatedAt:       time.Now().UTC().Add(time.Minute),
	}
}

func recoveredForkRepository(arg db.CreateForkRepoParams, id int64) db.Repository {
	return db.Repository{
		ID:              id,
		UserID:          arg.UserID,
		Name:            arg.Name,
		LowerName:       arg.LowerName,
		Description:     arg.Description,
		IsPublic:        arg.IsPublic,
		DefaultBookmark: arg.DefaultBookmark,
		IsFork:          true,
		ForkID:          arg.ForkID,
		CreatedAt:       time.Now().UTC().Add(time.Minute),
	}
}

func TestRepositoryCreateErrorClassification(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		name string
		err  error
		want repositoryCreateErrorKind
	}{
		{name: "unique pg error", err: &pgconn.PgError{Code: "23505"}, want: repositoryCreateErrorConflict},
		{name: "wrapped unique pg error", err: fmt.Errorf("insert: %w", &pgconn.PgError{Code: "23505"}), want: repositoryCreateErrorConflict},
		{name: "other pg error", err: &pgconn.PgError{Code: "40001"}, want: repositoryCreateErrorDefinitive},
		{name: "legacy textual unique", err: stdErrors.New("duplicate key violates unique constraint"), want: repositoryCreateErrorConflict},
		{name: "transport error", err: errAmbiguousRepositoryCreate, want: repositoryCreateErrorAmbiguous},
	} {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, test.want, classifyRepositoryCreateError(test.err))
		})
	}
}

func TestRepositoryMatchesCreateExpectationRequiresExactFreshRow(t *testing.T) {
	t.Parallel()

	notBefore := time.Now().UTC()
	expected := repositoryCreateExpectation{
		UserID:          pgtype.Int8{Int64: 7, Valid: true},
		Name:            "Demo",
		LowerName:       "demo",
		Description:     "description",
		IsPublic:        false,
		DefaultBookmark: "main",
		IsFork:          true,
		ForkID:          pgtype.Int8{Int64: 42, Valid: true},
		NotBefore:       notBefore,
	}
	exact := db.Repository{
		ID:              99,
		UserID:          expected.UserID,
		Name:            expected.Name,
		LowerName:       expected.LowerName,
		Description:     expected.Description,
		IsPublic:        expected.IsPublic,
		DefaultBookmark: expected.DefaultBookmark,
		IsFork:          expected.IsFork,
		ForkID:          expected.ForkID,
		CreatedAt:       notBefore,
	}
	require.True(t, repositoryMatchesCreateExpectation(exact, expected))

	mutations := map[string]func(*db.Repository){
		"zero id":          func(repo *db.Repository) { repo.ID = 0 },
		"user owner":       func(repo *db.Repository) { repo.UserID.Int64++ },
		"org owner":        func(repo *db.Repository) { repo.OrgID = pgtype.Int8{Int64: 8, Valid: true} },
		"name":             func(repo *db.Repository) { repo.Name = "demo" },
		"lower name":       func(repo *db.Repository) { repo.LowerName = "other" },
		"description":      func(repo *db.Repository) { repo.Description = "other" },
		"visibility":       func(repo *db.Repository) { repo.IsPublic = true },
		"default bookmark": func(repo *db.Repository) { repo.DefaultBookmark = "trunk" },
		"fork marker":      func(repo *db.Repository) { repo.IsFork = false },
		"fork parent":      func(repo *db.Repository) { repo.ForkID.Int64++ },
		"older row":        func(repo *db.Repository) { repo.CreatedAt = notBefore.Add(-time.Nanosecond) },
	}
	for name, mutate := range mutations {
		name, mutate := name, mutate
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			candidate := exact
			mutate(&candidate)
			assert.False(t, repositoryMatchesCreateExpectation(candidate, expected))
		})
	}
}

func TestReconcileAmbiguousRepositoryCreateUsesDetachedBoundedContext(t *testing.T) {
	parent, cancelParent := context.WithCancel(context.Background())
	cancelParent()
	notBefore := time.Now().UTC()
	expected := repositoryCreateExpectation{
		UserID:          pgtype.Int8{Int64: 7, Valid: true},
		Name:            "demo",
		LowerName:       "demo",
		DefaultBookmark: "main",
		NotBefore:       notBefore,
	}
	recovered := db.Repository{
		ID:              9,
		UserID:          expected.UserID,
		Name:            expected.Name,
		LowerName:       expected.LowerName,
		DefaultBookmark: expected.DefaultBookmark,
		CreatedAt:       notBefore,
	}

	actual, state, err := reconcileAmbiguousRepositoryCreate(parent, func(lookupCtx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		require.NoError(t, lookupCtx.Err())
		_, bounded := lookupCtx.Deadline()
		assert.True(t, bounded)
		assert.Equal(t, "alice", arg.Owner)
		assert.Equal(t, "demo", arg.LowerName)
		return recovered, nil
	}, "alice", expected)
	require.NoError(t, err)
	assert.Equal(t, repositoryCreateAdopted, state)
	assert.Equal(t, recovered.ID, actual.ID)
}

func TestRepoService_CreateRepo_AdoptsAmbiguousCommittedRow(t *testing.T) {
	var createArg db.CreateRepoParams
	q := &mockRepoQuerier{
		createRepoFn: func(_ context.Context, arg db.CreateRepoParams) (db.Repository, error) {
			createArg = arg
			return db.Repository{}, errAmbiguousRepositoryCreate
		},
		getRepoByOwnerAndLowerNameFn: func(lookupCtx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			require.NoError(t, lookupCtx.Err())
			assert.Equal(t, "testuser", arg.Owner)
			assert.Equal(t, "demo", arg.LowerName)
			return recoveredUserRepository(createArg, 71), nil
		},
	}
	initCalls := 0
	rh := &mockRepoHostClient{initRepoFn: func(context.Context, string, string, string, bool) error {
		initCalls++
		return nil
	}}

	repository, err := NewRepoService(q, rh, "s1").CreateRepo(context.Background(), testUser(), "demo", "desc", true, "main", false)
	require.NoError(t, err)
	assert.Equal(t, int64(71), repository.ID)
	assert.Equal(t, 1, initCalls)
	assert.False(t, q.deleteCalled)
}

func TestRepoService_CreateOrgRepo_AdoptsAmbiguousCommittedRow(t *testing.T) {
	var createArg db.CreateOrgRepoParams
	q := &mockRepoQuerier{
		getOrgByLowerNameFn: func(context.Context, string) (db.Organization, error) {
			return db.Organization{ID: 77, Name: "Acme", LowerName: "acme"}, nil
		},
		getOrgMemberFn: func(context.Context, db.GetOrgMemberParams) (db.OrgMember, error) {
			return db.OrgMember{OrganizationID: 77, UserID: 1, Role: "owner"}, nil
		},
		createOrgRepoFn: func(_ context.Context, arg db.CreateOrgRepoParams) (db.Repository, error) {
			createArg = arg
			return db.Repository{}, errAmbiguousRepositoryCreate
		},
		getRepoByOwnerAndLowerNameFn: func(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			assert.Equal(t, "Acme", arg.Owner)
			return recoveredOrgRepository(createArg, 72), nil
		},
	}

	repository, err := NewRepoService(q, &mockRepoHostClient{}, "s1").CreateOrgRepo(
		context.Background(), testUser(), "acme", "demo", "desc", true, "main", false,
	)
	require.NoError(t, err)
	assert.Equal(t, int64(72), repository.ID)
	assert.Equal(t, pgtype.Int8{Int64: 77, Valid: true}, repository.OrgID)
}

func TestRepoService_ForkRepo_AdoptsAmbiguousCommittedRow(t *testing.T) {
	// The source belongs to another user: a caller who can already write to it
	// is refused outright, so only a reader reaches the create path.
	source := testRepo(func(repo *db.Repository) {
		repo.ID = 42
		repo.UserID = pgtype.Int8{Int64: 99, Valid: true}
		repo.IsPublic = true
	})
	var createArg db.CreateForkRepoParams
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			switch arg.LowerName {
			case source.LowerName:
				return source, nil
			case "demo-copy":
				return recoveredForkRepository(createArg, 73), nil
			default:
				return db.Repository{}, pgx.ErrNoRows
			}
		},
		createForkRepoFn: func(_ context.Context, arg db.CreateForkRepoParams) (db.Repository, error) {
			createArg = arg
			return db.Repository{}, errAmbiguousRepositoryCreate
		},
	}
	forkCalls := 0
	rh := &mockRepoHostClient{forkRepoFn: func(context.Context, string, string, string, string) error {
		forkCalls++
		return nil
	}}

	repository, err := NewRepoService(q, rh, "s1").ForkRepo(
		context.Background(), testUser(), "alice", source.Name, "demo-copy", "fork desc",
	)
	require.NoError(t, err)
	assert.Equal(t, int64(73), repository.Repository.ID)
	assert.True(t, repository.Repository.IsFork)
	assert.Equal(t, source.ID, repository.Repository.ForkID.Int64)
	assert.Equal(t, 1, forkCalls)
}

func TestRepoService_CreateRepo_AmbiguousFailureWithoutRecoverableRowRemainsInternal(t *testing.T) {
	for _, lookupErr := range []error{pgx.ErrNoRows, stdErrors.New("lookup unavailable")} {
		lookupErr := lookupErr
		t.Run(lookupErr.Error(), func(t *testing.T) {
			lookupCalls := 0
			q := &mockRepoQuerier{
				createRepoFn: func(context.Context, db.CreateRepoParams) (db.Repository, error) {
					return db.Repository{}, errAmbiguousRepositoryCreate
				},
				getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
					lookupCalls++
					return db.Repository{}, lookupErr
				},
			}
			rh := &mockRepoHostClient{initRepoFn: func(context.Context, string, string, string, bool) error {
				t.Fatal("repo-host init must not run without a recovered row")
				return nil
			}}

			_, err := NewRepoService(q, rh, "s1").CreateRepo(context.Background(), testUser(), "demo", "", true, "main", false)
			assert.Equal(t, 500, apiStatus(t, err))
			assert.Equal(t, 1, lookupCalls)
		})
	}
}

func TestRepoService_CreateRepo_AmbiguousOlderOrMismatchedRowIsConflict(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*db.Repository)
	}{
		{name: "older", mutate: func(repo *db.Repository) { repo.CreatedAt = time.Now().UTC().Add(-time.Hour) }},
		{name: "mismatched", mutate: func(repo *db.Repository) { repo.Description = "different" }},
	} {
		test := test
		t.Run(test.name, func(t *testing.T) {
			var createArg db.CreateRepoParams
			q := &mockRepoQuerier{
				createRepoFn: func(_ context.Context, arg db.CreateRepoParams) (db.Repository, error) {
					createArg = arg
					return db.Repository{}, errAmbiguousRepositoryCreate
				},
				getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
					recovered := recoveredUserRepository(createArg, 81)
					test.mutate(&recovered)
					return recovered, nil
				},
			}
			rh := &mockRepoHostClient{initRepoFn: func(context.Context, string, string, string, bool) error {
				t.Fatal("repo-host init must not run for a conflicting recovered row")
				return nil
			}}

			_, err := NewRepoService(q, rh, "s1").CreateRepo(context.Background(), testUser(), "demo", "desc", true, "main", false)
			assert.Equal(t, 409, apiStatus(t, err))
		})
	}
}

func TestRepoService_CreateRepo_AdoptedAlreadyExistsConvergesWithoutUnsafeCompensation(t *testing.T) {
	for _, test := range []struct {
		name             string
		initErr          error
		wantStatus       int
		wantCompensation bool
	}{
		{
			name:       "concurrent identical storage already exists",
			initErr:    &repohost.StatusError{StatusCode: 409, Message: "repository already exists"},
			wantStatus: 0,
		},
		{
			name:       "other init failure preserves ambiguously owned row",
			initErr:    stdErrors.New("disk unavailable"),
			wantStatus: 500,
		},
	} {
		test := test
		t.Run(test.name, func(t *testing.T) {
			var createArg db.CreateRepoParams
			q := &mockRepoQuerier{
				createRepoFn: func(_ context.Context, arg db.CreateRepoParams) (db.Repository, error) {
					createArg = arg
					return db.Repository{}, errAmbiguousRepositoryCreate
				},
				getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
					return recoveredUserRepository(createArg, 91), nil
				},
			}
			rh := &mockRepoHostClient{initRepoFn: func(context.Context, string, string, string, bool) error {
				return test.initErr
			}}

			repository, err := NewRepoService(q, rh, "s1").CreateRepo(context.Background(), testUser(), "demo", "", true, "main", false)
			if test.wantStatus == 0 {
				require.NoError(t, err)
				assert.Equal(t, int64(91), repository.ID)
			} else {
				assert.Equal(t, test.wantStatus, apiStatus(t, err))
			}
			assert.Equal(t, test.wantCompensation, q.deleteCalled)
			if test.wantCompensation {
				assert.Equal(t, 1, rh.deleteRepoCalls)
			} else {
				assert.Zero(t, rh.deleteRepoCalls)
			}
		})
	}
}

func TestGitHubImportService_AdoptedInitFailurePreservesAmbiguouslyOwnedMirror(t *testing.T) {
	getCalls := 0
	var createArg db.CreateRepoParams
	repoDB := &reconciliationImportRepoDB{
		getFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			getCalls++
			if getCalls == 1 {
				return db.Repository{}, pgx.ErrNoRows
			}
			return recoveredUserRepository(createArg, 102), nil
		},
		createFn: func(_ context.Context, arg db.CreateRepoParams) (db.Repository, error) {
			createArg = arg
			return db.Repository{}, errAmbiguousRepositoryCreate
		},
	}
	host := &reconciliationImportRepoHost{initErr: stdErrors.New("repo host unavailable")}

	_, reused, err := NewGitHubImportService(nil, repoDB, nil, host, nil, "https://plue.test").
		ensureLocalRepo(context.Background(), 7, "alice", "octo", "demo", "main")
	require.Error(t, err)
	assert.False(t, reused)
	assert.Zero(t, repoDB.deleteCalls)
	assert.Zero(t, host.deleteCalls)
}

func TestRepoService_CreateRepo_AlreadyExistsIsOnlyIdempotentAfterAdoption(t *testing.T) {
	q := &mockRepoQuerier{createRepoFn: func(_ context.Context, arg db.CreateRepoParams) (db.Repository, error) {
		return recoveredUserRepository(arg, 92), nil
	}}
	rh := &mockRepoHostClient{initRepoFn: func(context.Context, string, string, string, bool) error {
		return &repohost.StatusError{StatusCode: 409, Message: "repository already exists"}
	}}

	_, err := NewRepoService(q, rh, "s1").CreateRepo(context.Background(), testUser(), "demo", "", true, "main", false)
	assert.Equal(t, 500, apiStatus(t, err))
	assert.True(t, q.deleteCalled)
	assert.Equal(t, 1, rh.deleteRepoCalls)
}

func TestRepoService_CreateRepo_GenuineUniqueViolationDoesNotReconcile(t *testing.T) {
	q := &mockRepoQuerier{
		createRepoFn: func(context.Context, db.CreateRepoParams) (db.Repository, error) {
			return db.Repository{}, &pgconn.PgError{Code: "23505"}
		},
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			t.Fatal("23505 must remain a definitive conflict without reconciliation")
			return db.Repository{}, nil
		},
	}

	_, err := NewRepoService(q, &mockRepoHostClient{}, "s1").CreateRepo(context.Background(), testUser(), "demo", "", true, "main", false)
	assert.Equal(t, 409, apiStatus(t, err))
}

type reconciliationImportRepoDB struct {
	getFn       func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	createFn    func(context.Context, db.CreateRepoParams) (db.Repository, error)
	deleteCalls int
}

func (d *reconciliationImportRepoDB) GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	return d.getFn(ctx, arg)
}

func (d *reconciliationImportRepoDB) CreateRepo(ctx context.Context, arg db.CreateRepoParams) (db.Repository, error) {
	return d.createFn(ctx, arg)
}

func (d *reconciliationImportRepoDB) DeleteRepo(context.Context, int64) error {
	d.deleteCalls++
	return nil
}

type reconciliationImportRepoHost struct {
	initErr     error
	initCalls   int
	deleteCalls int
}

func (h *reconciliationImportRepoHost) InitRepo(context.Context, string, string, string, bool) error {
	h.initCalls++
	return h.initErr
}

func (h *reconciliationImportRepoHost) DeleteRepo(context.Context, string, string) error {
	h.deleteCalls++
	return nil
}

func (*reconciliationImportRepoHost) ImportRefs(context.Context, string, string) error { return nil }

func (*reconciliationImportRepoHost) ListBookmarks(context.Context, string, string, string, int) ([]repohost.Bookmark, string, error) {
	return nil, "", nil
}

func (*reconciliationImportRepoHost) CreateBookmark(context.Context, string, string, repohost.CreateBookmarkRequest) (repohost.Bookmark, error) {
	return repohost.Bookmark{}, nil
}

func TestGitHubImportService_AdoptsAmbiguousCommittedMirror(t *testing.T) {
	getCalls := 0
	var createArg db.CreateRepoParams
	repoDB := &reconciliationImportRepoDB{
		getFn: func(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			getCalls++
			if getCalls == 1 {
				return db.Repository{}, pgx.ErrNoRows
			}
			assert.Equal(t, "alice", arg.Owner)
			return recoveredUserRepository(createArg, 101), nil
		},
		createFn: func(_ context.Context, arg db.CreateRepoParams) (db.Repository, error) {
			createArg = arg
			return db.Repository{}, errAmbiguousRepositoryCreate
		},
	}
	host := &reconciliationImportRepoHost{
		initErr: &repohost.StatusError{StatusCode: 400, Message: "destination repository already exists"},
	}
	svc := NewGitHubImportService(nil, repoDB, nil, host, nil, "https://plue.test")

	repository, reused, err := svc.ensureLocalRepo(context.Background(), 7, "alice", "octo", "demo", "main")
	require.NoError(t, err)
	assert.False(t, reused)
	assert.Equal(t, int64(101), repository.ID)
	assert.Equal(t, 2, getCalls)
	assert.Equal(t, 1, host.initCalls)
	assert.Zero(t, host.deleteCalls)
	assert.Zero(t, repoDB.deleteCalls)
}

func TestGitHubImportService_AmbiguousMismatchedCandidateContinues(t *testing.T) {
	getCalls := map[string]int{}
	createCalls := map[string]int{}
	repoDB := &reconciliationImportRepoDB{}
	repoDB.getFn = func(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		getCalls[arg.LowerName]++
		if arg.LowerName == "demo" && getCalls[arg.LowerName] == 2 {
			return db.Repository{
				ID:              111,
				UserID:          pgtype.Int8{Int64: 7, Valid: true},
				Name:            "demo",
				LowerName:       "demo",
				Description:     "another source",
				DefaultBookmark: "main",
				CreatedAt:       time.Now().UTC().Add(time.Minute),
			}, nil
		}
		return db.Repository{}, pgx.ErrNoRows
	}
	repoDB.createFn = func(_ context.Context, arg db.CreateRepoParams) (db.Repository, error) {
		createCalls[arg.LowerName]++
		if arg.LowerName == "demo" {
			return db.Repository{}, errAmbiguousRepositoryCreate
		}
		return recoveredUserRepository(arg, 112), nil
	}
	host := &reconciliationImportRepoHost{}

	repository, reused, err := NewGitHubImportService(nil, repoDB, nil, host, nil, "https://plue.test").
		ensureLocalRepo(context.Background(), 7, "alice", "octo", "demo", "main")
	require.NoError(t, err)
	assert.False(t, reused)
	assert.Equal(t, "demo-octo", repository.Name)
	assert.Equal(t, 2, getCalls["demo"])
	assert.Equal(t, 1, createCalls["demo"])
	assert.Equal(t, 1, createCalls["demo-octo"])
	assert.Equal(t, 1, host.initCalls)
}

func TestGitHubImportService_GenuineUniqueViolationKeepsCandidateBehavior(t *testing.T) {
	getCalls := 0
	createCalls := 0
	repoDB := &reconciliationImportRepoDB{
		getFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			getCalls++
			return db.Repository{}, pgx.ErrNoRows
		},
		createFn: func(context.Context, db.CreateRepoParams) (db.Repository, error) {
			createCalls++
			return db.Repository{}, &pgconn.PgError{Code: "23505"}
		},
	}
	host := &reconciliationImportRepoHost{}

	_, reused, err := NewGitHubImportService(nil, repoDB, nil, host, nil, "https://plue.test").
		ensureLocalRepo(context.Background(), 7, "alice", "octo", "demo", "main")
	require.Error(t, err)
	assert.ErrorContains(t, err, "create local repo")
	assert.False(t, reused)
	assert.Equal(t, 1, getCalls, "23505 must not trigger reconciliation or advance candidates")
	assert.Equal(t, 1, createCalls)
	assert.Zero(t, host.initCalls)
}

func (h *reconciliationImportRepoHost) GetBookmark(ctx context.Context, owner, repo, name string) (repohost.Bookmark, error) {
	items, _, err := h.ListBookmarks(ctx, owner, repo, "", 100)
	if err != nil {
		return repohost.Bookmark{}, err
	}
	for _, bookmark := range items {
		if bookmark.Name == name {
			return bookmark, nil
		}
	}
	return repohost.Bookmark{}, &repohost.StatusError{StatusCode: 404, Code: "bookmark_not_found"}
}
