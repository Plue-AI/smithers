package microsandbox

import (
	"context"
	"errors"
	"github.com/stretchr/testify/require"
	"sync"
	"testing"
	"time"
)

func TestTodoStackDemandCutoffHandoffAndPeople(t *testing.T) {
	r, p := admissionFixture()
	r.config.MaxRunningVMs = 3
	r.SetCapacityReader(func(context.Context) (int, error) { return 3, nil })
	require.NoError(t, r.SyncTodoAdmission("repo", []string{"todo:1", "todo:2", "todo:3", "todo:4", "todo:5"}, 2))
	require.True(t, r.TodoAdmissionEligible("todo:1"))
	require.True(t, r.TodoAdmissionEligible("todo:2"))
	require.False(t, r.TodoAdmissionEligible("todo:3"))
	// Unbound stack demand cannot boot, nor block the spare machine.
	_, err := r.Request("background", "wiki", "wiki", "refresh")
	require.NoError(t, err)
	granted, err := r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	require.Equal(t, "wiki", granted.Holder)
	for _, n := range []string{"1", "2"} {
		require.NoError(t, r.TransferTodoAdmission("todo:"+n, "workspace:"+n))
		granted, err = r.GrantNext(t.Context(), p)
		require.NoError(t, err)
		require.Equal(t, "workspace:"+n, granted.Holder)
	}
	require.Equal(t, "workspace:1", r.TodoAdmissionHolder("todo:1"))
	for _, row := range r.AdmissionSnapshot() {
		if row.Holder == "workspace:1" {
			require.Equal(t, []string{"todo:1"}, row.Aliases)
			row.Aliases[0] = "corrupted"
		}
	}
	require.Equal(t, "workspace:1", r.TodoAdmissionHolder("todo:1"))
	require.NoError(t, r.SyncTodoAdmission("repo", []string{"todo:1", "todo:2", "todo:3", "todo:4", "todo:5"}, 2))
	require.Equal(t, "workspace:1", r.TodoAdmissionHolder("todo:1"))
	require.Equal(t, 3, r.InUse())
	require.NoError(t, r.SyncTodoAdmission("repo", []string{"workspace:1", "workspace:2", "todo:6", "todo:3", "todo:4", "todo:5"}, 2))
	require.False(t, r.TodoAdmissionEligible("todo:6"))
	// Lowering the limit does not evict either TODO holder.
	require.NoError(t, r.SyncTodoAdmission("repo", []string{"workspace:1", "workspace:2", "todo:6", "todo:3"}, 1))
	require.True(t, r.AdmissionHeld("workspace:1"))
	require.True(t, r.AdmissionHeld("workspace:2"))
	require.False(t, r.TodoAdmissionEligible("todo:6"))
	r.ConfirmAdmissionStop("wiki", false)
	r.ConfirmAdmissionStop("workspace:1", false)
	require.NoError(t, r.SyncTodoAdmission("repo", []string{"workspace:2", "todo:6", "todo:3"}, 2))
	require.True(t, r.TodoAdmissionEligible("todo:6"))
	require.NoError(t, r.TransferTodoAdmission("todo:6", "workspace:6"))
	_, err = r.Request("person", "ben", "Ben", "terminal")
	require.NoError(t, err)
	positions := map[string]int{}
	for _, row := range r.AdmissionSnapshot() {
		if row.State == "waiting" {
			positions[row.Holder] = row.Position
		}
	}
	require.Equal(t, map[string]int{"ben": 1, "workspace:6": 2, "todo:3": 3}, positions)
	granted, err = r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	require.Equal(t, "ben", granted.Holder)
	granted, err = r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	require.Equal(t, "workspace:6", granted.Holder)
	require.NoError(t, r.SyncTodoAdmission("repo", []string{"workspace:2", "workspace:6", "todo:3"}, 0))
	require.Equal(t, 3, r.InUse())
	require.False(t, r.TodoAdmissionEligible("todo:3"))
	// Removal cancels only ungranted demands. A cancelled bound grant stays held.
	require.NoError(t, r.SyncTodoAdmission("repo", nil, 0))
	require.True(t, r.AdmissionHeld("workspace:6"))
	require.True(t, r.CancelAdmission("workspace:6", "workspace:6", time.Now()))
	require.True(t, r.AdmissionHeld("workspace:6"))
}

func TestTodoDemandHandoffRefusalsPreserveSource(t *testing.T) {
	r, _ := admissionFixture()
	require.Error(t, r.SyncTodoAdmission("", nil, 1))
	require.Error(t, r.TransferTodoAdmission("absent", "workspace:1"))
	require.NoError(t, r.SyncTodoAdmission("repo", []string{"todo:1"}, 1))
	_, err := r.Request("person", "workspace:1", "Ben", "terminal")
	require.NoError(t, err)
	require.Error(t, r.TransferTodoAdmission("todo:1", "workspace:1"))
	require.True(t, r.TodoAdmissionEligible("todo:1"))
	require.False(t, r.CancelAdmission("todo:1", "todo:1", time.Now()))
	require.Error(t, r.TransferTodoAdmission("todo:1", "workspace:2"))
	require.Len(t, r.AdmissionSnapshot(), 2)
	require.NoError(t, r.SyncTodoAdmission("repo", []string{"todo:1"}, 1))
	require.NoError(t, r.TransferTodoAdmission("todo:1", "workspace:2"))
}

func TestTodoGrantRechecksParallelWithoutEnginePass(t *testing.T) {
	r, p := admissionFixture()
	r.config.MaxRunningVMs = 3
	r.SetCapacityReader(func(context.Context) (int, error) { return 3, nil })
	require.NoError(t, r.SyncTodoAdmission("repo", []string{"todo:1", "todo:2", "todo:3"}, 3))
	for _, n := range []string{"1", "2", "3"} {
		require.NoError(t, r.TransferTodoAdmission("todo:"+n, "workspace:"+n))
	}
	parallel := 1
	r.SetTodoParallelReader(func(context.Context) (int, error) { return parallel, nil })
	first, err := r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	require.Equal(t, "workspace:1", first.Holder)
	blocked, err := r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	require.Empty(t, blocked.Holder)
	require.Equal(t, 1, r.InUse())
	parallel = 2
	second, err := r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	require.Equal(t, "workspace:2", second.Holder)
	parallel = 0
	third, err := r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	require.Empty(t, third.Holder)
	require.Equal(t, 2, r.InUse())
}

func TestTodoOwnershipWakeRequiresGrantOrConfirmedRelease(t *testing.T) {
	r, p := admissionFixture()
	changes := r.AdmissionOwnershipChanges()
	require.NoError(t, r.SyncTodoAdmission("repo", []string{"todo:1"}, 1))
	require.NoError(t, r.TransferTodoAdmission("todo:1", "workspace:1"))
	select {
	case <-changes:
		t.Fatal("demand/projection woke the engine")
	default:
	}
	granted, err := r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	require.Equal(t, "workspace:1", granted.Holder)
	select {
	case <-changes:
	default:
		t.Fatal("reservation did not wake the engine")
	}
	changes = r.AdmissionOwnershipChanges()
	require.True(t, r.CancelAdmission("workspace:1", "workspace:1", time.Now()))
	select {
	case <-changes:
		t.Fatal("cancellation is not confirmed release")
	default:
	}
	r.ConfirmAdmissionStop("workspace:1", false)
	select {
	case <-changes:
	default:
		t.Fatal("confirmed release did not wake the engine")
	}
}

func TestTodoInstallRecoveredDemandWaitsForStackOrder(t *testing.T) {
	r, p := admissionFixture()
	r.SetTodoParallelReader(func(context.Context) (int, error) { return 1, nil })
	// Recovery can register workspace demand in durable creation order before
	// the stack engine has supplied its authoritative order and cutoff.
	for _, holder := range []string{"workspace:2", "workspace:1"} {
		_, err := r.Request("todo", holder, holder, "machine")
		require.NoError(t, err)
	}
	blocked, err := r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	require.Empty(t, blocked.Holder)
	require.Zero(t, r.InUse())
	require.NoError(t, r.SyncTodoAdmission("repo", []string{"workspace:1", "workspace:2"}, 1))
	granted, err := r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	require.Equal(t, "workspace:1", granted.Holder)
	blocked, err = r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	require.Empty(t, blocked.Holder)
	require.True(t, r.AdmissionHeld("workspace:1"))
}

func TestTodoGrantRechecksParallelAfterReadiness(t *testing.T) {
	r, p := admissionFixture()
	r.config.MaxRunningVMs = 3
	r.SetCapacityReader(func(context.Context) (int, error) { return 3, nil })
	parallel := 2
	var readErr error
	r.SetTodoParallelReader(func(context.Context) (int, error) { return parallel, readErr })
	require.NoError(t, r.SyncTodoAdmission("repo", []string{"workspace:1", "workspace:2"}, 2))
	first, err := r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	require.Equal(t, "workspace:1", first.Holder)
	ready := p.Ready
	p.Ready = func(ctx context.Context, request AdmissionRequest) error {
		parallel = 1
		return ready(ctx, request)
	}
	blocked, err := r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	require.Empty(t, blocked.Holder)
	require.Equal(t, 1, r.InUse())
	require.True(t, r.AdmissionHeld("workspace:1"))
	require.False(t, r.AdmissionHeld("workspace:2"))
	parallel = 2
	failedRead := errors.New("settings read failed")
	p.Ready = func(ctx context.Context, request AdmissionRequest) error {
		readErr = failedRead
		return ready(ctx, request)
	}
	blocked, err = r.GrantNext(t.Context(), p)
	require.ErrorIs(t, err, failedRead)
	require.Empty(t, blocked.Holder)
	require.Equal(t, 1, r.InUse())
	readErr = nil
	p.Ready = ready
	second, err := r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	require.Equal(t, "workspace:2", second.Holder)
}

func TestTodoProjectionRetainsGrantedDemandDuringAutomaticRelease(t *testing.T) {
	for _, phase := range []string{"capture", "stop"} {
		t.Run(phase, func(t *testing.T) {
			r, p := admissionFixture()
			require.NoError(t, r.SyncTodoAdmission("repo", []string{"todo:1", "todo:6"}, 1))
			require.NoError(t, r.TransferTodoAdmission("todo:1", "workspace:1"))
			grant, err := r.GrantNext(t.Context(), p)
			require.NoError(t, err)
			require.Equal(t, "workspace:1", grant.Holder)
			h := r.admission["workspace:1"]
			if phase == "capture" {
				h.idlePreparing = true
			} else {
				h.releasing = time.Now()
			}
			require.NoError(t, r.SyncTodoAdmission("repo", []string{"workspace:1", "todo:6"}, 1))
			require.True(t, r.AdmissionHeld("workspace:1"))
			for _, row := range r.AdmissionSnapshot() {
				if row.Holder == "workspace:1" {
					require.Equal(t, "granted", row.State)
					require.Zero(t, row.Position)
				}
				if row.Holder == "todo:6" {
					require.Equal(t, "waiting", row.State)
					require.Equal(t, 1, row.Position)
				}
			}
			// An actual new wake still waits for the retained machine's stop.
			wake, err := r.Request("person", "workspace:1", "person:2", "terminal")
			require.NoError(t, err)
			require.Equal(t, "waiting", wake.State)
		})
	}
}

func TestAdmissionPublicationSerializesConcurrentFreeSlots(t *testing.T) {
	r, p := admissionFixture()
	r.config.MaxRunningVMs = 3
	r.SetCapacityReader(func(context.Context) (int, error) { return 3, nil })
	for _, holder := range []string{"Alice", "Ben", "T5"} {
		class := "person"
		if holder == "T5" {
			class = "todo"
		}
		_, err := r.Request(class, holder, holder, "terminal")
		require.NoError(t, err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	var mu sync.Mutex
	var publications []string
	r.SetAdmissionPublisher(func(_ context.Context, g AdmissionRequest) error {
		require.NotEmpty(t, g.PublicationID)
		if g.Holder == "Alice" {
			close(entered)
			<-release
		}
		mu.Lock()
		publications = append(publications, g.Holder)
		mu.Unlock()
		return nil
	})
	done := make(chan error, 3)
	for range 3 {
		go func() { _, err := r.GrantNext(t.Context(), p); done <- err }()
	}
	<-entered
	require.Equal(t, 1, r.InUse())
	require.False(t, r.admissionGranted("Alice", "Alice"))
	require.False(t, r.AdmissionHeld("Ben"))
	close(release)
	for range 3 {
		require.NoError(t, <-done)
	}
	require.Equal(t, []string{"Alice", "Ben", "T5"}, publications)
	require.Equal(t, 3, r.InUse())
}

func TestAdmissionPublicationRetryRetainsReservation(t *testing.T) {
	r, p := admissionFixture()
	r.config.MaxRunningVMs = 2
	r.SetCapacityReader(func(context.Context) (int, error) { return 2, nil })
	for _, holder := range []string{"Alice", "Ben"} {
		_, err := r.Request("person", holder, holder, "terminal")
		require.NoError(t, err)
	}
	refused := true
	var identity string
	r.SetAdmissionPublisher(func(_ context.Context, g AdmissionRequest) error {
		if g.Holder == "Alice" {
			if identity == "" {
				identity = g.PublicationID
			}
			require.Equal(t, identity, g.PublicationID)
			if refused {
				return errors.New("source rollback")
			}
		}
		return nil
	})
	for range 2 {
		grant, err := r.GrantNext(t.Context(), p)
		require.ErrorIs(t, err, ErrAdmissionNotReady)
		require.Empty(t, grant.Holder)
		require.Equal(t, 1, r.InUse())
		require.False(t, r.admissionGranted("Alice", "Alice"))
		require.False(t, r.AdmissionHeld("Ben"))
	}
	refused = false
	grant, err := r.GrantNext(t.Context(), p)
	require.NoError(t, err)
	require.Equal(t, "Ben", grant.Holder)
	require.True(t, r.admissionGranted("Alice", "Alice"))
	require.True(t, r.admissionGranted("Ben", "Ben"))
	require.Equal(t, 2, r.InUse())
}
