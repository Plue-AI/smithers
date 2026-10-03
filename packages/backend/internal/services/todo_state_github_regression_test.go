package services

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Real PostgreSQL and the real GitHub HTTP client. Only credentials and
// GitHub responses use local fixtures: this task cannot call live GitHub.
type stateFixtureGitHub struct{ mythicalGitHub }

func (g stateFixtureGitHub) Resolve(context.Context, db.Repository, string, int64) (mythicalGitHubRepo, error) {
	return stackRepo, nil
}

// §4.1 line 233 at 2be05ba6: external merge observations must reach any
// unmerged TODO, including an overlay that stops ordinary execution.
func TestTodoStateExternalMergeReachesEveryUnmergedPhasePostgres(t *testing.T) {
	for _, row := range []struct {
		state TodoState
		item  string
	}{
		{TodoQueued, "queued"}, {TodoStarting, "running"}, {TodoWorking, "running"},
		{TodoNeedsYou, "proposed"}, {TodoPaused, "proposed"}, {TodoFailed, "blocked"}, {TodoInReview, "proposed"},
	} {
		t.Run(string(row.state), func(t *testing.T) {
			f := newTodoFixture(t)
			ctx := context.Background()
			f.create("k", "External merge")
			recorder := &recordedGitHub{routes: map[string]func(http.ResponseWriter){
				"GET /repos/o/r/pulls/42": answer(http.StatusOK, map[string]any{
					"number": 42, "state": "closed", "merged_at": todoTestNow, "merge_commit_sha": "merged-commit",
					"head": map[string]string{"ref": "smithers/external-merge", "sha": "head"},
				}),
				"GET /repos/o/r/compare/main...merged-commit": answer(http.StatusOK, map[string]any{"status": "behind", "ahead_by": 0}),
			}}
			f.service.github = stateFixtureGitHub{recorder.api(t)}
			f.service.markBackfill(f.repoID)
			_, err := f.pool.Exec(ctx, `UPDATE mythical_items SET state = $1, pr_number = 42, pr_state = 'open', pr_head = 'head', candidate_verified = true WHERE todo_id = (SELECT id FROM todos WHERE number = 1)`, row.item)
			require.NoError(t, err)
			_, err = f.pool.Exec(ctx, `UPDATE todos SET state = $1 WHERE number = 1`, string(row.state))
			require.NoError(t, err)
			if row.state == TodoNeedsYou {
				_, err = f.pool.Exec(ctx, `UPDATE todos SET needs_you = '{"kind":"question","prompt":"Which?"}'::jsonb WHERE number = 1`)
				require.NoError(t, err)
			}
			if row.state == TodoPaused {
				_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET paused_at = now() WHERE todo_id = (SELECT id FROM todos WHERE number = 1)`)
				require.NoError(t, err)
			}
			before := f.todo(1)
			stack, err := db.New(f.pool).GetMythicalStack(ctx, f.repoID)
			require.NoError(t, err)
			f.service.advanceItems(ctx, &mythicalRun{row: stack})
			require.Equal(t, "landed", f.item(1).State, "poll external PR facts before skipping execution")
			require.Equal(t, string(TodoMerged), f.todo(1).State)
			require.Equal(t, before.ID, f.todo(1).ID)
			require.Nil(t, f.todo(1).NeedsYou)
			require.False(t, f.item(1).PausedAt.Valid)
			events := f.events(1)
			require.Len(t, events, 2)
			require.Equal(t, string(TodoPRMerged), events[1].Kind)
			require.Equal(t, string(row.state), events[1].FromState.String)
			require.Len(t, f.projections("todo:1"), 2)
			for _, call := range recorder.calls {
				require.Contains(t, call, "GET ", "external reconciliation performs no PR write, including draft conversion")
			}
		})
	}
}

// The observed merge must not become an item/TODO terminal fact before
// the PR's merge commit is known to be on the repository's main bookmark.
func TestTodoStateFollowRequiresMergeCommitOnMainPostgres(t *testing.T) {
	for _, row := range []struct {
		name    string
		status  int
		ahead   int
		missing bool
	}{
		{"reachable", http.StatusOK, 0, false}, {"not yet on main", http.StatusOK, 1, false}, {"compare unavailable", http.StatusBadGateway, 0, false}, {"missing merge commit", http.StatusOK, 0, true},
	} {
		t.Run(row.name, func(t *testing.T) {
			f := newTodoFixture(t)
			ctx := context.Background()
			f.create("k", "Merge facts")
			item := f.item(1)
			item.PRNumber, item.PRHead, item.State = qaPR(), "head", "proposed"
			merge := "merged-commit"
			if row.missing {
				merge = ""
			}
			recorder := &recordedGitHub{routes: map[string]func(http.ResponseWriter){
				"GET /repos/o/r/pulls/42": answer(http.StatusOK, map[string]any{
					"number": 42, "state": "closed", "merged_at": todoTestNow, "merge_commit_sha": merge,
					"head": map[string]string{"ref": "smithers/merge-facts", "sha": "head"},
				}),
				"GET /repos/o/r/compare/main...merged-commit": answer(row.status, map[string]any{"status": "diverged", "ahead_by": row.ahead}),
			}}
			f.service.github = stateFixtureGitHub{recorder.api(t)}
			stack, err := db.New(f.pool).GetMythicalStack(ctx, f.repoID)
			require.NoError(t, err)
			step := &mythicalItemStep{s: f.service, q: db.New(f.pool), r: &mythicalRun{row: stack}, now: todoTestNow}
			next, err := step.follow(ctx, item)
			require.NoError(t, err)
			if row.status == http.StatusOK && row.ahead == 0 && !row.missing {
				require.NotNil(t, next)
				require.Equal(t, "landed", next.State)
				require.Equal(t, "merged-commit", next.PRMergeCommit)
			} else if next != nil {
				require.NotEqual(t, "landed", next.State, "unknown main reachability cannot count as a merge")
				require.Empty(t, next.PRMergeCommit)
			}
			if row.missing || row.status != http.StatusOK || row.ahead != 0 {
				pending, _, err := step.advance(ctx, item)
				require.NoError(t, err)
				require.NotNil(t, pending, "pending merge must bypass the ordinary review gate")
				require.Equal(t, "proposed", pending.State)
				require.Empty(t, pending.PRMergeCommit)
				require.Nil(t, mythicalChecksOf(*pending).Review)
			}
			require.Equal(t, string(TodoQueued), f.todo(1).State, "follow only returns facts; its caller owns the write")
		})
	}
}

func TestTodoStatePollingReopenPreservesBranchPostgres(t *testing.T) {
	for _, age := range []time.Duration{24 * time.Hour, todoReopenWindow, todoReopenWindow + time.Second} {
		t.Run(age.String(), func(t *testing.T) {
			f := newTodoFixture(t)
			ctx := context.Background()
			f.service.now = func() time.Time { return todoTestNow }
			f.todos.now = f.service.now
			view := f.create("poll-reopen", "Reopen")
			item := f.item(1)
			item.State, item.PRNumber, item.PRState, item.PRHead = "rejected", qaPR(), "closed", "captured-head"
			item.ProposalRound = 3
			_, err := f.service.saveItem(ctx, item)
			require.NoError(t, err)
			_, err = f.pool.Exec(ctx, `UPDATE todos SET dropped_at=$1 WHERE number=1`, todoTestNow.Add(-age))
			require.NoError(t, err)
			_, err = f.pool.Exec(ctx, `UPDATE todos SET github_branch='smithers/custom-r3' WHERE branch_id=$1`, view.Branch.ID)
			require.NoError(t, err)
			before, count := f.todo(1), len(f.events(1))
			recorder := &recordedGitHub{routes: map[string]func(http.ResponseWriter){
				"GET /repos/o/r/pulls/42": answer(http.StatusOK, map[string]any{"number": 42, "state": "open", "head": map[string]string{"ref": "smithers/custom-r3", "sha": "captured-head"}}),
			}}
			f.service.github = stateFixtureGitHub{recorder.api(t)}
			f.service.markBackfill(f.repoID)
			stack, err := db.New(f.pool).GetMythicalStack(ctx, f.repoID)
			require.NoError(t, err)
			f.service.advanceItems(ctx, &mythicalRun{row: stack})
			if age > todoReopenWindow {
				require.Equal(t, before, f.todo(1))
				require.Equal(t, "rejected", f.item(1).State)
			} else {
				require.Equal(t, string(TodoInReview), f.todo(1).State)
				require.Equal(t, "proposed", f.item(1).State)
				require.Equal(t, before.ID, f.todo(1).ID)
				require.Equal(t, "captured-head", f.item(1).PRHead)
				require.Equal(t, int64(0), mythicalChecksOf(f.item(1)).Launches)
				require.Len(t, f.events(1), count+1)
				f.service.advanceItems(ctx, &mythicalRun{row: stack})
				require.Len(t, f.events(1), count+1)
				// Later polling still follows GitHub, but reopening alone is
				// not input that authorizes another run on the accepted head.
				f.service.now = func() time.Time { return todoTestNow.Add(2 * mythicalPullPollEvery) }
				f.service.advanceItems(ctx, &mythicalRun{row: stack})
				require.Len(t, f.events(1), count+1)
				latest := f.item(1)
				step := &mythicalItemStep{s: f.service, q: db.New(f.pool), r: &mythicalRun{row: stack}, now: f.service.now()}
				gated, launched, err := step.gate(ctx, latest)
				require.NoError(t, err)
				require.NotNil(t, gated, "reopened accepted head bypasses automatic run admission")
				require.False(t, launched)
				require.Equal(t, latest, *gated)
			}
			name, err := (&mythicalItemStep{s: f.service, q: db.New(f.pool)}).branch(ctx, f.item(1))
			require.NoError(t, err)
			require.Equal(t, "smithers/custom-r3", name, "recorded full branch never gets another suffix")
			require.Equal(t, 1, f.count("todos"))
			require.Equal(t, 1, f.count("todos"))
			for _, call := range recorder.calls {
				require.Contains(t, call, "GET ")
			}
		})
	}
}

func TestTodoStatePollingOpenPRLeavesExecutionHeldPostgres(t *testing.T) {
	for _, state := range []TodoState{TodoNeedsYou, TodoPaused} {
		t.Run(string(state), func(t *testing.T) {
			f := newTodoFixture(t)
			ctx := context.Background()
			f.create("hold", "Held work")
			_, err := f.pool.Exec(ctx, `UPDATE mythical_items SET state='proposed', pr_number=42, pr_state='open', pr_head='captured', candidate_base='old-tip', next_attempt_at=now()+interval '1 hour', paused_at=CASE WHEN $1='paused' THEN now() END WHERE todo_id=(SELECT id FROM todos WHERE number=1)`, string(state))
			require.NoError(t, err)
			_, err = f.pool.Exec(ctx, `UPDATE todos SET state=$1::text, needs_you=CASE WHEN $1::text='needs_you' THEN '{"kind":"question"}'::jsonb END WHERE number=1`, string(state))
			require.NoError(t, err)
			recorder := &recordedGitHub{routes: map[string]func(http.ResponseWriter){
				"GET /repos/o/r/pulls/42": answer(http.StatusOK, map[string]any{"number": 42, "state": "open", "mergeable_state": "behind", "head": map[string]string{"sha": "outside-head"}}),
			}}
			f.service.github = stateFixtureGitHub{recorder.api(t)}
			f.service.markBackfill(f.repoID)
			before, todo := f.item(1), f.todo(1)
			stack, err := db.New(f.pool).GetMythicalStack(ctx, f.repoID)
			require.NoError(t, err)
			f.service.advanceItems(ctx, &mythicalRun{row: stack})
			require.Equal(t, before, f.item(1))
			require.Equal(t, todo, f.todo(1))
			require.Len(t, recorder.calls, 1)
			require.Contains(t, recorder.calls[0], "GET /repos/o/r/pulls/42 ")
			require.Len(t, f.events(1), 1)
		})
	}
}

func TestTodoStateExternalCloseReachesHeldAndFailedPostgres(t *testing.T) {
	// One isolated database; each source state has its own TODO and branch.
	f := newTodoFixture(t)
	ctx := context.Background()
	recorder := &recordedGitHub{routes: map[string]func(http.ResponseWriter){
		"GET /repos/o/r/pulls/42": answer(http.StatusOK, map[string]any{"number": 42, "state": "closed", "head": map[string]string{"sha": "head"}}),
	}}
	f.service.github = stateFixtureGitHub{recorder.api(t)}
	f.service.markBackfill(f.repoID)
	for i, state := range []TodoState{TodoNeedsYou, TodoPaused, TodoFailed} {
		t.Run(string(state), func(t *testing.T) {
			n := int64(i + 1)
			f.create(string(state), string(state))
			item := f.item(n)
			_, err := f.pool.Exec(ctx, `UPDATE mythical_items SET state=$1,pr_number=42,pr_state='open',pr_head='head',paused_at=CASE WHEN $2='paused' THEN now() END WHERE id=$3`, map[TodoState]string{TodoNeedsYou: "running", TodoPaused: "running", TodoFailed: "blocked"}[state], string(state), item.ID)
			require.NoError(t, err)
			_, err = f.pool.Exec(ctx, `UPDATE todos SET state=$1::text,needs_you=CASE WHEN $1::text='needs_you' THEN '{"kind":"question"}'::jsonb END WHERE number=$2`, string(state), n)
			require.NoError(t, err)
			before := f.todo(n)
			stack, err := db.New(f.pool).GetMythicalStack(ctx, f.repoID)
			require.NoError(t, err)
			f.service.advanceItems(ctx, &mythicalRun{row: stack})
			require.Equal(t, "rejected", f.item(n).State)
			require.Equal(t, string(TodoDropped), f.todo(n).State)
			require.Equal(t, before.ID, f.todo(n).ID)
			require.Nil(t, f.todo(n).NeedsYou)
			require.False(t, f.item(n).PausedAt.Valid)
			events := f.events(n)
			require.Len(t, events, 2)
			require.Equal(t, string(TodoPRClosed), events[1].Kind)
			require.Equal(t, string(state), events[1].FromState.String)
			require.Len(t, f.projections(ProjectionTopicTodo(n)), 2)
		})
	}
	for _, call := range recorder.calls {
		require.Contains(t, call, "GET ")
	}
}

// Real PostgreSQL, GitHub HTTP client and dispatcher storage. The lane
// adapter is a deletion spy: exercising real VM deletion would endanger
// unrelated workers and cannot improve this ownership-boundary assertion.
func TestTodoStatePendingGitHubFactsPreserveActiveLanePostgres(t *testing.T) {
	f := newTodoFixture(t)
	ctx := context.Background()
	type fact struct {
		name          string
		pullStatus    int
		compareStatus int
		ahead         int
		confirmed     bool
	}
	cases := []fact{{"main pending", http.StatusOK, http.StatusOK, 1, false}, {"main unavailable", http.StatusOK, http.StatusBadGateway, 0, false}, {"pull unavailable", http.StatusBadGateway, http.StatusOK, 0, false}, {"confirmed", http.StatusOK, http.StatusOK, 0, true}}
	index := 0
	for _, state := range []TodoState{TodoWorking, TodoPaused, TodoNeedsYou} {
		for _, row := range cases {
			t.Run(string(state)+"/"+row.name, func(t *testing.T) {
				index++
				f.repoID = f.repository(fmt.Sprintf("lane-%d", index))
				view := f.create("lane", "Active lane")
				item := f.item(view.N)
				workspace := fmt.Sprintf("bound-lane-%d", index)
				_, err := f.pool.Exec(ctx, `UPDATE mythical_items SET state='running', workspace_id=$1,lane=0,pr_number=42,pr_state='open',pr_head='head',paused_at=CASE WHEN $2='paused' THEN now() END WHERE id=$3`, workspace, string(state), item.ID)
				require.NoError(t, err)
				_, err = f.pool.Exec(ctx, `UPDATE todos SET state=$1::text,needs_you=CASE WHEN $1::text='needs_you' THEN '{"kind":"question"}'::jsonb END WHERE id=$2`, string(state), f.todo(view.N).ID)
				require.NoError(t, err)
				item = f.item(view.N)
				_, bound, err := db.New(f.pool).BindMythicalLane(ctx, db.MythicalLane{WorkspaceID: workspace, RepositoryID: f.repoID, ItemID: item.ID, Name: workspace})
				require.NoError(t, err)
				require.True(t, bound)
				lanes := &fakeMythicalLanes{}
				f.service.lanes = lanes
				store, scope, receipt := todoStorageDispatch(t, f, item)
				recorder := &recordedGitHub{routes: map[string]func(http.ResponseWriter){
					"GET /repos/o/r/pulls/42":                     answer(row.pullStatus, map[string]any{"number": 42, "state": "closed", "merged_at": todoTestNow, "merge_commit_sha": "merged-commit", "head": map[string]string{"sha": "head"}}),
					"GET /repos/o/r/compare/main...merged-commit": answer(row.compareStatus, map[string]any{"ahead_by": row.ahead}),
				}}
				f.service.github = stateFixtureGitHub{recorder.api(t)}
				f.service.markBackfill(f.repoID)
				stack, err := db.New(f.pool).GetMythicalStack(ctx, f.repoID)
				require.NoError(t, err)
				f.service.advanceItems(ctx, &mythicalRun{row: stack})
				operation, err := store.Get(ctx, scope, receipt.OperationID)
				require.NoError(t, err)
				lane, err := db.New(f.pool).GetMythicalLane(ctx, workspace)
				require.NoError(t, err)
				if row.confirmed {
					require.Equal(t, "landed", f.item(view.N).State)
					require.Empty(t, f.item(view.N).WorkspaceID)
					require.Equal(t, []string{workspace}, lanes.deleted)
					require.True(t, lane.RetiredAt.Valid)
					require.True(t, operation.CancellationRequested)
				} else {
					require.Equal(t, workspace, f.item(view.N).WorkspaceID)
					require.Empty(t, lanes.deleted)
					require.False(t, lane.RetiredAt.Valid)
					require.False(t, operation.CancellationRequested)
					require.Equal(t, string(state), f.todo(view.N).State)
				}
			})
		}
	}
}
