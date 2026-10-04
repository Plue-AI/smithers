package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
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
	session := func(user db.User, value string) string {
		hash := sha256.Sum256([]byte(value))
		_, err := q.CreateAuthSession(ctx, db.CreateAuthSessionParams{SessionKey: hex.EncodeToString(hash[:]), UserID: user.ID, Username: user.Username, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return value
	}
	good := session(owner, "owner-capacity-session")
	other := session(member, "member-capacity-session")
	capacity := &services.InstallCapacityService{Queries: q, Profile: microsandbox.HostProfile{MemoryBytes: 32 << 30, PerfCores: 10, PhysicalCores: 14, DiskFreeBytes: 400 << 30, MacOSVersion: "15.6", Hypervisor: true}}
	require.NoError(t, capacity.Set(ctx, owner.ID, 2))
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = "http://localhost:4000"
	cfg.Server.AllowedOrigins = []string{"http://localhost:4000"}
	handler := &routes.GitHubAppSetupHandler{Owners: q, AllowedOrigins: []string{"http://localhost:4000"}, Setup: &services.InstallSetupService{Pool: pool, Capacity: capacity}}
	router := githubAppSetupComposeRouter(cfg, pool, handler)
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
			Memory   float64 `json:"memory_gb"`
			Capacity int     `json:"capacity"`
		} `json:"this_mac"`
		Steps []struct {
			ID string `json:"id"`
		} `json:"steps"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &status))
	require.Equal(t, 32.0, status.Mac.Memory)
	require.Equal(t, 2, status.Capacity)
	require.Equal(t, 3, status.Mac.Capacity)
	require.Len(t, status.Steps, 7)
	require.Equal(t, "app_manifest", status.Steps[1].ID)
	for _, test := range []struct {
		credential, body string
		want             int
	}{{other, `{"capacity":1}`, 403}, {good, `{"capacity":1,"extra":true}`, 400}, {good, `{"capacity":1} {}`, 400}, {good, `{}`, 400}, {good, `{"capacity":4}`, 422}, {good, `{"capacity":0}`, 422}, {good, `{"capacity":1}`, 200}} {
		response = request("PUT", "/api/install", test.credential, test.body)
		require.Equal(t, test.want, response.Code, response.Body.String())
	}
	capacity.Profile.DiskFreeBytes = 60 << 30
	response = request("GET", "/api/install", good, "")
	require.Equal(t, 200, response.Code)
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &status))
	require.Zero(t, status.Capacity)
}
