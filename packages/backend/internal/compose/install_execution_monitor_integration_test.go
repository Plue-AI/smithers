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

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// This VM has no guest runtime. Only the guest monitor wire response is a
// fixture; credentials, TODO/lane bindings, admission and HTTP composition use
// PostgreSQL. Native journal folding remains a separate runtime qualification.
type executionTraceReader struct {
	workspace string
	calls     int
	before    func()
	invalid   bool
}

func (r *executionTraceReader) Monitor(_ context.Context, target flowruntime.Target, run string, at *int64) (json.RawMessage, error) {
	r.calls++
	if target.WorkspaceID != r.workspace || run != "trace-run" {
		return nil, fmt.Errorf("foreign reader binding")
	}
	if r.before != nil {
		r.before()
	}
	if r.invalid {
		return json.RawMessage(`{"id":"trace-run","journal":[{"type":"control.engine.event","seq":1,"at":"bad","text":"invalid-private"}]}`), nil
	}
	raw := json.RawMessage(`{"id":"trace-run","flow":"todo","state":"running","title":"private-title","secrets":["private-secret"],"roster":["private-roster"],"view":"private-view","waits":[{"kind":"approval","label":"private-approval"}],"engine":[{"detail":"private-conversation"}],"attempts":[{"input":"private-input","output":"private-output"}],"journal":[{"seq":1,"at":"2026-10-07T00:00:01Z","type":"control.engine.event","text":"{\"eventType\":\"flows.engine.node-settled\",\"payload\":{\"nodeId\":\"check\",\"action\":\"coding/check-command\",\"outcome\":\"built\",\"result\":\"private-result\",\"input\":\"private-prompt\"}}"},{"seq":2,"at":"2026-10-07T00:00:02Z","type":"conversation","text":"private-chat"}]}`)
	if at == nil {
		return raw, nil
	}
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	rows := []any{}
	for _, row := range value["journal"].([]any) {
		if row.(map[string]any)["seq"].(float64) <= float64(*at) {
			rows = append(rows, row)
		}
	}
	value["journal"] = rows
	return json.Marshal(value)
}

func TestInstallExecutionMonitorPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	pool, err := postgresfixture.Open(f.ctx, f.pool.Config().ConnConfig.ConnString(), 1)
	require.NoError(t, err)
	defer pool.Close()
	q := db.New(pool)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Auth.SessionCookieName = "selfhost", "session"
	cfg.Server.PublicURL = "http://example.com"
	workspaces := make([]db.Workspace, 2)
	for i := range workspaces {
		ws, err := f.q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.owner.ID, Name: fmt.Sprintf("trace-%d", i), Kind: "container", Status: "running", TargetBookmark: fmt.Sprintf("todo/%d", i+1)})
		require.NoError(t, err)
		workspaces[i] = ws
		run := "trace-run"
		if i == 1 {
			run = "other-run"
		}
		var item pgtype.UUID
		require.NoError(t, f.pool.QueryRow(f.ctx, `INSERT INTO mythical_items(repository_id,source,state,number,stack_position,title,workspace_id,request_run_id,owner_id,created_by,attempt) VALUES($1,'todo','running',$2,$2,'Execution trace',$3,$4,$5,$5,1) RETURNING id`, f.repoID, i+1, ws.ID, run, f.owner.ID).Scan(&item))
		_, _, err = f.q.BindMythicalLane(f.ctx, db.MythicalLane{RepositoryID: f.repoID, WorkspaceID: ws.ID, ItemID: item, Name: fmt.Sprintf("trace-%d", i)})
		require.NoError(t, err)
	}
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", f.repoID), PrincipalID: fmt.Sprintf("user:%d", f.owner.ID)}
	_, err = store.Admit(f.ctx, jobs.Admission{Scope: scope, Operation: flowdispatch.OperationLaunch, RequestID: "execution-trace", Payload: json.RawMessage(`{}`), AuthorizationContext: json.RawMessage(`{}`), EffectPolicy: jobs.EffectReconcile})
	require.NoError(t, err)
	claim, err := store.Claim(f.ctx, "execution-trace", time.Minute)
	require.NoError(t, err)
	cp, err := json.Marshal(flowdispatch.RuntimeCheckpoint{RunID: "trace-run", FlowID: "todo", ExecutionDigest: strings.Repeat("a", 64), Target: flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, WorkspaceID: workspaces[0].ID}})
	require.NoError(t, err)
	_, err = store.BeginExternal(f.ctx, claim, json.RawMessage(`{"kind":"launching"}`))
	require.NoError(t, err)
	require.NoError(t, store.Park(f.ctx, claim, cp, time.Hour))
	reader := &executionTraceReader{workspace: workspaces[0].ID}
	router := hostStatusProductionRouter(cfg, q, &services.InstallCapacityService{}, conformanceServices{pool: pool})
	mountRunMonitors(router, cfg, q, &runMonitors{pool: pool, reader: reader})
	base := "read:repository," + middleware.RepositoryRestrictionScope(f.repoID) + "," + middleware.AgentSessionRestrictionScope("trace-run") + ","
	run := f.token(f.owner, "trace-own-run", base+middleware.LandingWorkspaceScope(workspaces[0].ID), true)
	machine := f.token(f.owner, "trace-own-machine", base+middleware.WorkspaceRestrictionScope(workspaces[0].ID), true)
	unbound := f.token(f.owner, "trace-unbound-machine", "read:repository,"+middleware.RepositoryRestrictionScope(f.repoID)+","+middleware.WorkspaceRestrictionScope(workspaces[0].ID), true)
	wrongScope := f.token(f.owner, "trace-wrong-scope", strings.Replace(base, "read:repository", "read:user", 1)+middleware.LandingWorkspaceScope(workspaces[0].ID), true)
	call := func(t *testing.T, token, path string, status, reads int) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest("GET", cfg.Server.PublicURL+path, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		var commands []string
		req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { commands = append(commands, command) }))
		before := reader.calls
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		require.Equal(t, status, out.Code, out.Body.String())
		require.Equal(t, []string{"monitor"}, commands)
		require.Equal(t, before+reads, reader.calls)
		require.NotContains(t, out.Body.String(), "private-")
		return out
	}
	for _, actor := range []struct{ name, token string }{{"run", run}, {"machine", machine}} {
		for _, cell := range []struct {
			name, path    string
			status, reads int
		}{
			{"own", "/api/runs/trace-run", 200, 1}, {"replay", "/api/runs/trace-run/trace?at=1", 200, 1}, {"trace", "/api/runs/" + workspaces[0].ID + ":trace-run/trace", 200, 1},
			{"global", "/api/runs", 403, 0}, {"other run", "/api/runs/other-run/trace", 403, 0}, {"other workspace", "/api/runs/" + workspaces[1].ID + ":trace-run/trace", 403, 0},
			{"missing", "/api/runs/missing/trace", 403, 0}, {"invalid replay", "/api/runs/trace-run/trace?at=-1", 400, 0},
		} {
			t.Run(actor.name+"/"+cell.name, func(t *testing.T) {
				out := call(t, actor.token, cell.path, cell.status, cell.reads)
				if cell.status == 200 {
					var value map[string]any
					require.NoError(t, json.Unmarshal(out.Body.Bytes(), &value))
					require.Equal(t, float64(1), value["todo"])
					require.Equal(t, float64(1), value["attempt"])
					require.Len(t, value, 7)
					events := value["events"].([]any)
					require.Len(t, events, 1)
					require.Equal(t, map[string]any{"seq": float64(1), "at": "2026-10-07T00:00:01Z", "type": "flows.engine.node-settled", "node": "check", "action": "coding/check-command", "outcome": "built"}, events[0])
				}
			})
		}
	}
	t.Run("machine needs a run restriction", func(t *testing.T) { call(t, unbound, "/api/runs/trace-run/trace", 403, 0) })
	t.Run("repository scope required", func(t *testing.T) { call(t, wrongScope, "/api/runs/trace-run/trace", 403, 0) })
	for _, mutation := range []struct{ name, sql, undo string }{
		{"replaced run", `UPDATE mythical_items SET request_run_id='replacement' WHERE repository_id=$1 AND number=1`, `UPDATE mythical_items SET request_run_id='trace-run' WHERE repository_id=$1 AND number=1`},
		{"sponsor", fmt.Sprintf(`UPDATE mythical_items SET owner_id=%d WHERE repository_id=$1 AND number=1`, f.other.ID), fmt.Sprintf(`UPDATE mythical_items SET owner_id=%d WHERE repository_id=$1 AND number=1`, f.owner.ID)},
		{"retired lane", `UPDATE mythical_lanes SET retired_at=now() WHERE repository_id=$1`, `UPDATE mythical_lanes SET retired_at=NULL WHERE repository_id=$1`},
	} {
		t.Run(mutation.name, func(t *testing.T) {
			_, err := f.pool.Exec(f.ctx, mutation.sql, f.repoID)
			require.NoError(t, err)
			defer func() { _, err := f.pool.Exec(f.ctx, mutation.undo, f.repoID); require.NoError(t, err) }()
			call(t, run, "/api/runs/trace-run/trace", 403, 0)
			call(t, machine, "/api/runs/trace-run/trace", 403, 0)
		})
	}

	t.Run("checkpoint cannot select a different workspace", func(t *testing.T) {
		update := func(workspace string) {
			_, err := f.pool.Exec(f.ctx, `UPDATE product_job_dispatches SET external_receipt=jsonb_set(external_receipt,'{target,WorkspaceID}',to_jsonb($1::text)) WHERE external_receipt->>'runId'='trace-run'`, workspace)
			require.NoError(t, err)
		}
		update(workspaces[1].ID)
		defer update(workspaces[0].ID)
		call(t, run, "/api/runs/trace-run/trace", 403, 0)
	})
	t.Run("person reads retained item without checks", func(t *testing.T) {
		raw := "trace-person"
		sum := sha256.Sum256([]byte(raw))
		_, err := f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: f.owner.ID, Username: f.owner.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		req := httptest.NewRequest("GET", cfg.Server.PublicURL+"/api/runs/trace-run", nil)
		req.AddCookie(&http.Cookie{Name: "session", Value: raw})
		var commands []string
		req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { commands = append(commands, command) }))
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		require.Equal(t, 200, out.Code, out.Body.String())
		require.Equal(t, []string{"monitor"}, commands)
		var value map[string]any
		require.NoError(t, json.Unmarshal(out.Body.Bytes(), &value))
		require.Equal(t, "trace-run", value["id"])
	})
	t.Run("bound decision cannot follow a replacement attempt", func(t *testing.T) {
		sum := sha256.Sum256([]byte(run))
		hash := hex.EncodeToString(sum[:])
		stored, err := f.q.GetAuthInfoByTokenHash(f.ctx, hash)
		require.NoError(t, err)
		scopes := base + middleware.LandingWorkspaceScope(workspaces[0].ID)
		ctx := middleware.ContextWithAuthInfo(f.ctx, &middleware.AuthInfo{User: &f.owner, IsTokenAuth: true, TokenSystemIssued: true, TokenID: stored.TokenID, TokenHash: hash, RawScopes: scopes, Scopes: middleware.ParseTokenScopes(scopes)})
		var commands []string
		ctx = services.WithAuthorizationObserver(ctx, func(command string) { commands = append(commands, command) })
		subject := services.InstallSubject{RepositoryID: f.repoID, WorkspaceID: workspaces[0].ID, TodoNumber: 1, Attempt: 1, RunID: "trace-run", Resource: "execution-trace"}
		decision, err := services.Authorize(ctx, f.q, "monitor", subject)
		require.NoError(t, err)
		ctx = services.WithInstallAuthorization(ctx, "monitor", decision, subject)
		_, err = f.pool.Exec(f.ctx, `UPDATE mythical_items SET attempt=2 WHERE repository_id=$1 AND number=1`, f.repoID)
		require.NoError(t, err)
		defer func() {
			_, err := f.pool.Exec(f.ctx, `UPDATE mythical_items SET attempt=1 WHERE repository_id=$1 AND number=1`, f.repoID)
			require.NoError(t, err)
		}()
		called := false
		_, err = services.ReadInstallExecutionMonitor(ctx, pool, f.repoID, "trace-run", func(context.Context, services.InstallSubject) (json.RawMessage, error) {
			called = true
			return nil, nil
		})
		var refusal *services.AccessError
		require.ErrorAs(t, err, &refusal)
		require.Equal(t, 403, refusal.Status)
		require.False(t, called)
		require.Equal(t, []string{"monitor"}, commands)
	})

	t.Run("native reader can use the one-connection pool", func(t *testing.T) {
		reader.before = func() {
			ctx, cancel := context.WithTimeout(f.ctx, time.Second)
			defer cancel()
			_, err := q.GetRepoByID(ctx, f.repoID)
			require.NoError(t, err)
		}
		defer func() { reader.before = nil }()
		call(t, run, "/api/runs/trace-run/trace", 200, 1)
	})
	t.Run("changed attempt during native read refuses disclosure", func(t *testing.T) {
		reader.before = func() {
			_, err := f.pool.Exec(f.ctx, `UPDATE mythical_items SET attempt=2 WHERE repository_id=$1 AND number=1`, f.repoID)
			require.NoError(t, err)
		}
		defer func() {
			reader.before = nil
			_, err := f.pool.Exec(f.ctx, `UPDATE mythical_items SET attempt=1 WHERE repository_id=$1 AND number=1`, f.repoID)
			require.NoError(t, err)
		}()
		call(t, run, "/api/runs/trace-run/trace", 403, 1)
	})
	t.Run("invalid journal is not disclosed", func(t *testing.T) {
		reader.invalid = true
		defer func() { reader.invalid = false }()
		call(t, run, "/api/runs/trace-run/trace", 503, 1)
	})
	t.Run("expiry during guest read refuses disclosure", func(t *testing.T) {
		sum := sha256.Sum256([]byte(run))
		deadline := time.Now().Add(2 * time.Second)
		_, err := f.pool.Exec(f.ctx, `UPDATE access_tokens SET expires_at=$2 WHERE token_hash=$1`, hex.EncodeToString(sum[:]), deadline)
		require.NoError(t, err)
		reader.before = func() { time.Sleep(time.Until(deadline) + 25*time.Millisecond) }
		defer func() { reader.before = nil }()
		call(t, run, "/api/runs/trace-run/trace", 401, 1)
	})
}
