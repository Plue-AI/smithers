package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/db/product"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// This exercises the install router's actual auth, CSRF and owner setting
// against PostgreSQL, including persistence when capacity falls to zero.
func TestParallelOwnerOnlyInstallBoundary(t *testing.T) {
	// Use only this lane's database. The shared test harness's automatic
	// orphan sweep must never remove a database this test did not create.
	server := os.Getenv("SMITHERS_STK03_DATABASE_URL")
	if server == "" {
		t.Skip("set SMITHERS_STK03_DATABASE_URL")
	}
	admin, err := pgx.Connect(t.Context(), server)
	require.NoError(t, err)
	name := fmt.Sprintf("fr_t_stk_03_parallel_%d", time.Now().UnixNano())
	_, err = admin.Exec(t.Context(), "CREATE DATABASE "+pgx.Identifier{name}.Sanitize()+" TEMPLATE template0")
	require.NoError(t, err)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_, err := admin.Exec(ctx, "DROP DATABASE "+pgx.Identifier{name}.Sanitize())
		require.NoError(t, err)
		require.NoError(t, admin.Close(ctx))
	})
	address, err := url.Parse(server)
	require.NoError(t, err)
	address.Path = "/" + name
	pool, err := postgresfixture.Open(t.Context(), address.String(), 4)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	require.NoError(t, product.Apply(t.Context(), pool))
	q := db.New(pool)
	ctx := t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "quiesceowner", LowerUsername: "quiesceowner"})
	require.NoError(t, err)
	member, err := q.CreateUser(ctx, db.CreateUserParams{Username: "quiescemember", LowerUsername: "quiescemember"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	for key, value := range map[string]string{
		"github.repository": `{"owner_login":"quiesceowner","repository_name":"fixture","repository_id":0}`,
		"owner.access":      fmt.Sprintf(`{"owner_login":"quiesceowner","repository_name":"fixture","repository_id":0,"last_access_check_at":%q}`, time.Now().UTC().Format(time.RFC3339Nano)),
	} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(value)}))
	}
	for _, user := range []db.User{owner, member} {
		token := user.Username + "-session"
		hash := sha256.Sum256([]byte(token))
		_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{SessionKey: hex.EncodeToString(hash[:]), UserID: user.ID, Username: user.Username, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
	}
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Install.QuiesceEnabled = true
	cfg.Install.StateDir = t.TempDir()
	cfg.Server.PublicURL = "http://localhost:4000"
	cfg.Server.AllowedOrigins = []string{"http://localhost:4000"}
	capacity := &services.InstallCapacityService{AuthorizeParallel: func(ctx context.Context) error { _, err := services.Authorize(ctx, q, "settings.parallel"); return err }, Queries: q, Profile: microsandbox.HostProfile{MemoryBytes: 32 << 30, PerfCores: 10, PhysicalCores: 14, DiskFreeBytes: 400 << 30, MacOSVersion: "15.6", Hypervisor: true}}
	require.NoError(t, capacity.Set(ctx, owner.ID, 2))
	router := githubAppSetupComposeRouter(cfg, pool, &routes.GitHubAppSetupHandler{Owners: q, Origins: middleware.FixedOrigins("http://localhost:4000"), Setup: &services.InstallSetupService{Pool: pool, Capacity: capacity}})
	request := func(method, path, token, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://localhost:4000"+path, strings.NewReader(body))
		r.RemoteAddr = "127.0.0.1:1234"
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(&http.Cookie{Name: "smithers_session", Value: token})
		r.Header.Set("Origin", "http://localhost:4000")
		r.Header.Set("X-CSRF-Token", "csrf")
		r.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}

	require.Equal(t, 403, request("PUT", "/api/install", "quiescemember-session", `{"parallel":8}`).Code)
	for _, body := range []string{`{"parallel":0}`, `{"parallel":9}`, `{"parallel":2.5}`} {
		require.Equal(t, 400, request("PUT", "/api/install", "quiesceowner-session", body).Code)
	}
	w := request("PUT", "/api/install", "quiesceowner-session", `{"parallel":8}`)
	require.Equal(t, 200, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), `"parallel":8`)
	raw, err := q.GetInstallParallel(ctx)
	require.NoError(t, err)
	require.JSONEq(t, `8`, string(raw))
	capacity.Profile.DiskFreeBytes = 60 << 30
	w = request("GET", "/api/install", "quiesceowner-session", "")
	require.Equal(t, 200, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), `"parallel":8`)
	setting, err := capacity.Parallel(ctx)
	require.NoError(t, err)
	require.Equal(t, services.InstallParallel{Requested: 8, Effective: 0}, setting)
}
