package services

import (
	"context"
	"errors"
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
