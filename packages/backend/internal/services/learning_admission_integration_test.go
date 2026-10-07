package services

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

type learningMachineFixture struct{ calls chan flowruntime.Pin }

func (f learningMachineFixture) EnsureLearningMachine(_ context.Context, repo, actor int64, item string, pin flowruntime.Pin) (flowruntime.Target, error) {
	f.calls <- pin
	return flowruntime.Target{TenantID: fmt.Sprintf("repository:%d", repo), PrincipalID: fmt.Sprintf("user:%d", actor), WorkspaceID: "isolated-learning-fixture", BindingKind: "learning", BindingID: item}, nil
}

func TestLearningAdmissionDurablePinAndRefusal(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "learningowner", LowerUsername: "learningowner"})
	require.NoError(t, err)
	var repository int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'app','app') RETURNING id`, owner.ID).Scan(&repository))
	var itemID string
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,source,state,owner_id,pr_state,pr_merge_commit,checks) VALUES($1,'todo','landed',$2,'merged',$3,'{}') RETURNING id::text`, repository, owner.ID, strings.Repeat("a", 40)).Scan(&itemID))
	item, err := q.GetMythicalItemByNumber(ctx, repository, 1)
	require.NoError(t, err)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	service := NewMythicalService(pool, nil)
	service.EnableLearningAdmission(store)
	digest := strings.Repeat("1", 64)
	_, err = q.InsertFlowVersion(ctx, repository, "learning", "flows/learning/flow.ts", strings.Repeat("a", 40), digest, "loaded", "", json.RawMessage(`{}`))
	require.NoError(t, err)
	_, err = q.ActivateFlowVersion(ctx, repository, "learning", digest)
	require.NoError(t, err)
	// A rolled-back merge has no orphaned Learning request.
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	require.NoError(t, service.admitLearningInTx(ctx, tx, item))
	require.NoError(t, tx.Rollback(ctx))
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='learning.admission'`).Scan(&count))
	require.Zero(t, count)
	require.NoError(t, pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error { return service.admitLearningInTx(ctx, tx, item) }))
	// Active changing cannot change either the identity or pin on replay.
	_, err = q.InsertFlowVersion(ctx, repository, "learning", "flows/learning/flow.ts", strings.Repeat("b", 40), strings.Repeat("2", 64), "loaded", "", json.RawMessage(`{}`))
	require.NoError(t, err)
	_, err = q.ActivateFlowVersion(ctx, repository, "learning", strings.Repeat("2", 64))
	require.NoError(t, err)
	require.NoError(t, pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error { return service.admitLearningInTx(ctx, tx, item) }))
	workerCtx, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() {
		done <- store.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: "learning-fixture", Capacity: 1, Lease: time.Second, PollInterval: time.Millisecond, Operations: []string{LearningAdmissionOperation}}, service.HandleLearningAdmission)
	}()
	active := true
	t.Cleanup(func() {
		if active {
			cancel()
			require.NoError(t, <-done)
		}
	})
	require.Eventually(t, func() bool {
		var checkpoint []byte
		if pool.QueryRow(ctx, `SELECT external_receipt FROM product_job_dispatches`).Scan(&checkpoint) != nil {
			return false
		}
		var saved struct {
			Pin *flowruntime.Pin `json:"pin"`
		}
		return json.Unmarshal(checkpoint, &saved) == nil && saved.Pin != nil && saved.Pin.ExecutionDigest == digest
	}, 5*time.Second, 10*time.Millisecond)
	runs, err := service.LearningBackgroundRuns(ctx, repository)
	require.NoError(t, err)
	require.Len(t, runs, 1)
	require.Equal(t, "Learning · T1", runs[0]["title"])
	// No allocator means no machine call or runtime launch; the intent is parked.
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.launch'`).Scan(&count))
	require.Zero(t, count)
	cancel()
	require.NoError(t, <-done)
	active = false
	// Restart on an available contract with a real durable dispatcher; the
	// allocator alone is the test-only dependency, never a host fallback.
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		t.Error("admission contacted runtime")
		return nil, ErrLearningUnavailable
	})})
	require.NoError(t, err)
	service.SetLauncher(dispatcher)
	machines := learningMachineFixture{calls: make(chan flowruntime.Pin, 1)}
	service.SetLearningMachines(machines)
	_, err = pool.Exec(ctx, `UPDATE product_job_dispatches SET next_attempt_at=clock_timestamp() WHERE operation_id IN (SELECT id FROM product_job_requests WHERE operation='learning.admission')`)
	require.NoError(t, err)
	workerCtx, cancel = context.WithCancel(ctx)
	done = make(chan error, 1)
	active = true
	go func() {
		done <- store.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: "learning-restart", Capacity: 1, Lease: time.Second, PollInterval: time.Millisecond, Operations: []string{LearningAdmissionOperation}}, service.HandleLearningAdmission)
	}()
	require.Eventually(t, func() bool {
		return pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.launch'`).Scan(&count) == nil && count == 1
	}, 5*time.Second, 10*time.Millisecond)
	require.Equal(t, flowruntime.Pin{Flow: "learning", SourceCommit: strings.Repeat("a", 40), ExecutionDigest: digest}, <-machines.calls)
	var launch []byte
	require.NoError(t, pool.QueryRow(ctx, `SELECT payload FROM product_job_requests WHERE operation='flow.runtime.launch'`).Scan(&launch))
	var saved struct {
		Pin     flowruntime.Pin    `json:"pin"`
		Target  flowruntime.Target `json:"target"`
		Payload map[string]int64   `json:"payload"`
	}
	require.NoError(t, json.Unmarshal(launch, &saved))
	require.Equal(t, digest, saved.Pin.ExecutionDigest)
	require.Equal(t, itemID, saved.Target.BindingID)
	require.Equal(t, int64(1), saved.Payload["todo"])
}
