package services

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

const freeStorageBytes = int64(100 * 1024 * 1024 * 1024)

func billingAtStorage(used int64) *BillingService {
	queries := newBillingQuerierMock()
	queries.sumStorageBytesByOwnerFn = func(context.Context, db.SumStorageBytesByOwnerParams) (int64, error) { return used, nil }
	return NewBillingService(queries, nil, BillingServiceConfig{})
}

// smithersai/plue#593: a push may add what is left of the owner's storage;
// an owner over the limit has a negative remainder.
func TestBillingService_RemainingStorageBytes(t *testing.T) {
	for name, tc := range map[string]struct {
		used, remaining int64
	}{
		"empty":    {used: 0, remaining: freeStorageBytes},
		"partial":  {used: freeStorageBytes - 4096, remaining: 4096},
		"at limit": {used: freeStorageBytes, remaining: 0},
		"over":     {used: freeStorageBytes + 1, remaining: -1},
	} {
		t.Run(name, func(t *testing.T) {
			remaining, limited, err := billingAtStorage(tc.used).RemainingStorageBytes(context.Background(), 11)
			require.NoError(t, err)
			assert.True(t, limited)
			assert.Equal(t, tc.remaining, remaining)
		})
	}
}

// staleCounterQuerier's persisted usage counters say the owner stores
// nothing, as an older concurrent sum could have left them.
type staleCounterQuerier struct{ *billingQuerierMock }

func (staleCounterQuerier) ListBillingUsageCountersByOwnerAndPeriod(context.Context, db.ListBillingUsageCountersByOwnerAndPeriodParams) ([]db.BillingUsageCounter, error) {
	return []db.BillingUsageCounter{{MetricKey: BillingMetricStorageBytes, ConsumedQuantity: 0}}, nil
}

// The remainder comes from the owner's storage sum itself, never from the
// persisted counters a concurrent older sum can overwrite.
func TestBillingService_RemainingStorageBytes_IgnoresPersistedCounters(t *testing.T) {
	queries := newBillingQuerierMock()
	queries.sumStorageBytesByOwnerFn = func(context.Context, db.SumStorageBytesByOwnerParams) (int64, error) { return 90, nil }
	remaining, limited, err := NewBillingService(staleCounterQuerier{queries}, nil, BillingServiceConfig{}).RemainingStorageBytes(context.Background(), 11)
	require.NoError(t, err)
	assert.True(t, limited)
	assert.Equal(t, freeStorageBytes-90, remaining)
}

func TestBillingService_RemainingStorageBytes_CorruptUsageFails(t *testing.T) {
	_, _, err := billingAtStorage(-1).RemainingStorageBytes(context.Background(), 11)
	require.ErrorContains(t, err, "corrupt")
}

func TestBillingService_RemainingStorageBytes_PropagatesUsageFailure(t *testing.T) {
	queries := newBillingQuerierMock()
	queries.sumStorageBytesByOwnerFn = func(context.Context, db.SumStorageBytesByOwnerParams) (int64, error) {
		return 0, errors.New("usage store down")
	}
	_, _, err := NewBillingService(queries, nil, BillingServiceConfig{}).RemainingStorageBytes(context.Background(), 11)
	require.Error(t, err)
}

func TestUnlimitedBillingPolicy_HasNoStorageLimit(t *testing.T) {
	remaining, limited, err := NewUnlimitedBillingPolicy().RemainingStorageBytes(context.Background(), 11)
	require.NoError(t, err)
	assert.False(t, limited)
	assert.Zero(t, remaining)
}

// gitBytesStore answers each read with the next of reads (the last one
// repeats) and keeps what is recorded.
type gitBytesStore struct {
	reads       []db.GetRepositoryGitUsageRow
	readErr     error
	recorded    []db.RecordRepositoryGitBytesParams
	readsOfRepo []int64
}

func usageAt(gitBytes int64, second int64) db.GetRepositoryGitUsageRow {
	return db.GetRepositoryGitUsageRow{GitBytes: gitBytes, MeasuredAt: time.Unix(second, 0)}
}

func (s *gitBytesStore) GetRepositoryGitUsage(_ context.Context, repositoryID int64) (db.GetRepositoryGitUsageRow, error) {
	s.readsOfRepo = append(s.readsOfRepo, repositoryID)
	if s.readErr != nil {
		return db.GetRepositoryGitUsageRow{}, s.readErr
	}
	read := s.reads[0]
	if len(s.reads) > 1 {
		s.reads = s.reads[1:]
	}
	return read, nil
}

func (s *gitBytesStore) RecordRepositoryGitBytes(_ context.Context, arg db.RecordRepositoryGitBytesParams) error {
	s.recorded = append(s.recorded, arg)
	return nil
}

// The allowance adds the repository's recorded bytes back to what the owner
// has left, so repo-host can measure the repository afresh under the push's
// lock.
func TestGitStorageMeter_AllowanceAndRecords(t *testing.T) {
	store := &gitBytesStore{reads: []db.GetRepositoryGitUsageRow{usageAt(4096, 1)}}
	meter := NewGitStorageMeter(billingAtStorage(freeStorageBytes-10), store)
	var _ repohost.PushMeter = meter

	allowance, limited, err := meter.GitBytesAllowance(context.Background(), 11)
	require.NoError(t, err)
	assert.True(t, limited)
	assert.Equal(t, int64(4096+10), allowance)
	assert.Equal(t, []int64{11, 11}, store.readsOfRepo)

	measuredAt := time.Unix(1700000000, 0)
	require.NoError(t, meter.RecordGitBytes(context.Background(), 11, 2048, measuredAt))
	assert.Equal(t, []db.RecordRepositoryGitBytesParams{{RepositoryID: 11, GitBytes: 2048, MeasuredAt: measuredAt}}, store.recorded)
}

// A measurement recorded while the owner's usage is read would pair the
// usage with the wrong repository bytes, so the meter reads again.
func TestGitStorageMeter_RereadsWhenAMeasurementLandsMidRead(t *testing.T) {
	store := &gitBytesStore{reads: []db.GetRepositoryGitUsageRow{usageAt(40, 1), usageAt(80, 2), usageAt(80, 2)}}
	allowance, _, err := NewGitStorageMeter(billingAtStorage(freeStorageBytes-20), store).GitBytesAllowance(context.Background(), 11)
	require.NoError(t, err)
	assert.Equal(t, int64(80+20), allowance)
	assert.Len(t, store.readsOfRepo, 4)

	sameBytes := &gitBytesStore{reads: []db.GetRepositoryGitUsageRow{usageAt(40, 1), usageAt(40, 2), usageAt(40, 2)}}
	_, _, err = NewGitStorageMeter(billingAtStorage(0), sameBytes).GitBytesAllowance(context.Background(), 11)
	require.NoError(t, err)
	assert.Len(t, sameBytes.readsOfRepo, 4, "a newer measurement of the same size is still another read")
}

// An owner over the limit gets no allowance beyond what its other
// repositories leave, even when this repository shrank since its record.
func TestGitStorageMeter_OwnerOverTheLimitClampsTheAllowance(t *testing.T) {
	for name, tc := range map[string]struct{ used, recorded, allowance int64 }{
		"over by less than the repository": {used: freeStorageBytes + 10, recorded: 50, allowance: 40},
		"over by more than the repository": {used: freeStorageBytes + 90, recorded: 50, allowance: 0},
	} {
		t.Run(name, func(t *testing.T) {
			store := &gitBytesStore{reads: []db.GetRepositoryGitUsageRow{usageAt(tc.recorded, 1)}}
			allowance, limited, err := NewGitStorageMeter(billingAtStorage(tc.used), store).GitBytesAllowance(context.Background(), 11)
			require.NoError(t, err)
			assert.True(t, limited)
			assert.Equal(t, tc.allowance, allowance)
		})
	}
}

func TestGitStorageMeter_RefusesAMeasurementThatNeverSettles(t *testing.T) {
	var reads []db.GetRepositoryGitUsageRow
	for i := range 2 * gitUsageReadAttempts {
		reads = append(reads, usageAt(int64(i), int64(i)))
	}
	_, _, err := NewGitStorageMeter(billingAtStorage(0), &gitBytesStore{reads: reads}).GitBytesAllowance(context.Background(), 11)
	require.ErrorContains(t, err, "changed on each of 3 reads")
}

func TestGitStorageMeter_UnlimitedOwnerHasNoAllowance(t *testing.T) {
	store := &gitBytesStore{reads: []db.GetRepositoryGitUsageRow{usageAt(4096, 1)}}
	allowance, limited, err := NewGitStorageMeter(NewUnlimitedBillingPolicy(), store).GitBytesAllowance(context.Background(), 11)
	require.NoError(t, err)
	assert.False(t, limited)
	assert.Zero(t, allowance)
}

func TestGitStorageMeter_GitBytesReadFailureStopsThePush(t *testing.T) {
	store := &gitBytesStore{readErr: errors.New("store down")}
	_, _, err := NewGitStorageMeter(billingAtStorage(0), store).GitBytesAllowance(context.Background(), 11)
	require.ErrorContains(t, err, "store down")
}

// Repo-host's storage refusal reaches the git client as the typed plan
// limit.
func TestGitProxyFailure_StorageLimitIsPlanLimitExceeded(t *testing.T) {
	err := gitProxyFailure(context.Background(), "receive-pack", "alice", "demo", &repohost.StatusError{
		StatusCode: http.StatusRequestEntityTooLarge, Code: repohost.StorageLimitCode,
		Message: "this push would exceed the storage limit for the current plan",
	})
	apiErr := apiError(t, err)
	assert.Equal(t, pkgerrors.CodePlanLimitExceeded, apiErr.Code)
	assert.Equal(t, BillingMetricStorageBytes, apiErr.LimitKind)
	assert.Equal(t, "this push would exceed the storage limit for the current plan", apiErr.Message)
}
