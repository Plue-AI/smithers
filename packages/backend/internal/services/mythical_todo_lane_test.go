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

// An owner's TODO releases its lanes as an issue item does (T-MCH-06,
// T-MCH-07): once its pull request is open, its coding lane is retired before
// the review opens a lane of its own, named for the TODO, and the review lane
// is retired once it answers, so the TODO holds no machine while a person
// decides.
func TestTodoReleasesItsCodingAndReviewLanes(t *testing.T) {
	o, session := newTodoAdmission(t)
	ctx := context.Background()
	id := uuidString(o.fileTodo(session, "first").ID)
	o.wake()
	item := o.byID(id)
	require.Equal(t, "running", item.State, item.Reason)
	coding := item.WorkspaceID
	tip := o.hostRef("refs/heads/main")
	candidate := o.laneResult(coding, tip, map[string]string{"JOURNEY.md": "Hello, reader.\n"}, "✨ feat: greet the reader")
	// Stands in for the candidate the run records: the engine pins it.
	_, err := o.pool.Exec(ctx, `UPDATE mythical_items SET state='integrating', candidate_base=$2, candidate_head=$3, candidate_verified=true,
		summary='✨ feat: greet the reader' WHERE id=$1`, item.ID, tip, candidate)
	require.NoError(t, err)
	o.wake()
	require.Equal(t, "proposing", o.byID(id).State)
	// Stands in for publication: the pull request is open at the candidate.
	_, err = o.pool.Exec(ctx, `UPDATE mythical_items SET state='proposed', pr_number=41, pr_head=$2, pr_state='open', reason='' WHERE id=$1`, item.ID, candidate)
	require.NoError(t, err)
	o.github.mu.Lock()
	if o.github.pulls == nil {
		o.github.pulls = map[int64]*mythicalPull{}
	}
	o.github.pulls[41] = &mythicalPull{Number: 41, State: "open", HeadSHA: candidate, HeadRef: "smithers/todo-1", MergeableState: "clean"}
	o.github.mu.Unlock()
	o.wake()

	item = o.byID(id)
	require.Equal(t, "proposed", item.State, item.Reason)
	assert.Contains(t, o.lanes.deleted, coding, "the coding lane is retired before the review starts")
	review := o.launcher.last(mythicalReviewFlow)
	require.NotEmpty(t, review.RequestID, "the review launched: reason %q checks %s next %v", item.Reason, item.Checks, item.NextAttemptAt)
	reviewLane := review.Target.WorkspaceID
	assert.NotEqual(t, coding, reviewLane)
	assert.Equal(t, reviewLane, item.WorkspaceID)
	assert.NotContains(t, o.lanes.deleted, reviewLane)
	var name string
	require.NoError(t, o.pool.QueryRow(ctx, `SELECT name FROM mythical_lanes WHERE workspace_id=$1`, reviewLane).Scan(&name))
	assert.Equal(t, "TODO 1 review g2", name)

	o.answerReviews(`"request-changes"`)
	item = o.byID(id)
	assert.Contains(t, o.lanes.deleted, reviewLane, "the review lane is retired once it answers")
	assert.Empty(t, item.WorkspaceID, "the TODO holds no machine while a person decides")
	assert.False(t, item.Lane.Valid)
}
