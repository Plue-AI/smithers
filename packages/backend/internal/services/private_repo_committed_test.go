package services

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type committedPrivateBillingPolicy struct {
	*stubBillingPolicy
	authorizeFn func(context.Context, string, int64, func(context.Context) error) error
	calls       int
	ownerType   string
	ownerID     int64
}

func (p *committedPrivateBillingPolicy) AuthorizePrivateRepoCommitted(
	ctx context.Context,
	ownerType string,
	ownerID int64,
	commit func(context.Context) error,
) error {
	p.calls++
	p.ownerType = ownerType
	p.ownerID = ownerID
	if p.authorizeFn != nil {
		return p.authorizeFn(ctx, ownerType, ownerID, commit)
	}
	return commit(ctx)
}

func newCommittedPrivateBillingPolicy() *committedPrivateBillingPolicy {
	return &committedPrivateBillingPolicy{stubBillingPolicy: &stubBillingPolicy{}}
}

func TestRepoService_CreateRepo_CommittedPrivateAdmissionWrapsProvisioning(t *testing.T) {
	var calls []string
	q := &mockRepoQuerier{
		createRepoFn: func(_ context.Context, arg db.CreateRepoParams) (db.Repository, error) {
			calls = append(calls, "create")
			return db.Repository{ID: 41, UserID: arg.UserID, Name: arg.Name, LowerName: arg.LowerName, IsPublic: arg.IsPublic}, nil
		},
	}
	rh := &mockRepoHostClient{initRepoFn: func(context.Context, string, string, string, bool) error {
		calls = append(calls, "init")
		return nil
	}}
	policy := newCommittedPrivateBillingPolicy()
	policy.authorizeFn = func(ctx context.Context, ownerType string, ownerID int64, commit func(context.Context) error) error {
		calls = append(calls, "authorize-start")
		err := commit(ctx)
		calls = append(calls, "authorize-end")
		return err
	}
	svc := NewRepoService(q, rh, "s1", WithRepoBillingPolicy(policy))

	created, err := svc.CreateRepo(context.Background(), testUser(), "private", "", false, "main", false)
	require.NoError(t, err)
	assert.Equal(t, int64(41), created.ID)
	assert.Equal(t, []string{"authorize-start", "create", "init", "authorize-end"}, calls)
	assert.Equal(t, 1, policy.calls)
	assert.Equal(t, BillingOwnerTypeUser, policy.ownerType)
	assert.Equal(t, testUser().ID, policy.ownerID)
}

func TestRepoService_CreateRepo_CommittedPrivateDenialAndPublicBypass(t *testing.T) {
	t.Run("denial leaves database and repo host untouched", func(t *testing.T) {
		q := &mockRepoQuerier{createRepoFn: func(context.Context, db.CreateRepoParams) (db.Repository, error) {
			t.Fatal("private quota denial must precede repository creation")
			return db.Repository{}, nil
		}}
		rh := &mockRepoHostClient{initRepoFn: func(context.Context, string, string, string, bool) error {
			t.Fatal("private quota denial must precede repo-host initialization")
			return nil
		}}
		policy := newCommittedPrivateBillingPolicy()
		policy.authorizeFn = func(context.Context, string, int64, func(context.Context) error) error {
			return pkgerrors.Forbidden("private repository cap reached")
		}

		_, err := NewRepoService(q, rh, "s1", WithRepoBillingPolicy(policy)).
			CreateRepo(context.Background(), testUser(), "private", "", false, "main", false)
		require.Error(t, err)
		assert.Equal(t, 403, apiStatus(t, err))
		assert.Equal(t, 1, policy.calls)
	})

	t.Run("public repository bypasses private admission", func(t *testing.T) {
		policy := newCommittedPrivateBillingPolicy()
		policy.authorizeFn = func(context.Context, string, int64, func(context.Context) error) error {
			t.Fatal("public repository must not consume private quota")
			return nil
		}
		_, err := NewRepoService(&mockRepoQuerier{}, &mockRepoHostClient{}, "s1", WithRepoBillingPolicy(policy)).
			CreateRepo(context.Background(), testUser(), "public", "", true, "main", false)
		require.NoError(t, err)
		assert.Zero(t, policy.calls)
	})
}

func TestRepoService_CreateOrgAndForkUseCommittedPrivateAdmission(t *testing.T) {
	t.Run("organization create", func(t *testing.T) {
		q := &mockRepoQuerier{
			getOrgByLowerNameFn: func(context.Context, string) (db.Organization, error) {
				return db.Organization{ID: 77, Name: "acme", LowerName: "acme"}, nil
			},
			getOrgMemberFn: func(context.Context, db.GetOrgMemberParams) (db.OrgMember, error) {
				return db.OrgMember{OrganizationID: 77, UserID: 1, Role: "owner"}, nil
			},
		}
		policy := newCommittedPrivateBillingPolicy()
		_, err := NewRepoService(q, &mockRepoHostClient{}, "s1", WithRepoBillingPolicy(policy)).
			CreateOrgRepo(context.Background(), testUser(), "acme", "private", "", false, "main", false)
		require.NoError(t, err)
		assert.Equal(t, 1, policy.calls)
		assert.Equal(t, BillingOwnerTypeOrg, policy.ownerType)
		assert.Equal(t, int64(77), policy.ownerID)
	})

}

func TestRepoService_UpdateRepo_PrivateAdmissionEnclosesOwnershipCommit(t *testing.T) {
	repository := testRepo(func(repo *db.Repository) {
		repo.IsPublic = true
		repo.UserID = pgtype.Int8{Int64: 1, Valid: true}
		repo.OrgID = pgtype.Int8{}
	})
	var calls []string
	q := &mockRepoQuerier{
		getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return repository, nil
		},
		updateRepoFn: func(_ context.Context, arg db.UpdateRepoParams) (db.Repository, error) {
			calls = append(calls, "update")
			updated := repository
			updated.IsPublic = arg.IsPublic
			return updated, nil
		},
	}
	tx := &fakeOwnershipTx{
		q:         q,
		getByIDFn: func(context.Context, int64) (db.Repository, error) { return repository, nil },
		commitFn: func(context.Context) error {
			calls = append(calls, "commit")
			return nil
		},
	}
	policy := newCommittedPrivateBillingPolicy()
	policy.authorizeFn = func(ctx context.Context, ownerType string, ownerID int64, commit func(context.Context) error) error {
		calls = append(calls, "authorize-start")
		err := commit(ctx)
		calls = append(calls, "authorize-end")
		return err
	}
	svc := NewRepoService(q, &mockRepoHostClient{}, "s1", WithRepoBillingPolicy(policy))
	svc.ownershipTx = &fakeOwnershipTxManager{tx: tx}

	updated, err := svc.UpdateRepo(context.Background(), testUser(), "owner", repository.Name, UpdateRepoRequest{Private: boolPtr(true)})
	require.NoError(t, err)
	assert.False(t, updated.IsPublic)
	assert.Equal(t, []string{"authorize-start", "update", "commit", "authorize-end"}, calls)
	assert.Equal(t, BillingOwnerTypeUser, policy.ownerType)
	assert.Equal(t, int64(1), policy.ownerID)
	assert.True(t, tx.committed)
}

func TestRepoService_UpdateRepo_DoesNotDoubleCountSerializedPrivateTransition(t *testing.T) {
	snapshot := testRepo(func(repo *db.Repository) {
		repo.IsPublic = true
		repo.UserID = pgtype.Int8{Int64: 1, Valid: true}
		repo.OrgID = pgtype.Int8{}
	})
	fresh := snapshot
	fresh.IsPublic = false
	q := &mockRepoQuerier{getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
		return snapshot, nil
	}}
	tx := &fakeOwnershipTx{
		q:         q,
		getByIDFn: func(context.Context, int64) (db.Repository, error) { return fresh, nil },
	}
	policy := newCommittedPrivateBillingPolicy()
	policy.authorizeFn = func(context.Context, string, int64, func(context.Context) error) error {
		t.Fatal("an already-private fresh row must not consume a second private slot")
		return nil
	}
	svc := NewRepoService(q, &mockRepoHostClient{}, "s1", WithRepoBillingPolicy(policy))
	svc.ownershipTx = &fakeOwnershipTxManager{tx: tx}

	_, err := svc.UpdateRepo(context.Background(), testUser(), "owner", snapshot.Name, UpdateRepoRequest{Private: boolPtr(true)})
	require.NoError(t, err)
	assert.Zero(t, policy.calls)
	assert.True(t, tx.committed)
}

type privateQuotaImportRepoDB struct {
	createCalls int
	existing    *db.Repository
}

func (d *privateQuotaImportRepoDB) GetRepoByOwnerAndLowerName(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	if d.existing != nil {
		return *d.existing, nil
	}
	return db.Repository{}, pgx.ErrNoRows
}

func (d *privateQuotaImportRepoDB) CreateRepo(_ context.Context, arg db.CreateRepoParams) (db.Repository, error) {
	d.createCalls++
	return db.Repository{ID: 42, UserID: arg.UserID, Name: arg.Name, LowerName: arg.LowerName}, nil
}

func (*privateQuotaImportRepoDB) DeleteRepo(context.Context, int64) error { return nil }

type privateQuotaImportRepoHost struct{}

func (*privateQuotaImportRepoHost) InitRepo(context.Context, string, string, string, bool) error {
	return nil
}
func (*privateQuotaImportRepoHost) DeleteRepo(context.Context, string, string) error { return nil }
func (*privateQuotaImportRepoHost) ImportRefs(context.Context, string, string) error { return nil }
func (*privateQuotaImportRepoHost) ListBookmarks(context.Context, string, string, string, int) ([]repohost.Bookmark, string, error) {
	return nil, "", nil
}
func (*privateQuotaImportRepoHost) CreateBookmark(context.Context, string, string, repohost.CreateBookmarkRequest) (repohost.Bookmark, error) {
	return repohost.Bookmark{}, nil
}

func TestGitHubImportService_PrivateMirrorUsesCommittedAdmission(t *testing.T) {
	repoDB := &privateQuotaImportRepoDB{}
	policy := newCommittedPrivateBillingPolicy()
	policy.authorizeFn = func(context.Context, string, int64, func(context.Context) error) error {
		return pkgerrors.Forbidden("private repository cap reached")
	}
	svc := NewGitHubImportService(
		nil,
		repoDB,
		nil,
		&privateQuotaImportRepoHost{},
		nil,
		"https://plue.test",
		WithGitHubImportBillingPolicy(policy),
	)

	_, reused, err := svc.ensureLocalRepo(context.Background(), 7, "alice", "octo", "demo", "main")
	require.Error(t, err)
	assert.Equal(t, 403, apiStatus(t, err))
	assert.False(t, reused)
	assert.Zero(t, repoDB.createCalls)
	assert.Equal(t, 1, policy.calls)
	assert.Equal(t, BillingOwnerTypeUser, policy.ownerType)
	assert.Equal(t, int64(7), policy.ownerID)
}

func TestGitHubImportService_ReusedMirrorDoesNotConsumePrivateQuota(t *testing.T) {
	existing := db.Repository{ID: 42, UserID: pgtype.Int8{Int64: 7, Valid: true}, Name: "demo", LowerName: "demo", IsPublic: false}
	repoDB := &privateQuotaImportRepoDB{existing: &existing}
	policy := newCommittedPrivateBillingPolicy()
	policy.authorizeFn = func(context.Context, string, int64, func(context.Context) error) error {
		t.Fatal("reusing an existing private mirror must not consume another quota slot")
		return nil
	}
	svc := NewGitHubImportService(
		nil,
		repoDB,
		nil,
		&privateQuotaImportRepoHost{},
		nil,
		"https://plue.test",
		WithGitHubImportBillingPolicy(policy),
		withGitHubImportProvenance(func(context.Context, int64, string, string, int64) (bool, error) {
			return true, nil
		}),
	)

	repository, reused, err := svc.ensureLocalRepo(context.Background(), 7, "alice", "octo", "demo", "main")
	require.NoError(t, err)
	assert.True(t, reused)
	assert.Equal(t, existing.ID, repository.ID)
	assert.Zero(t, repoDB.createCalls)
	assert.Zero(t, policy.calls)
}

func (h *privateQuotaImportRepoHost) GetBookmark(ctx context.Context, owner, repo, name string) (repohost.Bookmark, error) {
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
