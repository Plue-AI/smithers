package services

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
)

// launchOn is the last launch of flowID on workspaceID.
func (o *mythicalOrchestration) launchOn(flowID, workspaceID string) flowdispatch.LaunchRequest {
	o.t.Helper()
	var found flowdispatch.LaunchRequest
	for _, request := range o.launcher.byFlow(flowID) {
		if request.Target.WorkspaceID == workspaceID {
			found = request
		}
	}
	require.NotEmpty(o.t, found.RequestID, "no %s launch on %s", flowID, workspaceID)
	return found
}

// A TODO's lane is its own branch machine (T-MCH-04): two TODOs work on two
// lanes at once, and a TODO's fresh attempt, after any failure, runs again on
// the lane it holds. Nothing is provisioned or retired for the retry, and the
// other TODO's lane is untouched.
func TestTodoLanesAreTheirOwnAndARetryKeepsIt(t *testing.T) {
	for _, tc := range []struct{ name, fault, tag string }{
		{name: "plan failed", fault: "factory", tag: "coding/Error/fast_gate"},
		{name: "infrastructure", fault: "infra", tag: "flows/InfraInterrupt"},
		{name: "provider quota", fault: "wait", tag: "flows/model/ModelError/quota_exceeded"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			o, session := newTodoAdmission(t)
			ctx := context.Background()
			first := uuidString(o.fileTodo(session, "first").ID)
			second := uuidString(o.fileTodo(session, "second").ID)
			o.wake()
			one, two := o.byID(first), o.byID(second)
			require.Equal(t, "running", one.State, one.Reason)
			require.Equal(t, "running", two.State, two.Reason)
			require.NotEmpty(t, one.WorkspaceID)
			require.NotEmpty(t, two.WorkspaceID)
			require.NotEqual(t, one.WorkspaceID, two.WorkspaceID, "each TODO gets its own lane")
			require.Len(t, o.lanes.created, 2)

			o.fail(o.launchOn("coding/request", one.WorkspaceID), "run-first-1", tc.fault, tc.tag, "")
			o.wake()
			failed := o.byID(first)
			require.Equal(t, "retrying", failed.State, failed.Reason)
			_, err := o.pool.Exec(ctx, `UPDATE mythical_items SET next_attempt_at = NOW() - INTERVAL '1 minute' WHERE repository_id = $1`, o.repoID)
			require.NoError(t, err)
			o.wake()
			retried := o.byID(first)
			require.Equal(t, "running", retried.State, retried.Reason)
			assert.Equal(t, one.WorkspaceID, retried.WorkspaceID, "the TODO's own lane runs it again")
			assert.Equal(t, one.Generation+1, retried.Generation, "the retry is a new launch")
			assert.Len(t, o.lanes.created, 2, "no lane is provisioned")
			assert.Empty(t, o.lanes.deleted, "no lane is retired")
			assert.Equal(t, two.WorkspaceID, o.byID(second).WorkspaceID)
			assert.Len(t, o.launcher.byFlow("coding/request"), 3)
			o.launchOn("coding/request", one.WorkspaceID)
		})
	}
}

// A TODO whose lane was retired while it waited gets a fresh lane of its own.
func TestTodoRetryOpensANewLaneWhenItsLaneIsRetired(t *testing.T) {
	o, session := newTodoAdmission(t)
	ctx := context.Background()
	id := uuidString(o.fileTodo(session, "first").ID)
	o.wake()
	first := o.byID(id)
	require.Equal(t, "running", first.State, first.Reason)
	o.fail(o.launchOn("coding/request", first.WorkspaceID), "run-first-1", "factory", "coding/Error/fast_gate", "")
	o.wake()
	_, err := o.pool.Exec(ctx, `UPDATE mythical_lanes SET retired_at = NOW() WHERE workspace_id = $1`, first.WorkspaceID)
	require.NoError(t, err)
	_, err = o.pool.Exec(ctx, `UPDATE mythical_items SET next_attempt_at = NOW() - INTERVAL '1 minute' WHERE repository_id = $1`, o.repoID)
	require.NoError(t, err)
	o.wake()
	second := o.byID(id)
	require.Equal(t, "running", second.State, second.Reason)
	assert.NotEqual(t, first.WorkspaceID, second.WorkspaceID)
	assert.Len(t, o.lanes.created, 2)
}
