package services

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestBillingService_AgentRunAdmissionRejectsMissingTransaction(t *testing.T) {
	assert.Equal(t, 500, httpStatus(NewBillingService(billingCovNewQuerier(), nil, BillingServiceConfig{}).
		AuthorizeAgentRunCommitted(context.Background(), 91, nil)))
	called := false
	err := NewBillingService(billingCovNewQuerier(), nil, BillingServiceConfig{}).
		AuthorizeAgentRunCommitted(context.Background(), 91, func(context.Context, db.DBTX) error {
			called = true
			return nil
		})
	assert.Equal(t, 500, httpStatus(err))
	assert.False(t, called, "missing transaction support must never call the consuming write")
}

func TestBillingService_AgentRunAdmissionCountAndPlanBranches(t *testing.T) {
	for _, test := range []struct {
		name       string
		admissions int64
		countErr   error
		wantStatus int
	}{
		{name: "one slot remains"},
		{name: "cap reached", admissions: 1, wantStatus: 402},
		{name: "count fails closed", countErr: errors.New("count unavailable"), wantStatus: 500},
	} {
		t.Run(test.name, func(t *testing.T) {
			queries := billingCovNewQuerier()
			queries.usersByID[42] = db.User{ID: 42, Username: "agent-owner"}
			queries.reposByID[91] = db.Repository{ID: 91, UserID: pgtype.Int8{Int64: 42, Valid: true}}
			queries.countAgentRunAdmissionsByOwnerFn = func(_ context.Context, arg db.CountAgentRunAdmissionsByOwnerParams) (int64, error) {
				assert.Equal(t, BillingOwnerTypeUser, arg.OwnerType)
				assert.Equal(t, int64(42), arg.OwnerID)
				assert.True(t, arg.PeriodEnd.After(arg.PeriodStart))
				return test.admissions, test.countErr
			}
			service := NewBillingService(queries, nil, BillingServiceConfig{})
			plan := service.checkoutPlans[BillingOwnerTypeUser][BillingPlanFree]
			plan.Limits.AgentRuns = 1
			service.checkoutPlans[BillingOwnerTypeUser][BillingPlanFree] = plan
			err := service.authorizeAgentRunAdmission(context.Background(), 91)
			if test.wantStatus != 0 {
				assert.Equal(t, test.wantStatus, httpStatus(err))
			} else {
				require.NoError(t, err)
			}
		})
	}
}

type billingAgentTxStub struct {
	pgx.Tx
	execCalls     int
	execErrAt     int
	clockReads    int
	clockErr      error
	commitCalls   int
	commitErr     error
	rollbackCalls int
}

type billingAgentClockRow struct {
	when time.Time
	err  error
}

func (row billingAgentClockRow) Scan(dest ...any) error {
	if row.err != nil {
		return row.err
	}
	*dest[0].(*time.Time) = row.when
	return nil
}

func (tx *billingAgentTxStub) QueryRow(context.Context, string, ...any) pgx.Row {
	tx.clockReads++
	return billingAgentClockRow{when: time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC), err: tx.clockErr}
}

func (tx *billingAgentTxStub) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	tx.execCalls++
	if tx.execCalls == tx.execErrAt {
		return pgconn.CommandTag{}, errors.New("advisory lock unavailable")
	}
	return pgconn.NewCommandTag("SELECT 1"), nil
}

func (tx *billingAgentTxStub) Commit(context.Context) error {
	tx.commitCalls++
	return tx.commitErr
}

func (tx *billingAgentTxStub) Rollback(context.Context) error {
	tx.rollbackCalls++
	return nil
}

type billingAgentTxQuerierStub struct {
	*billingCovQuerier
	tx       *billingAgentTxStub
	beginErr error
	bindErr  error
}

func (q *billingAgentTxQuerierStub) BeginTx(context.Context) (pgx.Tx, error) {
	if q.beginErr != nil {
		return nil, q.beginErr
	}
	return q.tx, nil
}

func (q *billingAgentTxQuerierStub) RebindBillingQueries(db.DBTX) (BillingBaseQuerier, error) {
	if q.bindErr != nil {
		return nil, q.bindErr
	}
	return q.billingCovQuerier, nil
}

func TestBillingService_AgentRunAdmissionTransactionFailures(t *testing.T) {
	callbackErr := errors.New("callback insert failed")
	for _, test := range []struct {
		name         string
		beginErr     error
		bindErr      error
		execErrAt    int
		clockErr     error
		commitErr    error
		callbackErr  error
		wantExec     int
		wantCallback int
		wantCommit   int
		wantRollback int
	}{
		{name: "begin fails", beginErr: errors.New("begin unavailable")},
		{name: "repository ownership lock fails", execErrAt: 1, wantExec: 1, wantRollback: 1},
		{name: "transaction rebind fails", bindErr: errors.New("rebind unavailable"), wantExec: 1, wantRollback: 1},
		{name: "owner quota lock fails", execErrAt: 2, wantExec: 2, wantRollback: 1},
		{name: "transaction clock read fails", clockErr: errors.New("clock unavailable"), wantExec: 2, wantRollback: 1},
		{name: "callback fails", callbackErr: callbackErr, wantExec: 2, wantCallback: 1, wantRollback: 1},
		{name: "commit fails", commitErr: errors.New("commit unavailable"), wantExec: 2, wantCallback: 1, wantCommit: 1, wantRollback: 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			base := billingCovNewQuerier()
			base.usersByID[42] = db.User{ID: 42, Username: "agent-owner"}
			base.reposByID[91] = db.Repository{ID: 91, UserID: pgtype.Int8{Int64: 42, Valid: true}}
			tx := &billingAgentTxStub{execErrAt: test.execErrAt, clockErr: test.clockErr, commitErr: test.commitErr}
			queries := &billingAgentTxQuerierStub{billingCovQuerier: base, tx: tx, beginErr: test.beginErr, bindErr: test.bindErr}
			callbackCalls := 0
			err := NewBillingService(queries, nil, BillingServiceConfig{}).
				AuthorizeAgentRunCommitted(context.Background(), 91, func(_ context.Context, conn db.DBTX) error {
					callbackCalls++
					assert.Same(t, tx, conn)
					return test.callbackErr
				})
			require.Error(t, err)
			if test.callbackErr != nil {
				require.ErrorIs(t, err, test.callbackErr)
			} else {
				assert.Equal(t, 500, httpStatus(err))
			}
			assert.Equal(t, test.wantExec, tx.execCalls)
			assert.Equal(t, test.wantCallback, callbackCalls)
			assert.Equal(t, test.wantCommit, tx.commitCalls)
			assert.Equal(t, test.wantRollback, tx.rollbackCalls)
		})
	}
}

func billingAgentTestFixture(t *testing.T, pool *pgxpool.Pool, ownerType string) (int64, int64, int64) {
	t.Helper()
	ctx := context.Background()
	name := "billing-agent-" + uuid.NewString()
	var ownerID int64
	switch ownerType {
	case BillingOwnerTypeUser:
		require.NoError(t, pool.QueryRow(ctx,
			`INSERT INTO users (username, lower_username, email, lower_email, display_name)
			 VALUES ($1, $1, $2, $2, $1) RETURNING id`, name, name+"@example.test").Scan(&ownerID))
	case BillingOwnerTypeOrg:
		require.NoError(t, pool.QueryRow(ctx,
			`INSERT INTO organizations (name, lower_name) VALUES ($1, $1) RETURNING id`, name).Scan(&ownerID))
	default:
		t.Fatalf("unknown owner type %q", ownerType)
	}
	var repoID int64
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO repositories (user_id, org_id, name, lower_name, description, is_public, default_bookmark)
		 VALUES ($1, $2, $3, $3, '', TRUE, 'main') RETURNING id`,
		billingAgentOwnerID(ownerType == BillingOwnerTypeUser, ownerID),
		billingAgentOwnerID(ownerType == BillingOwnerTypeOrg, ownerID), name).Scan(&repoID))
	var definitionID int64
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO workflow_definitions (repository_id, name, path, config)
		 VALUES ($1, 'agent', 'flows/agent/flow.ts', '{}') RETURNING id`, repoID).Scan(&definitionID))
	return ownerID, repoID, definitionID
}

func billingAgentOwnerID(enabled bool, id int64) any {
	if enabled {
		return id
	}
	return nil
}

func billingAgentTestSession(t *testing.T, pool *pgxpool.Pool, ownerID, repoID int64) string {
	t.Helper()
	sessionID := uuid.NewString()
	_, err := pool.Exec(context.Background(),
		`INSERT INTO agent_sessions (id, repository_id, user_id, status) VALUES ($1, $2, $3, 'active')`,
		sessionID, repoID, ownerID)
	require.NoError(t, err)
	return sessionID
}

func billingAgentInsertRun(ctx context.Context, conn db.DBTX, repoID, definitionID int64, status, trigger string, createdAt time.Time) (int64, error) {
	var runID int64
	err := conn.QueryRow(ctx,
		`INSERT INTO workflow_runs (repository_id, workflow_definition_id, status, trigger_event, created_at)
		 VALUES ($1, $2, $3, $4, $5) RETURNING id`, repoID, definitionID, status, trigger, createdAt).Scan(&runID)
	return runID, err
}

func billingAgentMarkTaskStarted(t *testing.T, ctx context.Context, conn db.DBTX, repoID, runID int64) {
	t.Helper()
	var stepID int64
	require.NoError(t, conn.QueryRow(ctx,
		`INSERT INTO workflow_steps (workflow_run_id, repository_id, name, position, status)
		 VALUES ($1, $2, 'agent', 0, 'success') RETURNING id`, runID, repoID).Scan(&stepID))
	_, err := conn.Exec(ctx,
		`INSERT INTO workflow_tasks (workflow_run_id, workflow_step_id, repository_id, status, payload, started_at)
		 VALUES ($1, $2, $3, 'done', '{}', $4)`, runID, stepID, repoID, time.Now().UTC())
	require.NoError(t, err)
}

func TestBillingService_ConcurrentAgentRunDispatchStopsAtExactCap(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	ownerID, repoID, definitionID := billingAgentTestFixture(t, pool, BillingOwnerTypeUser)
	service := NewBillingService(db.New(pool), nil, BillingServiceConfig{})
	plan := service.checkoutPlans[BillingOwnerTypeUser][BillingPlanFree]
	plan.Limits.AgentRuns = 3
	service.checkoutPlans[BillingOwnerTypeUser][BillingPlanFree] = plan
	_, err := billingAgentInsertRun(ctx, pool, repoID, definitionID, "queued", "agent_message", time.Now().UTC())
	require.NoError(t, err)
	startedRunID, err := billingAgentInsertRun(ctx, pool, repoID, definitionID, "failure", "agent_message", time.Now().UTC())
	require.NoError(t, err)
	billingAgentMarkTaskStarted(t, ctx, pool, repoID, startedRunID)

	const contenders = 50
	start := make(chan struct{})
	results := make(chan error, contenders)
	var workers sync.WaitGroup
	workers.Add(contenders)
	for range contenders {
		go func() {
			defer workers.Done()
			<-start
			results <- service.AuthorizeAgentRunCommitted(ctx, repoID, func(commitCtx context.Context, conn db.DBTX) error {
				if conn == nil {
					return errors.New("committed admission did not provide its transaction")
				}
				_, err := billingAgentInsertRun(commitCtx, conn, repoID, definitionID, "queued", "agent_message", time.Now().UTC())
				return err
			})
		}()
	}
	close(start)
	workers.Wait()
	close(results)

	allowed, denied := 0, 0
	for err := range results {
		switch {
		case err == nil:
			allowed++
		case httpStatus(err) == 402:
			var api *pkgerrors.APIError
			require.ErrorAs(t, err, &api)
			assert.Equal(t, pkgerrors.CodePlanLimitExceeded, api.Code)
			assert.Equal(t, BillingMetricAgentRuns, api.LimitKind)
			denied++
		default:
			t.Fatalf("unexpected agent admission error: %v", err)
		}
	}
	assert.Equal(t, 1, allowed)
	assert.Equal(t, contenders-1, denied)
	var count int64
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM workflow_runs WHERE repository_id = $1 AND trigger_event = 'agent_message'`, repoID).Scan(&count))
	assert.Equal(t, int64(3), count, "only admitted callbacks can persist runs for owner %d", ownerID)
}

func TestBillingService_AgentRunAdmissionCountsQueuedRunningAndStartedTasks(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	ownerID, repoID, definitionID := billingAgentTestFixture(t, pool, BillingOwnerTypeOrg)
	now := time.Now().UTC()
	periodStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	periodEnd := periodStart.AddDate(0, 1, 0)
	for _, test := range []struct {
		status      string
		trigger     string
		createdAt   time.Time
		startedTask bool
	}{
		{status: "queued", trigger: "agent_message", createdAt: now},
		{status: "running", trigger: "agent_message", createdAt: now},
		{status: "failure", trigger: "agent_message", createdAt: now, startedTask: true},
		{status: "failure", trigger: "agent_message", createdAt: now}, // provisioning failed before a task started
		{status: "success", trigger: "push", createdAt: now, startedTask: true},
		{status: "queued", trigger: "agent_message", createdAt: periodStart.Add(-time.Second)},
	} {
		runID, err := billingAgentInsertRun(ctx, pool, repoID, definitionID, test.status, test.trigger, test.createdAt)
		require.NoError(t, err)
		if !test.startedTask {
			continue
		}
		billingAgentMarkTaskStarted(t, ctx, pool, repoID, runID)
	}
	count, err := db.New(pool).CountAgentRunAdmissionsByOwner(ctx, db.CountAgentRunAdmissionsByOwnerParams{
		OwnerType:   BillingOwnerTypeOrg,
		OwnerID:     ownerID,
		PeriodStart: periodStart,
		PeriodEnd:   periodEnd,
	})
	require.NoError(t, err)
	assert.Equal(t, int64(3), count, "queued, running, and a started terminal run consume admission")
}

func TestBillingService_AgentRunAdmissionRollbackAndRetry(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	_, repoID, definitionID := billingAgentTestFixture(t, pool, BillingOwnerTypeUser)
	service := NewBillingService(db.New(pool), nil, BillingServiceConfig{})
	plan := service.checkoutPlans[BillingOwnerTypeUser][BillingPlanFree]
	plan.Limits.AgentRuns = 1
	service.checkoutPlans[BillingOwnerTypeUser][BillingPlanFree] = plan
	want := errors.New("insert callback failed")
	err := service.AuthorizeAgentRunCommitted(ctx, repoID, func(commitCtx context.Context, conn db.DBTX) error {
		_, insertErr := billingAgentInsertRun(commitCtx, conn, repoID, definitionID, "queued", "agent_message", time.Now().UTC())
		if insertErr != nil {
			return insertErr
		}
		return want
	})
	require.ErrorIs(t, err, want)
	var count int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM workflow_runs WHERE repository_id = $1`, repoID).Scan(&count))
	assert.Zero(t, count, "callback failure must roll back its insert")

	for i := 0; i < 2; i++ {
		err = service.AuthorizeAgentRunCommitted(ctx, repoID, func(commitCtx context.Context, conn db.DBTX) error {
			_, insertErr := billingAgentInsertRun(commitCtx, conn, repoID, definitionID, "queued", "agent_message", time.Now().UTC())
			return insertErr
		})
		if i == 0 {
			require.NoError(t, err, fmt.Sprintf("retry %d", i))
		} else {
			assert.Equal(t, 402, httpStatus(err))
		}
	}
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM workflow_runs WHERE repository_id = $1`, repoID).Scan(&count))
	assert.Equal(t, int64(1), count)
}

func TestBillingService_AgentRunAdmissionUsesInsertMonthDespiteServiceClock(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	_, repoID, definitionID := billingAgentTestFixture(t, pool, BillingOwnerTypeUser)
	service := NewBillingService(db.New(pool), nil, BillingServiceConfig{})
	plan := service.checkoutPlans[BillingOwnerTypeUser][BillingPlanFree]
	plan.Limits.AgentRuns = 1
	service.checkoutPlans[BillingOwnerTypeUser][BillingPlanFree] = plan
	// Simulate a process clock that has crossed the month boundary while the
	// database transaction and its DEFAULT created_at still belong to this month.
	dbNow := time.Now().UTC()
	service.now = func() time.Time { return dbNow.AddDate(0, 1, 0) }
	commit := func(commitCtx context.Context, conn db.DBTX) error {
		_, err := db.New(conn).CreateWorkflowRun(commitCtx, db.CreateWorkflowRunParams{
			RepositoryID: repoID, WorkflowDefinitionID: definitionID,
			Status: "queued", TriggerEvent: "agent_message", ExecutionPlane: WorkflowRunPlaneAgent,
		})
		return err
	}
	require.NoError(t, service.AuthorizeAgentRunCommitted(ctx, repoID, commit))
	err := service.AuthorizeAgentRunCommitted(ctx, repoID, commit)
	assert.Equal(t, 402, httpStatus(err))
	var count int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM workflow_runs WHERE repository_id = $1`, repoID).Scan(&count))
	assert.Equal(t, int64(1), count)
}

func TestBillingService_AgentRunAdmissionCancelledWhileWaitingForOwnerLock(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	ownerID, repoID, definitionID := billingAgentTestFixture(t, pool, BillingOwnerTypeUser)
	service := NewBillingService(db.New(pool), nil, BillingServiceConfig{})
	holder, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer holder.Rollback(ctx)
	_, err = holder.Exec(ctx, storageAuthorizationLockSQL, BillingOwnerTypeUser, ownerID)
	require.NoError(t, err)

	waitCtx, cancel := context.WithTimeout(ctx, 150*time.Millisecond)
	defer cancel()
	called := false
	err = service.AuthorizeAgentRunCommitted(waitCtx, repoID, func(commitCtx context.Context, conn db.DBTX) error {
		called = true
		_, insertErr := billingAgentInsertRun(commitCtx, conn, repoID, definitionID, "queued", "agent_message", time.Now().UTC())
		return insertErr
	})
	require.Error(t, err)
	assert.False(t, called)
	var count int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM workflow_runs WHERE repository_id = $1`, repoID).Scan(&count))
	assert.Zero(t, count)
	require.NoError(t, holder.Rollback(ctx))
	require.NoError(t, service.AuthorizeAgentRunCommitted(ctx, repoID, func(commitCtx context.Context, conn db.DBTX) error {
		_, insertErr := billingAgentInsertRun(commitCtx, conn, repoID, definitionID, "queued", "agent_message", time.Now().UTC())
		return insertErr
	}))
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM workflow_runs WHERE repository_id = $1`, repoID).Scan(&count))
	assert.Equal(t, int64(1), count)
}

type billingAgentDispatchCommitSpy struct {
	*agentDispatchCovBilling
	conn   db.DBTX
	called bool
}

func (b *billingAgentDispatchCommitSpy) AuthorizeAgentRunCommitted(ctx context.Context, _ int64, commit func(context.Context, db.DBTX) error) error {
	b.called = true
	return commit(ctx, b.conn)
}

func TestAgentDispatch_CreateWorkflowRunUsesBillingTransaction(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	ownerID, repoID, definitionID := billingAgentTestFixture(t, pool, BillingOwnerTypeUser)
	sessionID := billingAgentTestSession(t, pool, ownerID, repoID)
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer tx.Rollback(ctx)
	billing := &billingAgentDispatchCommitSpy{agentDispatchCovBilling: &agentDispatchCovBilling{}, conn: tx}
	usedConfiguredQuerier := false
	dispatch := &agentDispatch{
		ctx:   ctx,
		input: DispatchAgentRunInput{RepositoryID: repoID, SessionID: sessionID},
		wfDef: db.WorkflowDefinition{ID: definitionID},
		svc: &AgentService{
			billing: billing,
			dispatchQ: &mockAgentDispatchQuerier{createWorkflowRunFn: func(context.Context, db.CreateWorkflowRunParams) (db.WorkflowRun, error) {
				usedConfiguredQuerier = true
				return db.WorkflowRun{}, errors.New("configured querier used outside admission transaction")
			}},
		},
	}
	require.NoError(t, dispatch.createWorkflowRun())
	assert.True(t, billing.called)
	assert.False(t, usedConfiguredQuerier)
	assert.NotZero(t, dispatch.run.ID)
	var runCount int64
	require.NoError(t, tx.QueryRow(ctx, `SELECT COUNT(*) FROM workflow_runs WHERE id = $1`, dispatch.run.ID).Scan(&runCount))
	assert.Equal(t, int64(1), runCount)
	var linkedID int64
	require.NoError(t, tx.QueryRow(ctx, `SELECT workflow_run_id FROM agent_sessions WHERE id = $1`, sessionID).Scan(&linkedID))
	assert.Equal(t, dispatch.run.ID, linkedID)
	require.NoError(t, tx.Commit(ctx))
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM workflow_runs WHERE id = $1`, dispatch.run.ID).Scan(&runCount))
	assert.Equal(t, int64(1), runCount)
	require.NoError(t, pool.QueryRow(ctx, `SELECT workflow_run_id FROM agent_sessions WHERE id = $1`, sessionID).Scan(&linkedID))
	assert.Equal(t, dispatch.run.ID, linkedID)
}

func TestAgentDispatch_LinkedTasklessRunIsRecoveredByNeverStartedReaper(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	ownerID, repoID, definitionID := billingAgentTestFixture(t, pool, BillingOwnerTypeUser)
	sessionID := billingAgentTestSession(t, pool, ownerID, repoID)
	queries := db.New(pool)
	svc := &AgentService{
		q: queries, dispatchQ: queries,
		billing:             NewBillingService(queries, nil, BillingServiceConfig{}),
		neverStartedTimeout: time.Hour,
	}
	dispatch := &agentDispatch{
		ctx: ctx, svc: svc,
		input: DispatchAgentRunInput{RepositoryID: repoID, SessionID: sessionID},
		wfDef: db.WorkflowDefinition{ID: definitionID},
	}
	require.NoError(t, dispatch.createWorkflowRun())
	var linkedID int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT workflow_run_id FROM agent_sessions WHERE id = $1`, sessionID).Scan(&linkedID))
	assert.Equal(t, dispatch.run.ID, linkedID)
	_, err := pool.Exec(ctx, `UPDATE agent_sessions SET created_at = now() - interval '2 hours' WHERE id = $1`, sessionID)
	require.NoError(t, err)

	// An old session with a newly admitted run is still inside its launch window.
	require.NoError(t, svc.reapNeverStartedSessions(ctx))
	var sessionStatus, runStatus string
	require.NoError(t, pool.QueryRow(ctx, `SELECT status FROM agent_sessions WHERE id = $1`, sessionID).Scan(&sessionStatus))
	require.NoError(t, pool.QueryRow(ctx, `SELECT status FROM workflow_runs WHERE id = $1`, dispatch.run.ID).Scan(&runStatus))
	assert.Equal(t, "active", sessionStatus)
	assert.Equal(t, "queued", runStatus)

	// Simulate a worker disappearing after admission, before the first task is inserted.
	_, err = pool.Exec(ctx, `UPDATE workflow_runs SET created_at = now() - interval '2 hours' WHERE id = $1`, dispatch.run.ID)
	require.NoError(t, err)
	require.NoError(t, svc.reapNeverStartedSessions(ctx))
	require.NoError(t, pool.QueryRow(ctx, `SELECT status FROM agent_sessions WHERE id = $1`, sessionID).Scan(&sessionStatus))
	require.NoError(t, pool.QueryRow(ctx, `SELECT status FROM workflow_runs WHERE id = $1`, dispatch.run.ID).Scan(&runStatus))
	assert.Equal(t, "failed", sessionStatus)
	assert.Equal(t, "failure", runStatus)
	periodStart, periodEnd := billingPeriodWindow(time.Now().UTC())
	admissions, err := queries.CountAgentRunAdmissionsByOwner(ctx, db.CountAgentRunAdmissionsByOwnerParams{
		OwnerType: BillingOwnerTypeUser, OwnerID: ownerID, PeriodStart: periodStart, PeriodEnd: periodEnd,
	})
	require.NoError(t, err)
	assert.Zero(t, admissions, "reaping an unstarted run must free its reserved monthly slot")
}

type billingAgentAmbiguousCommitTx struct {
	pgx.Tx
}

func (tx *billingAgentAmbiguousCommitTx) Commit(ctx context.Context) error {
	if err := tx.Tx.Commit(ctx); err != nil {
		return err
	}
	return errors.New("commit acknowledgment lost")
}

type billingAgentAmbiguousCommitQuerier struct {
	*db.Queries
	pool *pgxpool.Pool
}

func (q *billingAgentAmbiguousCommitQuerier) BeginTx(ctx context.Context) (pgx.Tx, error) {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return &billingAgentAmbiguousCommitTx{Tx: tx}, nil
}

func (*billingAgentAmbiguousCommitQuerier) RebindBillingQueries(conn db.DBTX) (BillingBaseQuerier, error) {
	return db.New(conn), nil
}

func TestAgentDispatch_AmbiguousCommitCleanupReleasesAdmission(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	ownerID, repoID, definitionID := billingAgentTestFixture(t, pool, BillingOwnerTypeUser)
	sessionID := billingAgentTestSession(t, pool, ownerID, repoID)
	queries := db.New(pool)
	billing := NewBillingService(&billingAgentAmbiguousCommitQuerier{Queries: queries, pool: pool}, nil, BillingServiceConfig{})
	svc := &AgentService{q: queries, dispatchQ: queries, billing: billing}
	dispatch := &agentDispatch{
		ctx: ctx, svc: svc,
		input: DispatchAgentRunInput{RepositoryID: repoID, SessionID: sessionID},
		wfDef: db.WorkflowDefinition{ID: definitionID},
	}
	err := dispatch.createWorkflowRun()
	require.ErrorContains(t, err, "failed to commit agent run admission")
	require.NotZero(t, dispatch.run.ID, "cleanup needs the maybe-committed run ID")
	dispatch.cleanup()
	var runStatus string
	require.NoError(t, pool.QueryRow(ctx, `SELECT status FROM workflow_runs WHERE id = $1`, dispatch.run.ID).Scan(&runStatus))
	assert.Equal(t, "failure", runStatus)
	var linkedID int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT workflow_run_id FROM agent_sessions WHERE id = $1`, sessionID).Scan(&linkedID))
	assert.Equal(t, dispatch.run.ID, linkedID, "cleanup must not re-point an uncertain session")
	periodStart, periodEnd := billingPeriodWindow(time.Now().UTC())
	admissions, err := queries.CountAgentRunAdmissionsByOwner(ctx, db.CountAgentRunAdmissionsByOwnerParams{
		OwnerType: BillingOwnerTypeUser, OwnerID: ownerID, PeriodStart: periodStart, PeriodEnd: periodEnd,
	})
	require.NoError(t, err)
	assert.Zero(t, admissions)
}

func TestAgentDispatch_LosingNilConnectionClaimFailsOnlyItsRun(t *testing.T) {
	const losingRunID = int64(71)
	failedRunID := int64(0)
	sessionTerminalCalls := 0
	queries := &mockAgentDispatchQuerier{
		createWorkflowRunFn: func(_ context.Context, arg db.CreateWorkflowRunParams) (db.WorkflowRun, error) {
			return db.WorkflowRun{ID: losingRunID, RepositoryID: arg.RepositoryID}, nil
		},
		claimAgentSessionForDispatchFn: func(_ context.Context, sessionID string, runID int64) (bool, error) {
			assert.Equal(t, "11111111-1111-4111-8111-111111111111", sessionID)
			assert.Equal(t, losingRunID, runID)
			return false, nil
		},
		failWorkflowRunFn: func(_ context.Context, runID int64) error {
			failedRunID = runID
			return nil
		},
		updateAgentSessionTerminalStatusFn: func(context.Context, db.UpdateAgentSessionTerminalStatusParams) (db.AgentSession, error) {
			sessionTerminalCalls++
			return db.AgentSession{}, nil
		},
	}
	dispatch := &agentDispatch{
		ctx:   context.Background(),
		svc:   &AgentService{dispatchQ: queries, billing: NewUnlimitedBillingPolicy()},
		input: DispatchAgentRunInput{RepositoryID: 101, SessionID: "11111111-1111-4111-8111-111111111111"},
		wfDef: db.WorkflowDefinition{ID: 7},
	}
	err := dispatch.createWorkflowRun()
	dispatch.cleanup()
	assert.Equal(t, 409, httpStatus(err))
	assert.Equal(t, losingRunID, failedRunID)
	assert.Zero(t, sessionTerminalCalls, "the winner's session must remain active")
}
