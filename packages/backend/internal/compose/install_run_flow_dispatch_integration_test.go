package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/stretchr/testify/require"
)

func TestInstallOwnRunFlowDispatchPostgres(t *testing.T) { testInstallOwnRunFlowDispatchPostgres(t) }

// The production HTTP, PostgreSQL admission, target resolver and jobs worker
// are real. Only guest transport is controlled: no microVM exists on this host.
func testInstallOwnRunFlowDispatchPostgres(t *testing.T) map[string]any {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	ws, err := f.q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.other.ID, Name: "child-flow-parent", Kind: "vm", Status: "running", TargetBookmark: "smithers/parent"})
	require.NoError(t, err)
	var number int64
	require.NoError(t, f.pool.QueryRow(f.ctx, `INSERT INTO mythical_items(repository_id,source,state,stack_position,title,workspace_id,request_run_id,owner_id,created_by,attempt,flow_digest,checks) VALUES($1,'todo','running',1,'Member parent',$2,'parent-run',$3,$3,1,$4,jsonb_build_object('flowSource',$5::text)) RETURNING number`, f.repoID, ws.ID, f.other.ID, strings.Repeat("c", 64), strings.Repeat("b", 40)).Scan(&number))
	item, err := f.q.GetMythicalItemByNumber(f.ctx, f.repoID, number)
	require.NoError(t, err)
	_, err = f.pool.Exec(f.ctx, `INSERT INTO mythical_lanes(workspace_id,repository_id,item_id,name) VALUES($1,$2,$3,'parent')`, ws.ID, f.repoID, item.ID)
	require.NoError(t, err)
	scopes := "write:repository," + middleware.RepositoryRestrictionScope(f.repoID) + "," + middleware.LandingWorkspaceScope(ws.ID) + "," + middleware.AgentSessionRestrictionScope("parent-run")
	token := f.token(f.other, "member-parent-run", scopes, true)
	sum := sha256.Sum256([]byte(token))
	hash := hex.EncodeToString(sum[:])
	store, err := jobs.NewStore(f.pool)
	require.NoError(t, err)
	runtime := &installFlowRuntime{launches: make(chan flowruntime.Launch, 8)}
	runtime.finished.Store(true)
	hosts, catalog := presenceHostBinding(t, f.pool, ws, f.other.ID)
	_, err = f.pool.Exec(f.ctx, `UPDATE flow_runtime_host_bindings SET source_revision=$2 WHERE workspace_id=$1`, ws.ID, strings.Repeat("b", 40))
	require.NoError(t, err)
	targetResolver := browserFlowTarget{queries: f.q, install: f.q}
	targets := make(chan flowruntime.Target, 8)
	dispatcher, err := flowdispatch.New(flowdispatch.Config{Store: store, ObservationDelay: time.Millisecond, MaxObservationDelay: 2 * time.Millisecond, Resolver: flowruntime.ResolverFunc(func(ctx context.Context, target flowruntime.Target) (flowruntime.Runtime, error) {
		authority, err := targetResolver.ResolveFlowHostTarget(ctx, target)
		if err != nil {
			return nil, err
		}
		if authority.UserID != f.other.ID || authority.WorkspaceID != ws.ID || authority.SourceRevision != strings.Repeat("b", 40) {
			return nil, fmt.Errorf("child escaped parent: %+v", authority)
		}
		lease, err := hosts.AcquireExisting(ctx, authority, catalog)
		if err != nil {
			return nil, err
		}
		if err := lease.Close(); err != nil {
			return nil, err
		}
		select {
		case targets <- target:
		default:
		}
		return runtime, nil
	})})
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Auth.SessionCookieName = "selfhost", "session"
	server := httptest.NewUnstartedServer(nil)
	cfg.Server.PublicURL = "http://" + server.Listener.Addr().String()
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	router := hostStatusProductionRouter(cfg, f.q, &services.InstallCapacityService{Queries: f.q}, conformanceServices{pool: f.pool, flowRuns: &services.InstallFlowRuns{Pool: f.pool, Queries: f.q, Dispatcher: dispatcher, Jobs: store}, mythical: &routes.MythicalHandler{Service: services.NewMythicalService(f.pool, nil)}})
	server.Config.Handler = router
	server.Start()
	t.Cleanup(server.Close)
	call := func(t *testing.T, rawToken, path, body, key string, status int) []byte {
		t.Helper()
		request, err := http.NewRequestWithContext(f.ctx, "POST", server.URL+path, strings.NewReader(body))
		require.NoError(t, err)
		request.Header.Set("Authorization", "Bearer "+rawToken)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", cfg.Server.PublicURL)
		request.Header.Set("Idempotency-Key", key)
		request.Header.Set("Smithers-Actor", "person")
		request.Header.Set("Smithers-Via", "smithers")
		// Instrument the same composed router request without changing its identity.
		var decisions []string
		local := request.Clone(services.WithAuthorizationObserver(request.Context(), func(command string) { decisions = append(decisions, command) }))
		local.RemoteAddr = "127.0.0.1:50999"
		out := httptest.NewRecorder()
		router.ServeHTTP(out, local)
		require.Equal(t, status, out.Code, out.Body.String())
		if status != 401 {
			require.Equal(t, []string{"flow.run"}, decisions)
		}
		// Also cross a real HTTP socket; a replay must observe the same authority.
		request.Body, err = request.GetBody()
		require.NoError(t, err)
		reply, err := server.Client().Do(request)
		require.NoError(t, err)
		defer reply.Body.Close()
		require.Equal(t, status, reply.StatusCode)
		return out.Body.Bytes()
	}
	body := fmt.Sprintf(`{"name":"canary","workspaceId":%q,"input":{"hello":"guest"}}`, ws.ID)
	for _, cell := range []struct{ name, token, body string }{
		{"other branch", token, strings.Replace(body, ws.ID, "00000000-0000-4000-8000-000000000001", 1)},
		{"other run", f.token(f.other, "other-run", strings.Replace(scopes, "parent-run", "other-run", 1), true), body},
		{"machine", f.token(f.other, "machine", "write:repository,"+middleware.RepositoryRestrictionScope(f.repoID)+","+middleware.WorkspaceRestrictionScope(ws.ID), true), body},
		{"read only", f.token(f.other, "reader", strings.Replace(scopes, "write:repository", "read:repository", 1), true), body},
		{"reserved", token, strings.Replace(body, "canary", "merge", 1)},
	} {
		t.Run(cell.name, func(t *testing.T) {
			out := call(t, cell.token, "/api/flows", cell.body, cell.name, 403)
			require.Contains(t, string(out), `"code":"permission"`)
		})
	}
	var count int
	require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT count(*) FROM product_job_requests WHERE operation=$1`, flowdispatch.OperationLaunch).Scan(&count))
	require.Zero(t, count)
	out := call(t, token, "/api/flows", body, "child", 202)
	var receipt jobs.RequestReceipt
	require.NoError(t, json.Unmarshal(out, &receipt))
	require.NotEmpty(t, receipt.OperationID)
	again := call(t, token, "/api/flows/canary/run", body, "child", 202)
	require.JSONEq(t, string(out), string(again))
	call(t, token, "/api/flows", strings.Replace(body, "guest", "changed", 1), "child", 409)
	require.Zero(t, runtime.started.Load(), "HTTP admission never resolves a host")
	workerCtx, cancel := context.WithCancel(f.ctx)
	done := make(chan error, 1)
	go func() {
		done <- dispatcher.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: "run-flow-proof", Capacity: 1, Lease: time.Second, PollInterval: time.Millisecond})
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("worker did not stop")
		}
	})
	require.Eventually(t, func() bool {
		op, err := store.Get(f.ctx, jobs.Scope{TenantID: fmt.Sprintf("repository:%d", f.repoID), PrincipalID: fmt.Sprintf("user:%d", f.other.ID)}, receipt.OperationID)
		return err == nil && op.State == jobs.StateCompleted
	}, 5*time.Second, 10*time.Millisecond)
	require.Equal(t, int64(1), runtime.started.Load())
	var target flowruntime.Target
	select {
	case target = <-targets:
	default:
		t.Fatal("worker never resolved the parent")
	}
	require.Equal(t, services.InstallRunFlowBinding, target.BindingKind)
	require.NotContains(t, target.BindingID, token, "no bearer persisted")
	// A lost parent host cannot become a fresh host with a newly minted credential.
	realResolver, err := flowhost.New(flowhost.Config{Store: hosts, Targets: targetResolver, Launcher: refusingHostTransport{url: "http://127.0.0.1:1"}, Catalogs: []flowhost.Catalog{catalog}})
	require.NoError(t, err)
	_, err = (installFlowResolver{realResolver}).ResolveFlowRuntime(f.ctx, target)
	require.ErrorContains(t, err, "runtime_host_not_running")
	var hostCount int
	require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT count(*) FROM flow_runtime_host_bindings WHERE workspace_id=$1 AND user_id=$2 AND owner_generation=1 AND state='running'`, ws.ID, f.other.ID).Scan(&hostCount))
	require.Equal(t, 1, hostCount)
	// Every worker reconnect uses the original attempt, never its replacement.
	for _, cell := range []struct{ name, sql, undo string }{
		{"paused", `UPDATE mythical_items SET paused_at=now() WHERE repository_id=$1`, `UPDATE mythical_items SET paused_at=NULL WHERE repository_id=$1`},
		{"generation", `UPDATE mythical_items SET generation=generation+1 WHERE repository_id=$1`, `UPDATE mythical_items SET generation=generation-1 WHERE repository_id=$1`},
		{"attempt", `UPDATE mythical_items SET attempt=2,request_run_id='replacement' WHERE repository_id=$1`, `UPDATE mythical_items SET attempt=1,request_run_id='parent-run' WHERE repository_id=$1`},
		{"pin", `UPDATE mythical_items SET flow_digest=repeat('d',64) WHERE repository_id=$1`, `UPDATE mythical_items SET flow_digest=repeat('c',64) WHERE repository_id=$1`},
	} {
		t.Run(cell.name, func(t *testing.T) {
			_, err := f.pool.Exec(f.ctx, cell.sql, f.repoID)
			require.NoError(t, err)
			_, err = targetResolver.ResolveFlowHostTarget(f.ctx, target)
			require.Error(t, err)
			_, err = f.pool.Exec(f.ctx, cell.undo, f.repoID)
			require.NoError(t, err)
		})
	}
	// Suspension is visible on the next HTTP request and worker resolution.
	_, err = f.pool.Exec(f.ctx, `UPDATE collaborators SET suspended_at=now() WHERE repository_id=$1 AND user_id=$2`, f.repoID, f.other.ID)
	require.NoError(t, err)
	start := time.Now()
	dead := call(t, token, "/api/flows", body, "after-suspend", 401)
	require.Contains(t, string(dead), "unauthenticated")
	require.Less(t, time.Since(start), 5*time.Second)
	_, err = targetResolver.ResolveFlowHostTarget(f.ctx, target)
	require.Error(t, err)
	require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT count(*) FROM product_job_requests WHERE operation=$1`, flowdispatch.OperationLaunch).Scan(&count))
	require.Equal(t, 1, count)
	return map[string]any{"credential_hash": hash, "sponsor": f.other.ID, "workspace": ws.ID, "todo": number, "run": "parent-run", "operation": receipt.OperationID, "state": "completed", "runtime": "controlled guest transport"}
}
