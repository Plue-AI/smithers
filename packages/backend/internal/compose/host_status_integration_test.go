package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
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
	// The member boundary (#3443) admits only a verified owner outside setup scope, so the retired /api/host reaches the router's 404.
	verified := fmt.Sprintf(`{"owner_login":"hostowner","repository_name":"fixture","repository_id":0,"last_access_check_at":%q}`, time.Now().UTC().Format(time.RFC3339Nano))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(`{"owner_login":"hostowner","repository_name":"fixture","repository_id":0}`)}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(verified)}))
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
	handler := &routes.GitHubAppSetupHandler{Owners: q, Origins: middleware.FixedOrigins("http://localhost:4000"), Setup: &services.InstallSetupService{Pool: pool, Capacity: capacity}}
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
	require.Zero(t, status.Mac.Capacity)
	// §8.2.1a: at capacity 0 Settings shows the limiting term and its fix, from the one Go host profile.
	require.NotNil(t, status.Mac.Limit, response.Body.String())
	require.Equal(t, "disk", status.Mac.Limit.Term)
	require.Equal(t, "free 12 GiB on the state volume", status.Mac.Limit.Fix)
}
