package services

import (
	"context"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/stretchr/testify/require"
	"testing"
	"time"
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
	freeDisk := int64(104 << 30)
	capacity.FreeDisk = func(context.Context) (int64, error) { return freeDisk, nil }
	o.wake()
	for _, id := range ids[:3] {
		require.Equal(t, "running", o.byID(id).State)
	}
	for _, id := range ids[3:] {
		require.Equal(t, "queued", o.byID(id).State)
	}
	freeDisk = 60 << 30
	o.wake()
	for _, id := range ids[:3] {
		require.Equal(t, "running", o.byID(id).State)
	}
	require.Empty(t, o.lanes.deleted)
	saved, err := capacity.Parallel(t.Context())
	require.NoError(t, err)
	require.Equal(t, InstallParallel{Requested: 8, Effective: 0}, saved)
}

// Only machine ownership is injected: stack storage and engine remain real.
type parallelObservedLanes struct {
	*fakeMythicalLanes
	held map[string]bool
}

func (l *parallelObservedLanes) MachineHeld(_ context.Context, id string) (bool, error) {
	return l.held[id], nil
}

func TestParallelRetainedMachineRelease(t *testing.T) {
	o, session := newTodoAdmission(t)
	capacity := &InstallCapacityService{Queries: db.New(o.pool), Profile: microsandbox.HostProfile{MemoryBytes: 32 << 30, PerfCores: 10, DiskFreeBytes: 400 << 30}}
	o.service.SetInstallParallel(capacity)
	require.NoError(t, db.New(o.pool).UpsertInstallSetting(t.Context(), db.UpsertInstallSettingParams{Key: "parallel", Value: []byte(`1`)}))
	lanes := &parallelObservedLanes{fakeMythicalLanes: o.lanes, held: map[string]bool{}}
	o.service.lanes = lanes
	lanes.provision = func(id string) { lanes.held[id] = true }
	first := o.fileTodo(session, "T1")
	second := o.fileTodo(session, "T2")
	o.wake()
	first = o.byID(uuidString(first.ID))
	require.Equal(t, "running", first.State)
	require.Equal(t, "queued", o.byID(uuidString(second.ID)).State)
	// Publishing for review does not itself establish safe-idle.
	first.State, first.PRState = "proposed", "open"
	lanes.held[first.WorkspaceID] = true
	_, err := db.New(o.pool).SaveMythicalItem(t.Context(), first)
	require.NoError(t, err)
	o.wake()
	first = o.byID(uuidString(first.ID))
	require.NotEmpty(t, first.WorkspaceID)
	require.Empty(t, o.lanes.deleted)
	require.Equal(t, "queued", o.byID(uuidString(second.ID)).State)
	// A stopped run needs a person; its machine still owns the only TODO slot.
	first.State, first.PRState = "blocked", ""
	first.RequestOutcome = "failed"
	waiting := mythicalChecksOf(first)
	waiting.Waits = []TodoWait{{ID: "question", Kind: "question", Prompt: "Which file?"}}
	first.Checks = waiting.encode()
	require.Equal(t, "needs_you", todoState(first))
	lanes.held[first.WorkspaceID] = true
	_, err = db.New(o.pool).SaveMythicalItem(t.Context(), first)
	require.NoError(t, err)
	o.wake()
	require.Equal(t, "queued", o.byID(uuidString(second.ID)).State)
	// A later-created TODO placed before T2 wins the next released slot.
	number := second.Number.Int64
	earlier, err := o.service.FileTodo(session, o.repoID, o.userID, MythicalTodoInput{Title: "Earlier", Prompt: "Add the earlier line", Request: "before-T2", Place: MythicalTodoPlace{Mode: "before", N: &number}})
	require.NoError(t, err)
	o.wake()
	require.Equal(t, "queued", o.byID(earlier.ID).State)
	require.NotEmpty(t, o.byID(uuidString(first.ID)).WorkspaceID)
	require.Empty(t, o.lanes.deleted)
	// A durable pause has the same retention rule even on an engine-settled row.
	first = o.byID(uuidString(first.ID))
	waiting = mythicalChecksOf(first)
	waiting.Waits = nil
	first.Checks = waiting.encode()
	first.PausedAt = pgtype.Timestamptz{Time: time.Now(), Valid: true}
	_, err = db.New(o.pool).SaveMythicalItem(t.Context(), first)
	require.NoError(t, err)
	require.Equal(t, "paused", todoState(first))
	o.wake()
	require.Equal(t, "queued", o.byID(earlier.ID).State)
	require.NotEmpty(t, o.byID(uuidString(first.ID)).WorkspaceID)
	require.Empty(t, o.lanes.deleted)
	// Only the runtime observation frees capacity; changing the TODO state did not.
	lanes.held[first.WorkspaceID] = false
	o.wake()
	require.Equal(t, "running", o.byID(earlier.ID).State)
	require.Equal(t, "queued", o.byID(uuidString(second.ID)).State)
}

func (l *fakeMythicalLanes) MachineHeld(_ context.Context, id string) (bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, deleted := range l.deleted {
		if deleted == id {
			return false, nil
		}
	}
	for _, created := range l.created {
		if created == id {
			return true, nil
		}
	}
	return false, nil
}
