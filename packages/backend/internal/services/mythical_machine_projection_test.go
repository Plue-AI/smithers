package services

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/stretchr/testify/require"
)

func TestParallelMachineQueueProjectionRollbackAndRetry(t *testing.T) {
	o, session := newTodoAdmission(t)
	first := o.fileTodo(session, "T1")
	second := o.fileTodo(session, "T2")
	runtime := new(microsandbox.Runtime)
	o.service.SetOrchestration(nil, nil, NewWorkspaceMythicalLanes(NewWorkspaceService(db.New(o.pool), WithWorkspaceRuntime(runtime))))
	capacity := &InstallCapacityService{Queries: db.New(o.pool), Profile: microsandbox.HostProfile{MemoryBytes: 32 << 30, PerfCores: 10, DiskFreeBytes: 400 << 30}}
	o.service.SetInstallParallel(capacity)
	ctx := t.Context()
	require.NoError(t, o.service.publishMachineQueueProjection(ctx))
	store, err := jobs.NewStore(o.pool.(*pgxpool.Pool))
	require.NoError(t, err)
	scope := jobs.RepositoryTodosScope(fmt.Sprint(o.repoID))
	head, err := store.Head(ctx, scope)
	require.NoError(t, err)
	itemHeads := map[string]int64{}
	for _, itemScope := range []jobs.Scope{todoOperationScope(first), todoOperationScope(second)} {
		itemHeads[itemScope.PrincipalID], err = store.Head(ctx, itemScope)
		require.NoError(t, err)
	}
	_, err = runtime.Request("person", "workspace:ben", "Ben", "machine")
	require.NoError(t, err)
	// A rejected receipt cannot advance either item or repository cursor.
	_, err = o.pool.Exec(ctx, fmt.Sprintf(`ALTER TABLE product_job_requests ADD CONSTRAINT stk03_queue_receipt_refusal CHECK(operation <> 'todo.machine.queue' OR principal_id <> '%s') NOT VALID`, todoOperationScope(second).PrincipalID))
	require.NoError(t, err)
	require.Error(t, o.service.publishMachineQueueProjection(ctx))
	after, err := store.Head(ctx, scope)
	require.NoError(t, err)
	require.Equal(t, head, after)
	for principal, before := range itemHeads {
		after, err := store.Head(ctx, jobs.Scope{TenantID: scope.TenantID, PrincipalID: principal})
		require.NoError(t, err)
		require.Equal(t, before, after)
	}
	_, err = o.pool.Exec(ctx, `ALTER TABLE product_job_requests DROP CONSTRAINT stk03_queue_receipt_refusal`)
	require.NoError(t, err)
	require.NoError(t, o.service.publishMachineQueueProjection(ctx))
	page, err := store.ReplayRepositoryTodos(ctx, scope.TenantID, head, 10)
	require.NoError(t, err)
	require.Len(t, page.Events, 2)
	for _, event := range page.Events {
		require.Equal(t, "todo.machine.queue", event.Type)
		var projection struct {
			Home struct {
				Items []struct {
					N     int `json:"n"`
					Queue struct {
						Position int `json:"position"`
					} `json:"queue"`
				} `json:"items"`
			} `json:"home"`
		}
		require.NoError(t, json.Unmarshal(event.Data, &projection))
		positions := map[int]int{}
		for _, item := range projection.Home.Items {
			positions[item.N] = item.Queue.Position
		}
		require.Equal(t, map[int]int{1: 2, 2: 3}, positions)
	}
	require.NoError(t, o.service.publishMachineQueueProjection(ctx))
	stable, err := store.Head(ctx, scope)
	require.NoError(t, err)
	require.Equal(t, page.Head, stable)
	// A busy item stream must not hold up the repository's source writer.
	_, err = runtime.Request("person", "workspace:alice", "Alice", "machine")
	require.NoError(t, err)
	blocked, err := o.pool.Begin(ctx)
	require.NoError(t, err)
	defer blocked.Rollback(context.Background())
	var lockedHead int64
	require.NoError(t, blocked.QueryRow(ctx, `SELECT head FROM product_job_streams WHERE tenant_id=$1 AND principal_id=$2 FOR UPDATE`, scope.TenantID, todoOperationScope(second).PrincipalID).Scan(&lockedHead))
	require.ErrorIs(t, o.service.publishMachineQueueProjection(ctx), errMachineProjectionBusy)
	after, err = store.Head(ctx, scope)
	require.NoError(t, err)
	require.Equal(t, stable, after)
	require.NoError(t, blocked.Rollback(ctx))
	require.NoError(t, o.service.publishMachineQueueProjection(ctx))
	stable, err = store.Head(ctx, scope)
	require.NoError(t, err)
	require.Equal(t, page.Head+2, stable)
	o.service.SetInstallParallel(nil)
	require.Error(t, o.service.publishMachineQueueProjection(ctx))
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	require.Error(t, o.service.publishMachineQueueProjection(cancelled))
	after, err = store.Head(ctx, scope)
	require.NoError(t, err)
	require.Equal(t, stable, after)
}

func TestScratchMachineProjectionRollbackAndRecovery(t *testing.T) {
	o, _ := newTodoAdmission(t)
	ctx := t.Context()
	q := db.New(o.pool)
	owner, err := q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	row, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: o.repoID, UserID: owner, Name: "notes", TargetBookmark: "scratch/owner/notes", Status: "suspended"})
	require.NoError(t, err)
	runtime := new(microsandbox.Runtime)
	o.service.SetOrchestration(nil, nil, NewWorkspaceMythicalLanes(NewWorkspaceService(q, WithWorkspaceRuntime(runtime))))
	store, err := jobs.NewStore(o.pool.(*pgxpool.Pool))
	require.NoError(t, err)
	scope := jobs.Scope{TenantID: fmt.Sprint(o.repoID), PrincipalID: "branch:" + row.ID + ":machine"}
	require.NoError(t, o.service.publishScratchMachineProjection(ctx))
	head, err := store.Head(ctx, scope)
	require.NoError(t, err)
	require.EqualValues(t, 1, head)
	_, err = runtime.Request("person", "workspace:"+row.ID, "owner", "terminal")
	require.NoError(t, err)
	_, err = o.pool.Exec(ctx, `ALTER TABLE product_job_requests ADD CONSTRAINT scratch_receipt_refusal CHECK(operation <> 'branch.machine') NOT VALID`)
	require.NoError(t, err)
	require.Error(t, o.service.publishScratchMachineProjection(ctx))
	after, err := store.Head(ctx, scope)
	require.NoError(t, err)
	require.Equal(t, head, after, "failed publication never advances a durable cursor")
	_, err = o.pool.Exec(ctx, `ALTER TABLE product_job_requests DROP CONSTRAINT scratch_receipt_refusal`)
	require.NoError(t, err)
	require.NoError(t, o.service.publishScratchMachineProjection(ctx))
	page, err := store.Replay(ctx, scope, head, 10)
	require.NoError(t, err)
	require.Len(t, page.Events, 1)
	require.Equal(t, "branch.machine", page.Events[0].Type)
	require.JSONEq(t, fmt.Sprintf(`{"branch":{"id":%q,"machine":{"state":"waiting","position":1}}}`, row.ID), string(page.Events[0].Data))
	recovered := NewMythicalService(o.pool, nil)
	recovered.SetOrchestration(nil, nil, NewWorkspaceMythicalLanes(NewWorkspaceService(q, WithWorkspaceRuntime(runtime))))
	require.NoError(t, recovered.publishScratchMachineProjection(ctx))
	stable, err := store.Head(ctx, scope)
	require.NoError(t, err)
	require.EqualValues(t, 2, stable)
}

func TestMachineGrantPublicationRollbackAndLostReply(t *testing.T) {
	o, _ := newTodoAdmission(t)
	ctx, q := t.Context(), db.New(o.pool)
	owner, err := q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	row, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: o.repoID, UserID: owner, Name: "grant", TargetBookmark: "scratch/owner/grant", Status: "suspended"})
	require.NoError(t, err)
	grant := microsandbox.AdmissionRequest{PublicationID: "11111111-1111-4111-8111-111111111111", Holder: "workspace:" + row.ID, Actor: "Alice", Class: "person", State: "granted"}
	scope := jobs.Scope{TenantID: fmt.Sprint(o.repoID), PrincipalID: "branch:" + row.ID + ":machine"}
	store, err := jobs.NewStore(o.pool.(*pgxpool.Pool))
	require.NoError(t, err)
	_, err = o.pool.Exec(ctx, `ALTER TABLE product_job_requests ADD CONSTRAINT grant_refused CHECK(operation <> 'branch.machine.granted') NOT VALID`)
	require.NoError(t, err)
	require.Error(t, o.service.PublishMachineGrant(ctx, grant))
	head, err := store.Head(ctx, scope)
	require.NoError(t, err)
	require.Zero(t, head)
	_, err = o.pool.Exec(ctx, `ALTER TABLE product_job_requests DROP CONSTRAINT grant_refused`)
	require.NoError(t, err)
	require.NoError(t, o.service.PublishMachineGrant(ctx, grant))
	// A committed source fact survives a lost acknowledgment and a new writer.
	recovered := NewMythicalService(o.pool, nil)
	require.NoError(t, recovered.PublishMachineGrant(ctx, grant))
	page, err := store.Replay(ctx, scope, 0, 10)
	require.NoError(t, err)
	require.Len(t, page.Events, 1)
	require.EqualValues(t, 1, page.Head)
	require.JSONEq(t, fmt.Sprintf(`{"branch":{"id":%q,"machine":{"state":"waking"}},"admission":{"holder":%q,"actor":"Alice","class":"person"}}`, row.ID, grant.Holder), string(page.Events[0].Data))
	require.Error(t, recovered.PublishMachineGrant(ctx, microsandbox.AdmissionRequest{Holder: grant.Holder}))
}

// A committed Branch receipt alone cannot acknowledge the grant if its TODO
// positions rolled back. Retry through a fresh service retains both cursors.
func TestMachineGrantWaitsForTodoProjectionCommit(t *testing.T) {
	o, session := newTodoAdmission(t)
	first := o.fileTodo(session, "T1")
	second := o.fileTodo(session, "T2")
	ctx, q := t.Context(), db.New(o.pool)
	runtime := new(microsandbox.Runtime)
	lanes := NewWorkspaceMythicalLanes(NewWorkspaceService(q, WithWorkspaceRuntime(runtime)))
	capacity := &InstallCapacityService{Queries: q, Profile: microsandbox.HostProfile{MemoryBytes: 32 << 30, PerfCores: 10, DiskFreeBytes: 400 << 30}}
	o.service.SetOrchestration(nil, nil, lanes)
	o.service.SetInstallParallel(capacity)
	require.NoError(t, o.service.publishMachineQueueProjection(ctx))
	owner, err := q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	branch, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: o.repoID, UserID: owner, Name: "source-barrier", TargetBookmark: "scratch/owner/source-barrier", Status: "suspended"})
	require.NoError(t, err)
	_, err = runtime.Request("person", "workspace:"+branch.ID, "Alice", "terminal")
	require.NoError(t, err)
	grant := microsandbox.AdmissionRequest{PublicationID: "22222222-2222-4222-8222-222222222222", Holder: "workspace:" + branch.ID, Class: "person", Actor: "Alice", State: "granted"}
	_, err = o.pool.Exec(ctx, fmt.Sprintf(`ALTER TABLE product_job_requests ADD CONSTRAINT grant_todo_refused CHECK(operation <> 'todo.machine.queue' OR principal_id <> '%s') NOT VALID`, todoOperationScope(second).PrincipalID))
	require.NoError(t, err)
	store, err := jobs.NewStore(o.pool.(*pgxpool.Pool))
	require.NoError(t, err)
	head, err := store.Head(ctx, todoOperationScope(first))
	require.NoError(t, err)
	require.Error(t, o.service.PublishMachineGrant(ctx, grant))
	unchanged, err := store.Head(ctx, todoOperationScope(first))
	require.NoError(t, err)
	require.Equal(t, head, unchanged)
	_, err = o.pool.Exec(ctx, `ALTER TABLE product_job_requests DROP CONSTRAINT grant_todo_refused`)
	require.NoError(t, err)
	recovered := NewMythicalService(o.pool, nil)
	recovered.SetOrchestration(nil, nil, lanes)
	recovered.SetInstallParallel(capacity)
	require.NoError(t, recovered.PublishMachineGrant(ctx, grant))
	require.NoError(t, recovered.PublishMachineGrant(ctx, grant))
	var count int
	require.NoError(t, o.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='branch.machine.granted' AND operation_id=$1`, grant.PublicationID).Scan(&count))
	require.Equal(t, 1, count)
	page, err := store.Replay(ctx, todoOperationScope(first), head, 10)
	require.NoError(t, err)
	require.Len(t, page.Events, 1)
	var fact struct {
		Card struct{ Queue struct{ Position int } }
	}
	require.NoError(t, json.Unmarshal(page.Events[0].Data, &fact))
	require.Equal(t, 2, fact.Card.Queue.Position)
}

func TestMachineGrantObservationRecoveryDoesNotRepublishMetadata(t *testing.T) {
	o, _ := newTodoAdmission(t)
	ctx, q := t.Context(), db.New(o.pool)
	owner, err := q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	row, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: o.repoID, UserID: owner, Name: "recovery", TargetBookmark: "scratch/owner/recovery", Status: "running"})
	require.NoError(t, err)
	grant := microsandbox.AdmissionRequest{PublicationID: "11111111-1111-4111-8111-111111111111", Holder: "workspace:" + row.ID, Actor: "Alice", Class: "person", State: "granted"}
	require.NoError(t, o.service.PublishMachineGrant(ctx, grant))
	recovered := NewMythicalService(o.pool, nil)
	recovered.SetOrchestration(nil, nil, NewWorkspaceMythicalLanes(NewWorkspaceService(q, WithWorkspaceRuntime(new(microsandbox.Runtime)))))
	require.NoError(t, recovered.publishScratchMachineProjection(ctx))
	store, err := jobs.NewStore(o.pool.(*pgxpool.Pool))
	require.NoError(t, err)
	head, err := store.Head(ctx, jobs.Scope{TenantID: fmt.Sprint(o.repoID), PrincipalID: "branch:" + row.ID + ":machine"})
	require.NoError(t, err)
	require.EqualValues(t, 1, head, "admission metadata is not another machine observation")
}
