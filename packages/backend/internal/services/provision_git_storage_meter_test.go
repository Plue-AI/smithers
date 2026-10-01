package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// A staged repository has no repository row yet. Its allowance must resolve
// the destination owner and count everything that owner already stores.
type provisionGitBytesStore struct {
	*gitBytesStore
	user          db.User
	org           db.Organization
	repository    db.Repository
	userErr       error
	orgErr        error
	repositoryErr error
	recordErr     error
	userNames     []string
	orgNames      []string
	repoLookups   []db.GetRepoByOwnerAndLowerNameParams
}

func (s *provisionGitBytesStore) GetUserByLowerUsername(_ context.Context, name string) (db.User, error) {
	s.userNames = append(s.userNames, name)
	if s.userErr != nil {
		return db.User{}, s.userErr
	}
	if s.user.ID == 0 {
		return db.User{}, pgx.ErrNoRows
	}
	return s.user, nil
}

func (s *provisionGitBytesStore) GetOrgByLowerName(_ context.Context, name string) (db.Organization, error) {
	s.orgNames = append(s.orgNames, name)
	if s.orgErr != nil {
		return db.Organization{}, s.orgErr
	}
	if s.org.ID == 0 {
		return db.Organization{}, pgx.ErrNoRows
	}
	return s.org, nil
}

func (s *provisionGitBytesStore) GetRepoByOwnerAndLowerName(_ context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	s.repoLookups = append(s.repoLookups, arg)
	if s.repositoryErr == nil && s.repository.ID == 0 {
		return db.Repository{}, pgx.ErrNoRows
	}
	return s.repository, s.repositoryErr
}

func (s *provisionGitBytesStore) RecordRepositoryGitBytes(ctx context.Context, arg db.RecordRepositoryGitBytesParams) error {
	if s.recordErr != nil {
		return s.recordErr
	}
	return s.gitBytesStore.RecordRepositoryGitBytes(ctx, arg)
}

func TestBillingService_RemainingOwnerStorageBytes(t *testing.T) {
	for _, ownerType := range []string{BillingOwnerTypeUser, BillingOwnerTypeOrg} {
		for name, tc := range map[string]struct{ used, remaining int64 }{
			"empty":    {used: 0, remaining: freeStorageBytes},
			"partial":  {used: freeStorageBytes - 37, remaining: 37},
			"at limit": {used: freeStorageBytes, remaining: 0},
			"over":     {used: freeStorageBytes + 1, remaining: -1},
		} {
			t.Run(ownerType+"/"+name, func(t *testing.T) {
				queries := newBillingQuerierMock()
				var owners []db.SumStorageBytesByOwnerParams
				queries.sumStorageBytesByOwnerFn = func(_ context.Context, arg db.SumStorageBytesByOwnerParams) (int64, error) {
					owners = append(owners, arg)
					return tc.used, nil
				}
				billing := NewBillingService(staleCounterQuerier{queries}, nil, BillingServiceConfig{})

				remaining, limited, err := billing.RemainingOwnerStorageBytes(context.Background(), ownerType, 87)

				require.NoError(t, err)
				assert.True(t, limited)
				assert.Equal(t, tc.remaining, remaining)
				assert.Equal(t, []db.SumStorageBytesByOwnerParams{{OwnerType: ownerType, OwnerID: 87}}, owners)
			})
		}
	}
}

func TestBillingService_RemainingOwnerStorageBytesRefusesAnInvalidOwner(t *testing.T) {
	for name, owner := range map[string]struct {
		ownerType string
		ownerID   int64
	}{
		"unknown type": {ownerType: "team", ownerID: 87},
		"no ID":        {ownerType: BillingOwnerTypeUser, ownerID: 0},
	} {
		t.Run(name, func(t *testing.T) {
			queries := newBillingQuerierMock()
			queries.sumStorageBytesByOwnerFn = func(context.Context, db.SumStorageBytesByOwnerParams) (int64, error) {
				t.Fatal("an invalid owner must not reach the usage query")
				return 0, nil
			}

			remaining, _, err := NewBillingService(queries, nil, BillingServiceConfig{}).RemainingOwnerStorageBytes(context.Background(), owner.ownerType, owner.ownerID)

			require.ErrorContains(t, err, "invalid storage billing owner")
			assert.Zero(t, remaining)
		})
	}
}

func TestBillingService_RemainingOwnerStorageBytes_FailsClosed(t *testing.T) {
	t.Run("corrupt usage", func(t *testing.T) {
		remaining, _, err := billingAtStorage(-1).RemainingOwnerStorageBytes(context.Background(), BillingOwnerTypeUser, 71)
		require.ErrorContains(t, err, "corrupt")
		assert.Zero(t, remaining)
	})
	t.Run("usage query fails", func(t *testing.T) {
		queries := newBillingQuerierMock()
		queries.sumStorageBytesByOwnerFn = func(context.Context, db.SumStorageBytesByOwnerParams) (int64, error) {
			return 0, errors.New("storage sum unavailable")
		}
		remaining, _, err := NewBillingService(queries, nil, BillingServiceConfig{}).RemainingOwnerStorageBytes(context.Background(), BillingOwnerTypeOrg, 87)
		require.Error(t, err)
		assert.Zero(t, remaining)
	})
	t.Run("plan query fails", func(t *testing.T) {
		queries := newBillingQuerierMock()
		queries.getBillingAccountByOwnerFn = func(context.Context, db.GetBillingAccountByOwnerParams) (db.BillingAccount, error) {
			return db.BillingAccount{}, errors.New("billing account unavailable")
		}
		remaining, _, err := NewBillingService(queries, nil, BillingServiceConfig{}).RemainingOwnerStorageBytes(context.Background(), BillingOwnerTypeUser, 71)
		require.Error(t, err)
		assert.Zero(t, remaining)
	})
}

func TestGitStorageMeter_ProvisionAllowanceResolvesDestinationOwner(t *testing.T) {
	for name, tc := range map[string]struct {
		ownerType string
		ownerID   int64
		user      db.User
		org       db.Organization
	}{
		"user":         {ownerType: BillingOwnerTypeUser, ownerID: 71, user: db.User{ID: 71}},
		"organization": {ownerType: BillingOwnerTypeOrg, ownerID: 87, org: db.Organization{ID: 87}},
	} {
		t.Run(name, func(t *testing.T) {
			store := &provisionGitBytesStore{gitBytesStore: &gitBytesStore{}, user: tc.user, org: tc.org}
			queries := newBillingQuerierMock()
			var owners []db.SumStorageBytesByOwnerParams
			queries.sumStorageBytesByOwnerFn = func(_ context.Context, arg db.SumStorageBytesByOwnerParams) (int64, error) {
				owners = append(owners, arg)
				return freeStorageBytes - 37, nil
			}
			meter := NewGitStorageMeter(NewBillingService(queries, nil, BillingServiceConfig{}), store)

			allowance, limited, err := meter.OwnerGitBytesAllowance(context.Background(), "Alice")

			require.NoError(t, err)
			assert.True(t, limited)
			assert.Equal(t, int64(37), allowance)
			assert.Equal(t, []db.SumStorageBytesByOwnerParams{{OwnerType: tc.ownerType, OwnerID: tc.ownerID}}, owners)
			assert.Equal(t, []string{"alice"}, store.userNames)
			if tc.ownerType == BillingOwnerTypeOrg {
				assert.Equal(t, []string{"alice"}, store.orgNames)
			} else {
				assert.Empty(t, store.orgNames)
			}
			assert.Empty(t, store.readsOfRepo, "a staged destination has no recorded git usage to add back")
			assert.Empty(t, store.repoLookups, "staging precedes destination publication")
		})
	}
}

func TestGitStorageMeter_ProvisionAllowanceClampsOwnersAtOrAboveStorageCap(t *testing.T) {
	for _, used := range []int64{freeStorageBytes, freeStorageBytes + 1} {
		store := &provisionGitBytesStore{gitBytesStore: &gitBytesStore{}, user: db.User{ID: 71}}
		allowance, limited, err := NewGitStorageMeter(billingAtStorage(used), store).OwnerGitBytesAllowance(context.Background(), "alice")
		require.NoError(t, err)
		assert.True(t, limited)
		assert.Zero(t, allowance)
	}
}

func TestGitStorageMeter_ProvisionUnlimitedStorageNeedsNoOwnerLookup(t *testing.T) {
	remaining, limited, err := NewUnlimitedBillingPolicy().RemainingOwnerStorageBytes(context.Background(), BillingOwnerTypeOrg, 87)
	require.NoError(t, err)
	assert.False(t, limited)
	assert.Zero(t, remaining)

	// The ordinary push store has no owner lookup methods. Unlimited
	// self-hosting must not introduce a database dependency for staging.
	allowance, limited, err := NewGitStorageMeter(NewUnlimitedBillingPolicy(), &gitBytesStore{}).OwnerGitBytesAllowance(context.Background(), "alice")
	require.NoError(t, err)
	assert.False(t, limited)
	assert.Zero(t, allowance)
}

func TestGitStorageMeter_ProvisionAllowanceLookupFailuresStopStaging(t *testing.T) {
	for name, store := range map[string]*provisionGitBytesStore{
		"user query fails": {gitBytesStore: &gitBytesStore{}, userErr: errors.New("user store unavailable")},
		"org query fails":  {gitBytesStore: &gitBytesStore{}, orgErr: errors.New("organization store unavailable")},
		"owner missing":    {gitBytesStore: &gitBytesStore{}},
	} {
		t.Run(name, func(t *testing.T) {
			allowance, _, err := NewGitStorageMeter(billingAtStorage(0), store).OwnerGitBytesAllowance(context.Background(), "alice")
			require.Error(t, err)
			assert.Zero(t, allowance)
			if store.userErr != nil {
				assert.Empty(t, store.orgNames, "a database error cannot be treated as an absent user")
			}
		})
	}
	t.Run("finite policy requires owner lookup", func(t *testing.T) {
		allowance, _, err := NewGitStorageMeter(billingAtStorage(0), &gitBytesStore{}).OwnerGitBytesAllowance(context.Background(), "alice")
		require.Error(t, err)
		assert.Zero(t, allowance)
	})
}

func TestGitStorageMeter_ProvisionAllowanceBudgetFailuresStopStaging(t *testing.T) {
	for name, fail := range map[string]func(*billingQuerierMock){
		"plan lookup": func(q *billingQuerierMock) {
			q.getBillingAccountByOwnerFn = func(context.Context, db.GetBillingAccountByOwnerParams) (db.BillingAccount, error) {
				return db.BillingAccount{}, errors.New("plan unavailable")
			}
		},
		"usage lookup": func(q *billingQuerierMock) {
			q.sumStorageBytesByOwnerFn = func(context.Context, db.SumStorageBytesByOwnerParams) (int64, error) {
				return 0, errors.New("usage unavailable")
			}
		},
		"corrupt usage": func(q *billingQuerierMock) {
			q.sumStorageBytesByOwnerFn = func(context.Context, db.SumStorageBytesByOwnerParams) (int64, error) {
				return -1, nil
			}
		},
	} {
		t.Run(name, func(t *testing.T) {
			store := &provisionGitBytesStore{gitBytesStore: &gitBytesStore{}, user: db.User{ID: 71}}
			queries := newBillingQuerierMock()
			fail(queries)

			allowance, _, err := NewGitStorageMeter(NewBillingService(queries, nil, BillingServiceConfig{}), store).OwnerGitBytesAllowance(context.Background(), "alice")

			require.Error(t, err)
			assert.Zero(t, allowance)
			assert.Empty(t, store.recorded)
			assert.Empty(t, store.repoLookups)
		})
	}
	t.Run("cancellation reaches usage query", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		store := &provisionGitBytesStore{gitBytesStore: &gitBytesStore{}, user: db.User{ID: 71}}
		queries := newBillingQuerierMock()
		var queried error
		queries.sumStorageBytesByOwnerFn = func(ctx context.Context, _ db.SumStorageBytesByOwnerParams) (int64, error) {
			queried = ctx.Err()
			return 0, queried
		}

		allowance, _, err := NewGitStorageMeter(NewBillingService(queries, nil, BillingServiceConfig{}), store).OwnerGitBytesAllowance(ctx, "alice")

		require.Error(t, err)
		assert.ErrorIs(t, queried, context.Canceled)
		assert.Zero(t, allowance)
	})
}

func TestGitStorageMeter_RecordProvisionedGitBytesUsesPublishedDestinationID(t *testing.T) {
	store := &provisionGitBytesStore{gitBytesStore: &gitBytesStore{}, repository: db.Repository{ID: 912}}
	measuredAt := time.Unix(1700000000, 123).UTC()
	meter := NewGitStorageMeter(billingAtStorage(0), store)

	require.NoError(t, meter.RecordProvisionedGitBytes(context.Background(), "Alice", "Demo", 2048, measuredAt))

	require.Len(t, store.repoLookups, 1)
	assert.Equal(t, db.GetRepoByOwnerAndLowerNameParams{Owner: "alice", LowerName: "demo"}, store.repoLookups[0])
	assert.Equal(t, []db.RecordRepositoryGitBytesParams{{RepositoryID: 912, GitBytes: 2048, MeasuredAt: measuredAt}}, store.recorded)
	assert.Empty(t, store.userNames, "the published destination row supplies the stable repository ID")
	assert.Empty(t, store.orgNames)
}

func TestGitStorageMeter_RecordProvisionedGitBytesPropagatesFailures(t *testing.T) {
	t.Run("published destination missing", func(t *testing.T) {
		store := &provisionGitBytesStore{gitBytesStore: &gitBytesStore{}}
		err := NewGitStorageMeter(billingAtStorage(0), store).RecordProvisionedGitBytes(context.Background(), "alice", "demo", 2048, time.Now())
		require.ErrorIs(t, err, pgx.ErrNoRows)
		assert.Empty(t, store.recorded)
	})
	t.Run("destination query fails", func(t *testing.T) {
		store := &provisionGitBytesStore{gitBytesStore: &gitBytesStore{}, repositoryErr: errors.New("repository store unavailable")}
		err := NewGitStorageMeter(billingAtStorage(0), store).RecordProvisionedGitBytes(context.Background(), "alice", "demo", 2048, time.Now())
		require.ErrorContains(t, err, "repository store unavailable")
		assert.Empty(t, store.recorded)
	})
	t.Run("measurement write fails", func(t *testing.T) {
		store := &provisionGitBytesStore{gitBytesStore: &gitBytesStore{}, repository: db.Repository{ID: 912}, recordErr: errors.New("measurement store unavailable")}
		err := NewGitStorageMeter(billingAtStorage(0), store).RecordProvisionedGitBytes(context.Background(), "alice", "demo", 2048, time.Now())
		require.ErrorContains(t, err, "measurement store unavailable")
		assert.Empty(t, store.recorded)
	})
}
