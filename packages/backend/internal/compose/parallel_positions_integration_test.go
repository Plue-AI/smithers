package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/coder/websocket"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

func TestParallelSchedulerPositionsInstallBoundary(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	busCtx, cancelBus := context.WithCancel(ctx)
	t.Cleanup(cancelBus)
	bus := revocation.NewBus(pool, q)
	require.NoError(t, bus.Start(busCtx))
	routes.SetRevocationSource(bus)
	t.Cleanup(func() { routes.SetRevocationSource(nil) })
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "maya", LowerUsername: "maya"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE users SET is_active=true WHERE id=$1`, owner.ID)
	require.NoError(t, err)
	var repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'app','app') RETURNING id`, owner.ID).Scan(&repo))
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	for _, key := range []string{"github.repository", "owner.access"} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(fmt.Sprintf(`{"owner_login":"maya","repository_name":"app","repository_id":%d,"last_access_check_at":"2026-10-05T10:00:00Z"}`, repo))}))
	}
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, repo, owner.ID)
	require.NoError(t, err)
	_, err = q.RequestMythicalBootstrap(ctx, repo, owner.ID, 1, false)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state='active' WHERE repository_id=$1`, repo)
	require.NoError(t, err)
	sum := sha256.Sum256([]byte("placement-session"))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: owner.ID, Username: owner.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "smithers_session"
	server := httptest.NewUnstartedServer(nil)
	t.Cleanup(server.Close)
	cfg.Server.PublicURL = "http://" + server.Listener.Addr().String()
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	runtime := new(microsandbox.Runtime)
	service := services.NewMythicalService(pool, nil)
	capacity := &services.InstallCapacityService{Queries: q, Profile: microsandbox.HostProfile{MemoryBytes: 32 << 30, PerfCores: 10, DiskFreeBytes: 400 << 30}}
	service.SetInstallParallel(capacity)
	service.SetOrchestration(nil, nil, services.NewWorkspaceMythicalLanes(services.NewWorkspaceService(q, services.WithWorkspaceRuntime(runtime))))
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	topics := &liveTopics{queries: q, todos: service, jobs: store, install: &services.InstallSetupService{Capacity: capacity}}
	handler := &routes.LiveHandler{Hub: live.NewHub(ctx, nil), Queries: q, Origins: func() []string { return cfg.Server.AllowedOrigins }, Topics: topics.resolver}
	router := hostStatusProductionRouter(cfg, q, capacity, conformanceServices{pool: pool, live: handler, mythical: &routes.MythicalHandler{Service: service}})
	server.Config.Handler = router
	server.Start()
	bearerToken := ""
	browserCookie := "placement-session"
	call := func(method, path, body, key string) (int, map[string]any) {
		t.Helper()
		req := httptest.NewRequest(method, cfg.Server.PublicURL+path, strings.NewReader(body))
		req.RemoteAddr = "127.0.0.1:51900"
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", cfg.Server.PublicURL)
		req.Header.Set("Idempotency-Key", key)
		req.Header.Set("X-CSRF-Token", "placement-csrf")
		req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "placement-csrf"})
		if bearerToken == "" {
			req.AddCookie(&http.Cookie{Name: cfg.Auth.SessionCookieName, Value: browserCookie})
		} else {
			req.Header.Set("Authorization", "Bearer "+bearerToken)
		}
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		var result map[string]any
		require.NoError(t, json.Unmarshal(res.Body.Bytes(), &result), res.Body.String())
		return res.Code, result
	}
	holders := map[int]string{}
	for n, title := range []string{"T1", "T2", "T3", "T4", "T5"} {
		code, body := call("POST", "/api/todos", fmt.Sprintf(`{"title":%q,"prompt":"Add a line","place":{"mode":"append"}}`, title), title)
		require.Equal(t, 202, code, body)
		if n >= 2 {
			continue
		}
		id := uuid.NewString()
		_, err = pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,status,target_bookmark) VALUES($1,$2,$3,'pending',$4)`, id, repo, owner.ID, fmt.Sprintf("smithers/todo-%d", n+1))
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `UPDATE mythical_items SET workspace_id=$1 WHERE repository_id=$2 AND number=$3`, id, repo, n+1)
		require.NoError(t, err)
		holders[n+1] = "workspace:" + id
	}
	// Asynchronous provisioning arrived in the opposite order to the stack.
	for _, n := range []int{2, 1} {
		_, err = runtime.Request("todo", holders[n], holders[n], "machine")
		require.NoError(t, err)
	}
	_, err = runtime.Request("person", "workspace:ben", "Ben", "machine")
	require.NoError(t, err)
	position := func(n, expected int) {
		code, card := call("GET", fmt.Sprintf("/api/todos/%d", n), "", "")
		require.Equal(t, 200, code, card)
		require.Equal(t, map[string]any{"reason": "machine", "position": float64(expected)}, card["queue"])
	}
	position(1, 2)
	position(2, 3)
	position(3, 4)
	position(4, 5)
	position(5, 6)
	code, body := call("POST", "/api/todos/2", `{"op":"move","direction":"up"}`, "move-T2")
	require.Equal(t, 202, code, body)
	position(2, 2)
	position(1, 3)
	require.False(t, runtime.CancelAdmission("workspace:ben", "Ben", time.Now()))
	position(2, 1)
	position(1, 2)
	position(3, 3)
	position(4, 4)
	position(5, 5)
	code, body = call("POST", "/api/todos/3", `{"op":"drop"}`, "drop-T3")
	require.Equal(t, 202, code, body)
	position(4, 3)
	position(5, 4)
	// Both live topics use the same production router, card builder and job facts.
	// Person demand is supplemental scheduler input; the terminal-open admission
	// journey remains gated on the production safe-idle provider.
	dial := func(topic string) *websocket.Conn {
		socket, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{live.Protocol}, HTTPHeader: http.Header{"Cookie": {"smithers_session=" + browserCookie}, "Origin": {cfg.Server.PublicURL}}})
		require.NoError(t, err)
		t.Cleanup(func() { socket.CloseNow() })
		raw, _ := json.Marshal(map[string]any{"t": "sub", "id": 1, "topic": topic})
		require.NoError(t, socket.Write(ctx, websocket.MessageText, raw))
		return socket
	}
	read := func(socket *websocket.Conn) live.Frame {
		t.Helper()
		deadline, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		_, raw, err := socket.Read(deadline)
		require.NoError(t, err)
		var frame live.Frame
		require.NoError(t, json.Unmarshal(raw, &frame))
		return frame
	}
	homeSocket, todoSocket := dial("home"), dial("todo:1")
	firstHome, firstTodo := read(homeSocket), read(todoSocket)
	require.Equal(t, "snap", firstHome.T)
	require.Equal(t, "snap", firstTodo.T)
	require.Contains(t, string(firstTodo.Data), `"position":2`)
	// A person joining the runtime waiting set refreshes both projections even
	// without an item SQL mutation or a new durable TODO event.
	_, err = runtime.Request("person", "workspace:ben-2", "Ben", "machine")
	require.NoError(t, err)
	personHome, personTodo := read(homeSocket), read(todoSocket)
	require.Equal(t, "snap", personHome.T)
	require.Equal(t, "snap", personTodo.T)
	require.Contains(t, string(personTodo.Data), `"position":3`)
	require.Equal(t, *firstTodo.Cursor, *personTodo.Cursor)
	var home map[string]any
	require.NoError(t, json.Unmarshal(personHome.Data, &home))
	positions := map[string]float64{}
	for _, raw := range home["items"].([]any) {
		row := raw.(map[string]any)
		if queue, ok := row["queue"].(map[string]any); ok {
			positions[fmt.Sprintf("T%.0f", row["n"].(float64))] = queue["position"].(float64)
		}
	}
	// Home items use T-number names; no expected value comes from the runtime.
	require.Equal(t, map[string]float64{"T2": 2, "T1": 3, "T4": 4, "T5": 5}, positions)
	code, body = call("POST", "/api/todos/1", `{"op":"move","direction":"up"}`, "live-move-T1")
	require.Equal(t, 202, code, body)
	movedHome, movedTodo := read(homeSocket), read(todoSocket)
	require.Equal(t, "delta", movedHome.T)
	require.Equal(t, "delta", movedTodo.T)
	var fact struct {
		Payload map[string]json.RawMessage `json:"data"`
	}
	require.NoError(t, json.Unmarshal(movedTodo.Data, &fact))
	require.Contains(t, string(fact.Payload["card"]), `"position":2`)
	var homeFact struct {
		Payload map[string]json.RawMessage `json:"data"`
	}
	require.NoError(t, json.Unmarshal(movedHome.Data, &homeFact))
	require.JSONEq(t, string(fact.Payload["home"]), string(homeFact.Payload["home"]))
	require.NoError(t, json.Unmarshal(homeFact.Payload["home"], &home))
	positions = map[string]float64{}
	for _, raw := range home["items"].([]any) {
		row := raw.(map[string]any)
		if queue, ok := row["queue"].(map[string]any); ok {
			positions[fmt.Sprintf("T%.0f", row["n"].(float64))] = queue["position"].(float64)
		}
	}
	require.Equal(t, map[string]float64{"T1": 2, "T2": 3, "T4": 4, "T5": 5}, positions)
	page, err := store.ReplayRepositoryTodos(ctx, strconv.FormatInt(repo, 10), 0, 100)
	require.NoError(t, err)
	require.NotEmpty(t, page.Events)
	// The displayed 500-card page must not cancel runtime demands behind it.
	// Fixture insertion is supplemental; the assertion reads the production route.
	_, err = pool.Exec(ctx, `INSERT INTO mythical_items(repository_id,source,state,title,owner_id,revisions)
 SELECT $1,'todo','queued','Backlog '||n,$2,'[]'::jsonb FROM generate_series(6,505) n ORDER BY n`, repo, owner.ID)
	require.NoError(t, err)
	position(505, 505)
	position(1, 2)
	require.Zero(t, runtime.InUse(), "projection/reorder never grants or boots a VM")
}
