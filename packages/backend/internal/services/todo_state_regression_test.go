package services

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// §12.3 line 1124 at 2be05ba6: non-member reviews are activity only.
func TestTodoStateNonMemberReviewsNeverSteerOrVoidApprovals(t *testing.T) {
	for _, actor := range []TodoActor{{System: "github"}, {Agent: "coding", Run: "run-1"}} {
		for _, from := range TodoStates {
			for _, trigger := range []TodoTrigger{TodoChangesRequested, TodoReviewComment} {
				t.Run(string(from)+"/"+string(trigger)+"/"+actor.System+actor.Agent, func(t *testing.T) {
					guard := satisfiedGuard()
					guard.Actor = actor
					event, err := Transition(from, trigger, guard)
					var refused *TodoTransitionRefused
					require.ErrorAs(t, err, &refused)
					require.Equal(t, TodoEvent{}, event, "no state event, steer delivery, or approval invalidation")
				})
			}
		}
	}
}

// §4.1 line 233 and §12.3 line 1126 at 2be05ba6. A PR stays ready
// after a steer, so evidence and rebase updates must preserve any overlay.
func TestTodoStateEvidenceUpdatesPreserveWorkAndOverlays(t *testing.T) {
	for _, from := range []TodoState{TodoWorking, TodoNeedsYou, TodoPaused, TodoInReview} {
		for _, trigger := range []TodoTrigger{TodoChecksUpdated, TodoRebased} {
			t.Run(string(from)+"/"+string(trigger), func(t *testing.T) {
				event, err := Transition(from, trigger, satisfiedGuard())
				require.NoError(t, err)
				require.Equal(t, from, event.To)
				require.False(t, event.VoidApprovals)
				require.False(t, event.EndsWork)
				require.False(t, event.SteerHeld)
			})
		}
	}
}

// §10.7.3 line 974 at 2be05ba6 plus Will's starting-held ruling.
func TestTodoStateSteerHeldUntilFirstStepWithoutImplicitRetry(t *testing.T) {
	for _, row := range []struct {
		from, to   TodoState
		held, void bool
	}{
		{TodoQueued, TodoQueued, true, false}, {TodoStarting, TodoStarting, true, false},
		{TodoWorking, TodoWorking, false, false}, {TodoNeedsYou, TodoNeedsYou, false, false},
		{TodoPaused, TodoPaused, true, false}, {TodoInReview, TodoWorking, false, true},
	} {
		t.Run(string(row.from), func(t *testing.T) {
			event, err := Transition(row.from, TodoSteer, satisfiedGuard())
			require.NoError(t, err)
			require.Equal(t, row.to, event.To)
			require.Equal(t, row.held, event.SteerHeld)
			require.Equal(t, row.void, event.VoidApprovals)
			require.False(t, event.EndsWork)
			require.Nil(t, event.Failure)
		})
	}
	event, err := Transition(TodoFailed, TodoSteer, satisfiedGuard())
	var refused *TodoTransitionRefused
	require.ErrorAs(t, err, &refused, "a steer cannot start a new attempt; Retry is explicit")
	require.Equal(t, TodoEvent{}, event)
}

// §4.1 line 233 and §10.6.4 line 964 at 2be05ba6: main is the
// authority whether this PR merged directly or via a later squash commit.
func TestTodoStateMergeFromEveryUnmergedStateRequiresMain(t *testing.T) {
	for _, from := range []TodoState{TodoQueued, TodoStarting, TodoWorking, TodoNeedsYou, TodoPaused, TodoFailed, TodoInReview} {
		for _, trigger := range []TodoTrigger{TodoPRMerged, TodoMergedVia} {
			t.Run(string(from)+"/"+string(trigger), func(t *testing.T) {
				event, err := Transition(from, trigger, satisfiedGuard())
				require.NoError(t, err)
				require.Equal(t, TodoMerged, event.To)
				require.True(t, event.EndsWork)
				require.False(t, event.VoidApprovals)
				guard := satisfiedGuard()
				guard.OnMain = false
				event, err = Transition(from, trigger, guard)
				var refused *TodoTransitionRefused
				require.ErrorAs(t, err, &refused)
				require.Equal(t, TodoEvent{}, event)
			})
		}
	}
}
