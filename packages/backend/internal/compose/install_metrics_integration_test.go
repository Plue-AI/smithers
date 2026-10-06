package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	dto "github.com/prometheus/client_model/go"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

func TestInstallMetricsOwnerBoundary(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	q := db.New(pool)
	ctx := t.Context()
	users := make([]db.User, 3)
	cookies := make([]string, 3)
	for i, login := range []string{"owner", "member", "maintainer"} {
		var err error
		users[i], err = q.CreateUser(ctx, db.CreateUserParams{Username: login, LowerUsername: login, DisplayName: login})
		require.NoError(t, err)
		cookies[i] = login + "-metrics-session"
		digest := sha256.Sum256([]byte(cookies[i]))
		_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: users[i].ID, Username: login, SessionKey: hex.EncodeToString(digest[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
	}
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, users[0].ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: users[0].ID, Valid: true}, Name: "scratch", LowerName: "scratch", DefaultBookmark: "main"})
	require.NoError(t, err)
	for i, permission := range []string{"admin", "write", "admin"} {
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,$3)`, repo.ID, users[i].ID, permission)
		require.NoError(t, err)
	}
	for key, value := range map[string]string{
		"github.repository": fmt.Sprintf(`{"owner_login":"owner","repository_name":"scratch","repository_id":%d}`, repo.ID),
		"owner.access":      fmt.Sprintf(`{"owner_login":"owner","repository_name":"scratch","repository_id":%d,"last_access_check_at":"2026-10-05T10:00:00Z"}`, repo.ID),
	} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(value)}))
	}
	ownerToken := "smithers_0000000000000000000000000000000000000123"
	digest := sha256.Sum256([]byte(ownerToken))
	hash := hex.EncodeToString(digest[:])
	_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: users[0].ID, Name: "metrics-cli", TokenHash: hash, TokenLastEight: hash[len(hash)-8:], Scopes: "read:repository", ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(t, err)
	delegated := "smithers_0000000000000000000000000000000000000456"
	digest = sha256.Sum256([]byte(delegated))
	hash = hex.EncodeToString(digest[:])
	scopes := "read:repository"
	for _, scope := range middleware.DelegationScopes(middleware.Delegation{Via: "smithers", Session: liveAppTurnCredentialFixture(t, pool, users[0].ID) + "/1"}) {
		scopes += "," + scope
	}
	_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: users[0].ID, Name: "metrics-delegated", TokenHash: hash, TokenLastEight: hash[len(hash)-8:], SystemIssued: true, Scopes: scopes, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.AllowedOrigins = []string{"http://mini.lan:8080"}
	metrics := routes.NewSmithersMetrics()
	metrics.RequestDurationSeconds().WithLabelValues("POST", "/api/todos/{n}").Observe(.125)
	metrics.SetLandingQueueDepth(3)
	runtime := new(microsandbox.Runtime)
	metrics.MustRegister(runtime.MachineMetrics())
	_, err = runtime.Request("todo", "workspace:A", "todo:5", "machine")
	require.NoError(t, err)
	_, err = runtime.Request("person", "workspace:A", "Alice", "terminal")
	require.NoError(t, err)
	_, err = runtime.Request("background", "review:50", "review:50", "review")
	require.NoError(t, err)

	// Invoke the production composition with real auth storage and collectors;
	// unrelated handlers are absent, not substituted implementations.
	fn := reflect.ValueOf(buildRouter)
	args := make([]reflect.Value, fn.Type().NumIn())
	for i := range args {
		args[i] = reflect.Zero(fn.Type().In(i))
		for _, value := range []any{cfg, q, pool, metrics} {
			v := reflect.ValueOf(value)
			if v.Type() == fn.Type().In(i) {
				args[i] = v
			}
		}
	}
	capacity := &services.InstallCapacityService{Queries: q, Profile: microsandbox.HostProfile{MemoryBytes: 64 << 30, PerfCores: 10, PhysicalCores: 12, DiskFreeBytes: 200 << 30, MacOSVersion: "15.7", Hypervisor: true}}
	args[len(args)-1] = reflect.ValueOf([]any{routerExtras{GitHubAppSetup: &routes.GitHubAppSetupHandler{Owners: q, Setup: &services.InstallSetupService{Pool: pool, Capacity: capacity}}}})
	router := fn.CallSlice(args)[0].Interface().(http.Handler)
	for _, tc := range []struct {
		name, cookie, token string
		status              int
	}{
		{"anonymous", "", "", 401}, {"owner", cookies[0], "", 200},
		{"member", cookies[1], "", 403}, {"maintainer", cookies[2], "", 403},
		{"owner token", "", ownerToken, 403},
		{"delegated owner", "", delegated, 403},
		{"invalid delegated", "", "delegated-invalid", 401},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "http://mini.lan:8080/api/install/metrics", nil)
			if tc.cookie != "" {
				r.AddCookie(&http.Cookie{Name: "session", Value: tc.cookie})
			}
			if tc.token != "" {
				r.Header.Set("Authorization", "Bearer "+tc.token)
			}
			w := httptest.NewRecorder()
			router.ServeHTTP(w, r)
			require.Equal(t, tc.status, w.Code, w.Body.String())
			if tc.status == 200 {
				require.Equal(t, "no-store", w.Header().Get("Cache-Control"))
				var snapshot struct {
					Clock   string            `json:"clock"`
					Metrics []json.RawMessage `json:"metrics"`
				}
				require.NoError(t, json.Unmarshal(w.Body.Bytes(), &snapshot))
				require.Equal(t, "process cumulative collectors", snapshot.Clock)
				require.Contains(t, w.Body.String(), `"sample_sum":0.125`)
				require.Contains(t, w.Body.String(), `"name":"smithers_landing_queue_depth"`)
				require.Contains(t, w.Body.String(), `"value":3`)
				require.Contains(t, w.Body.String(), `"memory_bytes":68719476736`)
				require.Contains(t, w.Body.String(), `"perf_cores":10`)
				require.Contains(t, w.Body.String(), `"macos_version":"15.7"`)
				require.Contains(t, w.Body.String(), `"live_connections":0`)
				var data struct {
					Metrics []*dto.MetricFamily `json:"metrics"`
				}
				require.NoError(t, json.Unmarshal(w.Body.Bytes(), &data))
				depths := map[string]float64{}
				for _, family := range data.Metrics {
					if family.GetName() != "smithers_machine_queue_depth" {
						continue
					}
					for _, sample := range family.Metric {
						require.Len(t, sample.Label, 1)
						require.Equal(t, "class", sample.Label[0].GetName())
						depths[sample.Label[0].GetValue()] = sample.GetGauge().GetValue()
					}
				}
				require.Equal(t, map[string]float64{"person": 1, "todo": 0, "background": 1}, depths)

			}
		})
	}
}
