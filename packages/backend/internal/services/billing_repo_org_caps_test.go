package services

import (
	"context"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// billingAtRepoCounts is a free-plan billing service whose owner holds the
// given total and private repository counts and owned organizations.
func billingAtRepoCounts(total, private, orgs int64) (*BillingService, *billingQuerierMock) {
	queries := newBillingQuerierMock()
	queries.countReposByOwnerFn = func(context.Context, db.CountReposByOwnerParams) (int64, error) { return total, nil }
	queries.countPrivateReposByOwnerFn = func(context.Context, db.CountPrivateReposByOwnerParams) (int64, error) { return private, nil }
	queries.countOrgsOwnedByUserFn = func(context.Context, int64) (int64, error) { return orgs, nil }
	return NewBillingService(queries, nil, BillingServiceConfig{}), queries
}

func requirePlanLimit(t *testing.T, err error, kind string, limit int) {
	t.Helper()
	apiErr := apiError(t, err)
	assert.Equal(t, pkgerrors.CodePlanLimitExceeded, apiErr.Code)
	assert.Equal(t, http.StatusPaymentRequired, apiErr.Status)
	assert.Equal(t, BillingPlanFree, apiErr.PlanKey)
	assert.Equal(t, kind, apiErr.LimitKind)
	require.NotNil(t, apiErr.Limit)
	assert.Equal(t, limit, *apiErr.Limit)
	require.NotNil(t, apiErr.Remaining)
	assert.Zero(t, *apiErr.Remaining)
}

func TestBillingService_AuthorizeRepoCreate_CapsEveryRepository(t *testing.T) {
	for _, tc := range []struct {
		name           string
		total, private int64
		privateRepo    bool
		wantKind       string
	}{
		{name: "public below total cap", total: 199},
		{name: "private below both caps", total: 199, private: 99, privateRepo: true},
		{name: "public at total cap", total: 200, wantKind: BillingMetricRepos},
		{name: "public past total cap", total: 350, wantKind: BillingMetricRepos},
		{name: "private at total cap", total: 200, private: 10, privateRepo: true, wantKind: BillingMetricRepos},
		{name: "private at private cap", total: 150, private: 100, privateRepo: true, wantKind: BillingMetricPrivateRepos},
		{name: "public ignores private cap", total: 150, private: 100},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, _ := billingAtRepoCounts(tc.total, tc.private, 0)
			committed := 0
			err := svc.AuthorizeRepoCreateCommitted(context.Background(), BillingOwnerTypeUser, 99, tc.privateRepo, func(context.Context) error {
				committed++
				return nil
			})
			switch tc.wantKind {
			case "":
				require.NoError(t, err)
				assert.Equal(t, 1, committed)
			case BillingMetricRepos:
				requirePlanLimit(t, err, BillingMetricRepos, 200)
				assert.Zero(t, committed)
			default:
				require.Error(t, err)
				assert.Contains(t, err.Error(), "private repositories quota exceeded")
				assert.Zero(t, committed)
			}
		})
	}
}

func TestBillingService_AuthorizeRepoCreate_RejectsInvalidInput(t *testing.T) {
	svc, _ := billingAtRepoCounts(0, 0, 0)
	commit := func(context.Context) error { return nil }
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, svc.AuthorizeRepoCreateCommitted(context.Background(), BillingOwnerTypeUser, 1, false, nil)))
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, svc.AuthorizeRepoCreateCommitted(context.Background(), "team", 1, false, commit)))
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, svc.AuthorizeRepoCreateCommitted(context.Background(), BillingOwnerTypeOrg, 0, false, commit)))
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, svc.AuthorizeOrgCreateCommitted(context.Background(), 1, nil)))
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, svc.AuthorizeOrgCreateCommitted(context.Background(), 0, commit)))
}

func TestBillingService_AuthorizeOrgCreate_CapsOwnedOrganizations(t *testing.T) {
	for _, tc := range []struct {
		owned int64
		allow bool
	}{{owned: 0, allow: true}, {owned: 2, allow: true}, {owned: 3}, {owned: 9}} {
		svc, _ := billingAtRepoCounts(0, 0, tc.owned)
		committed := 0
		err := svc.AuthorizeOrgCreateCommitted(context.Background(), 42, func(context.Context) error {
			committed++
			return nil
		})
		if tc.allow {
			require.NoError(t, err, "owned=%d", tc.owned)
			assert.Equal(t, 1, committed)
			continue
		}
		requirePlanLimit(t, err, BillingMetricOrgs, 3)
		assert.Zero(t, committed)
	}
}

func TestBillingService_Overview_ReportsRepositoryAndOrganizationUsage(t *testing.T) {
	svc, _ := billingAtRepoCounts(12, 4, 2)
	overview, err := svc.GetUserOverview(context.Background(), &db.User{ID: 42, Username: "alice"})
	require.NoError(t, err)
	usage := map[string]BillingUsageSummary{}
	for _, metric := range overview.Usage {
		usage[metric.MetricKey] = metric
	}
	assert.Equal(t, BillingUsageSummary{MetricKey: BillingMetricRepos, IncludedQuantity: 200, ConsumedQuantity: 12}, usage[BillingMetricRepos])
	assert.Equal(t, BillingUsageSummary{MetricKey: BillingMetricOrgs, IncludedQuantity: 3, ConsumedQuantity: 2}, usage[BillingMetricOrgs])
}

func TestBillingService_RepositoryTransfer_ChecksTargetRepositoryCap(t *testing.T) {
	svc, _ := billingAtRepoCounts(200, 0, 0)
	committed := false
	err := svc.AuthorizeRepositoryTransferCommitted(context.Background(), 5, BillingOwnerTypeUser, 99, false, func(context.Context) error {
		committed = true
		return nil
	})
	requirePlanLimit(t, err, BillingMetricRepos, 200)
	assert.False(t, committed)
}

func TestRepoService_CreateRepo_PublicRepositoryAtTotalCap(t *testing.T) {
	billing, _ := billingAtRepoCounts(200, 0, 0)
	q := &mockRepoQuerier{createRepoFn: func(context.Context, db.CreateRepoParams) (db.Repository, error) {
		t.Fatal("repository cap denial must precede repository creation")
		return db.Repository{}, nil
	}}
	rh := &mockRepoHostClient{initRepoFn: func(context.Context, string, string, string, bool) error {
		t.Fatal("repository cap denial must precede repo-host initialization")
		return nil
	}}
	_, err := NewRepoService(q, rh, "s1", WithRepoBillingPolicy(billing)).
		CreateRepo(context.Background(), testUser(), "public", "", true, "main", false)
	requirePlanLimit(t, err, BillingMetricRepos, 200)
}

func TestRepoService_CreateRepo_PublicRepositoryBelowTotalCap(t *testing.T) {
	billing, _ := billingAtRepoCounts(199, 0, 0)
	created := false
	q := &mockRepoQuerier{createRepoFn: func(_ context.Context, arg db.CreateRepoParams) (db.Repository, error) {
		created = true
		return db.Repository{ID: 8, UserID: arg.UserID, Name: arg.Name, LowerName: arg.LowerName, IsPublic: arg.IsPublic}, nil
	}}
	_, err := NewRepoService(q, &mockRepoHostClient{}, "s1", WithRepoBillingPolicy(billing)).
		CreateRepo(context.Background(), testUser(), "public", "", true, "main", false)
	require.NoError(t, err)
	assert.True(t, created)
}

func TestRepoService_ForkAndOrgRepo_UseRepositoryCap(t *testing.T) {
	t.Run("organization repository", func(t *testing.T) {
		billing, queries := billingAtRepoCounts(200, 0, 0)
		var counted db.CountReposByOwnerParams
		queries.countReposByOwnerFn = func(_ context.Context, arg db.CountReposByOwnerParams) (int64, error) {
			counted = arg
			return 200, nil
		}
		q := &mockRepoQuerier{
			getOrgByLowerNameFn: func(context.Context, string) (db.Organization, error) {
				return db.Organization{ID: 77, Name: "acme", LowerName: "acme"}, nil
			},
			getOrgMemberFn: func(context.Context, db.GetOrgMemberParams) (db.OrgMember, error) {
				return db.OrgMember{OrganizationID: 77, UserID: 1, Role: "owner"}, nil
			},
		}
		_, err := NewRepoService(q, &mockRepoHostClient{}, "s1", WithRepoBillingPolicy(billing)).
			CreateOrgRepo(context.Background(), testUser(), "acme", "public", "", true, "main", false)
		requirePlanLimit(t, err, BillingMetricRepos, 200)
		assert.Equal(t, db.CountReposByOwnerParams{OwnerType: BillingOwnerTypeOrg, OwnerID: 77}, counted)
	})

	t.Run("public fork", func(t *testing.T) {
		billing, _ := billingAtRepoCounts(200, 0, 0)
		source := testRepo(func(repository *db.Repository) {
			repository.UserID = pgtype.Int8{Int64: 99, Valid: true}
			repository.IsPublic = true
		})
		q := &mockRepoQuerier{
			getRepoByOwnerAndLowerNameFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				return source, nil
			},
		}
		_, err := NewRepoService(q, &mockRepoHostClient{}, "s1", WithRepoBillingPolicy(billing)).
			ForkRepo(context.Background(), testUser(), "someone", "src", "copy", "")
		requirePlanLimit(t, err, BillingMetricRepos, 200)
	})
}

func TestOrgService_CreateOrg_OwnedOrganizationCap(t *testing.T) {
	for _, tc := range []struct {
		owned int64
		allow bool
	}{{owned: 2, allow: true}, {owned: 3}} {
		billing, queries := billingAtRepoCounts(0, 0, tc.owned)
		var countedUser int64
		queries.countOrgsOwnedByUserFn = func(_ context.Context, userID int64) (int64, error) {
			countedUser = userID
			return tc.owned, nil
		}
		created := false
		svc := NewOrgService(&mockOrgQuerier{
			createOrganizationFn: func(_ context.Context, arg db.CreateOrganizationParams) (db.Organization, error) {
				created = true
				return db.Organization{ID: 71, Name: arg.Name, LowerName: arg.LowerName, Visibility: arg.Visibility}, nil
			},
			addOrgMemberFn: func(context.Context, db.AddOrgMemberParams) (db.OrgMember, error) { return db.OrgMember{}, nil },
		}, WithOrgBillingPolicy(billing))
		_, err := svc.CreateOrg(context.Background(), &db.User{ID: 42, Username: "alice"}, CreateOrgRequest{Name: "acme"})
		assert.Equal(t, int64(42), countedUser)
		if tc.allow {
			require.NoError(t, err)
			assert.True(t, created)
			continue
		}
		requirePlanLimit(t, err, BillingMetricOrgs, 3)
		assert.False(t, created)
	}
}

func TestUnlimitedBillingPolicy_AdmitsRepositoryAndOrganizationCreation(t *testing.T) {
	policy := NewUnlimitedBillingPolicy()
	calls := 0
	commit := func(context.Context) error {
		calls++
		return nil
	}
	require.NoError(t, authorizeRepoCreateThenCommit(context.Background(), policy, BillingOwnerTypeUser, 1, true, commit))
	require.NoError(t, authorizeOrgCreateThenCommit(context.Background(), policy, 1, commit))
	assert.Equal(t, 2, calls)
}
