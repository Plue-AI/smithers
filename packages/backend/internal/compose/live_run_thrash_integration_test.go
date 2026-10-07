package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The VM has no guest runtime. This reader pins the monitor wire contract;
// the real SQLite/native fold is qualified separately in GatewayServer.test.ts.
type monitorContractReader struct{}

func (monitorContractReader) Monitor(_ context.Context, target flowruntime.Target, run string, at *int64) (json.RawMessage, error) {
	if target.WorkspaceID != "monitor-box" || run != "thrash-run" {
		return nil, fmt.Errorf("foreign binding")
	}
	raw := json.RawMessage(`{"id":"thrash-run","flow":"todo","version":"","title":"todo","state":"running","attempts":[{"n":1,"run_id":"thrash-run","graph":[],"steps":[],"phases":[{"id":"phase:checks","step":"checks#1","title":"Ran checks","tone":"fail","took_s":0,"cells":[]}]}],"waits":[],"tokens":0,"time_s":0,"cost_usd":0,"engine":[]}`)
	if at == nil {
		return raw, nil
	}
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	journal := []map[string]any{}
	for sequence := int64(1); sequence <= 4 && sequence <= *at; sequence++ {
		action, receipt := "coding/check-command", `{"checkId":"unit","status":"failed","findings":[{"message":"failed src/retry.ts:42"}]}`
		if sequence == 4 {
			action, receipt = "coding/edit-atom", `{"writes":["src/retry.ts"]}`
		}
		preview, _ := json.Marshal(receipt)
		text := fmt.Sprintf(`{"version":1,"executionId":"native-%d","eventType":"flows.engine.node-settled","payload":{"nodeId":"step","action":%q,"outcome":"built","result":{"preview":%s,"truncated":false}}}`, sequence, action, preview)
		journal = append(journal, map[string]any{"seq": sequence, "at": fmt.Sprintf("2026-10-07T00:00:0%dZ", sequence), "type": "control.engine.event", "text": text})
	}
	if *at == 5 {
		journal = append(journal, map[string]any{"seq": 5, "type": "control.engine.event", "text": "repo-only-secret{"})
	}
	if *at == 6 {
		journal = append(journal, map[string]any{"seq": 7, "type": "control.engine.event", "text": `{}`})
	}
	value["journal"] = journal
	if *at == 3 {
		attempt := value["attempts"].([]any)[0].(map[string]any)
		attempt["phases"].([]any)[0].(map[string]any)["title"] = "Ran checks · 1 failed"
	}
	return json.Marshal(value)
}

func TestLiveTodoNativeThrash(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q, ctx := db.New(pool), t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "live-owner", LowerUsername: "live-owner", DisplayName: "Owner"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1);`, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, repo.ID, owner.ID)
	require.NoError(t, err)
	for key, value := range map[string]string{"github.repository": fmt.Sprintf(`{"owner_login":"live-owner","repository_name":"app","repository_id":%d}`, repo.ID), "owner.access": fmt.Sprintf(`{"owner_login":"live-owner","repository_name":"app","repository_id":%d,"last_access_check_at":"2026-10-07T00:00:00Z"}`, repo.ID)} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(value)}))
	}

	_, err = q.RequestMythicalBootstrap(ctx, repo.ID, owner.ID, 1, false)
	require.NoError(t, err)
	item, err := q.InsertMythicalTodo(ctx, repo.ID, owner.ID, "Checks", "Run checks", json.RawMessage(`[{"rev":1,"text":"Run checks"}]`), json.RawMessage(`{"todo":true,"run_launched":true,"flowSource":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}`))
	require.NoError(t, err)
	item.State, item.Attempt, item.RequestRunID = "running", 1, "thrash-run"
	item.FlowDigest = pgtype.Text{String: strings.Repeat("a", 64), Valid: true}
	item, err = q.SaveMythicalItem(ctx, item)
	require.NoError(t, err)
	token := "native-thrash-browser"
	hash := sha256.Sum256([]byte(token))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{SessionKey: hex.EncodeToString(hash[:]), UserID: owner.ID, Username: owner.Username, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	busCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	bus := revocation.NewBus(pool, q)
	require.NoError(t, bus.Start(busCtx))
	routes.SetRevocationSource(bus)
	defer routes.SetRevocationSource(nil)
	service := services.NewMythicalService(pool, nil)
	monitors := &runMonitors{pool: pool, reader: monitorContractReader{}}
	topics := &liveTopics{queries: q, todos: service}
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", repo.ID), PrincipalID: fmt.Sprintf("user:%d", owner.ID)}
	_, err = store.Admit(ctx, jobs.Admission{Scope: scope, Operation: flowdispatch.OperationLaunch, RequestID: "monitor-run", Payload: json.RawMessage(`{}`), AuthorizationContext: json.RawMessage(`{}`), EffectPolicy: jobs.EffectReconcile})
	require.NoError(t, err)
	claim, err := store.Claim(ctx, "monitor-fixture", time.Minute)
	require.NoError(t, err)
	checkpoint, err := json.Marshal(flowdispatch.RuntimeCheckpoint{RunID: "thrash-run", FlowID: "todo", ExecutionDigest: strings.Repeat("a", 64), Target: flowruntime.Target{TenantID: scope.TenantID, PrincipalID: scope.PrincipalID, WorkspaceID: "monitor-box", BindingKind: "mythical-item", BindingID: uuid.UUID(item.ID.Bytes).String()}})
	require.NoError(t, err)
	_, err = store.BeginExternal(ctx, claim, json.RawMessage(`{"kind":"launching"}`))
	require.NoError(t, err)
	require.NoError(t, store.Park(ctx, claim, checkpoint, time.Hour))
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	handler := &routes.LiveHandler{Hub: live.NewHub(ctx, nil), Queries: q, Origins: func() []string { return []string{origin} }, Topics: topics.resolver}
	router := hostStatusProductionRouter(cfg, q, &services.InstallCapacityService{}, conformanceServices{pool: pool, live: handler})
	mountRunMonitors(router, cfg, q, monitors)
	server.Config.Handler = router
	server.Start()
	defer server.Close()
	socket, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(origin, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{live.Protocol}, HTTPHeader: http.Header{"Cookie": {"smithers_session=" + token}, "Origin": {origin}}})
	require.NoError(t, err)
	defer socket.CloseNow()
	require.NoError(t, socket.Write(ctx, websocket.MessageText, []byte(fmt.Sprintf(`{"t":"sub","id":1,"topic":"todo:%d"}`, item.Number.Int64))))
	read := func() live.Frame {
		t.Helper()
		bounded, stop := context.WithTimeout(ctx, 5*time.Second)
		defer stop()
		_, raw, err := socket.Read(bounded)
		require.NoError(t, err)
		var f live.Frame
		require.NoError(t, json.Unmarshal(raw, &f))
		return f
	}
	require.Equal(t, "snap", read().T)
	projection, err := json.Marshal(map[string]any{"kind": "mythical-item", "itemId": uuid.UUID(item.ID.Bytes).String(), "generation": item.Generation, "attempt": 1, "phase": "todo", "flowDigest": strings.Repeat("a", 64), "flowSource": strings.Repeat("b", 40)})
	require.NoError(t, err)
	update := flowdispatch.ProjectionUpdate{State: jobs.StateWaiting, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: projection, FlowID: "todo", ExecutionDigest: strings.Repeat("a", 64), RunID: "thrash-run", Run: &flowruntime.Run{RunID: "thrash-run", FlowID: "todo", Status: "running"}}}
	for n := int64(1); n <= 3; n++ {
		preview, _ := json.Marshal(`{"checkId":"unit","status":"failed","findings":[{"message":"bad C:/checkout/src/retry.ts:42:4"}]}`)
		update.Events = []flowruntime.Event{{RunID: "thrash-run", Sequence: n, Kind: "control.engine.event", Payload: json.RawMessage(fmt.Sprintf(`{"version":1,"executionId":"child-%d","eventType":"flows.engine.node-settled","payload":{"nodeId":"check-%d","action":"coding/check-command","outcome":"built","result":{"preview":%s,"truncated":false}}}`, n, n, preview))}}
		require.NoError(t, service.ProjectFlowRuntime(ctx, update))
	}
	var frame live.Frame
	for {
		frame = read()
		if strings.Contains(string(frame.Data), "Thrashing: unit failed 3×") {
			break
		}
	}
	require.Contains(t, string(frame.Data), `"tone":"thrash"`)
	require.NoError(t, socket.Write(ctx, websocket.MessageText, []byte(`{"t":"sub","id":2,"topic":"run:thrash-run"}`)))
	for {
		f := read()
		if f.ID == 2 {
			require.Equal(t, "err", f.T)
			require.Equal(t, live.Unsupported, f.Code, "monitor HTTP composition never replaces the native journal topic")
			break
		}
	}
	httpRead := func(path string, authenticated bool) (int, []byte) {
		t.Helper()
		request, e := http.NewRequestWithContext(ctx, "GET", origin+path, nil)
		require.NoError(t, e)
		if authenticated {
			request.AddCookie(&http.Cookie{Name: "smithers_session", Value: token})
		}
		response, e := http.DefaultClient.Do(request)
		require.NoError(t, e)
		defer response.Body.Close()
		body, e := io.ReadAll(response.Body)
		require.NoError(t, e)
		return response.StatusCode, body
	}
	code, raw := httpRead("/api/runs/thrash-run/trace", true)
	require.Equal(t, 200, code)
	require.Contains(t, string(raw), `"tone":"thrash"`)
	code, raw = httpRead("/api/runs/monitor-box:thrash-run/trace", true)
	require.Equal(t, 200, code)
	require.Contains(t, string(raw), `"id":"monitor-box:thrash-run"`)
	code, raw = httpRead("/api/runs", true)
	require.Equal(t, 200, code)
	require.Contains(t, string(raw), `"id":"monitor-box:thrash-run"`)
	code, _ = httpRead("/api/runs/thrash-run/trace", false)
	require.Equal(t, 401, code)
	code, _ = httpRead("/api/runs/foreign-run/trace", true)
	require.Equal(t, 404, code)
	code, _ = httpRead("/api/runs/thrash-run/trace?at=-1", true)
	require.Equal(t, 400, code)
	code, raw = httpRead("/api/runs/thrash-run/trace?at=0", true)
	require.Equal(t, 200, code)
	require.NotContains(t, string(raw), `"tone":"thrash"`, "historical replay never overlays current detector state")
	code, raw = httpRead("/api/runs/thrash-run/trace?at=2", true)
	require.Equal(t, 200, code)
	require.NotContains(t, string(raw), `"tone":"thrash"`)
	code, raw = httpRead("/api/runs/thrash-run/trace?at=3", true)
	require.Equal(t, 200, code)
	require.Contains(t, string(raw), `"indicator":"Thrashing: unit failed 3×"`)
	require.Contains(t, string(raw), `"title":"Ran checks · 1 failed"`)
	code, raw = httpRead("/api/runs/thrash-run/trace?at=4", true)
	require.Equal(t, 200, code)
	require.NotContains(t, string(raw), `"tone":"thrash"`, "a recorded edit clears historical thrash")
	for _, position := range []string{"5", "6"} {
		code, raw = httpRead("/api/runs/thrash-run/trace?at="+position, true)
		require.Equal(t, 503, code, "malformed or future replay evidence must fail closed")
		require.Contains(t, string(raw), "run_unavailable")
		require.NotContains(t, string(raw), "repo-only-secret")
	}

	preview, _ := json.Marshal(`{"writes":["src/retry.ts"]}`)
	update.Events = []flowruntime.Event{{RunID: "thrash-run", Sequence: 4, Kind: "control.engine.event", Payload: json.RawMessage(fmt.Sprintf(`{"version":1,"executionId":"edit","eventType":"flows.engine.node-settled","payload":{"nodeId":"edit","action":"coding/edit-atom","outcome":"built","result":{"preview":%s,"truncated":false}}}`, preview))}}
	require.NoError(t, service.ProjectFlowRuntime(ctx, update))
	for {
		frame = read()
		if frame.ID == 1 && !strings.Contains(string(frame.Data), "Thrashing:") {
			break
		}
	}
	card, err := service.Todo(ctx, repo.ID, item.Number.Int64)
	require.NoError(t, err)
	require.Empty(t, card["run"].(map[string]any)["indicators"])
}
