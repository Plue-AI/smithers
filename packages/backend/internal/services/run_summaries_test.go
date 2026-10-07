package services_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture/seed"
	"github.com/stretchr/testify/require"
)

// T-FLW-07's deterministic event-to-phase source is not composed yet. This fake
// covers only its summary contract; it is not C-J11 or install journey evidence.
type summaryRunSource struct {
	mu  sync.Mutex
	run services.SummaryRun
}

func (s *summaryRunSource) ReadSummaryRun(_ context.Context, _ pgx.Tx, id string, attempt int64) (services.SummaryRun, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if id != s.run.RunID || attempt != s.run.Attempt {
		return services.SummaryRun{}, pgx.ErrNoRows
	}
	return s.run, nil
}
func (s *summaryRunSource) change(fn func(*services.SummaryRun)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	fn(&s.run)
}

func TestRunSummariesContractDurabilityAndFences(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	owner, err := seed.CreateUser(ctx, pool, "run-summary-owner")
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner, Valid: true}, Name: "summary", LowerName: "summary", DefaultBookmark: "main"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin');`, repo.ID, owner)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner)
	require.NoError(t, err)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: json.RawMessage(fmt.Sprintf(`{"repository_id":%d,"owner_login":"run-summary-owner","repository_name":"summary"}`, repo.ID))}))
	jobsStore, err := jobs.NewStore(pool)
	require.NoError(t, err)
	source := &summaryRunSource{run: services.SummaryRun{RunID: "run", RepositoryID: repo.ID, OwnerID: owner, Attempt: 1, Revision: 1, InspectionUntil: time.Now().Add(time.Minute), Phases: []services.SummaryPhase{{Number: 0, Text: "Ran checks; rm -rf /; import repo/flow.ts", Cells: map[int]string{1: "Read retry.ts"}}}}}
	var calls atomic.Int64
	entered := make(chan struct{}, 2)
	release := make(chan struct{}, 2)
	summaries := &services.ConversationSummaries{Pool: pool, Jobs: jobsStore, RunSource: source, Model: func(callCtx context.Context, user, repository int64, body json.RawMessage) (io.ReadCloser, error) {
		require.Equal(t, owner, user)
		require.Equal(t, repo.ID, repository)
		var request map[string]json.RawMessage
		require.NoError(t, json.Unmarshal(body, &request))
		require.JSONEq(t, `[]`, string(request["tools"]))
		require.Contains(t, string(body), "Read retry.ts")
		calls.Add(1)
		entered <- struct{}{}
		select {
		case <-release:
		case <-callCtx.Done():
			return nil, callCtx.Err()
		}
		values := `{"phase:0":"Checked retries","cell:1":"rm -rf /; import repo/flow.ts; tool()","cell:99":"not a recorded target"}`
		frame, _ := json.Marshal(map[string]string{"type": "delta", "kind": "text", "text": values})
		return io.NopCloser(strings.NewReader(string(frame) + "\n{\"type\":\"done\"}\n")), nil
	}}
	admit := func(commit bool) {
		tx, e := pool.Begin(ctx)
		require.NoError(t, e)
		require.NoError(t, summaries.AdmitRun(ctx, tx, "run", 1))
		if commit {
			require.NoError(t, tx.Commit(ctx))
		} else {
			require.NoError(t, tx.Rollback(ctx))
		}
	}
	count := func(table string) int {
		var n int
		require.NoError(t, pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&n))
		return n
	}
	// Missing model access does not create placeholders or durable jobs.
	admit(true)
	require.Zero(t, count("run_summaries"))
	require.Zero(t, count("product_job_requests"))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "agent:coding", Value: json.RawMessage(`{"protocol":"openai-chat","modelId":"test-fast","credential":"TEST_KEY"}`)}))
	modelPort := summaries.Model
	summaries.Model = nil
	admit(true)
	require.Zero(t, count("product_job_requests"))
	summaries.Model = modelPort
	summaries.RunSource = nil
	admit(true)
	require.Zero(t, count("product_job_requests"))
	summaries.RunSource = source
	source.change(func(run *services.SummaryRun) { run.RepositoryID = repo.ID + 1 })
	admit(true)
	require.Zero(t, count("product_job_requests"))
	source.change(func(run *services.SummaryRun) { run.RepositoryID = repo.ID })
	source.change(func(run *services.SummaryRun) { run.InspectionUntil = time.Now().Add(-time.Second) })
	admit(true)
	require.Zero(t, count("product_job_requests"))
	source.change(func(run *services.SummaryRun) { run.InspectionUntil = time.Now().Add(time.Minute) })
	_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=clock_timestamp() WHERE user_id=$1`, owner)
	require.NoError(t, err)
	admit(true)
	require.Zero(t, count("product_job_requests"))
	_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=NULL WHERE user_id=$1`, owner)
	require.NoError(t, err)
	admit(false)
	require.Zero(t, count("run_summaries"))
	require.Zero(t, count("product_job_requests"))
	admit(true)
	admit(true)
	require.Equal(t, 1, count("product_job_requests"))
	require.Equal(t, 1, count("run_summaries"))
	// Closing inspection before dispatch must not prevent same-revision backfill.
	source.change(func(run *services.SummaryRun) { run.InspectionUntil = time.Now().Add(-time.Second) })
	expiredCtx, expiredCancel := context.WithCancel(ctx)
	defer expiredCancel()
	expiredDone := make(chan error, 1)
	go func() {
		expiredDone <- jobsStore.RunWorker(expiredCtx, jobs.WorkerConfig{WorkerID: "run-summary-expired", Capacity: 1, Lease: time.Minute, PollInterval: time.Millisecond, Operations: []string{services.RunSummaryOperation}}, summaries.Handle)
	}()
	require.Eventually(t, func() bool {
		var pending int
		err := pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE state<>'completed'`).Scan(&pending)
		return err == nil && pending == 0
	}, 5*time.Second, 10*time.Millisecond)
	expiredCancel()
	require.NoError(t, <-expiredDone)
	require.Zero(t, calls.Load())
	source.change(func(run *services.SummaryRun) { run.InspectionUntil = time.Now().Add(time.Minute) })
	admit(true)
	require.Equal(t, 2, count("product_job_requests"), "reopening inspection backfills the unchanged source revision")
	// The restarted durable worker uses the same sealed model handler as entries.
	restarted, err := jobs.NewStore(pool)
	require.NoError(t, err)
	workerCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- restarted.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: "run-summary-contract", Capacity: 1, Lease: time.Minute, PollInterval: time.Millisecond, Operations: []string{services.RunSummaryOperation}}, summaries.Handle)
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("summary worker did not start")
	}
	source.change(func(run *services.SummaryRun) { run.Revision = 2 })
	release <- struct{}{}
	require.Eventually(t, func() bool {
		var pending int
		_ = pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE state NOT IN ('completed','failed','cancelled')`).Scan(&pending)
		return pending == 0
	}, 5*time.Second, 10*time.Millisecond)
	var text string
	var revision int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT text,rev FROM run_summaries WHERE target='phase:0'`).Scan(&text, &revision))
	require.Empty(t, text)
	require.Zero(t, revision, "a stale source cannot publish")
	admit(true)
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("current summary did not start")
	}
	release <- struct{}{}
	require.Eventually(t, func() bool {
		_ = pool.QueryRow(ctx, `SELECT rev FROM run_summaries WHERE target='phase:0'`).Scan(&revision)
		return revision == 2
	}, 5*time.Second, 10*time.Millisecond)
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	values, err := summaries.ReadRunSummaries(ctx, tx, "run", 1)
	require.NoError(t, err)
	require.Equal(t, map[string]string{"phase:0": "Checked retries", "cell:1": "rm -rf /; import repo/flow.ts; tool()"}, values)
	require.NoError(t, tx.Commit(ctx))
	// A member cannot forge a host summary job even with valid run facts.
	forgedScope := jobs.Scope{TenantID: fmt.Sprint(repo.ID), PrincipalID: fmt.Sprint(owner)}
	forged, err := jobsStore.Admit(ctx, jobs.Admission{Scope: forgedScope, Operation: services.RunSummaryOperation, RequestID: "forged-summary", Payload: json.RawMessage(fmt.Sprintf(`{"RunID":"run","RepositoryID":%d,"OwnerID":%d,"Attempt":1,"Revision":2,"Phase":0}`, repo.ID, owner)), EffectPolicy: jobs.EffectIdempotent})
	require.NoError(t, err)
	require.Eventually(t, func() bool {
		operation, err := jobsStore.Get(ctx, forgedScope, forged.OperationID)
		return err == nil && operation.State == jobs.StateFailed
	}, 5*time.Second, 10*time.Millisecond)
	admit(true)
	require.Equal(t, int64(2), calls.Load(), "a completed phase is not summarized twice")
	var pending *time.Time
	require.NoError(t, pool.QueryRow(ctx, `SELECT pending_since FROM run_summaries WHERE target='phase:0'`).Scan(&pending))
	require.Nil(t, pending, "a repeat admission does not mark a completed phase pending")
	cancel()
	require.NoError(t, <-done)
	// Missing provider preserves labels and cannot enqueue a replacement framework.
	summaries.RunSource = nil
	admit(true)
	require.Equal(t, 4, count("product_job_requests"))
	require.Equal(t, 2, count("run_summaries"))
	// A live phase uses the durable five-second debounce and thirty-second cap.
	summaries.RunSource = source
	source.change(func(run *services.SummaryRun) { run.Revision = 3; run.Phases[0].Live = true })
	admit(true)
	var after float64
	require.NoError(t, pool.QueryRow(ctx, `SELECT extract(epoch FROM d.next_attempt_at-clock_timestamp()) FROM product_job_dispatches d JOIN product_job_requests r ON r.id=d.operation_id WHERE r.payload->>'Revision'='3'`).Scan(&after))
	require.InDelta(t, 5, after, 0.5)
	_, err = pool.Exec(ctx, `UPDATE run_summaries SET pending_since=clock_timestamp()-interval '31 seconds' WHERE target='phase:0'`)
	require.NoError(t, err)
	source.change(func(run *services.SummaryRun) { run.Revision = 4 })
	admit(true)
	require.NoError(t, pool.QueryRow(ctx, `SELECT extract(epoch FROM d.next_attempt_at-clock_timestamp()) FROM product_job_dispatches d JOIN product_job_requests r ON r.id=d.operation_id WHERE r.payload->>'Revision'='4'`).Scan(&after))
	require.Less(t, after, 0.0, "continuous events cannot postpone the durable thirty-second deadline")
	summaries.Model = func(context.Context, int64, int64, json.RawMessage) (io.ReadCloser, error) {
		return nil, errors.New("controlled model failure")
	}
	retryCtx, retryCancel := context.WithCancel(ctx)
	defer retryCancel()
	retryDone := make(chan error, 1)
	go func() {
		retryDone <- restarted.RunWorker(retryCtx, jobs.WorkerConfig{WorkerID: "run-summary-retry", Capacity: 1, Lease: time.Minute, PollInterval: time.Millisecond, Operations: []string{services.RunSummaryOperation}}, summaries.Handle)
	}()
	require.Eventually(t, func() bool {
		err := pool.QueryRow(ctx, `SELECT extract(epoch FROM d.next_attempt_at-clock_timestamp()) FROM product_job_dispatches d JOIN product_job_requests r ON r.id=d.operation_id WHERE r.payload->>'Revision'='4'`).Scan(&after)
		return err == nil && after > 28 && after <= 30
	}, 5*time.Second, 10*time.Millisecond)
	require.NoError(t, pool.QueryRow(ctx, `SELECT text,rev FROM run_summaries WHERE target='phase:0'`).Scan(&text, &revision))
	require.Equal(t, "Checked retries", text)
	require.Equal(t, int64(2), revision)
	retryCancel()
	require.NoError(t, <-retryDone)

	// Revoking access after admission must allow same-revision backfill on return.
	source.change(func(run *services.SummaryRun) { run.Revision = 5; run.Phases[0].Live = false })
	admit(true)
	_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=clock_timestamp() WHERE repository_id=$1 AND user_id=$2`, repo.ID, owner)
	require.NoError(t, err)
	var resumedCalls atomic.Int64
	summaries.Model = func(context.Context, int64, int64, json.RawMessage) (io.ReadCloser, error) {
		resumedCalls.Add(1)
		return io.NopCloser(strings.NewReader("{\"type\":\"delta\",\"kind\":\"text\",\"text\":\"{\\\"phase:0\\\":\\\"Resumed checks\\\"}\"}\n{\"type\":\"done\"}\n")), nil
	}
	runUntil := func(worker string, done func() bool) {
		workerCtx, stop := context.WithCancel(ctx)
		defer stop()
		finished := make(chan error, 1)
		go func() {
			finished <- restarted.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: worker, Capacity: 1, Lease: time.Minute, PollInterval: time.Millisecond, Operations: []string{services.RunSummaryOperation}}, summaries.Handle)
		}()
		require.Eventually(t, done, 5*time.Second, 10*time.Millisecond)
		stop()
		require.NoError(t, <-finished)
	}
	runUntil("run-summary-suspended", func() bool {
		var pending int
		err := pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE payload->>'Revision'='5' AND state<>'completed'`).Scan(&pending)
		return err == nil && pending == 0
	})
	require.Zero(t, resumedCalls.Load())
	_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=NULL WHERE repository_id=$1 AND user_id=$2`, repo.ID, owner)
	require.NoError(t, err)
	admit(true)
	var requests int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE payload->>'Revision'='5'`).Scan(&requests))
	require.Equal(t, 2, requests, "restoring access must admit a fresh backfill")
	runUntil("run-summary-restored", func() bool {
		err := pool.QueryRow(ctx, `SELECT text,rev FROM run_summaries WHERE target='phase:0'`).Scan(&text, &revision)
		return err == nil && text == "Resumed checks" && revision == 5
	})
	require.Equal(t, int64(1), resumedCalls.Load())
}
