package services

import (
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/stretchr/testify/require"
	"testing"
)

// The composed HTTP boundary is tested in compose. This supplements it with
// the production engine using real storage and the existing lane/launch fixture.
func TestParallelAdmissionEngine(t *testing.T) {
	o, session := newTodoAdmission(t)
	capacity := &InstallCapacityService{Queries: db.New(o.pool), Profile: microsandbox.HostProfile{MemoryBytes: 32 << 30, PerfCores: 10, DiskFreeBytes: 400 << 30}}
	o.service.SetInstallParallel(capacity)
	ids := []string{}
	for _, title := range []string{"T1", "T2", "T3", "T4", "T5"} {
		ids = append(ids, uuidString(o.fileTodo(session, title).ID))
	}
	o.service.SetInstallParallel(nil)
	o.wake()
	require.Empty(t, o.lanes.created)
	for _, id := range ids {
		require.Equal(t, "queued", o.byID(id).State)
	}
	o.service.SetInstallParallel(capacity)
	o.wake()
	for _, id := range ids[:2] {
		require.Equal(t, "running", o.byID(id).State)
	}
	for _, id := range ids[2:] {
		require.Equal(t, "queued", o.byID(id).State)
	}
	require.NoError(t, db.New(o.pool).UpsertInstallSetting(t.Context(), db.UpsertInstallSettingParams{Key: "parallel", Value: []byte(`8`)}))
	o.wake()
	require.Equal(t, "running", o.byID(ids[2]).State)
	capacity.Profile.DiskFreeBytes = 104 << 30
	o.wake()
	for _, id := range ids[:3] {
		require.Equal(t, "running", o.byID(id).State)
	}
	for _, id := range ids[3:] {
		require.Equal(t, "queued", o.byID(id).State)
	}
	capacity.Profile.DiskFreeBytes = 60 << 30
	o.wake()
	for _, id := range ids[:3] {
		require.Equal(t, "running", o.byID(id).State)
	}
	require.Empty(t, o.lanes.deleted)
	saved, err := capacity.Parallel(t.Context())
	require.NoError(t, err)
	require.Equal(t, InstallParallel{Requested: 8, Effective: 0}, saved)
}
