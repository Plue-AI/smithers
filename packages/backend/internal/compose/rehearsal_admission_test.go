package compose

import (
	"github.com/stretchr/testify/require"
	"testing"
)

func TestRehearsalAdmissionOrderingAndHandoff(t *testing.T) {
	r := &rehearsalAdmissionRuntime{aliases: map[string]string{}}
	require.Error(t, r.SyncTodoAdmission("", []string{"todo:1"}, 1))
	require.False(t, r.TodoAdmissionEligible("todo:1"))
	require.NoError(t, r.SyncTodoAdmission("repository:1", []string{"todo:1", "todo:2"}, 1))
	require.True(t, r.TodoAdmissionEligible("todo:1"))
	require.False(t, r.TodoAdmissionEligible("todo:2"))
	require.Error(t, r.TransferTodoAdmission("todo:2", "workspace:2"))
	require.Error(t, r.TransferTodoAdmission("todo:1", ""))
	require.NoError(t, r.TransferTodoAdmission("todo:1", "workspace:1"))
	require.True(t, r.TodoAdmissionEligible("todo:1"))
	require.True(t, r.TodoAdmissionEligible("workspace:1"))
	require.Error(t, r.TransferTodoAdmission("todo:1", "workspace:3"))
	require.NoError(t, r.SyncTodoAdmission("repository:1", []string{"todo:2", "todo:1"}, 1))
	require.True(t, r.TodoAdmissionEligible("todo:2"))
	require.False(t, r.TodoAdmissionEligible("workspace:1"))
	require.NoError(t, r.SyncTodoAdmission("repository:1", []string{"todo:1"}, 0))
	require.False(t, r.TodoAdmissionEligible("todo:1"))
	require.NoError(t, r.SyncTodoAdmission("repository:1", nil, 2))
	require.False(t, r.TodoAdmissionEligible("workspace:1"))
}
