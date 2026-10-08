package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

type summaryArchiveHost struct {
	archiveHost
	monitor json.RawMessage
}

func (h *summaryArchiveHost) Monitor(context.Context, flowruntime.Target, string, *int64) (json.RawMessage, error) {
	return h.monitor, nil
}

// Native browser coverage qualifies the producer. This SQL integration uses a
// literal retained monitor to exercise rollback and stale-result races without
// changing a real native run's journal or deriving expected text from its fold.
func TestMonitorSummarySourcePostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	ctx := f.ctx
	_, err := f.pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, f.repoID, f.owner.ID)
	require.NoError(t, err)
	store, err := jobs.NewStore(f.pool)
	require.NoError(t, err)
	scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", f.repoID), PrincipalID: fmt.Sprintf("user:%d", f.owner.ID)}
	_, err = store.Admit(ctx, jobs.Admission{Scope: scope, Operation: flowdispatch.OperationLaunch, RequestID: "summary-source", Payload: json.RawMessage(`{}`), AuthorizationContext: json.RawMessage(`{}`), EffectPolicy: jobs.EffectReconcile})
	require.NoError(t, err)
	claim, err := store.Claim(ctx, "summary-source", time.Minute)
	require.NoError(t, err)
	cp := flowdispatch.RuntimeCheckpoint{RunID: "run-1", FlowID: "todo", Target: flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, WorkspaceID: "lane-1"}}
	raw, err := json.Marshal(cp)
	require.NoError(t, err)
	_, err = store.BeginExternal(ctx, claim, json.RawMessage(`{"kind":"launching"}`))
	require.NoError(t, err)
	require.NoError(t, store.Park(ctx, claim, raw, time.Hour))
	require.NoError(t, f.q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "agent:coding", Value: json.RawMessage(`{"protocol":"openai-chat","modelId":"test-fast","credential":"TEST_KEY"}`)}))
	monitor := strings.Replace(archivedMonitorJSON, `"phases":[]`, `"phases":[{"title":"Ran checks · 2 failed","tone":"fail","cells":[{"label":"Read retry.ts","output":"literal output"}]}]`, 1)
	_, err = f.pool.Exec(ctx, `INSERT INTO run_archives(repository_id,workspace_id,run_id,flow_id,status,summary,tree,monitor,inspection_until) VALUES($1,'lane-1','run-1','todo','completed','{}','[]',$2,clock_timestamp()+interval '5 minutes')`, f.repoID, monitor)
	require.NoError(t, err)
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	summaries := &services.ConversationSummaries{Pool: f.pool, Jobs: store, RunSource: monitorSummarySource{}, Model: func(callCtx context.Context, owner, repo int64, body json.RawMessage) (io.ReadCloser, error) {
		require.Equal(t, f.owner.ID, owner)
		require.Equal(t, f.repoID, repo)
		require.Contains(t, string(body), "Ran checks · 2 failed")
		require.Contains(t, string(body), "Read retry.ts")
		entered <- struct{}{}
		select {
		case <-release:
		case <-callCtx.Done():
			return nil, callCtx.Err()
		}
		return io.NopCloser(strings.NewReader("{\"type\":\"delta\",\"kind\":\"text\",\"text\":\"{\\\"phase:0\\\":\\\"Literal phase summary\\\",\\\"cell:0\\\":\\\"Literal cell explanation\\\"}\"}\n{\"type\":\"done\"}\n")), nil
	}}
	admit := func(commit bool) {
		tx, e := f.pool.Begin(ctx)
		require.NoError(t, e)
		require.NoError(t, summaries.AdmitRun(ctx, tx, "lane-1:run-1", 1))
		if commit {
			require.NoError(t, tx.Commit(ctx))
		} else {
			require.NoError(t, tx.Rollback(ctx))
		}
	}
	admit(false)
	var count int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='run.summary'`).Scan(&count))
	require.Zero(t, count)
	source := monitorSummarySource{}
	tx, err := f.pool.Begin(ctx)
	require.NoError(t, err)
	run, err := source.ReadSummaryRun(ctx, tx, "lane-1:run-1", 1)
	require.NoError(t, err)
	require.Equal(t, int64(1), run.Revision)
	require.Equal(t, "Ran checks · 2 failed", run.Phases[0].Text)
	require.Equal(t, "Read retry.ts\nliteral output\n\n", run.Phases[0].Cells[0])
	_, err = source.ReadSummaryRun(ctx, tx, "lane-1:run-1", 2)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = source.ReadSummaryRun(ctx, tx, "foreign:run-1", 1)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	require.NoError(t, tx.Rollback(ctx))
	// Refuse admission in SQL and prove the native event, archive revision and
	// summary request share one rollback. Only the model/host wire is a fixture.
	_, err = f.pool.Exec(ctx, `CREATE FUNCTION reject_monitor_summary() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operation='run.summary' THEN RAISE EXCEPTION 'summary admission rejected'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_monitor_summary BEFORE INSERT ON product_job_requests FOR EACH ROW EXECUTE FUNCTION reject_monitor_summary()`)
	require.NoError(t, err)
	capture := &runArchive{pool: f.pool, host: &summaryArchiveHost{monitor: json.RawMessage(monitor)}, summaries: summaries}
	rejected := flowdispatch.ProjectionUpdate{Checkpoint: cp, Events: []flowruntime.Event{{RunID: "run-1", Sequence: 98, Kind: "control.run.completed", Payload: json.RawMessage(`{}`)}}}
	require.ErrorContains(t, capture.capture(ctx, cp, rejected), "summary admission rejected")
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM run_archive_events WHERE run_id='run-1'`).Scan(&count))
	require.Zero(t, count)
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='run.summary'`).Scan(&count))
	require.Zero(t, count)
	var revision int64
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT summary_revision FROM run_archives WHERE run_id='run-1'`).Scan(&revision))
	require.Equal(t, int64(1), revision)
	_, err = f.pool.Exec(ctx, `DROP TRIGGER reject_monitor_summary ON product_job_requests; DROP FUNCTION reject_monitor_summary()`)
	require.NoError(t, err)
	admit(true)
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='run.summary'`).Scan(&count))
	require.Equal(t, 1, count)
	// Jobs survive opening a new store. No in-memory queue or fake source serves them.
	restarted, err := jobs.NewStore(f.pool)
	require.NoError(t, err)
	workerCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- restarted.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: "native-summary-source", Capacity: 1, Lease: time.Minute, PollInterval: time.Millisecond, Operations: []string{services.RunSummaryOperation}}, summaries.Handle)
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("model not dispatched")
	}
	// A new native event without a successful capture invalidates this source.
	archive := &runArchive{pool: f.pool}
	require.NoError(t, archive.keep(ctx, flowdispatch.ProjectionUpdate{Checkpoint: cp, Events: []flowruntime.Event{{RunID: "run-1", Sequence: 99, Kind: "control.engine.event", Payload: json.RawMessage(`{"literal":"source advanced"}`)}}}))
	close(release)
	require.Eventually(t, func() bool {
		var n int
		return f.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='run.summary' AND state='completed'`).Scan(&n) == nil && n == 1
	}, 5*time.Second, 10*time.Millisecond)
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM run_summaries WHERE text<>''`).Scan(&count))
	require.Zero(t, count, "old source result must not publish")
	// Duplicate events don't advance the revision or restore an uncaptured source.
	tx, err = f.pool.Begin(ctx)
	require.NoError(t, err)
	_, err = source.ReadSummaryRun(ctx, tx, "lane-1:run-1", 1)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	require.NoError(t, tx.Rollback(ctx))
	cancel()
	require.NoError(t, <-done)
}
