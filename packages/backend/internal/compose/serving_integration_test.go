package compose

import (
	"bufio"
	"context"
	"encoding/json"
	"github.com/coder/websocket"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/repository"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// C-INS-03: the production install router rejects an unknown host before
// authentication, including public endpoints outside setup/auth/live.
func TestInstallServingOriginBoundaryPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	origins := []string{"http://lan-a:4000", "https://box.example"}
	handler := &routes.GitHubAppSetupHandler{Origins: func() []string { return origins }}
	router := githubAppSetupComposeRouter(cfg, pool, handler)
	for _, tc := range []struct {
		host, peer, forwarded string
		want                  int
	}{
		{"evil.example", "127.0.0.1:1234", "", 421},
		{"localhost:4000", "192.0.2.2:1234", "", 421},
		{"lan-a:4000", "192.0.2.2:1234", "box.example", 200},
		{"internal", "127.0.0.1:1234", "box.example", 200},
		{"localhost:4000", "127.0.0.1:1234", "", 200},
	} {
		req := httptest.NewRequest(http.MethodGet, "http://"+tc.host+"/health", nil)
		req.RemoteAddr = tc.peer
		req.Header.Set("X-Forwarded-Host", tc.forwarded)
		req.Header.Set("X-Forwarded-Proto", "https")
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, req)
		require.Equal(t, tc.want, recorder.Code, recorder.Body.String())
		require.Empty(t, recorder.Header().Get("Access-Control-Allow-Origin"))
		if tc.want == 421 {
			require.JSONEq(t, `{"class":"user","code":"unknown_origin","message":"unknown_origin"}`, recorder.Body.String())
		}
	}
	origins = []string{"https://box.example"}
	req := httptest.NewRequest(http.MethodGet, "http://lan-a:4000/health", nil)
	req.RemoteAddr = "192.0.2.2:1234"
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, req)
	require.Equal(t, 421, recorder.Code)
}

func TestInstallServingOwnerAddressUpdatePostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	user, err := q.CreateUser(t.Context(), db.CreateUserParams{Username: "serving-owner", LowerUsername: "serving-owner"})
	require.NoError(t, err)
	_, err = pool.Exec(t.Context(), `INSERT INTO self_host_owners(user_id) VALUES($1)`, user.ID)
	require.NoError(t, err)
	_, err = q.CreateAuthSession(t.Context(), db.CreateAuthSessionParams{SessionKey: "serving-owner-session", UserID: user.ID, Username: user.Username, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	// Use the production gateway with ephemeral lane-owned ports. The owner
	// route must update both listeners, while preserving the loopback door.
	sshConfig := &config.Config{SSH: config.SSHConfig{Addr: "127.0.0.1:0", HostKeyDir: t.TempDir()}, Auth: config.AuthConfig{LFSSigningSecret: "serving-test-secret"}}
	gateway, sshPort, stopSSH, err := startInstallSSH(t.Context(), sshConfig, pool, repository.NewRemoteClient(nil, "test"), nil, nil, "http://localhost:4000")
	require.NoError(t, err)
	defer stopSSH()
	interfaces, err := net.InterfaceAddrs()
	require.NoError(t, err)
	bindHost := ""
	for _, address := range interfaces {
		if ip, ok := address.(*net.IPNet); ok && ip.IP.To4() != nil && !ip.IP.IsLoopback() && !ip.IP.IsLinkLocalUnicast() {
			bindHost = ip.IP.String()
			break
		}
	}
	require.NotEmpty(t, bindHost)
	sshNetwork := net.JoinHostPort(bindHost, sshPort)
	sshLoopback := net.JoinHostPort("127.0.0.1", sshPort)
	probeSSH := func(target string) {
		conn, err := net.DialTimeout("tcp", target, time.Second)
		require.NoError(t, err)
		defer conn.Close()
		require.NoError(t, conn.SetReadDeadline(time.Now().Add(time.Second)))
		banner, err := bufio.NewReader(conn).ReadString('\n')
		require.NoError(t, err)
		require.True(t, strings.HasPrefix(banner, "SSH-2.0-"), banner)
	}
	probeSSH(sshLoopback)
	before, err := net.DialTimeout("tcp", sshNetwork, time.Second)
	if before != nil {
		before.Close()
	}
	require.Error(t, err, "network SSH is closed before the owner sets a bind")
	var binds []string
	var opened []net.Listener
	server := httptest.NewUnstartedServer(nil)
	network := &networkListener{serve: server.Config.Serve, sshServe: gateway.Serve, sshPort: sshPort, listen: func(kind, target string) (net.Listener, error) {
		ln, err := net.Listen(kind, target)
		if err == nil {
			opened = append(opened, ln)
		}
		return ln, err
	}}
	address := &services.InstallAddress{Listen: func(bind string) error {
		binds = append(binds, bind)
		// Each lane owns ephemeral ports; the route's literal setting still uses 4000.
		if bind != "" {
			return network.Listen(net.JoinHostPort(bindHost, "0"))
		}
		return network.Listen("")
	}}
	setup := &services.InstallSetupService{Pool: pool, Address: address}
	handler := &routes.GitHubAppSetupHandler{Owners: q, Origins: address.Origins, Setup: setup}
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "smithers_session"
	router := githubAppSetupComposeRouter(cfg, pool, handler)
	server.Config.Handler = router
	server.Start()
	defer server.Close()
	defer network.Listen("")

	request := func(body, origin, csrf string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("PUT", "http://localhost:4000/api/install", strings.NewReader(body))
		req.RemoteAddr = "127.0.0.1:1234"
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", origin)
		req.Header.Set("X-CSRF-Token", csrf)
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: "serving-owner-session"})
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "serving-csrf"})
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, req)
		return recorder
	}
	body := `{"bind":"0.0.0.0","origins":["http://lan-a:4000","https://box.example","http://plain.example:80","https://secure.example:443"]}`
	for _, tc := range []struct{ origin, csrf, code string }{
		{"https://evil.example", "serving-csrf", "origin"},
		{"http://localhost:4000", "", "csrf"},
	} {
		recorder := request(body, tc.origin, tc.csrf)
		require.Equal(t, 403, recorder.Code, recorder.Body.String())
		require.JSONEq(t, `{"class":"permission","code":"`+tc.code+`","message":"`+tc.code+`"}`, recorder.Body.String())
		require.Empty(t, binds)
	}
	listener := address.Listen
	address.Listen = nil
	unavailable := request(body, "http://localhost:4000", "serving-csrf")
	require.Equal(t, 503, unavailable.Code, unavailable.Body.String())
	require.Contains(t, unavailable.Body.String(), `"code":"address_unavailable"`)
	require.Empty(t, binds)
	_, settingErr := q.GetInstallSetting(t.Context(), "bind")
	require.Error(t, settingErr, "an unavailable listener must not persist settings")
	address.Listen = listener
	recorder := request(body, "http://localhost:4000", "serving-csrf")
	require.Equal(t, 200, recorder.Code, recorder.Body.String())
	require.Equal(t, []string{"0.0.0.0:4000"}, binds)
	var facts int
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE tenant_id='install' AND principal_id='owner' AND event_type='install.address'`).Scan(&facts))
	require.Equal(t, 1, facts)
	var fact string
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT data::text FROM product_job_events WHERE event_type='install.address'`).Scan(&fact))
	require.JSONEq(t, `{"bind":"0.0.0.0:4000","origins":["http://lan-a:4000","https://box.example","http://plain.example","https://secure.example"]}`, fact)

	require.Equal(t, []string{"http://lan-a:4000", "https://box.example", "http://plain.example", "https://secure.example"}, address.Origins())
	require.Contains(t, recorder.Body.String(), `"ssh_host":"lan-a"`)
	var status map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &status))
	require.JSONEq(t, `{"listen":"network","bind":"0.0.0.0:4000","origins":["http://lan-a:4000","https://box.example","http://plain.example","https://secure.example"]}`, string(status["address"]))
	require.JSONEq(t, `"ssh -p 2222 <branch>@lan-a"`, string(status["ssh_line"]))
	require.Len(t, opened, 2)
	probeSSH(sshNetwork)
	probeSSH(sshLoopback)
	probe := func(target, host string) int {
		req, err := http.NewRequest("GET", "http://"+target+"/health", nil)
		require.NoError(t, err)
		req.Host = host
		response, err := server.Client().Do(req)
		require.NoError(t, err)
		defer response.Body.Close()
		return response.StatusCode
	}
	require.Equal(t, 200, probe(opened[0].Addr().String(), "lan-a:4000"))
	require.Equal(t, 200, probe(server.Listener.Addr().String(), "localhost:4000"))
	// Refresh real persisted sessions at each origin. Forwarded scheme never
	// decides cookie security, even when a loopback proxy forwards the host.
	for _, tc := range []struct {
		host, peer, forwarded, proto string
		secure                       bool
	}{
		{"localhost:4000", "127.0.0.1:1234", "", "https", false},
		{"lan-a:4000", "192.0.2.2:1234", "box.example", "https", false},
		{"internal", "127.0.0.1:1234", "box.example", "http", true},
		{"plain.example", "192.0.2.2:1234", "", "https", false},
		{"internal", "127.0.0.1:1234", "secure.example:443", "http", true},
	} {
		_, err = pool.Exec(t.Context(), "UPDATE auth_sessions SET expires_at = $1 WHERE user_id = $2", time.Now().Add(time.Minute), user.ID)
		require.NoError(t, err)
		req := httptest.NewRequest("GET", "http://"+tc.host+"/api/install", nil)
		req.RemoteAddr = tc.peer
		req.Header.Set("X-Forwarded-Host", tc.forwarded)
		req.Header.Set("X-Forwarded-Proto", tc.proto)
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: "serving-owner-session"})
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		require.Equal(t, 200, rec.Code, rec.Body.String())
		cookies := rec.Result().Cookies()
		require.Len(t, cookies, 2)
		for _, cookie := range cookies {
			require.Empty(t, cookie.Domain)
			require.Equal(t, http.SameSiteLaxMode, cookie.SameSite)
			require.Equal(t, tc.secure, cookie.Secure, cookie.Name)
		}
	}
	publicRequest := httptest.NewRequest("GET", "http://lan-a:4000/api/public/repos", nil)
	publicRequest.RemoteAddr = "192.0.2.2:1234"
	publicRequest.AddCookie(&http.Cookie{Name: "smithers_session", Value: "serving-owner-session"})
	publicResponse := httptest.NewRecorder()
	router.ServeHTTP(publicResponse, publicRequest)
	require.Empty(t, publicResponse.Header().Get("Access-Control-Allow-Origin"))
	require.Empty(t, publicResponse.Header().Get("Access-Control-Allow-Methods"))
	for _, invalid := range []string{
		`{"bind":null,"origins":["http://lan-a:4000"]}`,
		`{"bind":"0.0.0.0","origins":null}`,
		`{"bind":null}`,
		`{"origins":null}`,
		`{"bind":"0.0.0.0","origins":["http://box?"]}`,
		`{"bind":"0.0.0.0","origins":["http://box#"]}`,
		`{"bind":"0.0.0.0","origins":["http://box:80","https://box:443"]}`,
		`{"bind":"bad","origins":["http://lan-a:4000"]}`,
		`{"bind":"0.0.0.0","origins":["/relative"]}`,
		`{"bind":"0.0.0.0","origins":["http://box/path"]}`,
		`{"bind":"0.0.0.0","origins":["ftp://box"]}`,
		`{"bind":"0.0.0.0","origins":["http://box","https://box"]}`,
		`{"bind":"0.0.0.0","origins":["https://localhost:4000","http://lan-a:4000"]}`,
		`{"bind":"0.0.0.0","origins":["https://127.0.0.1:4000","http://lan-a:4000"]}`,
		`{"bind":"0.0.0.0","origins":["https://[::1]:4000","http://lan-a:4000"]}`,
	} {
		recorder = request(invalid, "http://localhost:4000", "serving-csrf")
		require.Equal(t, 400, recorder.Code, recorder.Body.String())
		require.Len(t, binds, 1)
	}
	first := opened[0].Addr().String()
	recorder = request(`{"bind":"","origins":["https://box.example"]}`, "http://localhost:4000", "serving-csrf")
	require.Equal(t, 200, recorder.Code, recorder.Body.String())
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &status))
	require.JSONEq(t, `{"listen":"mac","bind":"","origins":["https://box.example"]}`, string(status["address"]))
	_, dialErr := net.DialTimeout("tcp", first, time.Second)
	require.Error(t, dialErr)
	closedSSH, err := net.DialTimeout("tcp", sshNetwork, time.Second)
	if closedSSH != nil {
		closedSSH.Close()
	}
	require.Error(t, err, "removing the bind closes network SSH")
	probeSSH(sshLoopback)
	require.Equal(t, 200, probe(server.Listener.Addr().String(), "localhost:4000"))
	require.Equal(t, 421, probe(server.Listener.Addr().String(), "lan-a:4000"))
	restored := &services.InstallAddress{}
	require.NoError(t, restored.Load(t.Context(), q))
	require.Equal(t, []string{"https://box.example"}, restored.Origins())
	// Publication failure rolls back the setting and its source cursor together.
	_, err = pool.Exec(t.Context(), `CREATE FUNCTION refuse_address_fact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='install.address' THEN RAISE EXCEPTION 'publication refused'; END IF; RETURN NEW; END $$; CREATE TRIGGER refuse_address_fact BEFORE INSERT ON product_job_events FOR EACH ROW EXECUTE FUNCTION refuse_address_fact()`)
	require.NoError(t, err)
	recorder = request(`{"bind":"","origins":["https://changed.example"]}`, "http://localhost:4000", "serving-csrf")
	require.Equal(t, 500, recorder.Code, recorder.Body.String())
	require.NoError(t, restored.Load(t.Context(), q))
	require.Equal(t, []string{"https://box.example"}, restored.Origins())
	require.Equal(t, []string{"https://box.example"}, address.Origins())
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM product_job_events WHERE event_type='install.address'`).Scan(&facts))
	require.Equal(t, 2, facts)

}

// C-INS-03 exercises the actual live upgrade and reconnect after an owner
// removes an origin. The loopback socket acts as the configured HTTPS proxy.
func TestInstallServingLiveOriginReconnectPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	busContext, stopBus := context.WithCancel(t.Context())
	defer stopBus()
	bus := revocation.NewBus(pool, q)
	require.NoError(t, bus.Start(busContext))
	routes.SetRevocationSource(bus)
	defer routes.SetRevocationSource(nil)
	user, err := q.CreateUser(t.Context(), db.CreateUserParams{Username: "live-origin-owner", LowerUsername: "live-origin-owner"})
	require.NoError(t, err)
	_, err = pool.Exec(t.Context(), `INSERT INTO self_host_owners(user_id) VALUES($1)`, user.ID)
	require.NoError(t, err)
	_, err = q.CreateAuthSession(t.Context(), db.CreateAuthSessionParams{SessionKey: "live-origin-session", UserID: user.ID, Username: user.Username, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	require.NoError(t, q.UpsertInstallSetting(t.Context(), db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(`{"owner_login":"acme","repository_name":"app","repository_id":42}`)}))
	access, err := json.Marshal(map[string]any{"owner_login": "acme", "repository_name": "app", "repository_id": 42, "last_access_check_at": time.Now().UTC().Format(time.RFC3339)})
	require.NoError(t, err)
	require.NoError(t, q.UpsertInstallSetting(t.Context(), db.UpsertInstallSettingParams{Key: "owner.access", Value: access}))
	address := &services.InstallAddress{Configured: []string{"http://lan-a:4000", "https://box.example"}, Listen: func(string) error { return nil }}
	setup := &services.InstallSetupService{Pool: pool, Address: address}
	handler := &routes.GitHubAppSetupHandler{Owners: q, Origins: address.Origins, Setup: setup}
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	topics := &liveTopics{queries: q, install: setup, jobs: store}
	channel := &routes.LiveHandler{Queries: q, Hub: live.NewHub(t.Context(), nil), Origins: address.Origins, Topics: topics.resolver}
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "smithers_session"
	server := httptest.NewServer(githubAppSetupComposeRouter(cfg, pool, handler, routerExtras{Live: channel, GitHubAppSetup: handler}))
	defer server.Close()
	dial := func(host, origin string, want int) {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
		defer cancel()
		conn, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{live.Protocol}, HTTPHeader: http.Header{"X-Forwarded-Host": {host}, "X-Forwarded-Proto": {"http"}, "Origin": {origin}, "Cookie": {"smithers_session=live-origin-session"}}})
		require.NotNil(t, response)
		if response.StatusCode != want {
			body, _ := io.ReadAll(response.Body)
			t.Fatalf("%s from %s: status %d want %d: %s (%v)", host, origin, response.StatusCode, want, body, err)
		}
		require.Empty(t, response.Header.Get("Access-Control-Allow-Origin"))
		if want != 101 {
			require.Error(t, err)
			if want == 403 {
				body, _ := io.ReadAll(response.Body)
				require.JSONEq(t, `{"class":"permission","code":"origin","message":"origin"}`, string(body))
			}
			return
		}
		require.NoError(t, err)
		defer conn.CloseNow()
		require.NoError(t, conn.Write(ctx, websocket.MessageText, []byte(`{"t":"sub","id":1,"topic":"install"}`)))
		_, raw, err := conn.Read(ctx)
		require.NoError(t, err)
		var snapshot struct {
			T    string                     `json:"t"`
			Data map[string]json.RawMessage `json:"data"`
		}
		require.NoError(t, json.Unmarshal(raw, &snapshot))
		require.Equal(t, "snap", snapshot.T)
		require.Contains(t, snapshot.Data, "address")
	}
	for _, tc := range []struct{ host, origin string }{
		{"localhost:4000", "http://localhost:4000"},
		{"lan-a:4000", "http://lan-a:4000"},
		{"box.example", "https://box.example"},
	} {
		dial(tc.host, tc.origin, 101)
		dial(tc.host, tc.origin, 101)
	}
	dial("lan-a:4000", "https://box.example", 403)
	dial("box.example", "http://evil.example", 403)
	dial("box.example", "", 403)
	dial("evil.example", "http://evil.example", 421)
	req := httptest.NewRequest("PUT", "http://localhost:4000/api/install", strings.NewReader(`{"bind":"","origins":["https://box.example"]}`))
	req.RemoteAddr = "127.0.0.1:1234"
	req.Header.Set("Origin", "http://localhost:4000")
	req.Header.Set("X-CSRF-Token", "live-csrf")
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "smithers_session", Value: "live-origin-session"})
	req.AddCookie(&http.Cookie{Name: "__csrf", Value: "live-csrf"})
	rec := httptest.NewRecorder()
	server.Config.Handler.ServeHTTP(rec, req)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	dial("lan-a:4000", "http://lan-a:4000", 421)
	dial("box.example", "https://box.example", 101)
	dial("localhost:4000", "http://localhost:4000", 101)
	// Reconstruct the production resolver/hub as after a backend restart.
	// A persisted cursor replays the committed address fact, never a local
	// wall-clock cursor or another projection of the install settings.
	topics = &liveTopics{queries: q, install: setup, jobs: store}
	channel.Hub = live.NewHub(t.Context(), nil)
	channel.Topics = topics.resolver
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/api/live", &websocket.DialOptions{Subprotocols: []string{live.Protocol}, HTTPHeader: http.Header{"X-Forwarded-Host": {"localhost:4000"}, "Origin": {"http://localhost:4000"}, "Cookie": {"smithers_session=live-origin-session"}}})
	require.NoError(t, err)
	defer conn.CloseNow()
	require.NoError(t, conn.Write(ctx, websocket.MessageText, []byte(`{"t":"sub","id":2,"topic":"install","cursor":0}`)))
	_, raw, err := conn.Read(ctx)
	require.NoError(t, err)
	var replay live.Frame
	require.NoError(t, json.Unmarshal(raw, &replay))
	require.Equal(t, "delta", replay.T)
	var event jobs.Event
	require.NoError(t, json.Unmarshal(replay.Data, &event))
	require.Equal(t, "install.address", event.Type)
	require.JSONEq(t, `{"bind":"","origins":["https://box.example"]}`, string(event.Data))
	head, err := store.Head(ctx, jobs.Scope{TenantID: "install", PrincipalID: "owner"})
	require.NoError(t, err)
	require.Equal(t, head, *replay.Cursor)
	// Lease expiry changes the derived install status without inventing a
	// source fact. The shared snapshot refresh must preserve that behavior.
	step, err := json.Marshal(services.InstallStep{ID: "models", Status: services.InstallRunning, ExpiresAt: time.Now().Add(1500 * time.Millisecond)})
	require.NoError(t, err)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "setup.step.models", Value: step}))
	readSnapshot := func() live.Frame {
		t.Helper()
		for {
			_, raw, err := conn.Read(ctx)
			require.NoError(t, err)
			var frame live.Frame
			require.NoError(t, json.Unmarshal(raw, &frame))
			if frame.ID == 3 {
				return frame
			}
		}
	}
	require.NoError(t, conn.Write(ctx, websocket.MessageText, []byte(`{"t":"sub","id":3,"topic":"install"}`)))
	fresh := readSnapshot()
	require.Equal(t, "snap", fresh.T)
	require.Equal(t, head, *fresh.Cursor)
	require.Contains(t, string(fresh.Data), `"https://box.example"`)
	modelState := func(frame live.Frame) string {
		t.Helper()
		var status struct {
			Steps []struct {
				ID    string
				State string
			}
		}
		require.NoError(t, json.Unmarshal(frame.Data, &status))
		for _, step := range status.Steps {
			if step.ID == "models" {
				return step.State
			}
		}
		t.Fatal("models step missing")
		return ""
	}
	require.Equal(t, "running", modelState(fresh))
	refreshed := readSnapshot()
	require.Equal(t, "snap", refreshed.T)
	require.Equal(t, head, *refreshed.Cursor)
	require.Equal(t, "pending", modelState(refreshed))
	unchanged, err := store.Head(ctx, jobs.Scope{TenantID: "install", PrincipalID: "owner"})
	require.NoError(t, err)
	require.Equal(t, head, unchanged, "derived refresh never allocates a source event")
}
