package compose

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/db/product"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

func TestStackOrderAttentionComposedInstall(t *testing.T) {
	raw := os.Getenv("SMITHERS_TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("SMITHERS_TEST_DATABASE_URL required")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Minute)
	defer cancel()
	admin, err := pgx.Connect(ctx, raw)
	require.NoError(t, err)
	defer admin.Close(context.Background())
	name := "fr_t_gh_03_r6_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	_, err = admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize())
	require.NoError(t, err)
	defer func() {
		_, err := admin.Exec(context.Background(), "DROP DATABASE "+pgx.Identifier{name}.Sanitize()+" WITH (FORCE)")
		require.NoError(t, err)
	}()
	target, err := url.Parse(raw)
	require.NoError(t, err)
	target.Path = "/" + name
	pool, err := postgresfixture.Open(ctx, target.String(), 4)
	require.NoError(t, err)
	defer pool.Close()
	require.NoError(t, product.Apply(ctx, pool))
	q := db.New(pool)
	bus := revocation.NewBus(pool, q)
	busCtx, stopBus := context.WithCancel(context.Background())
	require.NoError(t, bus.Start(busCtx))
	defer func() { stopBus(); <-bus.Done() }()
	routes.SetRevocationSource(bus)
	defer routes.SetRevocationSource(nil)
	var owner, repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES('owner','owner') RETURNING id`).Scan(&owner))
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name,default_bookmark) VALUES($1,'app','app','main') RETURNING id`, owner).Scan(&repo))
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner)
	require.NoError(t, err)
	for key, value := range map[string]string{"github.repository": fmt.Sprintf(`{"owner_login":"owner","repository_name":"app","repository_id":%d}`, repo), "owner.access": fmt.Sprintf(`{"owner_login":"owner","repository_name":"app","repository_id":%d,"last_access_check_at":"2026-10-07T00:00:00Z"}`, repo)} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(value)}))
	}
	_, err = q.RequestMythicalBootstrap(ctx, repo, owner, 20, false)
	require.NoError(t, err)
	attention := `[{"id":"order-3","kind":"order","revision":2,"entries":[{"key":"3:sha","todo":3,"text":"T3 merged before T2; T2's change is in T3's commit"},{"key":"4:sha","todo":4,"text":"T4 merged out of order; containment of T1 is unverified"}]}]`
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET attention=$2 WHERE repository_id=$1`, repo, attention)
	require.NoError(t, err)
	session := func(login string, user int64) string {
		token := "order-" + login
		hash := sha256.Sum256([]byte(token))
		_, err := q.CreateAuthSession(ctx, db.CreateAuthSessionParams{SessionKey: hex.EncodeToString(hash[:]), UserID: user, Username: login, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return token
	}
	ownerToken := session("owner", owner)
	var member int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES('alice','alice') RETURNING id`).Scan(&member))
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, repo, member)
	require.NoError(t, err)
	memberToken := session("alice", member)
	var maintainer int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES('ben','ben') RETURNING id`).Scan(&maintainer))
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, repo, maintainer)
	require.NoError(t, err)
	maintainerToken := session("ben", maintainer)
	service := services.NewMythicalService(pool, nil)
	topics := &liveTopics{queries: q, todos: service}
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = config.AuthModeSelfHosted
	cfg.Server.AllowedOrigins = []string{origin}
	handler := &routes.LiveHandler{Hub: live.NewHub(ctx, nil), Queries: q, Origins: middleware.FixedOrigins(origin), Topics: topics.resolver}
	server.Config.Handler = hostStatusProductionRouter(cfg, q, &services.InstallCapacityService{}, conformanceServices{pool: pool, mythical: &routes.MythicalHandler{Service: service}, live: handler})
	server.Start()
	defer server.Close()
	call := func(method, path, token, body, via string) (int, map[string]any) {
		req, err := http.NewRequest(method, origin+path, bytes.NewBufferString(body))
		require.NoError(t, err)
		req.Header.Set("Cookie", "smithers_session="+token)
		req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf-order"})
		req.Header.Set("X-CSRF-Token", "csrf-order")
		req.Header.Set("Origin", origin)
		req.Header.Set("Content-Type", "application/json")
		if via != "" {
			req.Header.Set("Smithers-Via", via)
		}
		response, err := server.Client().Do(req)
		require.NoError(t, err)
		defer response.Body.Close()
		var result map[string]any
		if response.StatusCode != 204 {
			require.NoError(t, json.NewDecoder(response.Body).Decode(&result))
		}
		return response.StatusCode, result
	}
	status, home := call("GET", "/api/stack", ownerToken, "", "")
	require.Equal(t, 200, status)
	require.Len(t, home["attention"], 1)
	// One member must never receive the maintainer builder's cached Home.
	for _, audience := range []struct {
		token      string
		count      int
		permission string
	}{{ownerToken, 1, ""}, {maintainerToken, 1, ""}, {memberToken, 0, ""}, {maintainerToken, 0, "write"}, {maintainerToken, 1, "admin"}} {
		if audience.permission != "" {
			_, err := pool.Exec(ctx, `UPDATE collaborators SET permission=$3 WHERE repository_id=$1 AND user_id=$2`, repo, maintainer, audience.permission)
			require.NoError(t, err)
		}
		socket, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(origin, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{live.Protocol}, HTTPHeader: http.Header{"Cookie": {"smithers_session=" + audience.token}, "Origin": {origin}}})
		require.NoError(t, err)
		defer socket.CloseNow()
		require.NoError(t, socket.Write(ctx, websocket.MessageText, []byte(`{"t":"sub","id":1,"topic":"home"}`)))
		_, raw, err := socket.Read(ctx)
		require.NoError(t, err)
		var frame live.Frame
		require.NoError(t, json.Unmarshal(raw, &frame))
		require.Equal(t, "snap", frame.T)
		var model map[string]any
		require.NoError(t, json.Unmarshal(frame.Data, &model))
		require.Len(t, model["attention"], audience.count)
	}
	status, home = call("GET", "/api/stack", memberToken, "", "")
	require.Equal(t, 200, status)
	require.Empty(t, home["attention"])
	for _, tc := range []struct {
		token, via, body, code string
		status                 int
	}{
		{memberToken, "", `{"revision":2}`, "permission", 403},
		{ownerToken, "smithers", `{"revision":2}`, "never", 403},
		{ownerToken, "", `{"revision":1}`, "stale_attention", 409},
		{ownerToken, "", `{"revision":2}` + strings.Repeat(" ", 4096) + `{"revision":3}`, "invalid_attention", 400},
	} {
		status, result := call("POST", "/api/stack/attention/order-3", tc.token, tc.body, tc.via)
		require.Equal(t, tc.status, status)
		require.Equal(t, tc.code, result["code"])
		var current string
		require.NoError(t, pool.QueryRow(ctx, `SELECT attention::text FROM mythical_stacks WHERE repository_id=$1`, repo).Scan(&current))
		require.JSONEq(t, attention, current)
	}
	status, _ = call("POST", "/api/stack/attention/order-3", maintainerToken, `{"revision":2}`, "")
	require.Equal(t, 204, status)
	var settledBy int64
	require.NoError(t, pool.QueryRow(ctx, `SELECT (attention->0->>'settled_by')::bigint FROM mythical_stacks WHERE repository_id=$1`, repo).Scan(&settledBy))
	require.Equal(t, maintainer, settledBy)
	status, home = call("GET", "/api/stack", ownerToken, "", "")
	require.Equal(t, 200, status)
	require.Empty(t, home["attention"])
}
