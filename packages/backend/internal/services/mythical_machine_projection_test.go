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
	o.service.SetInstallParallel(nil)
	require.Error(t, o.service.publishMachineQueueProjection(ctx))
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	require.Error(t, o.service.publishMachineQueueProjection(cancelled))
	after, err = store.Head(ctx, scope)
	require.NoError(t, err)
	require.Equal(t, stable, after)
}
