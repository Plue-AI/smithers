package microsandbox

import (
	"context"
	"github.com/stretchr/testify/require"
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
