package services

import (
	"context"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/stretchr/testify/require"
	"sync"
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
	freeDisk = 40 << 30
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
	// A stopped run needs a person; its machine still owns the only TODO slot.
	first.State, first.PRState = "blocked", ""
	first.RequestOutcome = "failed"
	waiting := mythicalChecksOf(first)
	waiting.Waits = []TodoWait{{ID: "question", Kind: "question", Prompt: "Which file?"}}
	first.Checks = waiting.encode()
	require.Equal(t, "needs_you", todoState(first))
	lanes.held[first.WorkspaceID] = true
	_, err := db.New(o.pool).SaveMythicalItem(t.Context(), first)
	require.NoError(t, err)
	o.wake()
	require.NotEmpty(t, o.byID(uuidString(first.ID)).WorkspaceID)
	require.Empty(t, o.lanes.deleted)
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

// J5 covers this through the composed HTTP install: a reviewed flow edit must
// not hold the only free machine while another TODO waits for an answer.
func TestParallelFinishedReviewRetiresBeforeNextAdmission(t *testing.T) {
	o, session := newTodoAdmission(t)
	capacity := &InstallCapacityService{Queries: db.New(o.pool), Profile: microsandbox.HostProfile{MemoryBytes: 32 << 30, PerfCores: 10, DiskFreeBytes: 400 << 30}}
	o.service.SetInstallParallel(capacity)
	require.NoError(t, db.New(o.pool).UpsertInstallSetting(t.Context(), db.UpsertInstallSettingParams{Key: "parallel", Value: []byte(`1`)}))
	first := o.fileTodo(session, "T1")
	second := o.fileTodo(session, "T2")
	o.wake()
	first = o.byID(uuidString(first.ID))
	workspace := first.WorkspaceID
	require.NotEmpty(t, workspace)
	require.Equal(t, "queued", o.byID(uuidString(second.ID)).State)
	first.State, first.PRState, first.PRHead = "proposed", "open", "reviewed-head"
	_, err := db.New(o.pool).SaveMythicalItem(t.Context(), first)
	require.NoError(t, err)
	o.wake()
	first = o.byID(uuidString(first.ID))
	require.NotEmpty(t, first.WorkspaceID, "a pending review retains its machine until the review launch owns the handoff")
	require.Equal(t, "queued", o.byID(uuidString(second.ID)).State)
	workspace = first.WorkspaceID
	checks := mythicalChecksOf(first)
	checks.Review = &mythicalReview{Head: first.PRHead, Verdict: "approve"}
	first.Checks = checks.encode()
	_, err = db.New(o.pool).SaveMythicalItem(t.Context(), first)
	require.NoError(t, err)
	o.wake()
	require.Empty(t, o.byID(uuidString(first.ID)).WorkspaceID)
	require.Contains(t, o.lanes.deleted, workspace)
	// The current pass kept its ownership snapshot; the next observes release.
	o.wake()
	require.Equal(t, "running", o.byID(uuidString(second.ID)).State)
}

// The engine fixture has no VM runtime. Supply the cutoff contract here; the
// runtime implementation is exercised separately with the composed card route.
func (l *fakeMythicalLanes) SyncTodoMachines(_ int64, items []db.MythicalItem, limit int, _ time.Time) error {
	l.todoEligible = map[[16]byte]bool{}
	for _, item := range items {
		if item.WorkspaceID != "" {
			held, _ := l.MachineHeld(context.Background(), item.WorkspaceID)
			if held {
				limit--
				l.todoEligible[item.ID.Bytes] = true
			}
		}
	}
	for _, item := range items {
		if (item.State == "queued" || item.State == "retrying") && !l.todoEligible[item.ID.Bytes] && limit > 0 {
			l.todoEligible[item.ID.Bytes] = true
			limit--
		}
	}
	return nil
}
func (l *fakeMythicalLanes) TodoMachineEligible(item db.MythicalItem) bool {
	return l.todoEligible[item.ID.Bytes]
}
func (l *parallelObservedLanes) SyncTodoMachines(_ int64, items []db.MythicalItem, limit int, _ time.Time) error {
	l.todoEligible = map[[16]byte]bool{}
	for _, item := range items {
		if l.held[item.WorkspaceID] {
			limit--
			l.todoEligible[item.ID.Bytes] = true
		}
	}
	for _, item := range items {
		if (item.State == "queued" || item.State == "retrying") && !l.todoEligible[item.ID.Bytes] && limit > 0 {
			l.todoEligible[item.ID.Bytes] = true
			limit--
		}
	}
	return nil
}

type parallelWakeLanes struct {
	*parallelObservedLanes
	wake       chan struct{}
	subscribed chan struct{}
	once       sync.Once
}

func (l *parallelWakeLanes) MachineOwnershipChanges() <-chan struct{} {
	l.once.Do(func() { close(l.subscribed) })
	select {
	case <-l.wake:
		return nil
	default:
		return l.wake
	}
}

// T-MCH-06's runtime stop observation is the only injected event. The real
// database and engine must advance the waiting TODO without a new SQL command,
// a card refresh, a manual engine pass or the five-minute recovery sweep.
func TestParallelMachineReleaseWakesWaitingEngine(t *testing.T) {
	o, session := newTodoAdmission(t)
	o.service.SetInstallParallel(&InstallCapacityService{Queries: db.New(o.pool), Profile: microsandbox.HostProfile{MemoryBytes: 32 << 30, PerfCores: 10, DiskFreeBytes: 400 << 30}})
	require.NoError(t, db.New(o.pool).UpsertInstallSetting(t.Context(), db.UpsertInstallSettingParams{Key: "parallel", Value: []byte(`1`)}))
	lanes := &parallelWakeLanes{parallelObservedLanes: &parallelObservedLanes{fakeMythicalLanes: o.lanes, held: map[string]bool{}}, wake: make(chan struct{}), subscribed: make(chan struct{})}
	lanes.provision = func(id string) { lanes.held[id] = true }
	o.service.lanes = lanes
	first := o.fileTodo(session, "T1")
	second := o.fileTodo(session, "T2")
	o.wake()
	first = o.byID(uuidString(first.ID))
	require.Equal(t, "queued", o.byID(uuidString(second.ID)).State)
	lanes.held[first.WorkspaceID] = false
	// Stop reporting may precede subscription: the initial pass still reads the
	// runtime. Hold the stack dormant so only the ownership signal requests it.
	_, err := o.pool.Exec(t.Context(), `UPDATE mythical_stacks SET requested_generation=processed_generation,next_attempt_at=NOW() WHERE repository_id=$1`, o.repoID)
	require.NoError(t, err)
	o.service.sweepEvery = 6 * time.Hour
	ctx, cancel := context.WithCancel(t.Context())
	stopped := make(chan struct{})
	go func() { defer close(stopped); o.service.Start(ctx) }()
	t.Cleanup(func() { cancel(); <-stopped })
	<-lanes.subscribed
	close(lanes.wake)
	require.Eventually(t, func() bool { return o.byID(uuidString(second.ID)).State == "running" }, 2*time.Second, 10*time.Millisecond)
}
