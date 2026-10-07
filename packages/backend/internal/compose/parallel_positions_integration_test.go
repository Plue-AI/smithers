package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

func TestParallelSchedulerPositionsInstallBoundary(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
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
	cfg.Server.PublicURL = "http://127.0.0.1:4000"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	runtime := new(microsandbox.Runtime)
	_, err = runtime.Request("todo", "workspace:unregistered", "recovery", "machine")
	require.NoError(t, err)
	runtime.SetTodoParallelReader(func(context.Context) (int, error) { return 2, nil })
	readyCalls := 0
	unordered, err := runtime.GrantNext(ctx, microsandbox.AdmissionProviders{FreeDisk: func(context.Context) (int64, error) { return 400 << 30, nil }, Ready: func(context.Context, microsandbox.AdmissionRequest) error { readyCalls++; return nil }})
	require.NoError(t, err)
	require.Empty(t, unordered.Holder, "install demand waits for authoritative stack registration")
	require.Zero(t, readyCalls)
	require.False(t, runtime.CancelAdmission("workspace:unregistered", "recovery", time.Now()))
	service := services.NewMythicalService(pool, nil)
	service.SetInstallParallel(&services.InstallCapacityService{Queries: q, Profile: microsandbox.HostProfile{MemoryBytes: 32 << 30, PerfCores: 10, DiskFreeBytes: 400 << 30}})
	service.SetOrchestration(nil, nil, services.NewWorkspaceMythicalLanes(services.NewWorkspaceService(q, services.WithWorkspaceRuntime(runtime))))
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	topics := &liveTopics{queries: q, todos: service, jobs: store}
	liveContext, stopLive := context.WithCancel(ctx)
	defer stopLive()
	bus := revocation.NewBus(pool, q)
	require.NoError(t, bus.Start(liveContext))
	routes.SetRevocationSource(bus)
	defer routes.SetRevocationSource(nil)
	liveHandler := &routes.LiveHandler{Hub: live.NewHub(liveContext, nil), Queries: q,
		Origins: func() []string { return cfg.Server.AllowedOrigins }, Topics: topics.resolver}
	router := hostStatusProductionRouter(cfg, q, &services.InstallCapacityService{Queries: q},
		conformanceServices{pool: pool, mythical: &routes.MythicalHandler{Service: service}, live: liveHandler})
	server := httptest.NewServer(router)
	defer server.Close()
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
	projectionCtx, stopProjection := context.WithCancel(liveContext)
	defer stopProjection()
	go service.StartMachineQueueProjection(projectionCtx)
	_, err = runtime.Request("person", "workspace:ben", "Ben", "machine")
	require.NoError(t, err)
	require.Eventually(t, func() bool {
		var position int
		err := pool.QueryRow(ctx, `SELECT (data->'card'->'queue'->>'position')::int FROM product_job_events WHERE tenant_id=$1 AND data->'card'->>'n'='5' ORDER BY recorded_at DESC LIMIT 1`, fmt.Sprint(repo)).Scan(&position)
		return err == nil && position == 6
	}, 5*time.Second, 20*time.Millisecond)
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
	// The aggregate door must use the same install admission positions, with
	// Ben ahead of the TODOs, rather than counting only queued stack items.
	request := httptest.NewRequest("GET", cfg.Server.PublicURL+"/api/todos", nil)
	request.RemoteAddr = "127.0.0.1:51900"
	request.AddCookie(&http.Cookie{Name: cfg.Auth.SessionCookieName, Value: browserCookie})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	require.Equal(t, 200, response.Code, response.Body.String())
	var cards []map[string]any
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &cards))
	require.Len(t, cards, 5)
	for index, card := range cards {
		require.Equal(t, float64(index+1), card["n"])
		require.Equal(t, map[string]any{"reason": "machine", "position": float64(index + 2)}, card["queue"])
	}
	// The mounted live endpoint must publish all changed positions together.
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/api/live", &websocket.DialOptions{
		Subprotocols: []string{live.Protocol}, HTTPHeader: http.Header{"Cookie": {"smithers_session=placement-session"}, "Origin": {cfg.Server.PublicURL}}, Host: "127.0.0.1:4000"})
	require.NoError(t, err)
	defer conn.CloseNow()
	require.NoError(t, conn.Write(ctx, websocket.MessageText, []byte(`{"t":"sub","id":1,"topic":"home"}`)))
	readHome := func(kind string, want map[int]int) {
		t.Helper()
		readCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		for {
			_, raw, err := conn.Read(readCtx)
			require.NoError(t, err)
			var frame live.Frame
			require.NoError(t, json.Unmarshal(raw, &frame))
			require.NotEqual(t, "err", frame.T, string(raw))
			if frame.T != kind {
				continue
			}
			if frame.T == "delta" {
				var event struct {
					Data struct {
						Home json.RawMessage `json:"home"`
					} `json:"data"`
				}
				require.NoError(t, json.Unmarshal(frame.Data, &event), string(raw))
				require.NotEmpty(t, event.Data.Home, string(raw))
				frame.Data = event.Data.Home
			}
			var home struct {
				Items []struct {
					N     int `json:"n"`
					Queue *struct {
						Position int `json:"position"`
					} `json:"queue"`
				} `json:"items"`
			}
			data := frame.Data
			require.NoError(t, json.Unmarshal(data, &home), string(raw))
			got := map[int]int{}
			for _, item := range home.Items {
				if item.Queue != nil {
					got[item.N] = item.Queue.Position
				}
			}
			if !reflect.DeepEqual(want, got) {
				continue
			}
			require.Equal(t, want, got, string(raw))
			return
		}
	}
	readHome("snap", map[int]int{1: 2, 2: 3, 3: 4, 4: 5, 5: 6})
	// The install uses the durable TODO source. Runtime-only changes must also
	// reach an already subscribed card when no TODO journal event is appended.
	todoConn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/api/live", &websocket.DialOptions{
		Subprotocols: []string{live.Protocol}, HTTPHeader: http.Header{"Cookie": {"smithers_session=placement-session"}, "Origin": {cfg.Server.PublicURL}}, Host: "127.0.0.1:4000"})
	require.NoError(t, err)
	defer todoConn.CloseNow()
	require.NoError(t, todoConn.Write(ctx, websocket.MessageText, []byte(`{"t":"sub","id":1,"topic":"todo:5"}`)))
	readTodo := func(kind string, expected int) int64 {
		t.Helper()
		readCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		_, raw, err := todoConn.Read(readCtx)
		require.NoError(t, err)
		var frame live.Frame
		require.NoError(t, json.Unmarshal(raw, &frame))
		require.Equal(t, kind, frame.T, string(raw))
		var card struct {
			Queue struct {
				Reason   string `json:"reason"`
				Position int    `json:"position"`
			} `json:"queue"`
		}
		data := frame.Data
		if kind == "delta" {
			var fact struct{ Data map[string]json.RawMessage }
			require.NoError(t, json.Unmarshal(data, &fact))
			data = fact.Data["card"]
		}
		require.NoError(t, json.Unmarshal(data, &card))
		require.Equal(t, "machine", card.Queue.Reason)
		require.Equal(t, expected, card.Queue.Position)
		require.NotNil(t, frame.Cursor)
		return *frame.Cursor
	}
	todoCursor := readTodo("snap", 6)

	code, body := call("POST", "/api/todos/2", `{"op":"move","direction":"up"}`, "move-T2")
	require.Equal(t, 202, code, body)
	position(2, 2)
	position(1, 3)
	readHome("delta", map[int]int{1: 3, 2: 2, 3: 4, 4: 5, 5: 6})
	require.False(t, runtime.CancelAdmission("workspace:ben", "Ben", time.Now()))
	position(2, 1)
	position(1, 2)
	position(3, 3)
	position(4, 4)
	position(5, 5)
	readHome("delta", map[int]int{1: 2, 2: 1, 3: 3, 4: 4, 5: 5})
	cancelCursor := readTodo("delta", 5)
	require.Greater(t, cancelCursor, todoCursor, "person cancellation must commit the new card projection")
	// Preserve main's entry/cancellation journey, now through committed deltas.
	_, err = runtime.Request("person", "workspace:ben-live", "Ben", "machine")
	require.NoError(t, err)
	readHome("delta", map[int]int{1: 3, 2: 2, 3: 4, 4: 5, 5: 6})
	entryCursor := readTodo("delta", 6)
	require.Greater(t, entryCursor, cancelCursor)
	require.False(t, runtime.CancelAdmission("workspace:ben-live", "Ben", time.Now()))
	readHome("delta", map[int]int{1: 2, 2: 1, 3: 3, 4: 4, 5: 5})
	require.Greater(t, readTodo("delta", 5), entryCursor)
	// Repeated reads and a restarted projector must not invent duplicate facts.
	scope := jobs.RepositoryTodosScope(fmt.Sprint(repo))
	head, err := store.Head(ctx, scope)
	require.NoError(t, err)
	stopProjection()
	restarted := *service
	restartCtx, stopRestart := context.WithCancel(liveContext)
	defer stopRestart()
	go restarted.StartMachineQueueProjection(restartCtx)
	time.Sleep(600 * time.Millisecond)
	afterRestart, err := store.Head(ctx, scope)
	require.NoError(t, err)
	require.Equal(t, head, afterRestart)
	stopRestart()
	code, body = call("POST", "/api/todos/3", `{"op":"drop"}`, "drop-T3")
	require.Equal(t, 202, code, body)
	position(4, 3)
	position(5, 4)
	// Demand includes the full stack, even beyond Home's 500-card page.
	// Fixture insertion is supplemental; the assertion uses the install route.
	_, err = pool.Exec(ctx, `INSERT INTO mythical_items(repository_id,source,state,title,owner_id,revisions)
 SELECT $1,'todo','queued','Backlog '||n,$2,'[]'::jsonb FROM generate_series(6,505) n ORDER BY n`, repo, owner.ID)
	require.NoError(t, err)
	position(505, 504)
	position(1, 2)
	require.Zero(t, runtime.InUse(), "projection/reorder never grants or boots a VM")
}
