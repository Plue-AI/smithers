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

	"github.com/coder/websocket"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

func TestInstallStatusOwnerHTTPModelPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	ctx := t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "hostowner", LowerUsername: "hostowner"})
	require.NoError(t, err)
	member, err := q.CreateUser(ctx, db.CreateUserParams{Username: "hostmember", LowerUsername: "hostmember"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	var repository int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'fixture','fixture') RETURNING id`, owner.ID).Scan(&repository))
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, repository, owner.ID)
	require.NoError(t, err)
	// The member boundary (#3443) admits only a verified owner outside setup scope, so the retired /api/host reaches the router's 404.
	verified := fmt.Sprintf(`{"owner_login":"hostowner","repository_name":"fixture","repository_id":%d,"last_access_check_at":%q}`, repository, time.Now().UTC().Format(time.RFC3339Nano))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(fmt.Sprintf(`{"owner_login":"hostowner","repository_name":"fixture","repository_id":%d}`, repository))}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(verified)}))
	session := func(user db.User, value string) string {
		hash := sha256.Sum256([]byte(value))
		_, err := q.CreateAuthSession(ctx, db.CreateAuthSessionParams{SessionKey: hex.EncodeToString(hash[:]), UserID: user.ID, Username: user.Username, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return value
	}
	good := session(owner, "owner-capacity-session")
	other := session(member, "member-capacity-session")
	maintainer, err := q.CreateUser(ctx, db.CreateUserParams{Username: "hostmaintainer", LowerUsername: "hostmaintainer"})
	require.NoError(t, err)
	require.NoError(t, q.SetUserAdmin(ctx, db.SetUserAdminParams{UserID: maintainer.ID, IsAdmin: true}))
	admin := session(maintainer, "maintainer-capacity-session")
	capacity := &services.InstallCapacityService{Queries: q, Profile: microsandbox.HostProfile{MemoryBytes: 32 << 30, PerfCores: 10, PhysicalCores: 14, DiskFreeBytes: 400 << 30, MacOSVersion: "15.6", Hypervisor: true}}
	require.NoError(t, capacity.Set(ctx, owner.ID, 2))
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = "http://localhost:4000"
	cfg.Server.AllowedOrigins = []string{"http://localhost:4000"}
	handler := &routes.GitHubAppSetupHandler{Owners: q, Origins: middleware.FixedOrigins("http://localhost:4000"), Setup: &services.InstallSetupService{Pool: pool, Capacity: capacity}}
	cfg.FeatureFlags.SubscriptionConnections = false
	connections := &routes.ProviderConnectionHandler{Service: routerProviderConnectionStub{}, Pool: &routes.ProviderPoolHandler{}}
	router := githubAppSetupComposeRouter(cfg, pool, handler, connections)
	request := func(method, path, credential, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://localhost:4000"+path, strings.NewReader(body))
		r.RemoteAddr = "127.0.0.1:1234"
		r.Header.Set("Content-Type", "application/json")
		if credential != "" {
			r.AddCookie(&http.Cookie{Name: "smithers_session", Value: credential})
		}
		if method != "GET" {
			r.Header.Set("Origin", "http://localhost:4000")
			r.Header.Set("X-CSRF-Token", "csrf")
			r.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	require.Equal(t, 404, request("GET", "/api/host", good, "").Code)
	require.Equal(t, 404, request("PATCH", "/api/host", good, `{"capacity":1}`).Code)
	require.Equal(t, 403, request("GET", "/api/install", other, "").Code)
	response := request("GET", "/api/install", good, "")
	require.Equal(t, 200, response.Code, response.Body.String())
	var status struct {
		Capacity int `json:"capacity"`
		Mac      struct {
			Memory    float64 `json:"memory_gb"`
			PerfCores int     `json:"perf_cores"`
			Capacity  int     `json:"capacity"`
			Limit     *struct {
				Term string `json:"term"`
				Fix  string `json:"fix"`
			} `json:"limit"`
		} `json:"this_mac"`
		Steps []struct {
			ID string `json:"id"`
		} `json:"steps"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &status))
	require.Equal(t, 32.0, status.Mac.Memory)
	require.Equal(t, 2, status.Capacity)
	require.Equal(t, 3, status.Mac.Capacity)
	require.Equal(t, 10, status.Mac.PerfCores)
	require.Nil(t, status.Mac.Limit, "a host that fits a machine names no limiting term")
	require.Len(t, status.Steps, 7)
	require.Equal(t, "app_manifest", status.Steps[1].ID)
	require.Contains(t, response.Body.String(), `"chatgpt":false`)
	poolURL := codingHostAccountPoolURL(cfg, "http://localhost:4000")
	require.Equal(t, "http://localhost:4000/provider-pool", poolURL)
	require.Equal(t, 403, request("GET", "/api/user/provider-connections", good, "").Code)
	require.Equal(t, 403, request("POST", "/provider-pool/chatgpt/codex/responses", good, `{}`).Code)
	for _, body := range []string{`{"chatgpt":true}`, `{"chatgpt":false}`} {
		denied := request("PUT", "/api/install", other, body)
		require.Equal(t, 403, denied.Code)
		updated := request("PUT", "/api/install", good, body)
		require.Equal(t, 200, updated.Code, updated.Body.String())
		require.Contains(t, updated.Body.String(), body[1:len(body)-1])
		// Toggle through Settings without rebuilding the router or host catalog.
		connectionResponse := request("GET", "/api/user/provider-connections", good, "")
		poolResponse := request("POST", "/provider-pool/chatgpt/codex/responses", "", `{}`)
		if strings.Contains(body, "true") {
			require.Equal(t, 200, connectionResponse.Code, connectionResponse.Body.String())
			require.Equal(t, 401, poolResponse.Code, "enabled pool still requires a bound credential")
		} else {
			require.Equal(t, 403, connectionResponse.Code)
			require.Equal(t, 403, poolResponse.Code)
		}
		require.Equal(t, poolURL, codingHostAccountPoolURL(cfg, "http://localhost:4000"))
		restarted := &services.InstallSetupService{Pool: pool, Capacity: capacity}
		projection, err := restarted.Status(ctx)
		require.NoError(t, err)
		require.Equal(t, strings.Contains(body, "true"), projection["chatgpt"])
	}
	for _, body := range []string{`{"chatgpt":"true"}`, `{"chatgpt":null}`, `{"chatgpt":true,"unknown":1}`} {
		require.Equal(t, 400, request("PUT", "/api/install", good, body).Code)
	}
	// A real authenticated Home socket shares the production capacity reader
	// with Settings. Keep it open across owner writes to prove refresh, rather
	// than checking only a separately seeded Home model.
	openHome := func() (func(int), func()) {
		server := httptest.NewUnstartedServer(nil)
		origin := "http://" + server.Listener.Addr().String()
		cfg.Server.AllowedOrigins = append(cfg.Server.AllowedOrigins, origin)
		hubCtx, cancelHub := context.WithCancel(ctx)
		topics := &liveTopics{queries: q, todos: services.NewMythicalService(pool, nil), capacity: capacity, install: handler.Setup}
		liveHandler := &routes.LiveHandler{Queries: q, Hub: live.NewHub(hubCtx, nil), Origins: middleware.FixedOrigins(origin), Topics: topics.resolver}
		server.Config.Handler = githubAppSetupComposeRouter(cfg, pool, handler, routerExtras{Live: liveHandler})
		server.Start()
		t.Cleanup(server.Close)
		readCtx, cancelRead := context.WithTimeout(ctx, 15*time.Second)
		conn, _, err := websocket.Dial(readCtx, "ws"+strings.TrimPrefix(origin, "http")+"/api/live", &websocket.DialOptions{
			Subprotocols: []string{"smithers.live.v1"}, HTTPHeader: http.Header{"Origin": {origin}, "Cookie": {"smithers_session=" + good}},
		})
		require.NoError(t, err)
		require.NoError(t, conn.Write(readCtx, websocket.MessageText, []byte(`{"t":"sub","id":1,"topic":"home"}`)))
		awaitHomeCapacity := func(want int) {
			t.Helper()
			for {
				_, raw, err := conn.Read(readCtx)
				require.NoError(t, err)
				var frame liveFrame
				require.NoError(t, json.Unmarshal(raw, &frame))
				require.NotEqual(t, "err", frame.T, string(raw))
				if frame.T != "snap" {
					continue
				}
				var home struct {
					Machines struct {
						Capacity *int `json:"capacity"`
					} `json:"machines"`
				}
				require.NoError(t, json.Unmarshal(frame.Data, &home))
				require.NotNil(t, home.Machines.Capacity, string(raw))
				if *home.Machines.Capacity == want {
					return
				}
			}
		}
		stop := func() {
			conn.CloseNow()
			cancelRead()
			cancelHub()
			server.Close()
		}
		t.Cleanup(stop)
		return awaitHomeCapacity, stop
	}
	awaitHomeCapacity, stopHome := openHome()
	awaitHomeCapacity(2)
	for _, test := range []struct {
		credential, body string
		want             int
	}{{admin, `{"capacity":1}`, 403}, {other, `{"capacity":1}`, 403}, {good, `{"capacity":1,"extra":true}`, 400}, {good, `{"capacity":1} {}`, 400}, {good, `{}`, 400}, {good, `{"capacity":4}`, 422}, {good, `{"capacity":0}`, 422}, {good, `{"capacity":-1}`, 422}, {good, `{"capacity":1}`, 200}} {
		response = request("PUT", "/api/install", test.credential, test.body)
		require.Equal(t, test.want, response.Code, response.Body.String())
		if test.want == 422 {
			require.Contains(t, response.Body.String(), `"class":"user"`)
			if test.body == `{"capacity":4}` {
				require.Contains(t, response.Body.String(), "capacity cannot exceed 3")
			}
		}
		// Refused writes must never mutate the saved owner limit.
		read := request("GET", "/api/install", good, "")
		require.Equal(t, 200, read.Code, read.Body.String())
		require.NoError(t, json.Unmarshal(read.Body.Bytes(), &status))
		if test.want == 200 {
			require.Equal(t, 1, status.Capacity)
		} else {
			require.Equal(t, 2, status.Capacity)
		}
	}
	awaitHomeCapacity(1)
	// Stop the subscription before replacing the detected startup profile.
	stopHome()
	// A restarted composition on a smaller host preserves the owner's saved 1.
	capacity = &services.InstallCapacityService{Queries: q, Profile: microsandbox.HostProfile{MemoryBytes: 24 << 30, PerfCores: 8, PhysicalCores: 10, DiskFreeBytes: 200 << 30, MacOSVersion: "15.6", Hypervisor: true}}
	handler.Setup.Capacity = capacity
	router = githubAppSetupComposeRouter(cfg, pool, handler)
	response = request("GET", "/api/install", good, "")
	require.Equal(t, 200, response.Code, response.Body.String())
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &status))
	require.Equal(t, 24.0, status.Mac.Memory)
	require.Equal(t, 8, status.Mac.PerfCores)
	require.Equal(t, 2, status.Mac.Capacity)
	require.Equal(t, 1, status.Capacity)
	awaitHomeCapacity, stopHome = openHome()
	awaitHomeCapacity(1)
	stopHome()
	capacity.Profile.DiskFreeBytes = 60 << 30
	response = request("GET", "/api/install", good, "")
	require.Equal(t, 200, response.Code)
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &status))
	require.Zero(t, status.Capacity)
	require.Zero(t, status.Mac.Capacity)
	// §8.2.1a: at capacity 0 Settings shows the limiting term and its fix, from the one Go host profile.
	require.NotNil(t, status.Mac.Limit, response.Body.String())
	require.Equal(t, "disk", status.Mac.Limit.Term)
	require.Equal(t, "free 12 GiB on the state volume", status.Mac.Limit.Fix)
	awaitHomeCapacity, stopHome = openHome()
	awaitHomeCapacity(0)
	stopHome()
}
