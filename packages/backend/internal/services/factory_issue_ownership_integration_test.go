package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/runtimebridge"
)

type factoryOwnershipFixture struct {
	o          *mythicalOrchestration
	pool       *pgxpool.Pool
	store      *jobs.Store
	dispatcher *flowdispatch.Service
	role       *RepositoryJobService
	workspace  string
	issue      mythicalIssue
	payload    json.RawMessage
}

func newFactoryOwnershipFixture(t *testing.T) *factoryOwnershipFixture {
	t.Helper()
	o := newMythicalOrchestration(t)
	pool := o.pool.(*pgxpool.Pool)
	ctx := context.Background()
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, ObservationDelay: time.Millisecond, MaxObservationDelay: 5 * time.Millisecond, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) {
		return nil, errors.New("admission contacted runtime")
	})})
	require.NoError(t, err)
	o.service.SetLauncher(dispatcher)
	workspace := uuid.NewString()
	_, err = pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,status) VALUES($1,$2,$3,'running')`, workspace, o.repoID, o.userID)
	require.NoError(t, err)
	gateway := &repositoryJobTestGateway{target: BoxHostTarget{RepositoryID: o.repoID, UserID: o.userID, WorkspaceID: workspace}}
	role := NewRepositoryJobService(db.New(pool), gateway, pool)
	role.SetFlowDispatcher(dispatcher)
	// Reuse the canonical declarative contract rather than coupling ownership
	// to a particular authoring-format migration.
	projection := factoryFixture(t)
	projection.Flows = projection.Flows[:1]
	projection.Flows[0].ID = "engineering"
	projection.Flows[0].Capabilities = []string{"fs:read:**"}
	projection.Flows[0].Budget = json.RawMessage(`{"tokens":1000,"milliseconds":60000}`)
	projection.On = projection.On[:1]
	projection.On[0].Event = "issue.labeled:todo"
	projection.On[0].Flow = json.RawMessage(`"engineering"`)
	require.NoError(t, role.ReconcileFactoryRules(ctx, o.repoID, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", projection))
	issue := mythicalIssue{Number: 2081, Title: "One approved issue", Body: "Exactly one owner", State: "open", Labels: []string{"todo"}, TextByMaintainer: true}
	require.NoError(t, o.service.ObserveIssue(ctx, o.repoID, issue, maintainerTodo))
	payload := json.RawMessage(`{"action":"labeled","issue":{"number":2081,"title":"One approved issue","body":"Exactly one owner","state":"open","labels":[{"name":"todo"}],"smithers_text_by_maintainer":true},"label":{"name":"todo"},"smithers_label_by_maintainer":true}`)
	require.NoError(t, role.AdmitGitHubEvent(ctx, o.repoID, db.GithubWebhookJob{DeliveryID: "barrier", Payload: payload}, TriggerEvent{Type: "issues", Action: "labeled"}))
	return &factoryOwnershipFixture{o: o, pool: pool, store: store, dispatcher: dispatcher, role: role, workspace: workspace, issue: issue, payload: payload}
}

func (f *factoryOwnershipFixture) step(t *testing.T) *mythicalItemStep {
	t.Helper()
	stack, err := db.New(f.pool).GetMythicalStack(context.Background(), f.o.repoID)
	require.NoError(t, err)
	return &mythicalItemStep{s: f.o.service, r: &mythicalRun{row: stack}, now: time.Now(), inFlight: map[[16]byte]bool{}}
}
func (f *factoryOwnershipFixture) commit(t *testing.T, phase string) (db.MythicalItem, error) {
	t.Helper()
	item := f.o.item(f.issue.Number)
	item.State, item.WorkspaceID = "running", f.workspace
	item.Attempt, item.Generation = item.Attempt+1, item.Generation+1
	return f.step(t).commit(context.Background(), item, phase, "coding/request", json.RawMessage(`{"prompt":"one issue"}`))
}
func (f *factoryOwnershipFixture) claim(t *testing.T) db.FactoryIssueClaim {
	t.Helper()
	claim, err := db.New(f.pool).GetActiveFactoryIssueClaim(context.Background(), db.GetActiveFactoryIssueClaimParams{RepositoryID: f.o.repoID, IssueNumber: f.issue.Number})
	require.NoError(t, err)
	return claim
}
func (f *factoryOwnershipFixture) dispatches(t *testing.T) []db.RepositoryJobDispatch {
	t.Helper()
	rows, err := f.pool.Query(context.Background(), `SELECT d.id FROM repository_job_dispatches d JOIN repository_job_registrations r ON r.id=d.registration_id WHERE r.repository_id=$1 ORDER BY d.created_at,d.id`, f.o.repoID)
	require.NoError(t, err)
	var ids []string
	for rows.Next() {
		var id string
		require.NoError(t, rows.Scan(&id))
		ids = append(ids, id)
	}
	require.NoError(t, rows.Err())
	rows.Close()
	var result []db.RepositoryJobDispatch
	for _, id := range ids {
		d, err := db.New(f.pool).GetRepositoryJobDispatch(context.Background(), id)
		require.NoError(t, err)
		result = append(result, d)
	}
	return result
}
func (f *factoryOwnershipFixture) wake(t *testing.T) {
	t.Helper()
	_, err := f.pool.Exec(context.Background(), `UPDATE repository_job_dispatches SET next_attempt_at=now() WHERE registration_id IN(SELECT id FROM repository_job_registrations WHERE repository_id=$1)`, f.o.repoID)
	require.NoError(t, err)
	require.NoError(t, f.role.PollOnce(context.Background()))
}

// SQL proof fixtures isolate the admission guard from runtime execution. The
// independent HTTP/worker test below obtains these proofs through real delivery.
func (f *factoryOwnershipFixture) proof(t *testing.T, operation, state, status string) {
	t.Helper()
	receipt := fmt.Sprintf(`{"version":1,"runId":"run-%s","run":{"runId":"run-%s","status":%q}}`, operation, operation, status)
	_, err := f.pool.Exec(context.Background(), `UPDATE product_job_dispatches SET external_receipt=$2::jsonb WHERE operation_id=$1::uuid`, operation, receipt)
	require.NoError(t, err)
	_, err = f.pool.Exec(context.Background(), `UPDATE product_job_requests SET state=$2,terminal_receipt=CASE WHEN $2 IN('completed','failed','cancelled','uncertain') THEN '{"kind":"fixture"}'::jsonb ELSE NULL END WHERE id=$1::uuid`, operation, state)
	require.NoError(t, err)
}

// Both paths use the real Flow dispatcher and PostgreSQL jobs store. The
// barrier precedes admission, rather than relying on a process-local lock.
func TestFactoryIssueOwnershipBarrier(t *testing.T) {
	f := newFactoryOwnershipFixture(t)
	o, pool, role, workspace, issue := f.o, f.pool, f.role, f.workspace, f.issue
	ctx := context.Background()
	item := o.item(issue.Number)
	item.State, item.WorkspaceID = "running", workspace
	item.Attempt, item.Generation = 1, 1
	stack, err := db.New(pool).GetMythicalStack(ctx, o.repoID)
	require.NoError(t, err)
	step := &mythicalItemStep{s: o.service, r: &mythicalRun{row: stack}, now: time.Now(), inFlight: map[[16]byte]bool{}}
	start := make(chan struct{})
	type result struct {
		kind string
		err  error
	}
	errs := make(chan result, 2)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); <-start; errs <- result{"repository-job", role.PollOnce(ctx)} }()
	go func() {
		defer wg.Done()
		<-start
		_, e := step.commit(ctx, item, "request", "coding/request", json.RawMessage(`{"prompt":"one issue"}`))
		errs <- result{"mythical", e}
	}()
	close(start)
	wg.Wait()
	close(errs)
	claim := f.claim(t)
	require.Contains(t, []string{"mythical", "repository-job"}, claim.OwnerKind)
	require.Equal(t, mythicalIssueDigest(issue), claim.ApprovedDigest)
	for result := range errs {
		if result.kind == "repository-job" {
			require.NoError(t, result.err)
		} else if claim.OwnerKind == "mythical" {
			require.NoError(t, result.err)
			require.Equal(t, uuidString(item.ID), claim.OwnerID)
		} else {
			owner, ok := factoryIssueOwned(result.err)
			require.True(t, ok, "loser must be the typed ownership conflict, got %v", result.err)
			require.Equal(t, claim.ID, owner.ClaimID)
			require.Equal(t, claim.OwnerID, owner.ID)
		}
	}
	dispatches := f.dispatches(t)
	require.Len(t, dispatches, 1)
	if claim.OwnerKind == "mythical" {
		require.Equal(t, "queued", dispatches[0].Status)
		require.Contains(t, dispatches[0].Error, claim.OwnerID)
		require.Zero(t, dispatches[0].Attempts)
	} else {
		require.Equal(t, "waiting", dispatches[0].Status)
		require.Equal(t, dispatches[0].ID, claim.OwnerID)
	}
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE tenant_id=$1 AND operation='flow.runtime.launch'`, fmt.Sprintf("repository:%d", o.repoID)).Scan(&count))
	require.Equal(t, 1, count, "one approved issue must have only one active canonical launch across mythical and factory paths")
	// The item still names the exact approved source revision.
	current := o.item(issue.Number)
	require.Equal(t, mythicalIssueDigest(issue), current.ApprovedDigest)
	require.True(t, current.IssueNumber == pgtype.Int8{Int64: 2081, Valid: true})
}

func TestFactoryIssueOwnershipMythicalPhaseGapAndRevisedGeneration(t *testing.T) {
	f := newFactoryOwnershipFixture(t)
	ctx := context.Background()
	_, err := f.commit(t, "request")
	require.NoError(t, err)
	original := f.claim(t)
	operation := uuidString(original.OperationID)
	// A completed admission still names a live run; it cannot release ownership.
	f.proof(t, operation, "completed", "running")
	f.wake(t)
	require.Equal(t, original.ID, f.claim(t).ID)
	require.Equal(t, "queued", f.dispatches(t)[0].Status)
	// A terminal individual phase also cannot let a role steal this active item.
	f.proof(t, operation, "completed", "completed")
	f.wake(t)
	require.Equal(t, original.ID, f.claim(t).ID)
	_, err = f.commit(t, "planning")
	require.NoError(t, err)
	require.Equal(t, original.ID, f.claim(t).ID)
	phase := uuidString(f.claim(t).OperationID)
	edited := f.issue
	edited.Title = "New explicitly approved text"
	require.NoError(t, f.o.service.ObserveIssue(ctx, f.o.repoID, edited, maintainerTodo))
	require.Equal(t, f.issue.Title, f.o.item(f.issue.Number).IssueTitle, "running generation keeps its approved source")
	// Canonical cancellation/item settlement is distinct from merely asking to
	// cancel. Model the domain's cancelled checkpoint and reapproval here; the
	// worker test independently proves cancel-before-launch settlement.
	item := f.o.item(f.issue.Number)
	item.State = "cancelled"
	_, err = db.New(f.pool).SaveMythicalItem(ctx, item)
	require.NoError(t, err)
	require.NoError(t, f.o.service.ObserveIssue(ctx, f.o.repoID, edited, maintainerTodo))
	require.Equal(t, "queued", f.o.item(f.issue.Number).State)
	_, err = f.commit(t, "request")
	_, owned := factoryIssueOwned(err)
	require.True(t, owned, "old planning operation is still live: %v", err)
	f.proof(t, phase, "cancelled", "cancelled")
	_, err = f.commit(t, "request")
	require.NoError(t, err)
	fresh := f.claim(t)
	require.NotEqual(t, original.ID, fresh.ID)
	require.Equal(t, mythicalIssueDigest(edited), fresh.ApprovedDigest)
	var reason string
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT release_reason FROM factory_issue_claims WHERE id=$1`, original.ID).Scan(&reason))
	require.Equal(t, "canonical terminal handoff", reason)
}

func TestFactoryIssueOwnershipDuplicatesRestartAndInactiveDeclaration(t *testing.T) {
	f := newFactoryOwnershipFixture(t)
	ctx := context.Background()
	require.NoError(t, f.role.PollOnce(ctx))
	owner := f.claim(t)
	f.proof(t, uuidString(owner.OperationID), "waiting", "running")
	_, err := f.pool.Exec(ctx, `UPDATE repository_job_dispatches SET status='submitted',run_id=$2 WHERE id=$1`, owner.OwnerID, "run-"+uuidString(owner.OperationID))
	require.NoError(t, err)
	for _, delivery := range []string{"duplicate-label", "backfill", "comment-delivery"} {
		require.NoError(t, f.role.AdmitGitHubEvent(ctx, f.o.repoID, db.GithubWebhookJob{DeliveryID: delivery, Payload: f.payload}, TriggerEvent{Type: "issues", Action: "labeled"}))
	}
	// New services/process identities reconstruct authority from the same store.
	restarted := NewRepositoryJobService(db.New(f.pool), f.role.hosts, f.pool)
	restarted.SetFlowDispatcher(f.dispatcher)
	f.role = restarted
	f.wake(t)
	require.Equal(t, owner.ID, f.claim(t).ID)
	var launches int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.launch' AND tenant_id=$1`, repositoryJobFlowScope(f.o.repoID, f.o.userID).TenantID).Scan(&launches))
	require.Equal(t, 1, launches)
	deferred := 0
	for _, d := range f.dispatches(t) {
		if d.ID != owner.OwnerID {
			require.Equal(t, "queued", d.Status)
			if strings.Contains(d.Error, owner.OwnerID) {
				deferred++
			}
		}
	}
	require.Equal(t, 1, deferred, "FIFO followers retain the current blocked head's owner reason")
	// Pausing a declaration does not revoke the already active owner.
	_, err = f.pool.Exec(ctx, `UPDATE repository_job_registrations SET enabled=false WHERE repository_id=$1`, f.o.repoID)
	require.NoError(t, err)
	_, err = f.commit(t, "request")
	_, owned := factoryIssueOwned(err)
	require.True(t, owned)
	// A repository with only an inactive declaration never gets a phantom claim.
	other := newFactoryOwnershipFixture(t)
	_, err = other.pool.Exec(ctx, `UPDATE repository_job_registrations SET enabled=false WHERE repository_id=$1`, other.o.repoID)
	require.NoError(t, err)
	_, err = other.commit(t, "request")
	require.NoError(t, err)
	require.Equal(t, "mythical", other.claim(t).OwnerKind)
}

func TestFactoryIssueOwnershipRegistrationReplacementAndReplyAuthority(t *testing.T) {
	f := newFactoryOwnershipFixture(t)
	ctx := context.Background()
	require.NoError(t, f.role.PollOnce(ctx))
	claim := f.claim(t)
	dispatch := f.dispatches(t)[0]
	reg, err := db.New(f.pool).GetRepositoryJobRegistration(ctx, dispatch.RegistrationID)
	require.NoError(t, err)
	f.proof(t, uuidString(claim.OperationID), "waiting", "running")
	previous := dispatch
	previous.RunID = "run-" + uuidString(claim.OperationID)
	replyPayload := json.RawMessage(strings.TrimSuffix(string(f.payload), "}") + `,"comment":{"id":91,"body":"more information","smithers_text_by_maintainer":true}}`)
	require.NoError(t, db.New(f.pool).EnqueueRepositoryJobDispatch(ctx, db.EnqueueRepositoryJobDispatchParams{ID: reg.ID, Revision: reg.Revision, DeliveryKey: "reply", Source: "github", EventType: "issue_comment", EventAction: "created", IssueNumber: f.issue.Number, Payload: replyPayload, Status: "queued"}))
	replies := f.dispatches(t)
	reply := replies[len(replies)-1]
	receipt, err := f.role.admitRepositoryJobSignal(ctx, reg, reply, previous)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `UPDATE product_job_dispatches SET external_started_at=now(),external_receipt=$2::jsonb WHERE operation_id=$1::uuid`, receipt.OperationID, fmt.Sprintf(`{"version":1,"runId":%q}`, previous.RunID))
	require.NoError(t, err)
	// Replaced workspace/source/user cannot mutate a previously admitted run.
	replacementWorkspace := uuid.NewString()
	var replacementUser int64
	require.NoError(t, f.pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES($1,$1) RETURNING id`, "replacement"+strings.ReplaceAll(uuid.NewString(), "-", "")).Scan(&replacementUser))
	_, err = f.pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,status) VALUES($1,$2,$3,'running')`, replacementWorkspace, f.o.repoID, replacementUser)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `UPDATE repository_job_registrations SET revision=revision+1,digest='replacement',workspace_id=$3::uuid,user_id=$4,source_revision=$2 WHERE id=$1`, reg.ID, strings.Repeat("b", 40), replacementWorkspace, replacementUser)
	require.NoError(t, err)
	resolver, err := NewRepositoryJobFlowHostTargetResolver(f.role)
	require.NoError(t, err)
	target := repositoryJobFlowTarget(reg, reply)
	scope := repositoryJobFlowScope(reg.RepositoryID, reg.UserID)
	target.TenantID, target.PrincipalID = scope.TenantID, scope.PrincipalID
	authority, err := resolver.ResolveFlowHostTarget(ctx, target)
	require.NoError(t, err)
	require.Equal(t, reg.WorkspaceID, authority.WorkspaceID)
	require.Equal(t, reg.SourceRevision, authority.SourceRevision)
	foreign := target
	foreign.PrincipalID = "user:99999"
	_, err = resolver.ResolveFlowHostTarget(ctx, foreign)
	require.Error(t, err)
	// Fresh mutations cannot borrow that original operation's pin.
	reply.SignalAttempt++
	_, err = f.role.admitRepositoryJobSignal(ctx, reg, reply, previous)
	require.Error(t, err)
	// An already admitted but never attempted reply is not a continuation grant.
	_, err = f.pool.Exec(ctx, `UPDATE product_job_dispatches SET external_started_at=NULL,external_receipt=NULL WHERE operation_id=$1::uuid`, receipt.OperationID)
	require.NoError(t, err)
	_, err = resolver.ResolveFlowHostTarget(ctx, target)
	require.Error(t, err)
	// Original launch observation still works even after registration changes.
	target = repositoryJobFlowTarget(reg, dispatch)
	target.TenantID, target.PrincipalID = scope.TenantID, scope.PrincipalID
	authority, err = resolver.ResolveFlowHostTarget(ctx, target)
	require.NoError(t, err)
	require.Equal(t, reg.SourceRevision, authority.SourceRevision)
	_, err = f.pool.Exec(ctx, `UPDATE repository_job_dispatches SET status='skipped' WHERE id=$1`, dispatch.ID)
	require.NoError(t, err)
	// Only a current repository writer may cancel, using the pinned scope,
	// including a dispatch whose registration replacement already marked skipped.
	_, err = f.role.Pause(ctx, f.o.repoID, f.o.userID, reg.Job)
	require.NoError(t, err)
	op, err := f.store.Get(ctx, scope, uuidString(claim.OperationID))
	require.NoError(t, err)
	require.True(t, op.CancellationRequested)
}

// A controlled protocol peer is the concrete integration exception: provider
// launch is unrelated to ownership. PostgreSQL admission, HTTP bridge, fenced
// worker, durable cancellation and terminal observation all run for real.
func TestFactoryIssueOwnershipHTTPWorkerCancellationAndHandoff(t *testing.T) {
	f := newFactoryOwnershipFixture(t)
	ctx := context.Background()
	var launches atomic.Int32
	var unauthenticated atomic.Int32
	var completed atomic.Bool
	var selected atomic.Value
	selected.Store("coding/request")
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture-token" {
			unauthenticated.Add(1)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		identity := flowruntime.Identity{Protocol: flowruntime.Protocol, RuntimeArtifactDigest: strings.Repeat("a", 64), SourceRevision: strings.Repeat("b", 40), OwnerGeneration: 1}
		if r.URL.Path == "/health" {
			_ = json.NewEncoder(w).Encode(map[string]any{"runtimeBridge": identity})
			return
		}
		var input map[string]any
		if json.NewDecoder(r.Body).Decode(&input) != nil {
			w.WriteHeader(400)
			return
		}
		value := map[string]any{}
		if r.URL.Path == "/runtime/v1/observe" {
			status := "running"
			if completed.Load() {
				status = "completed"
			}
			value = map[string]any{"run": flowruntime.Run{RunID: "live-run", FlowID: selected.Load().(string), Status: status}, "events": []any{}, "nextCursor": "", "hasMore": false, "terminal": completed.Load()}
		} else {
			operation := input["operation"].(string)
			receipt := flowruntime.Receipt{Tag: "Accepted", RunID: "live-run"}
			if operation == "launch" {
				launches.Add(1)
				selected.Store(input["flowId"].(string))
			}
			value = map[string]any{"operation": operation, "applicationRequestId": input["applicationRequestId"], "ownerGeneration": 1, "runtimeArtifactDigest": identity.RuntimeArtifactDigest, "sourceRevision": identity.SourceRevision, "receipt": receipt}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"protocol": flowruntime.Protocol, "ok": true, "value": value})
	}))
	defer host.Close()
	bridge, err := runtimebridge.New(runtimebridge.Config{Endpoint: host.URL, Credential: "fixture-token"})
	require.NoError(t, err)
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: f.store, ObservationDelay: time.Millisecond, MaxObservationDelay: 5 * time.Millisecond, Resolver: flowruntime.ResolverFunc(func(context.Context, flowruntime.Target) (flowruntime.Runtime, error) { return bridge, nil })})
	require.NoError(t, err)
	f.o.service.SetLauncher(dispatcher)
	f.role.SetFlowDispatcher(dispatcher)
	_, err = f.commit(t, "request")
	require.NoError(t, err)
	claim := f.claim(t)
	scope := repositoryJobFlowScope(f.o.repoID, f.o.userID)
	operation, err := f.store.Get(ctx, scope, uuidString(claim.OperationID))
	require.NoError(t, err)
	_, err = dispatcher.CancelRequest(ctx, scope, operation.RequestID)
	require.NoError(t, err)
	runCtx, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() {
		done <- dispatcher.RunWorker(runCtx, jobs.WorkerConfig{WorkerID: "ownership-real-http", Capacity: 1, Lease: 2 * time.Second, PollInterval: time.Millisecond, RetryDelay: time.Millisecond})
	}()
	defer func() {
		cancel()
		select {
		case e := <-done:
			require.NoError(t, e)
		case <-time.After(5 * time.Second):
			t.Error("worker did not stop")
		}
	}()
	require.Eventually(t, func() bool {
		op, e := f.store.Get(ctx, scope, operation.ID)
		return e == nil && op.State == jobs.StateCancelled
	}, 5*time.Second, 5*time.Millisecond)
	require.Zero(t, launches.Load(), "cancellation before external launch creates no runtime execution")
	// The domain explicitly ends this item; a role can acquire the now quiet issue.
	item := f.o.item(f.issue.Number)
	item.State = "cancelled"
	_, err = db.New(f.pool).SaveMythicalItem(ctx, item)
	require.NoError(t, err)
	f.wake(t)
	fresh := f.claim(t)
	require.Equal(t, "repository-job", fresh.OwnerKind)
	require.NotEqual(t, claim.ID, fresh.ID)
	require.Eventually(t, func() bool {
		op, e := f.store.Get(ctx, scope, uuidString(fresh.OperationID))
		return e == nil && op.State == jobs.StateWaiting && strings.Contains(string(op.ExternalReceipt), "live-run")
	}, 5*time.Second, 5*time.Millisecond)
	require.EqualValues(t, 1, launches.Load())
	require.Zero(t, unauthenticated.Load())
	// Requests are accepted, but the actual run remains the only active owner.
	_, err = f.commit(t, "request")
	_, owned := factoryIssueOwned(err)
	require.True(t, owned)
	completed.Store(true)
	require.Eventually(t, func() bool {
		op, e := f.store.Get(ctx, scope, uuidString(fresh.OperationID))
		return e == nil && op.State == jobs.StateCompleted
	}, 5*time.Second, 5*time.Millisecond)
	_, err = f.commit(t, "request")
	require.NoError(t, err)
	require.Equal(t, "mythical", f.claim(t).OwnerKind)
}

func TestFactoryIssueOwnershipAdmissionAuthorityAndRollback(t *testing.T) {
	f := newFactoryOwnershipFixture(t)
	ctx := context.Background()
	q := db.New(f.pool)
	regs, err := q.ListRepositoryJobRegistrations(ctx, f.o.repoID)
	require.NoError(t, err)
	require.Len(t, regs, 1)
	reg := regs[0]
	require.NoError(t, q.EnqueueRepositoryJobDispatch(ctx, db.EnqueueRepositoryJobDispatchParams{ID: reg.ID, Revision: reg.Revision, DeliveryKey: "authority", Source: "github", EventType: "issues", EventAction: "labeled", IssueNumber: f.issue.Number, Payload: f.payload, Status: "queued"}))
	dispatch := f.dispatches(t)[0]
	scope := repositoryJobFlowScope(reg.RepositoryID, reg.UserID)
	var base map[string]any
	require.NoError(t, json.Unmarshal(repositoryJobFlowAuthorization(reg, dispatch), &base))
	count := func() {
		t.Helper()
		var n int
		require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM factory_issue_claims WHERE repository_id=$1`, f.o.repoID).Scan(&n))
		require.Zero(t, n, "refusal never acquires durable ownership")
	}
	for _, field := range []string{"userId", "workspaceId", "repositoryId", "registrationId", "dispatchId", "revision", "digest"} {
		t.Run(field, func(t *testing.T) {
			auth := map[string]any{}
			for k, v := range base {
				auth[k] = v
			}
			auth[field] = "foreign"
			raw, err := json.Marshal(auth)
			require.NoError(t, err)
			_, err = f.dispatcher.Admit(ctx, flowdispatch.LaunchRequest{Scope: scope, RequestID: "invalid-" + field, Target: repositoryJobFlowTarget(reg, dispatch), FlowID: reg.FlowID, Payload: json.RawMessage(`{}`), AuthorizationContext: raw})
			var refusal *pgconn.PgError
			require.ErrorAs(t, err, &refusal)
			require.Equal(t, "P2082", refusal.Code)
			count()
		})
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	_, err = f.dispatcher.Admit(cancelled, flowdispatch.LaunchRequest{Scope: scope, RequestID: "cancel-before-admission", Target: repositoryJobFlowTarget(reg, dispatch), FlowID: reg.FlowID, Payload: json.RawMessage(`{}`), AuthorizationContext: repositoryJobFlowAuthorization(reg, dispatch)})
	require.ErrorIs(t, err, context.Canceled)
	count()
	tx, err := f.pool.Begin(ctx)
	require.NoError(t, err)
	_, err = f.dispatcher.AdmitInTx(ctx, tx, flowdispatch.LaunchRequest{Scope: scope, RequestID: "rolled-back", Target: repositoryJobFlowTarget(reg, dispatch), FlowID: reg.FlowID, Payload: json.RawMessage(`{}`), AuthorizationContext: repositoryJobFlowAuthorization(reg, dispatch)})
	require.NoError(t, err)
	require.NoError(t, tx.Rollback(ctx))
	count()
	// Only the reviewed literal actor/workspace/catalog identity can commit.
	_, err = f.role.admitRepositoryJobLaunch(ctx, reg, dispatch)
	require.NoError(t, err)
	require.Equal(t, dispatch.ID, f.claim(t).OwnerID)
}

func TestFactoryIssueOwnershipDeferredApprovalRevocation(t *testing.T) {
	for _, change := range []string{"edited", "unlabeled"} {
		t.Run(change, func(t *testing.T) {
			f := newFactoryOwnershipFixture(t)
			ctx := context.Background()
			_, err := f.commit(t, "request")
			require.NoError(t, err)
			claim := f.claim(t)
			f.wake(t)
			require.Contains(t, f.dispatches(t)[0].Error, claim.OwnerID)
			var payload map[string]any
			require.NoError(t, json.Unmarshal(f.payload, &payload))
			issue := payload["issue"].(map[string]any)
			if change == "edited" {
				issue["body"] = "replacement text"
			} else {
				issue["labels"] = []any{}
			}
			updated, err := json.Marshal(payload)
			require.NoError(t, err)
			require.NoError(t, f.role.AdmitGitHubEvent(ctx, f.o.repoID, db.GithubWebhookJob{DeliveryID: "revocation", Payload: updated}, TriggerEvent{Type: "issues", Action: change}))
			f.proof(t, uuidString(claim.OperationID), "cancelled", "cancelled")
			item := f.o.item(f.issue.Number)
			item.State = "cancelled"
			_, err = db.New(f.pool).SaveMythicalItem(ctx, item)
			require.NoError(t, err)
			f.wake(t)
			require.Equal(t, claim.ID, f.claim(t).ID, "stale queued payload cannot acquire the now quiet issue")
			blocked := f.dispatches(t)[0]
			require.Equal(t, "queued", blocked.Status)
			if change == "edited" {
				require.Contains(t, blocked.Error, "issue text changed")
			} else {
				require.Contains(t, blocked.Error, "trigger label was removed")
			}
			var launches int
			require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.launch' AND tenant_id=$1`, repositoryJobFlowScope(f.o.repoID, f.o.userID).TenantID).Scan(&launches))
			require.Equal(t, 1, launches)
		})
	}
}

func TestFactoryIssueOwnershipOnlyDefinitiveNoLaunchFailuresYield(t *testing.T) {
	for _, attempted := range []bool{false, true} {
		t.Run(fmt.Sprint(attempted), func(t *testing.T) {
			f := newFactoryOwnershipFixture(t)
			ctx := context.Background()
			require.NoError(t, f.role.PollOnce(ctx))
			claim := f.claim(t)
			_, err := f.pool.Exec(ctx, `UPDATE product_job_requests SET state='failed',terminal_receipt='{"kind":"runtime-failed"}' WHERE id=$1::uuid`, uuidString(claim.OperationID))
			require.NoError(t, err)
			if attempted {
				_, err = f.pool.Exec(ctx, `UPDATE product_job_dispatches SET external_started_at=now(),external_receipt='{"failureCode":"transport"}' WHERE operation_id=$1::uuid`, uuidString(claim.OperationID))
				require.NoError(t, err)
			}
			_, err = f.commit(t, "request")
			if attempted {
				_, owned := factoryIssueOwned(err)
				require.True(t, owned)
				require.Equal(t, claim.ID, f.claim(t).ID)
			} else {
				require.NoError(t, err)
				require.NotEqual(t, claim.ID, f.claim(t).ID)
				require.Equal(t, "mythical", f.claim(t).OwnerKind)
			}
		})
	}
}

func TestFactoryIssueOwnershipDirectFactoryAndOrdinaryJobsRemainIndependent(t *testing.T) {
	for _, factory := range []bool{true, false} {
		t.Run(fmt.Sprint(factory), func(t *testing.T) {
			f := newFactoryOwnershipFixture(t)
			ctx := context.Background()
			q := db.New(f.pool)
			regs, err := q.ListRepositoryJobRegistrations(ctx, f.o.repoID)
			require.NoError(t, err)
			reg := regs[0]
			var config RegisterRepositoryJobInput
			require.NoError(t, json.Unmarshal(reg.Configuration, &config))
			config.Label = ""
			if !factory {
				config.FactoryRevision = ""
			}
			encoded, err := json.Marshal(config)
			require.NoError(t, err)
			_, err = f.pool.Exec(ctx, `UPDATE repository_job_registrations SET configuration=$2::jsonb WHERE id=$1`, reg.ID, encoded)
			require.NoError(t, err)
			require.NoError(t, f.role.PollOnce(ctx))
			dispatches := f.dispatches(t)
			require.Len(t, dispatches, 1)
			require.Equal(t, "waiting", dispatches[0].Status)
			var owned int
			require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM factory_issue_claims WHERE repository_id=$1`, f.o.repoID).Scan(&owned))
			require.Zero(t, owned, "direct read/reply registrations do not suppress implementation admission")
			_, err = f.commit(t, "request")
			require.NoError(t, err)
			require.Equal(t, "mythical", f.claim(t).OwnerKind)
			var launches int
			require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE tenant_id=$1 AND operation='flow.runtime.launch'`, repositoryJobFlowScope(f.o.repoID, f.o.userID).TenantID).Scan(&launches))
			require.Equal(t, 2, launches, "ordinary approved direct event remains independent")
		})
	}
}
