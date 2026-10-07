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
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

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
	item.State, item.Attempt = "running", 1
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
	topics := &liveTopics{queries: q, todos: service}
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = origin
	cfg.Server.AllowedOrigins = []string{origin}
	handler := &routes.LiveHandler{Hub: live.NewHub(ctx, nil), Queries: q, Origins: func() []string { return []string{origin} }, Topics: topics.resolver}
	server.Config.Handler = hostStatusProductionRouter(cfg, q, &services.InstallCapacityService{}, conformanceServices{pool: pool, live: handler})
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
	preview, _ := json.Marshal(`{"writes":["src/retry.ts"]}`)
	update.Events = []flowruntime.Event{{RunID: "thrash-run", Sequence: 4, Kind: "control.engine.event", Payload: json.RawMessage(fmt.Sprintf(`{"version":1,"executionId":"edit","eventType":"flows.engine.node-settled","payload":{"nodeId":"edit","action":"coding/edit-atom","outcome":"built","result":{"preview":%s,"truncated":false}}}`, preview))}}
	require.NoError(t, service.ProjectFlowRuntime(ctx, update))
	for {
		frame = read()
		if !strings.Contains(string(frame.Data), "Thrashing:") {
			break
		}
	}
	card, err := service.Todo(ctx, repo.ID, item.Number.Int64)
	require.NoError(t, err)
	require.Empty(t, card["run"].(map[string]any)["indicators"])
}
