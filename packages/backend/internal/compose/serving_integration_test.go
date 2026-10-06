package compose

import (
	"encoding/json"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
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
	var binds []string
	var opened []net.Listener
	server := httptest.NewUnstartedServer(nil)
	network := &networkListener{serve: server.Config.Serve, listen: func(kind, target string) (net.Listener, error) {
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
			return network.Listen("127.0.0.1:0")
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
	require.Equal(t, []string{"http://lan-a:4000", "https://box.example", "http://plain.example", "https://secure.example"}, address.Origins())
	require.Contains(t, recorder.Body.String(), `"ssh_host":"lan-a"`)
	var status map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &status))
	require.JSONEq(t, `{"listen":"network","bind":"0.0.0.0:4000","origins":["http://lan-a:4000","https://box.example","http://plain.example","https://secure.example"]}`, string(status["address"]))
	require.JSONEq(t, `"ssh -p 2222 <branch>@lan-a"`, string(status["ssh_line"]))
	require.Len(t, opened, 1)
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
	require.Equal(t, 200, probe(server.Listener.Addr().String(), "localhost:4000"))
	require.Equal(t, 421, probe(server.Listener.Addr().String(), "lan-a:4000"))
	restored := &services.InstallAddress{}
	require.NoError(t, restored.Load(t.Context(), q))
	require.Equal(t, []string{"https://box.example"}, restored.Origins())
}
