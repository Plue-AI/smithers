package compose

import (
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

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
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
	for key, value := range map[string]string{
		"github.repository": `{"owner_login":"quiesceowner","repository_name":"fixture","repository_id":0}`,
		"owner.access":      fmt.Sprintf(`{"owner_login":"quiesceowner","repository_name":"fixture","repository_id":0,"last_access_check_at":%q}`, time.Now().UTC().Format(time.RFC3339Nano)),
	} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(value)}))
	}
	maintainer, err := q.CreateUser(ctx, db.CreateUserParams{Username: "quiescemaintainer", LowerUsername: "quiescemaintainer"})
	require.NoError(t, err)
	require.NoError(t, q.SetUserAdmin(ctx, db.SetUserAdminParams{UserID: maintainer.ID, IsAdmin: true}))
	for _, user := range []db.User{owner, member, maintainer} {
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
	setupSessions := &services.InstallSetupSessions{Pool: pool}
	router := githubAppSetupComposeRouter(cfg, pool, &routes.GitHubAppSetupHandler{Sessions: setupSessions, Owners: q, Origins: middleware.FixedOrigins("http://localhost:4000"), Setup: &services.InstallSetupService{Pool: pool, Capacity: capacity}})
	request := func(method, path, token, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://localhost:4000"+path, strings.NewReader(body))
		r.RemoteAddr = "127.0.0.1:1234"
		r.Header.Set("Content-Type", "application/json")
		if strings.HasPrefix(token, "setup:") {
			r.AddCookie(&http.Cookie{Name: "smithers_setup_session", Value: strings.TrimPrefix(token, "setup:")})
		} else if strings.HasPrefix(token, "smithers_") {
			r.Header.Set("Authorization", "Bearer "+token)
		} else {
			r.AddCookie(&http.Cookie{Name: "smithers_session", Value: token})
		}
		r.Header.Set("Origin", "http://localhost:4000")
		r.Header.Set("X-CSRF-Token", "csrf")
		r.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}

	// Before claim, genuine setup authority cannot write owner settings. The
	// composed middleware and handler validate the durable setup cookie; no
	// injected AuthInfo supplies the refusal.
	setupDigest := sha256.Sum256([]byte("parallel-setup-token"))
	setupValue, err := json.Marshal(hex.EncodeToString(setupDigest[:]))
	require.NoError(t, err)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "setup.token", Value: setupValue}))
	setupCookie, err := setupSessions.Exchange(ctx, "parallel-setup-token")
	require.NoError(t, err)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "parallel", Value: []byte(`2`)}))
	setupRead := request("GET", "/api/install", "setup:"+setupCookie, "")
	require.Equal(t, 200, setupRead.Code, setupRead.Body.String())
	setupDenied := request("PUT", "/api/install", "setup:"+setupCookie, `{"parallel":8}`)
	require.Equal(t, 403, setupDenied.Code, setupDenied.Body.String())
	require.Contains(t, setupDenied.Body.String(), `"class":"permission"`)
	setupSaved, err := q.GetInstallParallel(ctx)
	require.NoError(t, err)
	require.JSONEq(t, `2`, string(setupSaved))
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)

	require.NoError(t, capacity.Set(ctx, owner.ID, 2))

	// Every credential goes through the composed authentication chain. Refusal
	// must preserve the requested value, including when the bearer belongs to
	// the owner; administrator status cannot substitute for install ownership.
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "parallel", Value: []byte(`2`)}))
	for _, credential := range []struct {
		name, scopes string
		issued       bool
	}{
		{"delegated", "write:repository,via:cli", true},
		{"run", "write:repository", true},
		{"machine", "credential:sync", true},
		{"personal", "all", false},
	} {
		t.Run(credential.name, func(t *testing.T) {
			seed := sha256.Sum256([]byte("parallel-" + credential.name))
			raw := "smithers_" + hex.EncodeToString(seed[:])[:40]
			digest := sha256.Sum256([]byte(raw))
			_, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner.ID, Name: credential.name, TokenHash: hex.EncodeToString(digest[:]), TokenLastEight: hex.EncodeToString(digest[:])[56:], Scopes: credential.scopes, SystemIssued: credential.issued, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
			require.NoError(t, err)
			denied := request("PUT", "/api/install", raw, `{"parallel":8}`)
			require.Equal(t, 403, denied.Code, denied.Body.String())
			require.Contains(t, denied.Body.String(), `"class":"permission"`)
			saved, err := q.GetInstallParallel(ctx)
			require.NoError(t, err)
			require.JSONEq(t, `2`, string(saved))
		})
	}
	for _, session := range []string{"quiescemember-session", "quiescemaintainer-session"} {
		denied := request("PUT", "/api/install", session, `{"parallel":8}`)
		require.Equal(t, 403, denied.Code, denied.Body.String())
		require.Contains(t, denied.Body.String(), `"class":"permission"`)
		saved, err := q.GetInstallParallel(ctx)
		require.NoError(t, err)
		require.JSONEq(t, `2`, string(saved))
	}
	// The former per-repository setter must not remain an owner bypass.
	require.Equal(t, 404, request("PUT", "/api/repos/quiesceowner/fixture/mythical/config", "quiesceowner-session", `{"maxParallel":8}`).Code)
	for _, body := range []string{`{"parallel":0}`, `{"parallel":9}`, `{"parallel":2.5}`, `{"parallel":8,"unknown":true}`, `{"capacity":null}`, `{"chatgpt":null}`} {
		require.Equal(t, 400, request("PUT", "/api/install", "quiesceowner-session", body).Code, body)
		saved, err := q.GetInstallParallel(ctx)
		require.NoError(t, err)
		require.JSONEq(t, `2`, string(saved), body)
	}
	w := request("PUT", "/api/install", "quiesceowner-session", `{"parallel":8}`)
	require.Equal(t, 200, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), `"parallel":8`)
	raw, err := q.GetInstallParallel(ctx)
	require.NoError(t, err)
	require.JSONEq(t, `8`, string(raw))
	// The served owner setting preserves the request as detected free disk
	// changes. Startup memory/core measurements are not refreshed with disk.
	w = request("PUT", "/api/install", "quiesceowner-session", `{"capacity":3}`)
	require.Equal(t, 200, w.Code, w.Body.String())
	for _, disk := range []struct {
		free     int64
		capacity int
	}{
		{400 << 30, 3},
		{104 << 30, 2},
	} {
		capacity.FreeDisk = func(context.Context) (int64, error) { return disk.free, nil }
		w = request("GET", "/api/install", "quiesceowner-session", "")
		require.Equal(t, 200, w.Code, w.Body.String())
		var snapshot struct {
			Parallel int `json:"parallel"`
			Capacity int `json:"capacity"`
		}
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &snapshot))
		require.Equal(t, 8, snapshot.Parallel)
		require.Equal(t, disk.capacity, snapshot.Capacity)
		effective, err := capacity.Parallel(ctx)
		require.NoError(t, err)
		require.Equal(t, services.InstallParallel{Requested: 8, Effective: disk.capacity}, effective)
		saved, err := q.GetInstallParallel(ctx)
		require.NoError(t, err)
		require.JSONEq(t, `8`, string(saved))
		require.EqualValues(t, 32<<30, capacity.Profile.MemoryBytes)
		require.Equal(t, 10, capacity.Profile.PerfCores)
	}
	capacity.FreeDisk = func(context.Context) (int64, error) { return 60 << 30, nil }
	w = request("GET", "/api/install", "quiesceowner-session", "")
	require.Equal(t, 200, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), `"parallel":8`)
	require.Contains(t, w.Body.String(), `"capacity":0`)
	require.EqualValues(t, 400<<30, capacity.Profile.DiskFreeBytes, "startup measurements stay fixed")
	setting, err := capacity.Parallel(ctx)
	require.NoError(t, err)
	require.Equal(t, services.InstallParallel{Requested: 8, Effective: 0}, setting)
	// Reconstruct the service against persisted storage, as install restart does.
	restarted := &services.InstallCapacityService{Queries: q, Profile: capacity.Profile, FreeDisk: capacity.FreeDisk}
	restored, err := restarted.Parallel(ctx)
	require.NoError(t, err)
	require.Equal(t, services.InstallParallel{Requested: 8, Effective: 0}, restored)
	// A lost policy provider fails closed even for the authenticated owner.
	authorize := capacity.AuthorizeParallel
	capacity.AuthorizeParallel = nil
	denied := request("PUT", "/api/install", "quiesceowner-session", `{"parallel":1}`)
	require.Equal(t, 503, denied.Code, denied.Body.String())
	raw, err = q.GetInstallParallel(ctx)
	require.NoError(t, err)
	require.JSONEq(t, `8`, string(raw))
	capacity.AuthorizeParallel = authorize
	// Read unsaved defaults through the served Settings endpoint. Disk alone
	// varies; startup memory/cores permit all six literal capacity cases.
	_, err = pool.Exec(ctx, `DELETE FROM install_settings WHERE key IN ('parallel', 'capacity')`)
	require.NoError(t, err)
	capacity.Profile.MemoryBytes = 128 << 30
	capacity.Profile.PerfCores = 32
	for _, fixture := range []struct {
		capacity, parallel int
		free               int64
	}{
		{0, 1, 60 << 30},
		{1, 1, 72 << 30},
		{2, 1, 104 << 30},
		{3, 2, 136 << 30},
		{6, 5, 232 << 30},
		{7, 6, 264 << 30},
	} {
		t.Run(fmt.Sprintf("default_capacity_%d", fixture.capacity), func(t *testing.T) {
			capacity.FreeDisk = func(context.Context) (int64, error) { return fixture.free, nil }
			read := request("GET", "/api/install", "quiesceowner-session", "")
			require.Equal(t, 200, read.Code, read.Body.String())
			var snapshot struct {
				Parallel int `json:"parallel"`
				Capacity int `json:"capacity"`
			}
			require.NoError(t, json.Unmarshal(read.Body.Bytes(), &snapshot))
			require.Equal(t, fixture.parallel, snapshot.Parallel)
			require.Equal(t, fixture.capacity, snapshot.Capacity)
			saved, err := q.GetInstallParallel(ctx)
			require.NoError(t, err)
			require.Empty(t, saved, "reading a default does not persist a request")
		})
	}
	// An unsaved default must also fit the owner field on a larger host.
	_, err = pool.Exec(ctx, `DELETE FROM install_settings WHERE key='parallel'`)
	require.NoError(t, err)
	capacity.Profile.MemoryBytes = 128 << 30
	capacity.Profile.PerfCores = 32
	capacity.Profile.DiskFreeBytes = 360 << 30
	capacity.FreeDisk = func(context.Context) (int64, error) { return 360 << 30, nil }
	w = request("PUT", "/api/install", "quiesceowner-session", `{"capacity":10}`)
	require.Equal(t, 200, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), `"parallel":8`)
	require.Contains(t, w.Body.String(), `"capacity":10`)

}
