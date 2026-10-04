package services

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"strconv"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/stretchr/testify/require"
)

// Unit failure injection covers inaccessible/corrupt persistence and a lost
// owner fence. The owner/persistence success cases use real PostgreSQL separately.
type capacityQueries struct {
	row               db.GetInstallCapacityRow
	readErr, writeErr error
	rows              int64
}

func (q *capacityQueries) GetInstallCapacity(context.Context) (db.GetInstallCapacityRow, error) {
	return q.row, q.readErr
}
func (q *capacityQueries) SetInstallCapacity(context.Context, db.SetInstallCapacityParams) (int64, error) {
	return q.rows, q.writeErr
}

func TestInstallCapacityReadAndWriteFailuresRefuse(t *testing.T) {
	ctx := t.Context()
	q := &capacityQueries{row: db.GetInstallCapacityRow{OwnerID: 1}, rows: 1}
	s := InstallCapacityService{Queries: q, Profile: microsandbox.HostProfile{MemoryBytes: 32 << 30, PerfCores: 10, DiskFreeBytes: 400 << 30}, InUse: func() int { return 2 }}
	status, err := s.Read(ctx)
	require.NoError(t, err)
	require.Equal(t, MachineCapacity{InUse: 2, Capacity: 3}, status.Machines)
	q.readErr = errors.New("read unavailable")
	_, err = s.Read(ctx)
	require.ErrorIs(t, err, q.readErr)
	require.ErrorIs(t, s.Set(ctx, 1, 1), q.readErr)
	require.ErrorIs(t, s.ValidateStart(ctx), q.readErr)
	q.readErr = nil
	q.row.Capacity = []byte(`"bad"`)
	_, err = s.Read(ctx)
	require.ErrorContains(t, err, "read saved capacity")
	q.row.Capacity = []byte(`0`)
	_, err = s.Read(ctx)
	require.Error(t, err)
	q.row.Capacity = nil
	require.Error(t, s.Set(ctx, 0, 1))
	q.writeErr = errors.New("write unavailable")
	require.ErrorIs(t, s.Set(ctx, 1, 1), q.writeErr)
	q.writeErr = nil
	q.rows = 0
	require.Error(t, s.Set(ctx, 1, 1))
	q.rows = 1
	require.NoError(t, s.Set(ctx, 1, 1))
}

// These doubles inject storage failures and owner-race refusals only; success
// and restart persistence are also tested against PostgreSQL.
type parallelQueries struct {
	capacityQueries
	saved           []byte
	parallelReadErr error
	last            db.SetInstallParallelParams
	writes          int
}

func (q *parallelQueries) GetInstallParallel(context.Context) (json.RawMessage, error) {
	return q.saved, q.parallelReadErr
}
func (q *parallelQueries) SetInstallParallel(_ context.Context, input db.SetInstallParallelParams) (int64, error) {
	q.last = input
	q.writes++
	if q.writeErr == nil && q.rows == 1 {
		q.saved = input.Value
	}
	return q.rows, q.writeErr
}
func parallelOwnerContext(ctx context.Context, id int64) context.Context {
	return middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &db.User{ID: id}, SessionHash: "person-session"})
}
func TestInstallParallelDefaultsClampAndSavedValues(t *testing.T) {
	q := &parallelQueries{capacityQueries: capacityQueries{row: db.GetInstallCapacityRow{OwnerID: 1}, rows: 1}}
	s := InstallCapacityService{Queries: q, Profile: microsandbox.HostProfile{MemoryBytes: 128 << 30, PerfCores: 32, DiskFreeBytes: 1024 << 30}}
	for _, tc := range []struct{ capacity, requested, effective int }{{0, 1, 0}, {1, 1, 1}, {2, 1, 1}, {3, 2, 2}, {6, 5, 5}, {7, 6, 6}} {
		// Inject the disk term only, leaving startup memory/core measurements fixed.
		s.Profile.DiskFreeBytes = int64(40+32*tc.capacity) << 30
		result, err := s.Parallel(t.Context())
		require.NoError(t, err)
		require.Equal(t, InstallParallel{tc.requested, tc.effective}, result)
	}
	q.saved = []byte(`8`)
	for _, tc := range []struct{ capacity, effective int }{{0, 0}, {2, 2}, {3, 3}} {
		s.Profile.DiskFreeBytes = int64(40+32*tc.capacity) << 30
		result, err := s.Parallel(t.Context())
		require.NoError(t, err)
		require.Equal(t, InstallParallel{8, tc.effective}, result)
		require.Equal(t, []byte(`8`), q.saved)
	}
	for _, raw := range []string{`0`, `9`, `1.5`, `null`, `"2"`, `{`} {
		q.saved = []byte(raw)
		_, err := s.Parallel(t.Context())
		require.Error(t, err, raw)
	}
	q.saved = nil
	q.parallelReadErr = errors.New("parallel read failure")
	_, err := s.Parallel(t.Context())
	require.ErrorIs(t, err, q.parallelReadErr)
	q.parallelReadErr = nil
	q.readErr = errors.New("capacity read failure")
	_, err = s.Parallel(t.Context())
	require.ErrorIs(t, err, q.readErr)
	_, err = (&InstallCapacityService{Queries: &capacityQueries{}}).Parallel(t.Context())
	require.Error(t, err)
	_, err = (*InstallCapacityService)(nil).Parallel(t.Context())
	require.Error(t, err)
}
func TestInstallParallelOwnerAndPolicyRefuseBeforeEffects(t *testing.T) {
	q := &parallelQueries{capacityQueries: capacityQueries{row: db.GetInstallCapacityRow{OwnerID: 1}, rows: 1}}
	s := InstallCapacityService{Queries: q}
	owner := parallelOwnerContext(t.Context(), 1)
	for _, info := range []*middleware.AuthInfo{nil, {}, {User: &db.User{ID: 1}},
		{User: &db.User{ID: 1}, SessionHash: "s", IsTokenAuth: true},
		{User: &db.User{ID: 1}, SessionHash: "s", IsTokenAuth: true, TokenSystemIssued: true}} {
		ctx := t.Context()
		if info != nil {
			ctx = middleware.ContextWithAuthInfo(ctx, info)
		}
		require.Error(t, s.SetParallel(ctx, 2))
	}
	require.Error(t, s.SetParallel(owner, 2)) // Missing shared authority/catalog.
	require.Zero(t, q.writes)
	denied := pkgerrors.Forbidden("policy refusal")
	s.AuthorizeParallel = func(context.Context) error { return denied }
	require.ErrorIs(t, s.SetParallel(owner, 2), denied)
	s.AuthorizeParallel = func(context.Context) error { return nil }
	for _, actor := range []int64{0, 2, 3} {
		require.Error(t, s.SetParallel(parallelOwnerContext(t.Context(), actor), 2))
	}
	for _, value := range []int{0, -1, 9} {
		require.Error(t, s.SetParallel(owner, value))
	}
	require.Zero(t, q.writes)
	q.readErr = errors.New("read failure")
	require.ErrorIs(t, s.SetParallel(owner, 2), q.readErr)
	q.readErr = nil
	q.writeErr = errors.New("write failure")
	require.ErrorIs(t, s.SetParallel(owner, 2), q.writeErr)
	q.writeErr = nil
	q.rows = 0
	require.Error(t, s.SetParallel(owner, 2))
	q.rows = 1
	for _, value := range []int{1, 8} {
		require.NoError(t, s.SetParallel(owner, value))
		require.Equal(t, int64(1), q.last.ActorID)
		require.JSONEq(t, strconv.Itoa(value), string(q.saved))
	}
	s.Queries = &capacityQueries{row: db.GetInstallCapacityRow{OwnerID: 1}}
	require.Error(t, s.SetParallel(owner, 2))
	require.Error(t, (*InstallCapacityService)(nil).SetParallel(owner, 2))
}
