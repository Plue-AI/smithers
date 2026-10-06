package services

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

func TestTodoRetainsPlanThroughVeryHardRecovery(t *testing.T) {
	o, session := newTodoAdmission(t)
	o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
	id := uuidString(o.fileTodo(session, "retained-plan").ID)
	plan := `{"title":"Previous plan","steps":["Add greeting","Check greeting"],"checks":[]}`
	for i := range mythicalAttempts + 1 {
		o.wake()
		item := o.byID(id)
		require.Equal(t, "running", item.State, item.Reason)
		if i == 0 {
			// A retained plan from an earlier result is durable state. These
			// subsequent runs fail before producing any replacement plan.
			item.Plan = json.RawMessage(plan)
			_, err := o.service.queries().SaveMythicalItem(t.Context(), item)
			require.NoError(t, err)
		} else {
			require.JSONEq(t, plan, string(item.Plan))
		}
		o.projectTodo(o.launcher.last("todo"), jobs.StateCompleted, fmt.Sprintf("plan-run-%d", i), todoPinOne, `{}`)
		o.wake()
	}
	item := o.byID(id)
	require.Equal(t, "blocked", item.State)
	require.EqualValues(t, mythicalAttempts, item.Attempt)
	require.True(t, mythicalChecksOf(item).VeryHard)
	require.JSONEq(t, plan, string(item.Plan))
	require.Len(t, o.launcher.byFlow("todo"), mythicalAttempts+1)
}

func TestTodoRetainedPlanCannotValidateNewCandidate(t *testing.T) {
	o, session := newTodoAdmission(t)
	o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
	id := uuidString(o.fileTodo(session, "fresh-candidate-plan").ID)
	o.wake()
	o.projectTodo(o.launcher.last("todo"), jobs.StateWaiting, "current-run", todoPinOne, "")
	item := o.byID(id)
	item.Plan = json.RawMessage(`{"title":"Earlier plan","steps":["Old implementation"],"checks":[{"id":"old-check"}]}`)
	_, err := o.service.queries().SaveMythicalItem(t.Context(), item)
	require.NoError(t, err)
	before := o.byID(id)
	candidate := o.laneResult(item.WorkspaceID, item.BaseCommit, map[string]string{"JOURNEY.md": "Hello, reader.\n"}, "Greet the reader")
	submission := MythicalLaneSubmission{WorkspaceID: item.WorkspaceID, Base: item.BaseCommit, Source: candidate, RequestRunID: "current-run", Summary: "Greet the reader"}
	for _, plan := range []json.RawMessage{nil, json.RawMessage(`null`), json.RawMessage(`{"changes":[]}`)} {
		submission.Plan = plan
		_, err = o.service.SubmitLane(t.Context(), o.repoID, o.userID, submission)
		require.Error(t, err, "an earlier plan cannot qualify a new candidate")
		require.Equal(t, before, o.byID(id), "refusal preserves the retained evidence and candidate state")
	}
	submission.Plan = json.RawMessage(`{"changes":[{"title":"New plan","atoms":[{"changeId":null,"message":"Greet reader"}],"checks":[{"id":"new-check","target":"test","flow":"checks/test","flowDigest":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","tier":"fast","required":true}]}]}`)
	receipt, err := o.service.SubmitLane(t.Context(), o.repoID, o.userID, submission)
	require.NoError(t, err)
	after := o.byID(id)
	require.Equal(t, "integrating", after.State)
	require.Equal(t, candidate, after.CandidateHead)
	require.Contains(t, string(after.Plan), `"new-check"`)
	require.NotContains(t, string(after.Plan), `"old-check"`)
	// A lost acknowledgment may retry the already accepted candidate. It
	// reuses that receipt without replacing the plan or admitting new work.
	submission.Plan = nil
	again, err := o.service.SubmitLane(t.Context(), o.repoID, o.userID, submission)
	require.NoError(t, err)
	require.Equal(t, receipt, again)
	require.Equal(t, after, o.byID(id))
}
