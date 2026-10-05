package services

import (
	"context"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

func TestBackgroundRef(t *testing.T) {
	for _, id := range []string{"", "0", "-1", "+1", "01", " 1", "1/2", "flow-load:0", "flow-load:01", "9223372036854775808"} {
		_, _, err := backgroundRef(id)
		require.Error(t, err, id)
	}
	for _, id := range []string{"1", "9223372036854775807", "flow-load:3"} {
		n, native, err := backgroundRef(id)
		require.NoError(t, err)
		require.Positive(t, n)
		require.Equal(t, id == "flow-load:3", native)
	}
}
func FuzzBackgroundRef(f *testing.F) {
	for _, id := range []string{"1", "flow-load:3", "", "-1", "+1", "01", "999999999999999999999999"} {
		f.Add(id)
	}
	f.Fuzz(func(t *testing.T, id string) {
		n, native, err := backgroundRef(id)
		if err == nil {
			require.Positive(t, n)
			want := strconv.FormatInt(n, 10)
			if native {
				want = "flow-load:" + want
			}
			require.Equal(t, want, id)
		}
	})
}
func TestBackgroundRunsInvalidAndDisabled(t *testing.T) {
	svc := &BackgroundRunService{}
	for _, pair := range [][2]string{{"1", "unknown"}, {"bad", "retry"}, {"flow-load:1", "retry"}, {"1", "retry"}} {
		_, err := svc.Control(context.Background(), 1, 1, pair[0], pair[1])
		require.Error(t, err)
	}
}

// Real PostgreSQL and git: failed flow-load's own durable worker admits one
// new run, and duplicate requests survive a fresh service instance.
func TestBackgroundRunsFlowLoadRetryDismiss(t *testing.T) {
	o := newMythicalOrchestration(t)
	ctx := context.Background()
	q := db.New(o.pool)
	o.lanes.provision = func(id string) {
		_, err := o.pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,name,status) VALUES($1,$2,$3,$4,'running')`, id, o.repoID, o.userID, id)
		require.NoError(t, err)
	}
	o.service.SetFlowLoad(true)
	o.wake()
	failLoad := func() {
		loads := o.flowLoads()
		require.NotEmpty(t, loads)
		o.projectLoad(loads[len(loads)-1], jobs.StateFailed, "run-failed", "bad import")
		o.wake()
		_, err := o.pool.Exec(ctx, `UPDATE flow_loads SET next_attempt_at=NOW() WHERE repository_id=$1`, o.repoID)
		require.NoError(t, err)
	}
	for range 3 {
		failLoad()
		o.wake()
	}
	row, err := q.GetFlowLoad(ctx, o.repoID)
	require.NoError(t, err)
	require.Equal(t, int32(3), row.Attempt)
	require.NotEmpty(t, row.Error)
	svc := &BackgroundRunService{Queries: q, Mythical: o.service}
	list, err := svc.List(ctx, o.repoID)
	require.NoError(t, err)
	require.Len(t, list, 1)
	id := list[0].ID
	_, err = svc.Control(ctx, o.repoID, o.userID, id, "retry")
	require.NoError(t, err)
	_, err = svc.Control(ctx, o.repoID, o.userID, id, "retry")
	require.NoError(t, err)
	before := len(o.flowLoads())
	o.wake()
	require.Len(t, o.flowLoads(), before+1)
	reloaded := &BackgroundRunService{Queries: q, Mythical: o.service}
	_, err = reloaded.Control(ctx, o.repoID, o.userID, id, "retry")
	require.NoError(t, err)
	o.wake()
	require.Len(t, o.flowLoads(), before+1)
	// Cancellation is a failure with the same retry budget, never a success.
	loads := o.flowLoads()
	o.projectLoad(loads[len(loads)-1], jobs.StateCancelled, "cancelled", "cancelled")
	o.wake()
	for range 2 {
		_, err = o.pool.Exec(ctx, `UPDATE flow_loads SET next_attempt_at=NOW() WHERE repository_id=$1`, o.repoID)
		require.NoError(t, err)
		o.wake()
		failLoad()
		o.wake()
	}
	list, err = svc.List(ctx, o.repoID)
	require.NoError(t, err)
	require.Len(t, list, 1)
	dismissID := list[0].ID
	_, err = svc.Control(ctx, o.repoID, o.userID, dismissID, "dismiss")
	require.NoError(t, err)
	_, err = svc.Control(ctx, o.repoID, o.userID, dismissID, "dismiss")
	require.NoError(t, err)
	list, err = reloaded.List(ctx, o.repoID)
	require.NoError(t, err)
	require.Empty(t, list)
	var by int64
	var at bool
	require.NoError(t, o.pool.QueryRow(ctx, `SELECT dismissed_by,dismissed_at IS NOT NULL FROM flow_loads WHERE repository_id=$1`, o.repoID).Scan(&by, &at))
	require.Equal(t, o.userID, by)
	require.True(t, at)
	_, err = svc.Control(ctx, o.repoID, o.userID, dismissID, "retry")
	require.Error(t, err)
	_, err = svc.Control(ctx, o.repoID+100, o.userID, dismissID, "retry")
	require.Error(t, err)
}

// Legacy rerun still reads config at the original commit and creates its rows
// transactionally. Concurrent Home presses return one durable child id.
func TestBackgroundRunsWorkflowAtomicRetry(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	q := db.New(pool)
	var user, repo, def, run int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES('background','background') RETURNING id`).Scan(&user))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name,default_bookmark) VALUES($1,'repo','repo','main') RETURNING id`, user).Scan(&repo))
	config := `{"on":{"push":{}},"jobs":{"build":{"steps":[{"run":"echo ok"}]}}}`
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workflow_definitions(repository_id,name,path,config,is_active) VALUES($1,'wiki','.smithers/workflows/wiki.tsx',$2,true) RETURNING id`, repo, []byte(config)).Scan(&def))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workflow_runs(repository_id,workflow_definition_id,status,trigger_event,trigger_ref,trigger_commit_sha,dispatch_inputs) VALUES($1,$2,'failure','push','main',$3,'{"mode":"original"}') RETURNING id`, repo, def, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").Scan(&run))
	loader := backgroundDefinitionLoader{workflowLoadResultForPath(".smithers/workflows/wiki.tsx", config)}
	runner := NewWorkflowRunService(q, WithWorkflowRunDefinitionCommitLoader(loader))
	svc := &BackgroundRunService{Queries: q, Runner: runner}
	id := strconv.FormatInt(run, 10)
	const callers = 8
	var wg sync.WaitGroup
	results := make(chan BackgroundRunReceipt, callers)
	errs := make(chan error, callers)
	for range callers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			receipt, err := svc.Control(ctx, repo, user, id, "retry")
			results <- receipt
			errs <- err
		}()
	}
	wg.Wait()
	close(results)
	close(errs)
	for err := range errs {
		require.NoError(t, err)
	}
	child := ""
	for receipt := range results {
		if child == "" {
			child = receipt.RetryID
		}
		require.Equal(t, child, receipt.RetryID)
	}
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workflow_runs WHERE repository_id=$1`, repo).Scan(&count))
	require.Equal(t, 2, count)
	var inputs string
	require.NoError(t, pool.QueryRow(ctx, `SELECT dispatch_inputs::text FROM workflow_runs WHERE id=$1`, child).Scan(&inputs))
	require.JSONEq(t, `{"mode":"original"}`, inputs)
	_, err := svc.Control(ctx, repo, user, id, "dismiss")
	require.Error(t, err)
	// The child remains retryable after it fails; the original is not listed.
	_, err = pool.Exec(ctx, `UPDATE workflow_runs SET status='failure' WHERE id=$1`, child)
	require.NoError(t, err)
	list, err := svc.List(ctx, repo)
	require.NoError(t, err)
	require.Len(t, list, 1)
	require.Equal(t, child, list[0].ID)
	_, err = svc.Control(ctx, repo, user, child, "dismiss")
	require.NoError(t, err)
	list, err = svc.List(ctx, repo)
	require.NoError(t, err)
	require.Empty(t, list)
	_, err = svc.Control(ctx, repo, user, child, "retry")
	require.Error(t, err)
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	_, err = svc.Control(cancelled, repo, user, id, "retry")
	require.Error(t, err)
}

type backgroundDefinitionLoader struct{ result WorkflowLoadResult }

func (l backgroundDefinitionLoader) LoadDefinitionsFromCommit(context.Context, int64, string) (WorkflowLoadResult, error) {
	return l.result, nil
}

func TestBackgroundRunsFailedVersionIsListedAndRetryLoadsAgain(t *testing.T) {
	o := newMythicalOrchestration(t)
	ctx := context.Background()
	q := db.New(o.pool)
	o.lanes.provision = func(id string) {
		_, err := o.pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,name,status) VALUES($1,$2,$3,$4,'running')`, id, o.repoID, o.userID, id)
		require.NoError(t, err)
	}
	o.service.SetFlowLoad(true)
	stack := o.wake()
	loads := o.flowLoads()
	require.Len(t, loads, 1)
	o.projectLoad(loads[0], jobs.StateCompleted, "load-failed-import", flowLoadOutput(stack.LandedMain, FlowLoadVersion{Name: "todo", Path: "flows/todo/flow.ts", Digest: strings.Repeat("a", 64), Status: "failed", Error: "flows/todo/flow.ts:2: syntax error"}))
	o.wake()
	svc := &BackgroundRunService{Queries: q, Mythical: o.service}
	list, err := svc.List(ctx, o.repoID)
	require.NoError(t, err)
	require.Len(t, list, 1)
	require.Contains(t, list[0].Detail, "syntax error")
	status, err := svc.Status(ctx, o.repoID, list[0].ID)
	require.NoError(t, err)
	require.Equal(t, "failed", status.State)
	_, err = svc.Control(ctx, o.repoID, o.userID, list[0].ID, "retry")
	require.NoError(t, err)
	o.wake()
	require.Len(t, o.flowLoads(), 2)
}
