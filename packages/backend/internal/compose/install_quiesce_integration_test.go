package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
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

// This exercises the install router's actual auth, CSRF, admission and owner
// handler against PostgreSQL. Missing capture must never create a freeze row.
func TestInstallQuiesceRouteGate(t *testing.T) {
	// Use only this lane's database. The shared test harness's automatic
	// orphan sweep must never remove a database this test did not create.
	server := os.Getenv("SMITHERS_INS07_DATABASE_URL")
	if server == "" {
		t.Skip("set SMITHERS_INS07_DATABASE_URL")
	}
	admin, err := pgx.Connect(t.Context(), server)
	require.NoError(t, err)
	name := fmt.Sprintf("fr_t_ins_07_quiesce_%d", time.Now().UnixNano())
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
	capacity := &services.InstallCapacityService{Queries: q, Profile: microsandbox.HostProfile{MemoryBytes: 32 << 30, PerfCores: 10, PhysicalCores: 14, DiskFreeBytes: 400 << 30, MacOSVersion: "15.6", Hypervisor: true}}
	require.NoError(t, capacity.Set(ctx, owner.ID, 2))
	// Exercise the production socket composition without a browser session.
	if os.Getuid() != 0 {
		require.NoError(t, os.Chmod(cfg.Install.StateDir, 0700))
		closeHandoff, err := startInstallMaintenanceHandoff(ctx, cfg.Install.StateDir, pool, func(context.Context, io.Writer) error { return nil })
		require.NoError(t, err)
		t.Cleanup(func() { require.NoError(t, closeHandoff()) })
		transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", filepath.Join(cfg.Install.StateDir, "run/host.sock"))
		}}
		defer transport.CloseIdleConnections()
		client := &http.Client{Transport: transport}
		response, err := client.Post("http://install/maintenance/quiesce", "application/json", strings.NewReader(`{"op":"backup-cli"}`))
		require.NoError(t, err)
		body, err := io.ReadAll(response.Body)
		require.NoError(t, err)
		require.NoError(t, response.Body.Close())
		require.Equal(t, 503, response.StatusCode)
		require.Contains(t, string(body), "T-MCH-07 required")
		var freezes int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM install_settings WHERE key='quiesce'`).Scan(&freezes))
		require.Zero(t, freezes)
		response, err = client.Get("http://install/maintenance/check")
		require.NoError(t, err)
		body, err = io.ReadAll(response.Body)
		require.NoError(t, err)
		require.NoError(t, response.Body.Close())
		require.Equal(t, 503, response.StatusCode)
		require.Contains(t, string(body), "T-MCH-07 required")
		request, err := http.NewRequest("DELETE", "http://install/maintenance/quiesce", nil)
		require.NoError(t, err)
		response, err = client.Do(request)
		require.NoError(t, err)
		require.NoError(t, response.Body.Close())
		require.Equal(t, 204, response.StatusCode)
	}
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
	require.Equal(t, 403, request("POST", "/api/install/quiesce", "quiescemember-session", `{"op":"backup"}`).Code)
	w := request("POST", "/api/install/quiesce", "quiesceowner-session", `{"op":"backup"}`)
	require.Equal(t, 503, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "T-MCH-07 required")
	require.Contains(t, w.Body.String(), `"class":"infra"`)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM install_settings WHERE key='quiesce'`).Scan(&count))
	require.Zero(t, count)
	require.Equal(t, 204, request("DELETE", "/api/install/quiesce", "quiesceowner-session", "").Code)
	// A persisted ready freeze closes real install mutation routes, while reads
	// pass through to their normal handler. Reopen restores the original result.
	frozen := fmt.Sprintf(`{"op":"backup-fixture","by":%d,"since":%q,"lease_until":%q,"ready":true}`, owner.ID, time.Now().UTC().Format(time.RFC3339Nano), time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano))
	before := request("PUT", "/api/install", "quiesceowner-session", `{}`).Code
	require.Equal(t, 400, before)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "quiesce", Value: []byte(frozen)}))
	w = request("PUT", "/api/install", "quiesceowner-session", `{}`)
	require.Equal(t, 503, w.Code)
	require.Contains(t, w.Body.String(), `"code":"install_quiesced"`)
	require.Contains(t, w.Body.String(), `"retry_at":`)
	require.Equal(t, 200, request("GET", "/api/install", "quiesceowner-session", "").Code)
	// Restarted composition has no runtime resume provider. Neither an explicit
	// owner reopen nor lease expiry can claim recovery or discard the freeze.
	w = request("DELETE", "/api/install/quiesce", "quiesceowner-session", "")
	require.Equal(t, 503, w.Code)
	require.Contains(t, w.Body.String(), "T-FLW-01 required")
	expired := fmt.Sprintf(`{"op":"persisted","by":%d,"since":"2026-01-01T00:00:00Z","lease_until":"2026-01-01T00:00:30Z","ready":true}`, owner.ID)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "quiesce", Value: []byte(expired)}))
	w = request("PUT", "/api/install", "quiesceowner-session", `{}`)
	require.Equal(t, 503, w.Code)
	require.Contains(t, w.Body.String(), "T-FLW-01 required")
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM install_settings WHERE key='quiesce'`).Scan(&count))
	require.Equal(t, 1, count)
	require.Equal(t, 200, request("GET", "/api/install", "quiesceowner-session", "").Code)
	// Remove only this test's synthetic fixture to retain the unfrozen control.
	_, err = pool.Exec(ctx, `DELETE FROM install_settings WHERE key='quiesce'`)
	require.NoError(t, err)
	require.Equal(t, before, request("PUT", "/api/install", "quiesceowner-session", `{}`).Code)
}
