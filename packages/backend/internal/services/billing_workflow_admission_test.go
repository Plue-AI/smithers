package services

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

func billingWorkflowService(queries BillingBaseQuerier, ciMinutes int64) *BillingService {
	service := NewBillingService(queries, nil, BillingServiceConfig{})
	plan := service.checkoutPlans[BillingOwnerTypeUser][BillingPlanFree]
	plan.Limits.CIMinutes = ciMinutes
	service.checkoutPlans[BillingOwnerTypeUser][BillingPlanFree] = plan
	return service
}

// billingWorkflowInsertRun inserts one run with explicit timing so its metered
// minutes are known: started minutes ago, completed when completedAfter > 0.
func billingWorkflowInsertRun(ctx context.Context, conn db.DBTX, repoID, definitionID int64, status string, createdAt time.Time, startedAgo, completedAfter time.Duration) (int64, error) {
	var started, completed pgtype.Timestamptz
	if startedAgo > 0 {
		startedAt := time.Now().UTC().Add(-startedAgo)
		started = pgtype.Timestamptz{Time: startedAt, Valid: true}
		if completedAfter > 0 {
			completed = pgtype.Timestamptz{Time: startedAt.Add(completedAfter), Valid: true}
		}
	}
	var runID int64
	err := conn.QueryRow(ctx,
		`INSERT INTO workflow_runs (repository_id, workflow_definition_id, status, trigger_event, created_at, started_at, completed_at)
		 VALUES ($1, $2, $3, 'push', $4, $5, $6) RETURNING id`,
		repoID, definitionID, status, createdAt, started, completed).Scan(&runID)
	return runID, err
}

func TestBillingService_WorkflowDispatchAdmissionBranches(t *testing.T) {
	for _, test := range []struct {
		name       string
		minutes    int64
		limit      int64
		countErr   error
		wantStatus int
	}{
		{name: "one minute remains", minutes: 9, limit: 10},
		{name: "cap reached", minutes: 10, limit: 10, wantStatus: 402},
		{name: "past the cap", minutes: 11, limit: 10, wantStatus: 402},
		{name: "unlimited plan", minutes: 1 << 40, limit: unlimitedBillingQuantity},
		{name: "count fails closed", countErr: errors.New("count unavailable"), limit: 10, wantStatus: 500},
	} {
		t.Run(test.name, func(t *testing.T) {
			queries := billingCovNewQuerier()
			queries.usersByID[42] = db.User{ID: 42, Username: "ci-owner"}
			queries.reposByID[91] = db.Repository{ID: 91, UserID: pgtype.Int8{Int64: 42, Valid: true}}
			queries.sumWorkflowAdmissionMinutesFn = func(_ context.Context, arg db.SumWorkflowAdmissionMinutesByOwnerParams) (int64, error) {
				assert.Equal(t, BillingOwnerTypeUser, arg.OwnerType)
				assert.Equal(t, int64(42), arg.OwnerID)
				assert.True(t, arg.PeriodEnd.After(arg.PeriodStart))
				return test.minutes, test.countErr
			}
			err := billingWorkflowService(queries, test.limit).authorizeWorkflowDispatchAdmission(context.Background(), 91)
			if test.wantStatus == 0 {
				require.NoError(t, err)
				return
			}
			assert.Equal(t, test.wantStatus, httpStatus(err))
			if test.wantStatus == 402 {
				var api *pkgerrors.APIError
				require.ErrorAs(t, err, &api)
				assert.Equal(t, pkgerrors.CodePlanLimitExceeded, api.Code)
				assert.Equal(t, BillingMetricCIMinutes, api.LimitKind)
				require.NotNil(t, api.Limit)
				assert.Equal(t, int(test.limit), *api.Limit)
				require.NotNil(t, api.Remaining)
				assert.Zero(t, *api.Remaining)
			}
		})
	}
}

func TestBillingService_WorkflowDispatchAdmissionRequiresTransaction(t *testing.T) {
	service := NewBillingService(billingCovNewQuerier(), nil, BillingServiceConfig{})
	assert.Equal(t, 500, httpStatus(service.AuthorizeWorkflowDispatchCommitted(context.Background(), 91, nil)))
	called := false
	err := service.AuthorizeWorkflowDispatchCommitted(context.Background(), 91, func(context.Context, pgx.Tx) error {
		called = true
		return nil
	})
	assert.Equal(t, 500, httpStatus(err))
	assert.False(t, called, "missing transaction support must never call the consuming write")
}

func TestBillingService_WorkflowDispatchAdmissionTransactionFailures(t *testing.T) {
	callbackErr := errors.New("callback insert failed")
	for _, test := range []struct {
		name         string
		execErrAt    int
		commitErr    error
		callbackErr  error
		wantCallback int
		wantCommit   int
	}{
		{name: "owner quota lock fails", execErrAt: 2},
		{name: "callback fails", callbackErr: callbackErr, wantCallback: 1},
		{name: "commit fails", commitErr: errors.New("commit unavailable"), wantCallback: 1, wantCommit: 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			base := billingCovNewQuerier()
			base.usersByID[42] = db.User{ID: 42, Username: "ci-owner"}
			base.reposByID[91] = db.Repository{ID: 91, UserID: pgtype.Int8{Int64: 42, Valid: true}}
			tx := &billingAgentTxStub{execErrAt: test.execErrAt, commitErr: test.commitErr}
			queries := &billingAgentTxQuerierStub{billingCovQuerier: base, tx: tx}
			callbackCalls := 0
			err := NewBillingService(queries, nil, BillingServiceConfig{}).
				AuthorizeWorkflowDispatchCommitted(context.Background(), 91, func(_ context.Context, conn pgx.Tx) error {
					callbackCalls++
					assert.Same(t, tx, conn)
					return test.callbackErr
				})
			if test.callbackErr != nil {
				require.ErrorIs(t, err, test.callbackErr)
			} else {
				assert.Equal(t, 500, httpStatus(err))
			}
			if test.commitErr != nil {
				assert.ErrorContains(t, err, "failed to commit workflow run admission")
			}
			assert.Equal(t, test.wantCallback, callbackCalls)
			assert.Equal(t, test.wantCommit, tx.commitCalls)
			assert.Equal(t, 1, tx.rollbackCalls)
		})
	}
}

func TestUnlimitedBillingPolicy_WorkflowDispatchCommittedUsesCallerTransaction(t *testing.T) {
	policy := NewUnlimitedBillingPolicy()
	require.Error(t, policy.AuthorizeWorkflowDispatchCommitted(context.Background(), 1, nil))
	var got pgx.Tx = &billingAgentTxStub{}
	require.NoError(t, policy.AuthorizeWorkflowDispatchCommitted(context.Background(), 1, func(_ context.Context, tx pgx.Tx) error {
		got = tx
		return nil
	}))
	assert.Nil(t, got, "an unlimited policy admits without a transaction")
}

func TestBillingService_WorkflowAdmissionMinutesReserveInFlightRuns(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	ownerID, repoID, definitionID := billingAgentTestFixture(t, pool, BillingOwnerTypeUser)
	now := time.Now().UTC()
	periodStart, periodEnd := billingPeriodWindow(now)
	for _, run := range []struct {
		status         string
		createdAt      time.Time
		startedAgo     time.Duration
		completedAfter time.Duration
	}{
		{status: "queued", createdAt: now},                                                            // reserves 1
		{status: "running", createdAt: now, startedAgo: 1 * time.Second},                              // reserves 1 (meters 1)
		{status: "running", createdAt: now, startedAgo: 4*time.Minute + 30*time.Second},               // meters 5
		{status: "success", createdAt: now, startedAgo: time.Hour, completedAfter: 150 * time.Second}, // meters 3
		{status: "failure", createdAt: now},                                                           // never started: 0
		{status: "cancelled", createdAt: now},                                                         // never started: 0
		{status: "queued", createdAt: periodStart.Add(-time.Second)},                                  // previous period
	} {
		_, err := billingWorkflowInsertRun(ctx, pool, repoID, definitionID, run.status, run.createdAt, run.startedAgo, run.completedAfter)
		require.NoError(t, err)
	}
	queries := db.New(pool)
	minutes, err := queries.SumWorkflowAdmissionMinutesByOwner(ctx, db.SumWorkflowAdmissionMinutesByOwnerParams{
		OwnerType: BillingOwnerTypeUser, OwnerID: ownerID, PeriodStart: periodStart, PeriodEnd: periodEnd,
	})
	require.NoError(t, err)
	assert.Equal(t, int64(10), minutes)
	usage, err := queries.SumWorkflowMinutesByOwner(ctx, db.SumWorkflowMinutesByOwnerParams{
		OwnerType: BillingOwnerTypeUser, OwnerID: ownerID, PeriodStart: periodStart, PeriodEnd: periodEnd,
	})
	require.NoError(t, err)
	assert.Equal(t, int64(9), usage, "the usage report keeps metering only executed minutes")
}

func TestBillingService_ConcurrentWorkflowDispatchStopsAtExactCap(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	_, repoID, definitionID := billingAgentTestFixture(t, pool, BillingOwnerTypeUser)
	service := billingWorkflowService(db.New(pool), 4)
	// Three executed minutes leave the owner one minute below the cap.
	_, err := billingWorkflowInsertRun(ctx, pool, repoID, definitionID, "success", time.Now().UTC(), time.Hour, 3*time.Minute)
	require.NoError(t, err)

	const contenders = 50
	start := make(chan struct{})
	results := make(chan error, contenders)
	var workers sync.WaitGroup
	workers.Add(contenders)
	for range contenders {
		go func() {
			defer workers.Done()
			<-start
			results <- service.AuthorizeWorkflowDispatchCommitted(ctx, repoID, func(commitCtx context.Context, tx pgx.Tx) error {
				if tx == nil {
					return errors.New("committed admission did not provide its transaction")
				}
				_, err := billingWorkflowInsertRun(commitCtx, tx, repoID, definitionID, "queued", time.Now().UTC(), 0, 0)
				return err
			})
		}()
	}
	close(start)
	workers.Wait()
	close(results)
	allowed, denied := billingWorkflowTally(t, results)
	assert.Equal(t, 1, allowed)
	assert.Equal(t, contenders-1, denied)
	assert.Equal(t, int64(1), billingWorkflowQueuedRuns(t, pool, repoID))
}

func TestBillingService_WorkflowDispatchAdmissionRollsBackFailedInsert(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	_, repoID, definitionID := billingAgentTestFixture(t, pool, BillingOwnerTypeUser)
	service := billingWorkflowService(db.New(pool), 1)
	want := errors.New("insert callback failed")
	err := service.AuthorizeWorkflowDispatchCommitted(ctx, repoID, func(commitCtx context.Context, tx pgx.Tx) error {
		if _, err := billingWorkflowInsertRun(commitCtx, tx, repoID, definitionID, "queued", time.Now().UTC(), 0, 0); err != nil {
			return err
		}
		return want
	})
	require.ErrorIs(t, err, want)
	assert.Zero(t, billingWorkflowQueuedRuns(t, pool, repoID), "a failed insert must release its reservation")

	insert := func(commitCtx context.Context, tx pgx.Tx) error {
		_, err := billingWorkflowInsertRun(commitCtx, tx, repoID, definitionID, "queued", time.Now().UTC(), 0, 0)
		return err
	}
	require.NoError(t, service.AuthorizeWorkflowDispatchCommitted(ctx, repoID, insert))
	assert.Equal(t, 402, httpStatus(service.AuthorizeWorkflowDispatchCommitted(ctx, repoID, insert)))
	// A run that ends without executing frees its reserved minute.
	_, err = pool.Exec(ctx, `UPDATE workflow_runs SET status = 'cancelled' WHERE repository_id = $1`, repoID)
	require.NoError(t, err)
	require.NoError(t, service.AuthorizeWorkflowDispatchCommitted(ctx, repoID, insert))
}

// Every non-agent dispatch path inserts its run inside the admission
// transaction: concurrent pushes at the cap create exactly one run.
func TestWorkflowRunService_ConcurrentDispatchAtCIMinuteCapCreatesOneRun(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	queries := db.New(pool)
	repoID := createWorkflowRunIntegrationRepo(t, pool)
	_, err := queries.CreateWorkflowDefinition(ctx, db.CreateWorkflowDefinitionParams{
		RepositoryID: repoID, Name: "ci", Path: ".smithers/workflows/ci.tsx",
		Config: json.RawMessage(`{"on":{"workflow_dispatch":{}},"jobs":{"build":{"runs-on":"ubuntu","steps":[{"run":"make"}]}}}`),
	})
	require.NoError(t, err)
	svc := NewWorkflowRunService(queries, WithWorkflowRunBillingPolicy(billingWorkflowService(queries, 1)))

	const contenders = 20
	start := make(chan struct{})
	results := make(chan error, contenders)
	var workers sync.WaitGroup
	workers.Add(contenders)
	for range contenders {
		go func() {
			defer workers.Done()
			<-start
			_, err := svc.DispatchForEvent(ctx, DispatchForEventInput{
				RepositoryID: repoID,
				Event:        TriggerEvent{Type: "workflow_dispatch", Ref: "main", CommitSHA: "abc123abc123abc123abc123abc123abc123abcd"},
			})
			results <- err
		}()
	}
	close(start)
	workers.Wait()
	close(results)
	allowed, denied := billingWorkflowTally(t, results)
	assert.Equal(t, 1, allowed)
	assert.Equal(t, contenders-1, denied)
	var runs, tasks int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM workflow_runs WHERE repository_id = $1`, repoID).Scan(&runs))
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM workflow_tasks WHERE repository_id = $1`, repoID).Scan(&tasks))
	assert.Equal(t, int64(1), runs)
	assert.Equal(t, int64(1), tasks, "the admitted run keeps its task; refused dispatches leave no rows")
}

func billingWorkflowTally(t *testing.T, results <-chan error) (allowed, denied int) {
	t.Helper()
	for err := range results {
		switch {
		case err == nil:
			allowed++
		case httpStatus(err) == 402:
			var api *pkgerrors.APIError
			require.ErrorAs(t, err, &api)
			assert.Equal(t, pkgerrors.CodePlanLimitExceeded, api.Code)
			assert.Equal(t, BillingMetricCIMinutes, api.LimitKind)
			denied++
		default:
			t.Fatalf("unexpected workflow admission error: %v", err)
		}
	}
	return allowed, denied
}

func billingWorkflowQueuedRuns(t *testing.T, pool *pgxpool.Pool, repoID int64) int64 {
	t.Helper()
	var count int64
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM workflow_runs WHERE repository_id = $1 AND status = 'queued'`, repoID).Scan(&count))
	return count
}

// A flow invocation writes its run, step, launch and invocation record inside
// the CI-minute admission transaction, so a refused invocation leaves nothing.
func TestInvokeWorkflowAdmitsInsideCIMinuteAdmission(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	q := db.New(pool)
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")
	var userID, repositoryID int64
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO users(username,lower_username,email,lower_email) VALUES($1,$1,$2,$2) RETURNING id`,
		"owner"+suffix, suffix+"@example.invalid").Scan(&userID))
	require.NoError(t, pool.QueryRow(ctx,
		`INSERT INTO repositories(user_id,name,lower_name) VALUES($1,$2,$2) RETURNING id`,
		userID, "repo"+suffix).Scan(&repositoryID))
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Resolver: flowruntime.ResolverFunc(
		func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
			return nil, errors.New("admission must not resolve a runtime")
		})})
	require.NoError(t, err)
	invoked := NewInvokedFlowService(pool, NewRepositoryJobService(q, nil, pool), invokedFlowTestWorkspaces{workspaceID: uuid.NewString()})
	invoked.SetFlowDispatcher(dispatcher)
	invoked.SetFlowSourceReader(invokedFlowTestSources{flows: []string{"echo"}})

	_, _, err = invoked.Invoke(ctx, InvokedFlowLaunch{RepositoryID: repositoryID, UserID: userID, FlowID: "echo", TriggerRef: "main"}, nil)
	assert.Equal(t, 500, httpStatus(err), "an invocation without admission is refused")

	api := NewWorkflowAPIService(q, nil, WithWorkflowAPIFlowInvoker(invoked), WithWorkflowAPIBillingPolicy(billingWorkflowService(q, 1)))
	invoke := func() (*InvokeWorkflowResult, error) {
		return api.InvokeWorkflow(ctx, InvokeWorkflowInput{RepositoryID: repositoryID, UserID: userID, Identifier: "echo", TriggerRef: "main"})
	}
	result, err := invoke()
	require.NoError(t, err)
	assert.Equal(t, "queued", result.Run.Status)
	_, err = invoke()
	assert.Equal(t, 402, httpStatus(err))

	var runs, invocations int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM workflow_runs WHERE repository_id = $1`, repositoryID).Scan(&runs))
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM workflow_run_flow_invocations i JOIN workflow_runs r ON r.id = i.workflow_run_id WHERE r.repository_id = $1`,
		repositoryID).Scan(&invocations))
	assert.Equal(t, int64(1), runs)
	assert.Equal(t, int64(1), invocations)
	_, err = store.GetByRequest(ctx, repositoryJobFlowScope(repositoryID, userID), flowdispatch.OperationLaunch, invokedFlowRequestID(result.Run.ID))
	require.NoError(t, err, "the admitted run's Flow launch commits with it")
}
