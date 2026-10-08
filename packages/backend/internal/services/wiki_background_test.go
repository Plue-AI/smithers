package services

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

type wikiSandboxedMachine struct{}

func (wikiSandboxedMachine) Isolation() workspace.IsolationLevel { return workspace.IsolationSandboxed }

// C-J8-06 at the service boundary: each generated-page refresh is a Home
// background run. A failed refresh keeps Retry (one new refresh of main by
// the same worker, whatever the number of presses) and Dismiss (shared,
// record kept); a later refresh supersedes an earlier one.
func TestMythicalWikiRefreshRunsRetryAndDismissOnHome(t *testing.T) {
	o := newMythicalOrchestration(t)
	o.service.SetWiki(&fakeWikiStore{pages: map[string]WikiPageResponse{}})
	ctx := context.Background()
	pool, ok := o.pool.(*pgxpool.Pool)
	require.True(t, ok)
	o.service.SetHomeBackground(&HomeBackground{Pool: pool, Invoker: &InvokedFlowService{dispatcher: o.launcher},
		Billing: NewUnlimitedBillingPolicy(), Machine: wikiSandboxedMachine{}})
	type run struct {
		ID     int64
		Status string
		Input  string
		By     *int64
	}
	runs := func() []run {
		t.Helper()
		rows, err := o.pool.Query(ctx, `SELECT r.id,r.status,COALESCE(r.dispatch_inputs::text,''),r.dismissed_by FROM workflow_runs r
 JOIN workflow_definitions d ON d.id=r.workflow_definition_id WHERE r.repository_id=$1 AND d.name='Refresh wiki' AND d.path='flows/coding/wiki/flow.ts' AND r.execution_plane='flow' ORDER BY r.id`, o.repoID)
		require.NoError(t, err)
		defer rows.Close()
		result := []run{}
		for rows.Next() {
			var r run
			require.NoError(t, rows.Scan(&r.ID, &r.Status, &r.Input, &r.By))
			result = append(result, r)
		}
		return result
	}
	home := func() []map[string]any {
		t.Helper()
		listed, err := o.service.BackgroundRuns(ctx, o.repoID)
		require.NoError(t, err)
		return listed
	}
	control := func(id int64, op, key string) (HomeBackgroundReceipt, error) {
		return o.service.homeBackground.Control(ctx, o.repoID, o.userID, id, op, key)
	}
	retryDismiss := []any{map[string]any{"tag": "background.retry", "label": "Retry"}, map[string]any{"tag": "background.dismiss", "label": "Dismiss"}}

	o.declareWiki()
	o.wake()
	first := o.launcher.last(mythicalWikiFlow)
	require.NotEmpty(t, first.RequestID)
	admitted := runs()
	require.Len(t, admitted, 1)
	require.Equal(t, "queued", admitted[0].Status)
	require.JSONEq(t, string(first.Payload), admitted[0].Input, "the record holds the launch's input")
	require.Equal(t, []map[string]any{{"id": fmt.Sprint(admitted[0].ID), "title": "Refresh wiki", "state": "queued", "actions": []any{}}}, home())

	o.project(first, jobs.StateRunning, "wiki-run-1", "")
	require.Equal(t, "running", runs()[0].Status)
	o.project(first, jobs.StateFailed, "wiki-run-1", "")
	o.wake()
	require.Equal(t, "failed", o.wiki().State)
	failed := runs()[0]
	require.Equal(t, "failure", failed.Status)
	require.Equal(t, []map[string]any{{"id": fmt.Sprint(failed.ID), "title": "Refresh wiki", "state": "failed", "actions": retryDismiss, "detail": o.wiki().Error}}, home())

	// Two members press Retry: one refresh of main, one new record.
	one, err := control(failed.ID, "retry", "retry-one")
	require.NoError(t, err)
	two, err := control(failed.ID, "retry", "retry-two")
	require.NoError(t, err)
	require.Equal(t, "accepted", one.State)
	require.NotEqual(t, failed.ID, one.RunID)
	require.Equal(t, one, two)
	require.True(t, o.wiki().Requested)
	require.Equal(t, []map[string]any{{"id": fmt.Sprint(one.RunID), "title": "Refresh wiki", "state": "queued", "actions": []any{}}}, home(), "the retry supersedes the failure on Home")
	o.wake()
	second := o.launcher.last(mythicalWikiFlow)
	require.NotEqual(t, first.RequestID, second.RequestID)
	retried := runs()
	require.Len(t, retried, 2)
	require.Equal(t, run{ID: failed.ID, Status: "failure", Input: failed.Input}, retried[0], "the failed record stays readable")
	require.Equal(t, one.RunID, retried[1].ID, "the worker adopts the record Retry queued")
	require.JSONEq(t, string(second.Payload), retried[1].Input)
	// Main did not move: the retry refreshes the same commit. Only its
	// machine's source ref differs.
	var failedInput, retriedInput struct {
		Base struct {
			CommitID string `json:"commitId"`
		} `json:"base"`
	}
	require.NoError(t, json.Unmarshal([]byte(failed.Input), &failedInput))
	require.NoError(t, json.Unmarshal([]byte(retried[1].Input), &retriedInput))
	require.NotEmpty(t, failedInput.Base.CommitID)
	require.Equal(t, failedInput.Base.CommitID, retriedInput.Base.CommitID)

	body := "# Runtime\n\nExplained behavior.\n\n[.smithers/coding-project.json:1](../sources/.smithers/coding-project.json#L1)\n"
	o.project(second, jobs.StateCompleted, "wiki-run-2", wikiResult(o.wiki().BaseCommit, `null`, "runtime", body))
	o.wake()
	require.Equal(t, "idle", o.wiki().State, o.wiki().Error)
	require.Equal(t, "success", runs()[1].Status)
	require.Empty(t, home(), "a published refresh leaves Home")
	_, err = control(failed.ID, "retry", "retry-stale")
	require.ErrorContains(t, err, "A later wiki refresh replaced this run")

	// The next failure is dismissed once for every member; its record stays.
	require.NoError(t, o.service.RequestWiki(ctx, o.repoID))
	o.wake()
	third := o.launcher.last(mythicalWikiFlow)
	o.project(third, jobs.StateFailed, "wiki-run-3", "")
	o.wake()
	last := runs()[2]
	require.Equal(t, "failure", last.Status)

	// Without the refresh worker's providers the failure offers Dismiss
	// only, and a direct Retry refuses without a write.
	launcher := o.service.launcher
	o.service.launcher = nil
	require.Equal(t, []any{map[string]any{"tag": "background.dismiss", "label": "Dismiss"}}, home()[0]["actions"])
	_, err = control(last.ID, "retry", "retry-dark")
	require.ErrorContains(t, err, "Isolated Retry unavailable")
	require.Len(t, runs(), 3)
	require.False(t, o.wiki().Requested)
	o.service.launcher = launcher

	dismissed, err := control(last.ID, "dismiss", "")
	require.NoError(t, err)
	require.Equal(t, HomeBackgroundReceipt{State: "dismissed", RunID: last.ID}, dismissed)
	require.Empty(t, home())
	kept := runs()[2]
	require.Equal(t, "failure", kept.Status)
	require.NotNil(t, kept.By)
	require.Equal(t, o.userID, *kept.By)
}
