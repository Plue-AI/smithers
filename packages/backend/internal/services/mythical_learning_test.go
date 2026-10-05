package services

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
	"testing"
	"time"
	"unicode/utf8"
)

func TestLearningMergedTodoLaunchOnceAndProjection(t *testing.T) {
	o, session := newTodoAdmission(t)
	item := o.fileTodo(session, "learning-merge")
	item = mythicalLanded(item, o.landedMain(), o.service.now())
	_, err := db.New(o.pool).SaveMythicalItem(context.Background(), item)
	require.NoError(t, err)
	o.wake()
	request := o.launcher.last("learning")
	require.Equal(t, "learning", request.FlowID)
	require.Nil(t, request.Pin)
	item = o.byID(uuidString(item.ID))
	require.Equal(t, "landed", item.State)
	require.Equal(t, "merged", todoState(item))
	require.Equal(t, "requested", mythicalChecksOf(item).Learning.State)
	count := len(o.launcher.requests)
	o.wake()
	require.Len(t, o.launcher.requests, count)
	o.project(request, jobs.StateRunning, "learning-run", "")
	item = o.byID(uuidString(item.ID))
	require.Equal(t, "running", mythicalChecksOf(item).Learning.State)
	require.Contains(t, todoSteps(item), map[string]any{"id": "learning", "label": "Learn", "state": "current"})
	o.project(request, jobs.StateRunning, "stale-run", "")
	require.Equal(t, "learning-run", mythicalChecksOf(o.byID(uuidString(item.ID))).Learning.RunID)
	o.project(request, jobs.StateCancelled, "learning-run", "")
	item = o.byID(uuidString(item.ID))
	require.Equal(t, "cancelled", mythicalChecksOf(item).Learning.State)
	require.Equal(t, "merged", todoState(item))
	o.wake()
	require.Len(t, o.launcher.requests, count)
}
func TestLearningFailedAdmissionRetriesWithoutDuplicateRun(t *testing.T) {
	o, session := newTodoAdmission(t)
	item := o.fileTodo(session, "learning-failed-admission")
	item = mythicalLanded(item, o.landedMain(), o.service.now())
	_, err := db.New(o.pool).SaveMythicalItem(context.Background(), item)
	require.NoError(t, err)
	o.launcher.fail = 1
	o.wake()
	require.Nil(t, mythicalChecksOf(o.byID(uuidString(item.ID))).Learning)
	o.wake()
	require.Equal(t, "requested", mythicalChecksOf(o.byID(uuidString(item.ID))).Learning.State)
	require.Len(t, o.launcher.requests, 1)
}
func TestLearningStepsPreserveMergedState(t *testing.T) {
	for _, state := range []string{"requested", "running", "committing", "completed", "failed", "cancelled"} {
		t.Run(state, func(t *testing.T) {
			checks := mythicalChecks{Todo: true, Learning: &mythicalLearning{WorkspaceID: "workspace", RunID: "run", State: state}}
			item := db.MythicalItem{Source: "todo", State: "landed", Checks: checks.encode()}
			require.Equal(t, "merged", todoState(item))
			steps := todoSteps(item)
			require.Len(t, steps, 1)
			want := map[string]string{"requested": "waiting", "running": "current", "committing": "current", "completed": "done", "failed": "failed", "cancelled": "failed"}[state]
			require.Equal(t, want, steps[0]["state"])
		})
	}
}
func FuzzLearningCheckRoundTrip(f *testing.F) {
	f.Add("requested", "run", "workspace")
	f.Fuzz(func(t *testing.T, state, run, workspace string) {
		if len(state)+len(run)+len(workspace) > 4096 || !utf8.ValidString(state) || !utf8.ValidString(run) || !utf8.ValidString(workspace) {
			return
		}
		checks := mythicalChecks{Learning: &mythicalLearning{State: state, RunID: run, WorkspaceID: workspace}}
		var decoded mythicalChecks
		require.NoError(t, json.Unmarshal(checks.encode(), &decoded))
		require.Equal(t, checks.Learning, decoded.Learning)
	})
}

func TestLearningCanonicalAdmissionRealDatabase(t *testing.T) {
	o, session := newTodoAdmission(t)
	pool, _ := o.runDispatcher(t, flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		return nil, errors.New("not needed before worker starts")
	}))
	item := o.fileTodo(session, "learning-real-dispatch")
	item = mythicalLanded(item, o.landedMain(), o.service.now())
	_, err := db.New(pool).SaveMythicalItem(context.Background(), item)
	require.NoError(t, err)
	o.wake()
	o.wake()
	var count int
	require.NoError(t, pool.QueryRow(context.Background(), `SELECT count(*) FROM product_job_requests WHERE request_id=$1`, "todo-learning:"+uuidString(item.ID)).Scan(&count))
	require.Equal(t, 1, count)
	require.Equal(t, "merged", todoState(o.byID(uuidString(item.ID))))
}

func TestLearningCompletionRetriesCommitAndPreservesMerged(t *testing.T) {
	o, session := newTodoAdmission(t)
	item := o.fileTodo(session, "learning-commit")
	item = mythicalLanded(item, o.landedMain(), o.service.now())
	_, err := db.New(o.pool).SaveMythicalItem(context.Background(), item)
	require.NoError(t, err)
	o.wake()
	request := o.launcher.last("learning")
	repository, owner, err := o.service.repository(context.Background(), o.repoID)
	require.NoError(t, err)
	output, _ := json.Marshal(LearningOutput{Repository: owner + "/" + repository.Name, Todo: item.Number.Int64, Run: "learning-complete", Pages: []LearningPage{{Title: "Choice", Body: "Use existing admission"}}})
	store := &learningFixture{fail: true}
	o.service.SetLearning(store)
	o.project(request, jobs.StateCompleted, "learning-complete", string(output))
	o.wake()
	item = o.byID(uuidString(item.ID))
	require.Equal(t, "committing", mythicalChecksOf(item).Learning.State)
	require.False(t, store.done)
	// Late running observations cannot undo the durable success awaiting commit.
	o.project(request, jobs.StateRunning, "learning-complete", "")
	require.Equal(t, "committing", mythicalChecksOf(o.byID(uuidString(item.ID))).Learning.State)
	store.fail = false
	o.wake()
	item = o.byID(uuidString(item.ID))
	require.Equal(t, "completed", mythicalChecksOf(item).Learning.State)
	require.Equal(t, "merged", todoState(item))
	require.Equal(t, 1, store.pages)
	o.project(request, jobs.StateCompleted, "learning-complete", string(output))
	o.wake()
	require.Equal(t, 1, store.pages)
	require.Len(t, o.launcher.requests, 1)
}

func TestLearningMalformedOutputFailsVisibly(t *testing.T) {
	o, session := newTodoAdmission(t)
	item := o.fileTodo(session, "learning-malformed")
	item = mythicalLanded(item, o.landedMain(), o.service.now())
	_, err := db.New(o.pool).SaveMythicalItem(context.Background(), item)
	require.NoError(t, err)
	o.wake()
	request := o.launcher.last("learning")
	o.project(request, jobs.StateCompleted, "learning-malformed", "not json")
	item = o.byID(uuidString(item.ID))
	require.Equal(t, "failed", mythicalChecksOf(item).Learning.State)
	require.Equal(t, "merged", todoState(item))
	o.wake()
	require.Len(t, o.launcher.requests, 1)
}
func TestLearningLaunchAndRunTimeoutRemainMerged(t *testing.T) {
	for _, state := range []string{"requested", "running"} {
		t.Run(state, func(t *testing.T) {
			o, session := newTodoAdmission(t)
			item := o.fileTodo(session, "learning-timeout-"+state)
			item = mythicalLanded(item, o.landedMain(), o.service.now())
			_, err := db.New(o.pool).SaveMythicalItem(context.Background(), item)
			require.NoError(t, err)
			o.wake()
			item = o.byID(uuidString(item.ID))
			checks := mythicalChecksOf(item)
			checks.Learning.State = state
			checks.Learning.StartedAt = o.service.now().Add(-4 * time.Hour).UnixMilli()
			item.Checks = checks.encode()
			_, err = db.New(o.pool).SaveMythicalItem(context.Background(), item)
			require.NoError(t, err)
			o.wake()
			item = o.byID(uuidString(item.ID))
			require.Equal(t, "failed", mythicalChecksOf(item).Learning.State)
			require.Equal(t, "Learning timed out", mythicalChecksOf(item).Learning.Error)
			require.Equal(t, "merged", todoState(item))
			require.Len(t, o.launcher.requests, 1)
		})
	}
}

// Real GitHub merge and PostgreSQL; canonical admission is checked separately.
// No model is needed to prove post-merge admission.
func TestLearningFollowsRealGitHubMergeOnce(t *testing.T) {
	h := newMergeHarness(t)
	launcher := &fakeMythicalLauncher{}
	h.service.SetLauncher(launcher)
	h.service.lanes = &fakeMythicalLanes{}
	number, head, _ := h.first("Learning merge")
	require.NoError(t, h.pressAs(h.ctx, "learning-merge-press", number, head))
	for i := 0; i < 8 && h.item(number).State != "landed"; i++ {
		h.pass()
	}
	require.Equal(t, "landed", h.item(number).State)
	h.pass()
	request := launcher.last("learning")
	require.Equal(t, "learning", request.FlowID)
	require.Equal(t, "merged", todoState(h.item(number)))
	count := len(launcher.requests)
	// The same person request and the next reconciliation never launch twice.
	require.NoError(t, h.pressAs(h.ctx, "learning-merge-press", number, head))
	h.pass()
	h.pass()
	require.Len(t, launcher.requests, count)
	require.Len(t, h.merges(), 1)
}
